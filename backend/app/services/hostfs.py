"""Files on the active SSH engine's server ("Server files").

Everything first runs over the engine's SSH connection as its SSH user, with that user's rights:
the same shell scripts as the container file browser (fsbrowse), plus cat / mkdir / rm / chmod for
changes. When the user may not read or change something, and the user agreed to it for this server,
the same operation runs in a short-lived helper container on that server instead, with the folder
bind-mounted (read-only for browsing; a separate writable helper only for changes, as for volumes).
Being allowed to use Docker is as good as root on the server, so that works where SSH doesn't.

Never mounted: the root folder itself, and /proc, /sys, /dev. A Docker engine that runs rootless or
with user-namespace remapping gives the helper no more rights than the user, so the fallback is
reported as unavailable there.
"""

import asyncio
import json
import logging
import os
import posixpath
import secrets
import shlex
import time
from collections.abc import AsyncIterator

import aiodocker

from app.services import fsbrowse, fswrite
from app.services.docker_client import get_docker, query_json
from app.services.engines import DATA_DIR, engines
from app.services.fsbrowse import FsError
from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image, _remove, busy, lease

log = logging.getLogger("pierside.hostfs")

STORE = os.path.join(DATA_DIR, "hostfs.json")  # engine id -> true/false: use Docker where SSH is denied
MOUNT = "/h"  # where the host folder appears inside a helper
NEVER_MOUNTED = ("/proc", "/sys", "/dev")
HELPER_IDLE_S = 60
SSH_TIMEOUT_S = 60

_helpers: dict[tuple[str, str, bool], tuple[str, float]] = {}  # (engine, host folder, writable) -> (container, last used)
_lock = asyncio.Lock()
_reaper: asyncio.Task | None = None
_capable: dict[str, str | None] = {}  # engine id -> why Docker can't help (None: it can)


class NeedsConsent(FsError):
    """SSH was denied and the user hasn't said yet whether Docker may be used on this server."""

    def __init__(self, path: str) -> None:
        super().__init__(f"Your SSH user has no permission for {path}", 403)
        self.path = path


# ---- where we are -------------------------------------------------------------------------------------


def engine_id() -> str:
    if engines.is_local or engines.tunnel is None:
        raise FsError("Server files are for SSH engines: switch to one first", 409)
    return engines.active_id


def ssh_user() -> str:
    return engines.tunnel.cfg.user if engines.tunnel else ""


def _norm(path: str) -> str:
    return posixpath.normpath("/" + (path or "/").lstrip("/"))


# ---- the user's choice per server ---------------------------------------------------------------------


def _load() -> dict:
    try:
        with open(STORE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def consent() -> bool | None:
    """Whether Docker may be used on this server where SSH is denied (None: not asked yet)."""
    value = _load().get(engine_id())
    return value if isinstance(value, bool) else None


def set_consent(allow: bool) -> None:
    data = _load()
    data[engine_id()] = allow
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STORE + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(STORE + ".tmp", STORE)


async def docker_problem() -> str | None:
    """Why the Docker fallback can't help on this server, or None."""
    eid = engine_id()
    if eid not in _capable:
        info = await query_json("info")
        options = " ".join(info.get("SecurityOptions") or [])
        if "name=rootless" in options:
            _capable[eid] = "Docker runs rootless on this server, so its containers have no more rights than you"
        elif "name=userns" in options:
            _capable[eid] = "Docker remaps users on this server (userns-remap), so its containers have no more rights than you"
        else:
            _capable[eid] = None
    return _capable[eid]


# ---- over SSH -----------------------------------------------------------------------------------------


async def ssh_run(cmd: list[str], data: bytes | None = None) -> tuple[int, bytes, bytes]:
    conn = await engines.tunnel._connection()
    try:
        result = await asyncio.wait_for(conn.run(shlex.join(cmd), input=data, encoding=None, check=False), SSH_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise FsError(f"The server didn't answer within {SSH_TIMEOUT_S} seconds", 504)
    code = result.exit_status if result.exit_status is not None else -1
    return code, result.stdout or b"", result.stderr or b""


def _ssh_failed(path: str, code: int, err: bytes, what: str) -> FsError:
    text = err.decode("utf-8", "replace").strip()
    if code == fsbrowse.DENIED or "Permission denied" in text or "Operation not permitted" in text:
        return fsbrowse.denied(path)
    return FsError(text or f"{what} failed ({code})", 404 if "No such file" in text else 409)


# ---- through Docker -----------------------------------------------------------------------------------


def _mountable(folder: str) -> None:
    if folder == "/":
        raise FsError("Pierside doesn't mount the server's root folder; the files directly in / can only be reached with your own rights", 403)
    if any(folder == p or folder.startswith(p + "/") for p in NEVER_MOUNTED):
        raise FsError(f"{folder} is a system folder that Pierside doesn't mount", 403)


async def _create(folder: str, writable: bool) -> str:
    await _ensure_image()
    config = {
        "Image": HELPER_IMAGE,
        "Cmd": ["sleep", "3600"],
        "User": "0:0",
        "Labels": {HELPER_LABEL: "true", f"{HELPER_LABEL}.host": folder, f"{HELPER_LABEL}.mode": "rw" if writable else "ro"},
        "NetworkDisabled": True,
        # A bind mount through Mounts (not Binds) fails for a missing folder instead of creating it.
        "HostConfig": {"AutoRemove": True, "NetworkMode": "none", "Mounts": [{"Type": "bind", "Source": folder, "Target": MOUNT, "ReadOnly": not writable}]},
    }
    try:
        c = await get_docker().containers.create(config, name=f"pierside-helper-{secrets.token_hex(4)}")
    except aiodocker.DockerError as e:
        if "does not exist" in str(e.message):
            raise FsError(f"{folder} doesn't exist on the server", 404)
        raise
    await c.start()
    return c.id


async def _helper(folder: str, writable: bool) -> tuple[str, str]:
    """A running helper that has `folder` (or a folder above it) mounted: (container id, mounted folder)."""
    _mountable(folder)
    eid = engine_id()
    async with _lock:
        _start_reaper()
        for (e, mounted, w), (cid, _last) in sorted(_helpers.items(), key=lambda kv: -len(kv[0][1])):
            if e == eid and w == writable and (folder == mounted or folder.startswith(mounted + "/")):
                try:
                    if ((await query_json(f"containers/{cid}/json")).get("State") or {}).get("Running"):
                        _helpers[(e, mounted, w)] = (cid, time.monotonic())
                        return cid, mounted
                except aiodocker.DockerError:
                    pass
                _helpers.pop((e, mounted, w), None)
        cid = await _create(folder, writable)
        _helpers[(eid, folder, writable)] = (cid, time.monotonic())
        return cid, folder


def _inside(mounted: str, path: str) -> str:
    """A host path as the helper sees it, relative to its mount (fsbrowse/fswrite add MOUNT)."""
    return "/" + posixpath.relpath(path, mounted) if path != mounted else "/"


def _start_reaper() -> None:
    global _reaper
    if _reaper is None or _reaper.done():
        _reaper = asyncio.create_task(_reap(), name="hostfs-reaper")


async def _reap() -> None:
    while _helpers:
        await asyncio.sleep(10)
        now = time.monotonic()
        for key, (cid, last) in list(_helpers.items()):
            if key[0] == engines.active_id and busy(cid):
                _helpers[key] = (cid, now)  # a download, upload or measurement is using it
                continue
            # Helpers on another engine than the active one can't be reached; they remove themselves.
            if now - last > HELPER_IDLE_S or key[0] != engines.active_id:
                _helpers.pop(key, None)
                if key[0] == engines.active_id:
                    await _remove(cid)


async def _fallback(path: str) -> None:
    """SSH was denied for `path`: may Docker take over? Raises if not."""
    allowed = consent()
    if allowed is None:
        raise NeedsConsent(path)
    if not allowed:
        raise FsError(f"Your SSH user ({ssh_user()}) has no permission for {path}. Using Docker for such files is switched off for this server.", 403)
    problem = await docker_problem()
    if problem:
        raise FsError(f"Your SSH user ({ssh_user()}) has no permission for {path}, and Docker can't help: {problem}.", 403)


# ---- operations: each returns its result with "via": "ssh" | "docker" ---------------------------------


async def home() -> str:
    code, out, _err = await ssh_run(["sh", "-c", 'printf %s "$HOME"'])
    return out.decode("utf-8", "replace") if code == 0 and out.startswith(b"/") else "/"


async def list_dir(path: str) -> dict:
    path = _norm(path)
    try:
        return {**await fsbrowse.list_dir(None, "/", path, run=ssh_run), "via": "ssh"}
    except FsError as e:
        if e.status != 403:
            raise
    await _fallback(path)
    cid, mounted = await _helper(path, False)
    r = await fsbrowse.list_dir(cid, MOUNT, _inside(mounted, path))
    for entry in r["entries"]:
        entry["path"] = posixpath.join(mounted, entry["path"].lstrip("/")) if entry["path"] != "/" else mounted
    return {**r, "path": path, "via": "docker"}


async def search_names(path: str, query: str) -> dict:
    """Names below `path`. As the SSH user first; where that user can't read the folder, or (with
    Docker allowed for this server) had to skip folders, through a helper instead."""
    path = _norm(path)
    result = None
    try:
        result = {**await fsbrowse.search_names(None, "/", path, query, run=ssh_run), "via": "ssh"}
        if not result["skipped"] or consent() is not True or path == "/" or await docker_problem():
            return result
    except FsError as e:
        if e.status != 403:
            raise
        await _fallback(path)
    try:
        cid, mounted = await _helper(path, False)
    except FsError:
        if result is None:
            raise
        return result  # a folder Pierside doesn't mount: keep what the user could see
    r = await fsbrowse.search_names(cid, MOUNT, _inside(mounted, path), query)
    for entry in r["entries"]:
        entry["path"] = posixpath.join(mounted, entry["path"].lstrip("/")) if entry["path"] != "/" else mounted
    return {**r, "path": path, "via": "docker"}


async def read_preview(path: str) -> dict:
    path = _norm(path)
    try:
        return {**await fsbrowse.read_preview(None, "/", path, run=ssh_run), "via": "ssh"}
    except FsError as e:
        if e.status != 403:
            raise
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), False)
    return {**await fsbrowse.read_preview(cid, MOUNT, _inside(mounted, path)), "path": path, "via": "docker"}


async def save_text(path: str, content: str) -> dict:
    path = _norm(path)
    raw = content.encode("utf-8")
    if len(raw) > fswrite.MAX_EDIT:
        raise FsError("Edited files are limited to 1 MB", 413)
    # Writing in place (not to a new file renamed over it) keeps the file's owner and permissions.
    script = (
        'F="$1"; if [ -e "$F" ]; then [ -f "$F" ] || { echo "not a regular file" >&2; exit 2; }; [ -w "$F" ] || exit 3; C=0; '
        'else [ -w "$(dirname "$F")" ] || exit 3; C=1; fi; cat > "$F" && echo "$C"'
    )
    code, out, err = await ssh_run(["sh", "-c", script, "sh", path], raw)
    if code == 0:
        return {"path": path, "size": len(raw), "created": out.strip() == b"1", "via": "ssh"}
    failure = _ssh_failed(path, code, err, "Saving")
    if failure.status != 403:
        raise failure
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), True)
    inner = _inside(mounted, path)
    owner = await fswrite.owner_of(cid, posixpath.dirname(inner) or "/", MOUNT)
    return {**await fswrite.save_text(cid, inner, content, root=MOUNT, owner=owner), "path": path, "via": "docker"}


async def make_dir(path: str) -> dict:
    path = _norm(path)
    code, _out, err = await ssh_run(["sh", "-c", '[ -w "$(dirname "$1")" ] || exit 3; mkdir -- "$1"', "sh", path])
    if code == 0:
        return {"path": path, "via": "ssh"}
    failure = _ssh_failed(path, code, err, "Creating the folder")
    if failure.status != 403:
        raise failure
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), True)
    inner = _inside(mounted, path)
    owner = await fswrite.owner_of(cid, posixpath.dirname(inner) or "/", MOUNT)
    await fswrite.make_dir(cid, inner, root=MOUNT, owner=owner)
    return {"path": path, "via": "docker"}


async def delete(path: str) -> dict:
    path = _norm(path)
    if path == "/":
        raise FsError("The root folder can't be deleted")
    code, _out, err = await ssh_run(["sh", "-c", '[ -w "$(dirname "$1")" ] || exit 3; rm -rf -- "$1"', "sh", path])
    if code == 0:
        return {"path": path, "via": "ssh"}
    failure = _ssh_failed(path, code, err, "Deleting")
    if failure.status != 403:
        raise failure
    # Whatever SSH could delete is gone already; Docker deletes the rest.
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), True)
    await fswrite.delete(cid, _inside(mounted, path), root=MOUNT)
    return {"path": path, "via": "docker"}


async def chmod(path: str, mode: str, recursive: bool) -> dict:
    path = _norm(path)
    mode = mode.strip()
    if not (3 <= len(mode) <= 4) or any(ch not in "01234567" for ch in mode):
        raise FsError("Permissions must be 3 or 4 octal digits, like 644 or 0755")
    code, _out, err = await ssh_run(["chmod", *(["-R"] if recursive else []), mode, "--", path])
    if code == 0:
        return {"path": path, "mode": mode, "via": "ssh"}
    failure = _ssh_failed(path, code, err, "Changing permissions")
    if failure.status != 403:
        raise failure
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), True)
    await fswrite.chmod(cid, _inside(mounted, path), mode, recursive, root=MOUNT)
    return {"path": path, "mode": mode, "via": "docker"}


async def upload_target(directory: str) -> tuple[str, str, str]:
    """Where an upload into `directory` goes: ("ssh", "", "") or ("docker", helper container id, mounted folder).
    Checked before the body is read, as a stream can't be sent twice."""
    directory = _norm(directory)
    code, _out, err = await ssh_run(["sh", "-c", '[ -d "$1" ] || exit 2; [ -w "$1" ] || exit 3', "sh", directory])
    if code == 0:
        return "ssh", "", ""
    if code != fsbrowse.DENIED:
        raise _ssh_failed(directory, code, err, "Uploading")
    await _fallback(directory)
    cid, mounted = await _helper(directory, True)
    return "docker", cid, mounted


async def upload(directory: str, name: str, size: int, body: AsyncIterator[bytes]) -> dict:
    directory = _norm(directory)
    fswrite._check_name(name)
    via, cid, mounted = await upload_target(directory)
    target = posixpath.join(directory, name)
    if via == "docker":
        inner = _inside(mounted, directory)
        async with lease(cid):
            owner = await fswrite.owner_of(cid, inner, MOUNT)
            await fswrite.upload(cid, inner, name, size, body, root=MOUNT, owner=owner)
        return {"path": target, "via": "docker"}
    conn = await engines.tunnel._connection()
    proc = await conn.create_process(shlex.join(["sh", "-c", 'cat > "$1"', "sh", target]), encoding=None)
    received = 0
    async for chunk in body:
        received += len(chunk)
        proc.stdin.write(chunk)
        await proc.stdin.drain()
    proc.stdin.write_eof()
    await proc.wait()
    if proc.exit_status != 0 or received != size:
        err = (await proc.stderr.read()) if proc.exit_status != 0 else b""
        raise FsError(err.decode("utf-8", "replace").strip() or "The upload was interrupted", 409)
    return {"path": target, "via": "ssh"}


async def download(path: str) -> AsyncIterator[bytes]:
    """The file's bytes; the caller has checked with readable() first."""
    path = _norm(path)
    code, _out, _err = await ssh_run(["sh", "-c", '[ -f "$1" ] && [ -r "$1" ]', "sh", path])
    if code != 0:
        await _fallback(path)
        cid, mounted = await _helper(posixpath.dirname(path), False)
        async with lease(cid):
            async for chunk in fsbrowse.stream_file(cid, MOUNT, _inside(mounted, path)):
                yield chunk
        return
    conn = await engines.tunnel._connection()
    proc = await conn.create_process(shlex.join(["cat", "--", path]), encoding=None)
    while True:
        chunk = await proc.stdout.read(65536)
        if not chunk:
            break
        yield chunk
    await proc.wait()


async def readable(path: str) -> int:
    """Raise now (before a download starts streaming) if the file can't be read either way; else its size."""
    path = _norm(path)
    try:
        return await fsbrowse.file_size(None, "/", path, run=ssh_run)
    except FsError as e:
        if e.status != 403:
            raise
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), False)
    return await fsbrowse.file_size(cid, MOUNT, _inside(mounted, path))


async def release_all() -> None:
    """Remove this feature's helpers on the active engine (backend shutdown, engine switch)."""
    for key, (cid, _last) in list(_helpers.items()):
        _helpers.pop(key, None)
        if key[0] == engines.active_id:
            await _remove(cid)
