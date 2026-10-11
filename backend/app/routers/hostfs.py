"""Server files: browse and edit files on the active SSH engine's server (see services/hostfs.py).

The same shape as the volume and container file routes, so the UI's file browser works unchanged.
Every answer says how it was done ("via": "ssh" or "docker"). When SSH is denied and the user hasn't
decided yet whether Docker may be used on this server, the answer is 403 with `needsConsent`.
"""

import posixpath
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services import hostfs
from app.services.fsbrowse import FsError, at_most

router = APIRouter(prefix="/hostfs", tags=["hostfs"])


def _error(e: FsError) -> HTTPException:
    if isinstance(e, hostfs.NeedsConsent):
        return HTTPException(403, {"message": str(e), "needsConsent": True, "path": e.path, "user": hostfs.ssh_user()})
    return HTTPException(e.status, str(e))


async def _do(coro):
    try:
        return await coro
    except FsError as e:
        raise _error(e)


@router.get("")
async def state():
    """For the page: which server, as whom, where to start, and the Docker choice for this server."""
    async def build():
        return {"engine": hostfs.engine_id(), "user": hostfs.ssh_user(), "home": await hostfs.home(), "useDocker": hostfs.consent(), "dockerProblem": await hostfs.docker_problem()}

    return await _do(build())


class Consent(BaseModel):
    allow: bool


@router.put("/consent")
async def set_consent(body: Consent):
    async def apply():
        hostfs.set_consent(body.allow)
        if not body.allow:
            await hostfs.release_all()
        return {"useDocker": body.allow}

    return await _do(apply())


@router.get("/files")
async def list_files(path: str = "/"):
    return await _do(hostfs.list_dir(path))


@router.get("/search")
async def search_files(path: str, q: str):
    """Files and folders below `path` whose name contains `q`."""
    return await _do(hostfs.search_names(path, q))


@router.get("/file")
async def preview_file(path: str):
    return await _do(hostfs.read_preview(path))


class SaveFile(BaseModel):
    path: str
    content: str


@router.put("/file")
async def save_file(body: SaveFile):
    return await _do(hostfs.save_text(body.path, body.content))


class PathBody(BaseModel):
    path: str


@router.post("/mkdir")
async def make_dir(body: PathBody):
    return await _do(hostfs.make_dir(body.path))


@router.post("/delete")
async def delete_path(body: PathBody):
    return await _do(hostfs.delete(body.path))


class Chmod(BaseModel):
    path: str
    mode: str
    recursive: bool = False


@router.post("/chmod")
async def chmod_path(body: Chmod):
    return await _do(hostfs.chmod(body.path, body.mode, body.recursive))


@router.post("/upload")
async def upload_file(request: Request, path: str, filename: str):
    """Raw file body into folder `path` (sent straight to the TCP port: vm.service can't carry binary)."""
    size = request.headers.get("content-length")
    if not size or not size.isdigit():
        raise HTTPException(411, "Content-Length is required")
    return await _do(hostfs.upload(path, filename, int(size), request.stream()))


@router.get("/download")
async def download_file(path: str):
    """Binary download; used directly over the TCP port (vm.service can't carry binary)."""
    size = await _do(hostfs.readable(path))
    filename = posixpath.basename(path) or "download"
    # Content-Length: a stream that stops short (a dropped connection) shows as a failed download.
    return StreamingResponse(
        at_most(hostfs.download(path), size),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}", "Content-Length": str(size)},
    )
