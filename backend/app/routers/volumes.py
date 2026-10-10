import asyncio
import json
import posixpath
import time
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services import fsbrowse, fswrite, helper
from app.services.containers import PROJECT_LABEL
from app.services.docker_client import query_json

router = APIRouter(prefix="/volumes", tags=["volumes"])

_sizes_cache: tuple[float, dict[str, int]] | None = None
_sizes_lock = asyncio.Lock()
SIZES_TTL_S = 20


async def _usage() -> dict[str, list[dict]]:
    """volume name -> containers mounting it (helpers excluded)."""
    containers = await query_json("containers/json", params={"all": "1"})
    usage: dict[str, list[dict]] = {}
    for c in containers:
        labels = c.get("Labels") or {}
        if labels.get(helper.HELPER_LABEL):
            continue
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                usage.setdefault(m["Name"], []).append(
                    {
                        "id": c["Id"],
                        "name": (c.get("Names") or ["/"])[0].lstrip("/"),
                        "state": c.get("State"),
                        "project": labels.get(PROJECT_LABEL),
                        "destination": m.get("Destination"),
                        "rw": m.get("RW", True),
                    }
                )
    return usage


def _normalise(v: dict, users: list[dict]) -> dict:
    labels = v.get("Labels") or {}
    return {
        "name": v["Name"],
        "driver": v.get("Driver"),
        "mountpoint": v.get("Mountpoint"),
        "createdAt": v.get("CreatedAt"),
        "scope": v.get("Scope"),
        "labels": labels,
        "project": labels.get(PROJECT_LABEL),
        "anonymous": len(v["Name"]) == 64 and all(ch in "0123456789abcdef" for ch in v["Name"]),
        "inUse": bool(users),
        "containers": users,
    }


def invalidate_sizes() -> None:
    global _sizes_cache
    _sizes_cache = None


@router.get("")
async def list_volumes():
    data, usage = await asyncio.gather(query_json("volumes"), _usage())
    return [_normalise(v, usage.get(v["Name"], [])) for v in data.get("Volumes") or []]


@router.get("/sizes")
async def volume_sizes(refresh: bool = False):
    """Slow (walks every volume): the UI loads this lazily after the list renders."""
    global _sizes_cache
    async with _sizes_lock:
        if not refresh and _sizes_cache and time.monotonic() - _sizes_cache[0] < SIZES_TTL_S:
            return _sizes_cache[1]
        df = await query_json("system/df", params={"type": "volume"})
        sizes = {v["Name"]: (v.get("UsageData") or {}).get("Size", -1) for v in df.get("Volumes") or []}
        _sizes_cache = (time.monotonic(), sizes)
        return sizes


class CreateVolume(BaseModel):
    name: str = ""
    driver: str = "local"
    labels: dict[str, str] = {}


@router.post("")
async def create_volume(body: CreateVolume):
    return await query_json("volumes/create", method="POST", data={"Name": body.name, "Driver": body.driver, "Labels": body.labels})


EXTENSION_PREFIX = "rd-extension-"  # compose project of a Rancher Desktop extension


async def prune_unused(all: bool = True, extension: bool = False) -> dict:
    """Delete unused volumes. all=true includes unused *named* volumes (API >= 1.42 only prunes
    anonymous ones by default). Volumes of Rancher Desktop extensions are kept unless `extension` is
    set: they hold an extension's saved data (Pierside's own engines and SSH keys among them) and are
    unused whenever that extension isn't installed at the moment."""
    await helper.remove_all_helpers()  # our browser helpers would keep volumes "in use"
    data, usage = await asyncio.gather(query_json("volumes"), _usage())
    volumes = [_normalise(v, usage.get(v["Name"], [])) for v in data.get("Volumes") or []]
    protected = [] if extension else [v for v in volumes if (v["project"] or "").startswith(EXTENSION_PREFIX)]
    if not protected:
        filters = json.dumps({"all": ["true"]}) if all else None
        res = await query_json("volumes/prune", method="POST", params={"filters": filters} if filters else None)
        invalidate_sizes()
        return {"deleted": res.get("VolumesDeleted") or [], "spaceReclaimed": res.get("SpaceReclaimed", 0)}
    # The engine's prune can't exclude several projects (its `label!` filters are OR-ed, so each
    # extension's volumes pass the other's filter): delete the rest one by one.
    keep = {v["name"] for v in protected}
    sizes = await volume_sizes()
    deleted, reclaimed = [], 0
    for v in volumes:
        if v["name"] in keep or v["inUse"] or not (all or v["anonymous"]):
            continue
        try:
            await query_json(f"volumes/{v['name']}", method="DELETE")
        except Exception:
            continue  # taken into use meanwhile
        deleted.append(v["name"])
        reclaimed += max(sizes.get(v["name"], 0), 0)
    invalidate_sizes()
    return {"deleted": deleted, "spaceReclaimed": reclaimed}


@router.post("/prune")
async def prune_volumes(all: bool = True, extension: bool = False):
    return await prune_unused(all, extension)


@router.get("/{name}")
async def inspect_volume(name: str):
    v, usage = await asyncio.gather(query_json(f"volumes/{name}"), _usage())
    return {"volume": _normalise(v, usage.get(name, [])), "inspect": v}


@router.delete("/{name}")
async def delete_volume(name: str, force: bool = False):
    await helper.release_volume(name)
    await query_json(f"volumes/{name}", method="DELETE", params={"force": str(force).lower()})
    return {"ok": True}


def _fs_error(e: fsbrowse.FsError) -> HTTPException:
    return HTTPException(e.status, str(e))


@router.get("/{name}/files")
async def list_files(name: str, path: str = "/"):
    cid = await helper.helper_for(name)
    try:
        return await fsbrowse.list_dir(cid, helper.MOUNT, path)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


@router.get("/{name}/search")
async def search_files(name: str, path: str, q: str):
    """Files and folders below `path` whose name contains `q`."""
    cid = await helper.helper_for(name)
    try:
        return await fsbrowse.search_names(cid, helper.MOUNT, path, q)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


@router.get("/{name}/file")
async def preview_file(name: str, path: str):
    cid = await helper.helper_for(name)
    try:
        return await fsbrowse.read_preview(cid, helper.MOUNT, path)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


# ---- changing the contents (a separate, writable helper; browsing stays read-only) ------------------


async def _writable(name: str) -> str:
    return await helper.helper_for(name, writable=True)


@router.post("/{name}/upload")
async def upload_file(name: str, request: Request, path: str, filename: str):
    """Raw file body into folder `path` (sent straight to the TCP port: vm.service can't carry binary)."""
    size = request.headers.get("content-length")
    if not size or not size.isdigit():
        raise HTTPException(411, "Content-Length is required")
    cid = await _writable(name)
    try:
        owner = await fswrite.owner_of(cid, path, helper.MOUNT)
        target = await fswrite.upload(cid, path, filename, int(size), request.stream(), root=helper.MOUNT, owner=owner)
    except fsbrowse.FsError as e:
        raise _fs_error(e)
    return {"path": target[len(helper.MOUNT) :] or "/"}


class SaveFile(BaseModel):
    path: str
    content: str


@router.put("/{name}/file")
async def save_file(name: str, body: SaveFile):
    cid = await _writable(name)
    try:
        owner = await fswrite.owner_of(cid, posixpath.dirname(body.path) or "/", helper.MOUNT)
        return await fswrite.save_text(cid, body.path, body.content, root=helper.MOUNT, owner=owner)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


class PathBody(BaseModel):
    path: str


@router.post("/{name}/mkdir")
async def make_dir(name: str, body: PathBody):
    cid = await _writable(name)
    try:
        owner = await fswrite.owner_of(cid, posixpath.dirname(body.path) or "/", helper.MOUNT)
        return await fswrite.make_dir(cid, body.path, root=helper.MOUNT, owner=owner)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


@router.post("/{name}/delete")
async def delete_path(name: str, body: PathBody):
    cid = await _writable(name)
    try:
        return await fswrite.delete(cid, body.path, root=helper.MOUNT)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


class Chmod(BaseModel):
    path: str
    mode: str
    recursive: bool = False


@router.post("/{name}/chmod")
async def chmod_path(name: str, body: Chmod):
    cid = await _writable(name)
    try:
        return await fswrite.chmod(cid, body.path, body.mode, body.recursive, root=helper.MOUNT)
    except fsbrowse.FsError as e:
        raise _fs_error(e)


@router.get("/{name}/download")
async def download_file(name: str, path: str):
    """Binary download; used directly over the TCP port (vm.service can't carry binary)."""
    cid = await helper.helper_for(name)
    try:
        fsbrowse.confine(helper.MOUNT, path)
    except fsbrowse.FsError as e:
        raise _fs_error(e)
    filename = posixpath.basename(path) or "download"
    return StreamingResponse(
        fsbrowse.stream_file(cid, helper.MOUNT, path),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
