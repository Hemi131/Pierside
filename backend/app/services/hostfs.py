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
from collections.abc import AsyncIterator, Awaitable
from contextvars import ContextVar
from typing import TypeVar

import aiodocker
import asyncssh

from app.services import fsbrowse, fswrite
from app.services.docker_client import get_docker, query_json
from app.services.engines import DATA_DIR, engines
from app.services.fsbrowse import FsError
from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image, _remove, busy, helper_labels, lease
from app.services.store import write_json

log = logging.getLogger("pierside.hostfs")
T = TypeVar("T")

STORE = os.path.join(DATA_DIR, "hostfs.json")  # engine id -> true/false: use Docker where SSH is denied
MOUNT = "/h"  # where the host folder appears inside a helper
NEVER_MOUNTED = ("/proc", "/sys", "/dev")
HELPER_IDLE_S = 60
SSH_TIMEOUT_S = 60
# The server's Docker can stop answering while SSH still works (a stuck daemon, a dead forwarded
# channel); every Docker step of the fallback is bounded so a request fails instead of waiting forever.
DOCKER_TIMEOUT_S = 30  # one API call: inspect, create, start, info, remove
PULL_TIMEOUT_S = 180  # the helper image, the first time on this server
OP_TIMEOUT_S = SSH_TIMEOUT_S  # one operation in a helper (a listing, a save), as over SSH

_helpers: dict[tuple[str, str, bool], tuple[str, float]] = {}  # (engine, host folder, writable) -> (container, last used)
# Helpers being created, so two requests for the same mount share one. No lock is held while Docker is
# asked anything: one stuck call would otherwise hold up every other request that needs a helper.
_creating: dict[tuple[str, str, bool], asyncio.Task] = {}
_reaper: asyncio.Task | None = None
_capable: dict[str, str | None] = {}  # engine id -> why Docker can't help (None: it can)
_checking: dict[str, asyncio.Task] = {}  # engine id -> docker_problem's check under way
PAGE_WAIT_S = 3  # how long a page waits for that check


class NeedsConsent(FsError):
    """SSH was denied and the user hasn't said yet whether Docker may be used on this server."""

    def __init__(self, path: str) -> None:
        super().__init__(f"Your SSH user has no permission for {path}", 403)
        self.path = path


# ---- where we are -------------------------------------------------------------------------------------


# The engine a request is meant for. A file or process action takes several steps, and an engine switch can
# land between two of them: engine_id() and tunnel() then refuse, so the next step can't run on the other
# server. A step already running stays on its own connection. Requests are bound by bind_request; other
# callers (background clean-up) aren't.
_request_engine: ContextVar[str | None] = ContextVar("hostfs_request_engine", default=None)


async def bind_request(engine: str | None = None) -> None:
    """FastAPI dependency of the Server files, performance and disk routers. `?engine=` is the server the
    page shows: a second window can still show the old one after a switch, and its request must not run on
    the new one. Without it, the engine active now. Async on purpose: it runs in the request's own task,
    where the value stays for the handler and its streamed answer."""
    _request_engine.set(engine or (None if engines.is_local else engines.active_id))


def engine_id() -> str:
    if engines.is_local or engines.tunnel is None:
        raise FsError("Server files are for SSH engines: switch to one first", 409)
    bound = _request_engine.get()
    if bound is not None and bound != engines.active_id:
        raise FsError("The active engine changed, so this stopped here. Look at the page again, and check the previous server if this was already running.", 409)
    return engines.active_id


def tunnel():
    """The active engine's tunnel, for the engine this request started on."""
    engine_id()
    return engines.tunnel


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
    write_json(STORE, data, indent=None)


def root_terminal() -> bool:
    """Whether this server's terminal opens as root, through a privileged helper (off unless switched on).
    Separate from consent(): that one lets helpers read and change files, this one is the whole server."""
    value = _load().get("rootTerminal")
    return isinstance(value, dict) and value.get(engine_id()) is True


def set_root_terminal(on: bool) -> None:
    data = _load()
    chosen = data.get("rootTerminal")
    chosen = chosen if isinstance(chosen, dict) else {}
    chosen[engine_id()] = on
    data["rootTerminal"] = chosen
    write_json(STORE, data, indent=None)


async def _check_capable(eid: str) -> None:
    info = await bounded(query_json("info"))
    engine_id()  # still the engine asked about
    options = " ".join(info.get("SecurityOptions") or [])
    if "name=rootless" in options:
        _capable[eid] = "Docker runs rootless on this server, so its containers have no more rights than you"
    elif "name=userns" in options:
        _capable[eid] = "Docker remaps users on this server (userns-remap), so its containers have no more rights than you"
    else:
        _capable[eid] = None


def _checked(eid: str, task: asyncio.Task) -> None:
    if _checking.get(eid) is task:
        _checking.pop(eid, None)
    if not task.cancelled():
        task.exception()  # retrieved: a check nobody waits for any more fails quietly


async def docker_problem(wait: float | None = None) -> str | None:
    """Why the Docker fallback can't help on this server for good (rootless, userns-remap), or None.
    Raises FsError (504) when Docker doesn't answer, within `wait` seconds if given: that is never
    remembered as the answer, and one check per engine goes on in the background meanwhile."""
    eid = engine_id()
    if eid in _capable:
        return _capable[eid]
    task = _checking.get(eid)
    if task is None or task.done():  # done: it failed, its callback just hasn't run yet
        task = _checking[eid] = asyncio.ensure_future(_check_capable(eid))
        task.add_done_callback(lambda t, eid=eid: _checked(eid, t))
    await bounded(asyncio.shield(task), DOCKER_TIMEOUT_S if wait is None else wait)
    return _capable[eid]


async def docker_problem_for_page() -> str | None:
    """docker_problem() for a page: answers within PAGE_WAIT_S. Not knowing yet (Docker slow or not
    answering) is no reason to switch the Docker choice off; an action then says what is wrong."""
    try:
        return await docker_problem(PAGE_WAIT_S)
    except FsError:
        return None


# ---- over SSH -----------------------------------------------------------------------------------------


async def ssh_run(cmd: list[str], data: bytes | None = None) -> tuple[int, bytes, bytes]:
    conn = await tunnel()._connection()
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
    return FsError(fsbrowse._brief(text) or f"{what} failed ({code})", 404 if "No such file" in text else 409)


# ---- through Docker -----------------------------------------------------------------------------------


async def bounded(aw: Awaitable[T], seconds: float | None = None, what: str = "") -> T:
    """`aw`, or a 504 FsError when the server's Docker doesn't answer within `seconds` (DOCKER_TIMEOUT_S)."""
    seconds = DOCKER_TIMEOUT_S if seconds is None else seconds
    try:
        return await asyncio.wait_for(aw, seconds)
    except asyncio.TimeoutError:
        raise FsError(f"Docker on the server didn't answer within {seconds:g} seconds{what}", 504)


async def _remove_bounded(cid: str) -> None:
    try:
        await bounded(_remove(cid))
    except FsError as e:
        log.warning("couldn't remove helper %s: %s", cid[:12], e)  # it ends with its `sleep` anyway


def _mountable(folder: str) -> None:
    if folder == "/":
        raise FsError("Pierside doesn't mount the server's root folder; the files directly in / can only be reached with your own rights", 403)
    if any(folder == p or folder.startswith(p + "/") for p in NEVER_MOUNTED):
        raise FsError(f"{folder} is a system folder that Pierside doesn't mount", 403)


async def _create(folder: str, writable: bool) -> str:
    engine_id()
    await bounded(_ensure_image(), PULL_TIMEOUT_S, " (checking or pulling the helper image)")
    config = {
        "Image": HELPER_IMAGE,
        "Cmd": ["sleep", "3600"],
        "User": "0:0",
        "Labels": helper_labels(**{f"{HELPER_LABEL}.host": folder, f"{HELPER_LABEL}.mode": "rw" if writable else "ro"}),
        "NetworkDisabled": True,
        # A bind mount through Mounts (not Binds) fails for a missing folder instead of creating it.
        "HostConfig": {"AutoRemove": True, "NetworkMode": "none", "Mounts": [{"Type": "bind", "Source": folder, "Target": MOUNT, "ReadOnly": not writable}]},
    }
    engine_id()  # no await between this and using the client below
    try:
        # A create that answers after the time limit leaves a helper nobody uses: labelled, it is swept
        # on the next engine switch, and ends with its `sleep` (AutoRemove) otherwise.
        c = await bounded(get_docker().containers.create(config, name=f"pierside-helper-{secrets.token_hex(4)}"), what=" (creating a helper)")
    except aiodocker.DockerError as e:
        if "does not exist" in str(e.message):
            raise FsError(f"{folder} doesn't exist on the server", 404)
        raise
    try:
        await bounded(c.start(), what=" (starting a helper)")
    except BaseException:
        asyncio.ensure_future(_remove_bounded(c.id))
        raise
    return c.id


async def _mount_point(folder: str) -> tuple[str, str]:
    """What to bind-mount for `folder`: (the folder or the nearest folder above it whose real path the SSH
    user can resolve, that real path). Docker follows symbolic links in a bind source, so a link to /
    (say in another user's home) would mount the whole server: the resolved path is checked and mounted.
    Where the SSH user can't resolve the folder (a parent it may not enter), a folder above it is mounted
    instead; the rest of the path is then followed inside the helper, where a link leads into the
    helper's own filesystem, not the server's."""
    _mountable(folder)
    candidate = folder
    while True:
        code, out, _err = await ssh_run(["readlink", "-f", "--", candidate])
        real = out.decode("utf-8", "replace").rstrip("\n") if code == 0 else ""  # a name may end in a space
        if real.startswith("/"):
            _mountable(candidate)
            _mountable(real)
            return candidate, real
        if candidate == "/":
            raise FsError("Pierside can't tell where this folder really is, so it doesn't mount it", 403)
        candidate = posixpath.dirname(candidate)


async def _running_helper(eid: str, folder: str, writable: bool) -> tuple[str, str] | None:
    """An existing helper that has `folder` or a folder above it mounted."""
    candidates = [
        (key, cid)
        for key, (cid, _last) in sorted(_helpers.items(), key=lambda kv: -len(kv[0][1]))
        if key[0] == eid and key[2] == writable and (folder == key[1] or folder.startswith(key[1] + "/"))
    ]
    for key, cid in candidates:
        try:
            running = ((await bounded(query_json(f"containers/{cid}/json"), what=" (checking a helper)")).get("State") or {}).get("Running")
        except aiodocker.DockerError:
            running = False
        if running:
            if key in _helpers and _helpers[key][0] == cid:  # not reaped meanwhile
                _helpers[key] = (cid, time.monotonic())
                return cid, key[1]
            continue
        if key in _helpers and _helpers[key][0] == cid:  # only the one checked, not a newer one
            _helpers.pop(key, None)
    return None


async def _new_helper(key: tuple[str, str, bool], real: str) -> str:
    cid = await _create(real, key[2])
    _helpers[key] = (cid, time.monotonic())
    return cid


async def _helper(folder: str, writable: bool) -> tuple[str, str]:
    """A running helper that has `folder` (or a folder above it) mounted: (container id, mounted folder)."""
    _mountable(folder)
    eid = engine_id()
    _start_reaper()
    found = await _running_helper(eid, folder, writable)
    if found is None:
        # A new mount, of the real path (no symbolic link left in it to swap or follow).
        mounted, real = await _mount_point(folder)
        found = await _running_helper(eid, folder, writable)  # made by another request meanwhile?
        if found is None:
            key = (eid, mounted, writable)
            task = _creating.get(key)
            if task is None:
                # Shared by every request for this mount until it is done; shielded, so a request that
                # gives up doesn't cancel the creation another one is waiting for.
                task = _creating[key] = asyncio.ensure_future(_new_helper(key, real))
                task.add_done_callback(lambda t, key=key: _creating.pop(key, None) if _creating.get(key) is t else None)
            found = (await asyncio.shield(task), mounted)
    cid, mounted = found
    if mounted != folder:
        # The rest of the path is followed inside the helper: a link there that leads out of the mount
        # would show the helper's own files as if they were the server's.
        inner = MOUNT + _inside(mounted, folder) if _inside(mounted, folder) != "/" else MOUNT
        # Decided by the output whatever the exit code says (Docker may record it late): any answer
        # outside the mount refuses; no answer means nothing to follow (the next step reports it missing).
        _code, out, _err = await bounded(fsbrowse._exec(cid, ["readlink", "-f", "--", inner]), what=" (in a helper)")
        real = out.decode("utf-8", "replace").rstrip("\n")
        if real and not (real == MOUNT or real.startswith(MOUNT + "/")):
            raise FsError(f"{folder} is a link that leads outside the folder Pierside could mount, so it can't be followed here", 403)
    return cid, mounted


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
                    await _remove_bounded(cid)


async def _fallback(path: str) -> None:
    """SSH was denied for `path`: may Docker take over? Raises if not."""
    allowed = consent()
    if allowed is None:
        raise NeedsConsent(path)
    if not allowed:
        raise FsError(f"Your SSH user ({ssh_user()}) has no permission for {path}. Using Docker for such files is switched off for this server.", 403)
    try:
        problem = await docker_problem()
    except FsError as e:
        raise FsError(f"Your SSH user ({ssh_user()}) has no permission for {path}, and {e}.", e.status)
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
    r = await bounded(fsbrowse.list_dir(cid, MOUNT, _inside(mounted, path)), OP_TIMEOUT_S, " (in a helper)")
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
        if not result["skipped"] or consent() is not True or path == "/":
            return result
        try:
            if await docker_problem():
                return result
        except FsError:
            return result  # Docker not answering: keep what the user could see
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
    r = await bounded(fsbrowse.search_names(cid, MOUNT, _inside(mounted, path), query), OP_TIMEOUT_S, " (in a helper)")
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
    return {**await bounded(fsbrowse.read_preview(cid, MOUNT, _inside(mounted, path)), OP_TIMEOUT_S, " (in a helper)"), "path": path, "via": "docker"}


# Saving over SSH, as the SSH user: the "$2" bytes of the input go to a private temporary file first
# (mktemp: the folder itself need not be writable to edit a file in it), so a connection lost while they
# arrive leaves file "$1" as it was. Then they are copied into it locally: an existing file in place
# (keeps owner, mode, hard links; through a link to it, as before), a new one created (`set -C`: never
# one that appeared meanwhile). Prints 1 for created, 0 for changed. Exit 3: not permitted.
_SSH_SAVE = (
    'F="$1"; T=$(mktemp) || exit 1; trap \'rm -f -- "$T"\' EXIT; trap \'exit 1\' HUP INT TERM; '
    'head -c "$2" > "$T" || exit 1; '
    'if [ "$(wc -c < "$T")" -ne "$2" ]; then echo "The file didn\'t arrive whole" >&2; exit 1; fi; '
    'if [ -e "$F" ]; then [ -f "$F" ] || { echo "not a regular file" >&2; exit 2; }; [ -w "$F" ] || exit 3; '
    'cat -- "$T" > "$F" || exit 1; echo 0; '
    'else [ -w "$(dirname "$F")" ] || exit 3; ( set -C; cat -- "$T" > "$F" ) || exit 1; echo 1; fi'
)


async def save_text(path: str, content: str) -> dict:
    path = _norm(path)
    raw = content.encode("utf-8")
    if len(raw) > fswrite.MAX_EDIT:
        raise FsError("Edited files are limited to 1 MB", 413)
    code, out, err = await ssh_run(["sh", "-c", _SSH_SAVE, "sh", path, str(len(raw))], raw)
    if code == 0:
        return {"path": path, "size": len(raw), "created": out.strip() == b"1", "via": "ssh"}
    failure = _ssh_failed(path, code, err, "Saving")
    if failure.status != 403:
        raise failure
    await _fallback(path)
    cid, mounted = await _helper(posixpath.dirname(path), True)
    inner = _inside(mounted, path)
    owner = await bounded(fswrite.owner_of(cid, posixpath.dirname(inner) or "/", MOUNT), OP_TIMEOUT_S, " (in a helper)")
    return {**await bounded(fswrite.save_text(cid, inner, content, root=MOUNT, owner=owner), OP_TIMEOUT_S, " (in a helper)"), "path": path, "via": "docker"}


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
    owner = await bounded(fswrite.owner_of(cid, posixpath.dirname(inner) or "/", MOUNT), OP_TIMEOUT_S, " (in a helper)")
    await bounded(fswrite.make_dir(cid, inner, root=MOUNT, owner=owner), OP_TIMEOUT_S, " (in a helper)")
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
    await bounded(fswrite.delete(cid, _inside(mounted, path), root=MOUNT), OP_TIMEOUT_S, " (in a helper)")
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
    await bounded(fswrite.chmod(cid, _inside(mounted, path), mode, recursive, root=MOUNT), OP_TIMEOUT_S, " (in a helper)")
    return {"path": path, "mode": mode, "via": "docker"}


# Uploading over SSH, as the SSH user, in folder "$1": the "$3" bytes of the input go to part "$2" next to
# the target "$4" (never an existing file: `set -C`), so an upload that breaks off leaves the target as it
# was; the part is removed whenever it isn't put in place, also when the connection is lost (HUP).
# A new target: the part moved into place (owner and mode as `cat >` gave them: the SSH user, its umask).
# An existing regular file: the part gets its owner and mode and replaces it (`mv`: the old file's ACLs,
# extended attributes and hard links don't carry over, and there must be room for both while it runs);
# when the owner can't be given (it is someone else's, and the SSH user isn't root), or the target is a
# link, the part is copied into the existing file in place instead, as a writable file was written
# before (keeps owner, mode, hard links and the link). That copy runs on the server, so a lost
# connection can't cut it short. Exit 3: not permitted.
_SSH_RECEIVE = (
    'cd -- "$1" || exit 1; trap \'rm -f -- "$2"\' EXIT; trap \'exit 1\' HUP INT TERM; '
    '( set -C; head -c "$3" > "$2" ) || exit 1; '
    'if [ "$(wc -c < "$2")" -ne "$3" ]; then echo "The upload didn\'t arrive whole" >&2; exit 1; fi; '
    'if [ -L "$4" ]; then :; '
    'elif [ -d "$4" ]; then echo "$4 is a folder" >&2; exit 1; '
    'elif [ ! -e "$4" ]; then mv -f -- "$2" "$4" || exit 1; exit 0; '
    'elif [ ! -f "$4" ]; then echo "$4 is not a regular file" >&2; exit 1; '
    'else O=$(stat -c %u:%g -- "$4") && M=$(stat -c %a -- "$4") || exit 1; '
    'if { [ "$O" = "$(stat -c %u:%g -- "$2")" ] || chown -- "$O" "$2" 2>/dev/null; } && chmod -- "$M" "$2"; then mv -f -- "$2" "$4" || exit 1; exit 0; fi; fi; '
    '[ -w "$4" ] || exit 3; cat -- "$2" > "$4" || exit 1'
)


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
            owner = await bounded(fswrite.owner_of(cid, inner, MOUNT), OP_TIMEOUT_S, " (in a helper)")
            await fswrite.upload(cid, inner, name, size, body, root=MOUNT, owner=owner)
        return {"path": target, "via": "docker"}
    conn = await tunnel()._connection()
    cmd = ["sh", "-c", _SSH_RECEIVE, "sh", directory, fswrite._temp_name("part"), str(size), name]
    proc = await conn.create_process(shlex.join(cmd), encoding=None)
    # _Body fails on a short or oversized upload and holds each chunk back until the next one (or the end)
    # has arrived, so the script never gets all `size` bytes of an upload that fails.
    chunks = fswrite._Body(body, size)
    failed: Exception | None = None
    try:
        async for chunk in chunks:
            proc.stdin.write(chunk)
            await proc.stdin.drain()
    except FsError as e:
        failed = e  # the upload broke off: the script sees its input end short and removes the part
    except (OSError, asyncssh.Error):
        pass  # the script stopped reading (it failed); its exit code and stderr say why
    try:
        proc.stdin.write_eof()
    except (OSError, asyncssh.Error):
        pass
    result = await proc.wait(check=False)
    if failed is not None:
        raise failed
    if result.exit_status == 0:
        return {"path": target, "via": "ssh"}
    if result.exit_status == fsbrowse.DENIED:
        raise fsbrowse.denied(target)
    err = result.stderr.decode("utf-8", "replace").strip() if isinstance(result.stderr, bytes) else ""
    raise FsError(fsbrowse._brief(err) or "The upload failed", 409)


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
    conn = await tunnel()._connection()
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
    return await bounded(fsbrowse.file_size(cid, MOUNT, _inside(mounted, path)), OP_TIMEOUT_S, " (in a helper)")


async def release_all() -> None:
    """Remove this feature's helpers on the active engine (backend shutdown, engine switch)."""
    for key, (cid, _last) in list(_helpers.items()):
        _helpers.pop(key, None)
        if key[0] == engines.active_id:
            await _remove_bounded(cid)
