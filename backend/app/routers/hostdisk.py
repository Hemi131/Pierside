"""Server disk: where the space on the active SSH engine's server went (see services/hostdisk.py).

The UI lists a folder through the Server files routes (/hostfs/files) and asks here for the size of
each of its subfolders, one request each, so the list fills in as the answers arrive.
"""

from fastapi import APIRouter, HTTPException

from app.services import hostdisk, hostfs
from app.services.fsbrowse import FsError

router = APIRouter(prefix="/hostdisk", tags=["hostdisk"])


async def _do(coro):
    try:
        return await coro
    except FsError as e:
        raise HTTPException(e.status, str(e))


@router.get("")
async def overview():
    """The server's filesystems, and whether Docker may be used for folders the SSH user can't read."""

    async def build():
        return {
            "engine": hostfs.engine_id(),
            "user": hostfs.ssh_user(),
            "filesystems": await hostdisk.filesystems(),
            "useDocker": hostfs.consent(),
            "dockerProblem": await hostfs.docker_problem(),
        }

    return await _do(build())


@router.get("/size")
async def folder_size(path: str):
    return await _do(hostdisk.size(path))


@router.post("/cancel")
async def cancel():
    await hostdisk.cancel()
    return {"ok": True}
