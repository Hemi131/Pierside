import posixpath
from typing import Literal
from urllib.parse import quote

import aiodocker
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services import containers as svc
from app.services import fsbrowse, fswrite
from app.services.conflicts import safe_start
from app.services.docker_client import query_json
from app.services.runcmd import docker_run_command

router = APIRouter(prefix="/containers", tags=["containers"])

Action = Literal["start", "stop", "restart", "pause", "unpause", "kill"]


@router.get("")
async def list_containers(all: bool = True):
    return await svc.list_containers(all=all)


@router.get("/{cid}")
async def inspect_container(cid: str):
    return await query_json(f"containers/{cid}/json")


@router.get("/{cid}/run-command")
async def run_command(cid: str):
    return {"command": await docker_run_command(cid)}


async def _running_with_shell(cid: str) -> None:
    info = await query_json(f"containers/{cid}/json")
    if not (info.get("State") or {}).get("Running"):
        raise HTTPException(409, "The container isn't running. Start it to browse its files.")


def _fs_http(e: fsbrowse.FsError) -> HTTPException:
    return HTTPException(e.status, str(e))


async def _fs_call(cid: str, coro_fn):
    await _running_with_shell(cid)
    try:
        return await coro_fn()
    except fsbrowse.FsError as e:
        raise _fs_http(e)
    except aiodocker.DockerError as e:
        msg = (e.message.get("message") if isinstance(e.message, dict) else str(e.message)) or ""
        if "executable file not found" in msg or "no such file" in msg.lower():
            raise HTTPException(501, "This container has no shell tools (sh/find/stat), so its files can't be browsed.")
        raise


@router.get("/{cid}/files")
async def container_files(cid: str, path: str = "/"):
    return await _fs_call(cid, lambda: fsbrowse.list_dir(cid, "/", path))


@router.get("/{cid}/search")
async def search_files(cid: str, path: str, q: str):
    """Files and folders below `path` whose name contains `q`."""
    return await _fs_call(cid, lambda: fsbrowse.search_names(cid, "/", path, q))


@router.get("/{cid}/file")
async def container_file(cid: str, path: str):
    return await _fs_call(cid, lambda: fsbrowse.read_preview(cid, "/", path))


@router.get("/{cid}/download")
async def container_download(cid: str, path: str):
    size = await _fs_call(cid, lambda: fsbrowse.file_size(cid, "/", path))
    filename = posixpath.basename(path) or "download"
    return StreamingResponse(
        fsbrowse.at_most(fsbrowse.stream_file(cid, "/", path), size),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}", "Content-Length": str(size)},
    )


@router.post("/{cid}/upload")
async def container_upload(cid: str, request: Request, path: str, name: str):
    """Raw file body into directory `path` (sent straight to the TCP port: vm.service can't carry binary)."""
    size = request.headers.get("content-length")
    if not size or not size.isdigit():
        raise HTTPException(411, "Content-Length is required")
    try:
        target = await fswrite.upload(cid, path, name, int(size), request.stream())
    except fsbrowse.FsError as e:
        raise _fs_http(e)
    return {"path": target}


class SaveFile(BaseModel):
    path: str
    content: str


@router.put("/{cid}/file")
async def container_save_file(cid: str, body: SaveFile):
    try:
        return await fswrite.save_text(cid, body.path, body.content)
    except fsbrowse.FsError as e:
        raise _fs_http(e)


class MakeDir(BaseModel):
    path: str


@router.post("/{cid}/mkdir")
async def container_mkdir(cid: str, body: MakeDir):
    try:
        return await fswrite.make_dir(cid, body.path)
    except fsbrowse.FsError as e:
        raise _fs_http(e)


@router.post("/{cid}/delete")
async def container_delete_path(cid: str, body: MakeDir):
    await _running_with_shell(cid)
    try:
        return await fswrite.delete(cid, body.path)
    except fsbrowse.FsError as e:
        raise _fs_http(e)


class Chmod(BaseModel):
    path: str
    mode: str
    recursive: bool = False


@router.post("/{cid}/chmod")
async def container_chmod(cid: str, body: Chmod):
    await _running_with_shell(cid)
    try:
        return await fswrite.chmod(cid, body.path, body.mode, body.recursive)
    except fsbrowse.FsError as e:
        raise _fs_http(e)


@router.post("/{cid}/{action}")
async def container_action(cid: str, action: Action):
    try:
        if action in ("start", "restart"):
            await safe_start(cid, action)
        else:
            await query_json(f"containers/{cid}/{action}", method="POST")
    finally:
        svc.invalidate(cid)
    return {"ok": True}


@router.delete("/{cid}")
async def remove_container(cid: str, force: bool = True, volumes: bool = False):
    await query_json(f"containers/{cid}", method="DELETE", params={"force": str(force).lower(), "v": str(volumes).lower()})
    svc.invalidate(cid)
    return {"ok": True}
