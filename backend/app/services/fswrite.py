"""Writing into a filesystem through Docker's archive API (PUT /containers/{id}/archive).

Used for a container's own files, and for volumes through a writable helper container (the helper
used for browsing mounts volumes read-only; see helper.py). Paths are confined to `root`.

Uploads are streamed into a one-entry tar on the fly, so large files never sit in memory. Edits
fetch the file's own tar entry first and write it back with only the content changed, so owner,
group and mode are kept. New files and folders get `owner` (uid, gid) when given (volumes: the owner
of the folder they're created in), otherwise the container's default user (copyUIDGID).
"""

import io
import posixpath
import tarfile
import time
from collections.abc import AsyncIterator

from app.services.docker_client import STREAM_TIMEOUT, get_docker
from app.services.fsbrowse import PREVIEW_LIMIT, FsError, confine, run_in

MAX_UPLOAD = 4 * 1024**3
MAX_EDIT = PREVIEW_LIMIT  # what the preview shows is what can be edited

Owner = tuple[int, int] | None


def _check_name(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise FsError(f"Invalid file name: {name!r}")
    return name


def _new_entry(name: str, owner: Owner, kind: bytes = tarfile.REGTYPE, mode: int = 0o644) -> tarfile.TarInfo:
    info = tarfile.TarInfo(_check_name(name))
    info.type = kind
    info.mode = mode
    info.mtime = int(time.time())
    if owner:
        info.uid, info.gid = owner
    return info


async def _put_archive(cid: str, directory: str, data, keep_owner: bool) -> None:
    params = {"path": directory}
    if not keep_owner:
        params["copyUIDGID"] = "true"
    async with get_docker()._query(
        f"containers/{cid}/archive", method="PUT", params=params, data=data, headers={"Content-Type": "application/x-tar"}, timeout=STREAM_TIMEOUT
    ) as resp:
        await resp.read()


async def upload(cid: str, directory: str, name: str, size: int, body: AsyncIterator[bytes], root: str = "/", owner: Owner = None) -> str:
    directory = confine(root, directory)
    if size > MAX_UPLOAD:
        raise FsError("Files larger than 4 GB can't be uploaded here", 413)
    info = _new_entry(name, owner)
    info.size = size
    header = info.tobuf(format=tarfile.PAX_FORMAT)  # PAX: long names and big sizes

    async def tar_stream():
        yield header
        received = 0
        async for chunk in body:
            received += len(chunk)
            if received > size:
                raise FsError("The upload is larger than announced")
            yield chunk
        if received != size:
            raise FsError("The upload was interrupted")
        yield b"\0" * ((512 - size % 512) % 512) + b"\0" * 1024  # padding + end-of-archive

    await _put_archive(cid, directory, tar_stream(), keep_owner=owner is not None)
    return posixpath.join(directory, info.name)


async def _current_entry(cid: str, path: str) -> tarfile.TarInfo | None:
    try:
        async with get_docker()._query(f"containers/{cid}/archive", params={"path": path}, timeout=STREAM_TIMEOUT) as resp:
            data = await resp.read()
    except Exception as e:
        if getattr(e, "status", None) == 404:
            return None
        raise
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        member = tf.next()
    if member is None:
        return None
    if member.issym() or member.islnk():
        raise FsError(f"This is a link to {member.linkname}; open the target to edit it", 409)
    if not member.isfile():
        raise FsError("Only regular files can be edited", 409)
    if member.size > MAX_EDIT:
        raise FsError("Files larger than 1 MB can't be edited here; download, edit and upload it instead", 413)
    return member


async def save_text(cid: str, path: str, content: str, root: str = "/", owner: Owner = None) -> dict:
    """Overwrite (or create) a text file, keeping owner and mode of an existing one."""
    full = confine(root, path)
    if full == root:
        raise FsError("Choose a file")
    raw = content.encode("utf-8")
    if len(raw) > MAX_EDIT:
        raise FsError("Edited files are limited to 1 MB", 413)
    member = await _current_entry(cid, full)
    created = member is None
    if member is None:
        member = _new_entry(posixpath.basename(full), owner)
    member.size = len(raw)
    member.mtime = int(time.time())
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as out:
        out.addfile(member, io.BytesIO(raw))
    await _put_archive(cid, posixpath.dirname(full), buf.getvalue(), keep_owner=not created or owner is not None)
    return {"path": full, "size": len(raw), "created": created}


async def make_dir(cid: str, path: str, root: str = "/", owner: Owner = None) -> dict:
    full = confine(root, path)
    if full == root:
        raise FsError("Choose a name for the folder")
    info = _new_entry(posixpath.basename(full), owner, tarfile.DIRTYPE, 0o755)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as out:
        out.addfile(info)
    await _put_archive(cid, posixpath.dirname(full), buf.getvalue(), keep_owner=owner is not None)
    return {"path": full}


async def delete(cid: str, path: str, root: str = "/") -> dict:
    """Delete a file or a folder with everything in it (never the root itself)."""
    full = confine(root, path)
    if full == root:
        raise FsError("The top folder can't be deleted")
    code, _out, err = await run_in(cid, ["rm", "-rf", "--", full])
    if code != 0:
        raise FsError(err.decode("utf-8", "replace").strip() or f"rm exited with {code}", 409)
    return {"path": full}


async def chmod(cid: str, path: str, mode: str, recursive: bool = False, root: str = "/") -> dict:
    """Set permission bits (octal, e.g. "644" or "2755") on a file or folder; `recursive` includes its contents."""
    full = confine(root, path)
    mode = mode.strip()
    if not (3 <= len(mode) <= 4) or any(ch not in "01234567" for ch in mode):
        raise FsError("Permissions must be 3 or 4 octal digits, like 644 or 0755")
    code, _out, err = await run_in(cid, ["chmod", *(["-R"] if recursive else []), mode, "--", full])
    if code != 0:
        raise FsError(err.decode("utf-8", "replace").strip() or f"chmod exited with {code}", 409)
    return {"path": full, "mode": mode}


async def owner_of(cid: str, directory: str, root: str) -> Owner:
    """uid/gid of a folder, for new entries created in it."""
    full = confine(root, directory)
    code, out, _err = await run_in(cid, ["stat", "-c", "%u %g", full])
    if code != 0:
        return None
    try:
        uid, gid = (int(x) for x in out.decode().split())
        return uid, gid
    except ValueError:
        return None
