import asyncio
import json
import re
from typing import Literal

import aiodocker
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import imagecopy
from app.services.conflicts import docker_message, safe_start
from app.services.containers import PROJECT_LABEL
from app.services.docker_client import get_docker, query_json
from app.services.engines import EngineError, engines
from app.services.helper import HELPER_LABEL

router = APIRouter(prefix="/images", tags=["images"])


_SYSTEM_REPOS = ("rancher/", "ghcr.io/rancher-sandbox/rancher-desktop/")


def is_system(repo: str, labels: dict) -> bool:
    """Rancher/k8s plumbing and extension images; hidden by default (like Docker Desktop)."""
    return repo.startswith(_SYSTEM_REPOS) or "com.docker.desktop.extension.api.version" in labels


def split_ref(ref: str) -> tuple[str, str]:
    """'repo/name:tag' -> ('repo/name', 'tag'); handles registry ports ('host:5000/x')."""
    if "@" in ref:
        return ref.split("@", 1)[0], "<digest>"
    name, sep, tag = ref.rpartition(":")
    if not sep or "/" in tag:
        return ref, "latest"
    return name, tag


async def _usage() -> dict[str, list[dict]]:
    """image id -> containers using it (helpers excluded)."""
    containers = await query_json("containers/json", params={"all": "1"})
    out: dict[str, list[dict]] = {}
    for c in containers:
        labels = c.get("Labels") or {}
        if labels.get(HELPER_LABEL):
            continue
        out.setdefault(c.get("ImageID"), []).append(
            {"id": c["Id"], "name": (c.get("Names") or ["/"])[0].lstrip("/"), "state": c.get("State"), "project": labels.get(PROJECT_LABEL)}
        )
    return out


@router.get("")
async def list_images():
    images, usage = await asyncio.gather(query_json("images/json", params={"all": "0"}), _usage())
    rows = []
    for img in images:
        users = usage.get(img["Id"], [])
        base = {
            "id": img["Id"],
            "created": img.get("Created"),
            "size": img.get("Size"),
            "inUse": bool(users),
            "containers": len(users),
            "digests": img.get("RepoDigests") or [],
            "labels": img.get("Labels") or {},
        }
        tags = [t for t in (img.get("RepoTags") or []) if t != "<none>:<none>"]
        if not tags:
            repo = (img.get("RepoDigests") or ["<none>@"])[0].split("@")[0]
            rows.append({**base, "ref": img["Id"], "repo": repo, "tag": "<none>", "dangling": True, "isSystem": False})
        for t in tags:
            repo, tag = split_ref(t)
            rows.append({**base, "ref": t, "repo": repo, "tag": tag, "dangling": False, "isSystem": is_system(repo, base["labels"])})
    return rows


class CopyImage(BaseModel):
    image: str
    target: str  # engine id


# Before the /{ref:path} routes, which would otherwise match /copy/...
@router.post("/copy")
async def copy_image(body: CopyImage):
    """Stream `docker save` from the active engine into `docker load` on another engine (background job)."""
    try:
        return await imagecopy.start_copy(body.image, body.target)
    except EngineError as e:
        raise HTTPException(400, str(e))


@router.get("/copy/{jid}")
async def copy_status(jid: str):
    job = imagecopy.get_job(jid)
    if job is None:
        raise HTTPException(404, "Unknown copy job")
    return imagecopy.public(job)


@router.delete("/copy/{jid}")
async def copy_cancel(jid: str):
    return {"cancelled": imagecopy.cancel(jid)}


@router.get("/{ref:path}/details")
async def image_details(ref: str):
    info, history, usage = await asyncio.gather(query_json(f"images/{ref}/json"), query_json(f"images/{ref}/history"), _usage())
    return {"inspect": info, "history": history, "containers": usage.get(info["Id"], [])}


class PullBody(BaseModel):
    ref: str


@router.post("/pull")
async def pull_image(body: PullBody):
    """Blocking pull (the UI uses WS /ws/images/pull for progress)."""
    repo, tag = split_ref(body.ref)
    await get_docker().images.pull(repo, tag=None if tag == "<digest>" else tag)
    return {"ok": True}


@router.post("/prune")
async def prune_images(mode: Literal["dangling", "unused"] = "dangling"):
    filters = json.dumps({"dangling": ["false" if mode == "unused" else "true"]})
    res = await query_json("images/prune", method="POST", params={"filters": filters})
    deleted = [d.get("Deleted") or d.get("Untagged") for d in res.get("ImagesDeleted") or []]
    return {"deleted": [d for d in deleted if d], "spaceReclaimed": res.get("SpaceReclaimed", 0)}


@router.delete("/{ref:path}")
async def delete_image(ref: str, force: bool = False):
    """Deleting a tag ref untags it (image stays if it has other tags); deleting an id removes the image."""
    return await query_json(f"images/{ref}", method="DELETE", params={"force": str(force).lower()})


# ---- Run -------------------------------------------------------------------------------------

_WIN_PATH = re.compile(r"^([A-Za-z]):[\\/](.*)$")


def host_path(p: str) -> str:
    r"""Rancher (WSL) exposes Windows drives at /mnt/<drive>: 'C:\x\y' -> '/mnt/c/x/y'."""
    m = _WIN_PATH.match(p.strip())
    if not m or not engines.is_local:
        return p.strip()
    return f"/mnt/{m.group(1).lower()}/" + m.group(2).replace("\\", "/")


class PortSpec(BaseModel):
    host: str = ""  # empty -> random host port
    container: str  # "80" or "80/udp"


class VolumeSpec(BaseModel):
    source: str  # volume name, Linux path or Windows path
    target: str
    readOnly: bool = False


class EnvSpec(BaseModel):
    key: str
    value: str = ""


class RunBody(BaseModel):
    image: str
    name: str = ""
    ports: list[PortSpec] = []
    volumes: list[VolumeSpec] = []
    env: list[EnvSpec] = []


@router.get("/{ref:path}/run-defaults")
async def run_defaults(ref: str):
    info = await query_json(f"images/{ref}/json")
    cfg = info.get("Config") or {}
    return {
        "exposedPorts": sorted((cfg.get("ExposedPorts") or {}).keys(), key=lambda p: int(p.split("/")[0]) if p.split("/")[0].isdigit() else 0),
        "volumes": sorted((cfg.get("Volumes") or {}).keys()),
        "env": cfg.get("Env") or [],
    }


@router.post("/run")
async def run_image(body: RunBody):
    exposed: dict[str, dict] = {}
    bindings: dict[str, list[dict]] = {}
    for p in body.ports:
        cport = p.container.strip()
        if not cport:
            continue
        key = cport if "/" in cport else f"{cport}/tcp"
        exposed[key] = {}
        bindings.setdefault(key, []).append({"HostIp": "", "HostPort": p.host.strip()})
    binds = []
    for v in body.volumes:
        if not v.source.strip() or not v.target.strip():
            continue
        binds.append(f"{host_path(v.source)}:{v.target.strip()}{':ro' if v.readOnly else ''}")
    config = {
        "Image": body.image,
        "Env": [f"{e.key}={e.value}" for e in body.env if e.key.strip()],
        "ExposedPorts": exposed,
        "HostConfig": {"PortBindings": bindings, "Binds": binds},
    }
    docker = get_docker()
    try:
        c = await docker.containers.create(config, name=body.name.strip() or None)
    except aiodocker.DockerError as e:
        if e.status == 404:
            raise HTTPException(404, f"Image {body.image} not found locally; pull it first")
        raise
    # Keep the created container (like `docker run`), but report why it didn't start.
    try:
        await safe_start(c.id)
    except HTTPException as e:
        msg = e.detail.get("message") if isinstance(e.detail, dict) else e.detail
        raise HTTPException(e.status_code, f"Container created but failed to start: {msg}")
    except aiodocker.DockerError as e:
        raise HTTPException(e.status, f"Container created but failed to start: {docker_message(e)}")
    return {"id": c.id}
