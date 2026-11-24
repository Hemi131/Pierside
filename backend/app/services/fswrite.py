"""Changing files in a running container (the Files tab) or a volume (through a writable helper
container; the helper used for browsing mounts volumes read-only, see helper.py). Paths are confined
to `root`.

Everything goes through `docker exec`, so it changes what the container itself sees, the same view
the listing, preview and download use. Docker's archive API (what `docker cp` uses) doesn't see a tmpfs
or anything the container mounted itself (the /tmp of a Docker-in-Docker image): there it writes into
the folder hidden underneath, and the file never shows up.

Uploads are the exception, for speed (exec input runs at about 65 MB/s, the archive API at about 450):
`upload` first creates an empty probe file through exec and asks the archive API whether it sees it.
Only if it does is the upload sent through the archive API; otherwise it is fed through exec. Either
way it goes under a random part name next to the target and is moved into place only once it is all
there, so an upload that breaks off never replaces a file with part of another.

Writes run as root, as through the archive API. Root denied (a container started with --cap-drop ALL
has no DAC_OVERRIDE) → the same again as the container's own user. New files and folders get `owner`
(volumes: the owner of the folder they're created in), otherwise the container's own user, as the
archive API's copyUIDGID does; an edited file keeps its owner and mode (written in place).
"""

import posixpath
import secrets
import tarfile
import time
from collections.abc import AsyncIterator, Awaitable, Callable

import aiodocker

from app.services.docker_client import STREAM_TIMEOUT, get_docker
from app.services.fsbrowse import PREVIEW_LIMIT, FsError, confine, run_in, run_script

MAX_UPLOAD = 4 * 1024**3
MAX_EDIT = PREVIEW_LIMIT  # what the preview shows is what can be edited

Owner = tuple[int, int] | None
ROOT = "0"
AS_CONTAINER_USER = ""  # exec's default: the container's own user


def _check_name(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise FsError(f"Invalid file name: {name!r}")
    return name


def _temp_name(kind: str) -> str:
    """A name for a file that exists only during one change, next to its target: random (nothing can be
    planted under it beforehand, two uploads of one name don't share it) and short (a target name up to
    the length limit still works). The scripts create it with `set -C`, so it is never an existing file."""
    return f".pierside-{secrets.token_hex(6)}.{kind}"


def _runner(cid: str, user: str, stdin: bytes | AsyncIterator[bytes] | None = None):
    return lambda cmd: run_in(cid, cmd, user=user, stdin=stdin)


async def default_owner(cid: str) -> Owner:
    """uid and gid of the container's own user, whom the archive API's copyUIDGID gives new files to.
    Decided by the output (exactly two numbers); None if they can't be found out."""
    try:
        _code, out, _err = await run_in(cid, ["sh", "-c", "id -u && id -g"])
        uid, gid = (int(x) for x in out.split())
    except (ValueError, aiodocker.DockerError):
        return None
    return uid, gid


def _chown_arg(user: str, owner: Owner) -> str:
    """What the scripts give new entries to: only as root (the container's user owns what it creates),
    and only when it isn't root itself."""
    return f"{owner[0]}:{owner[1]}" if user == ROOT and owner and owner != (0, 0) else ""


def _denied(e: FsError) -> bool:
    text = str(e)
    return e.status == 403 or "Permission denied" in text or "Operation not permitted" in text


async def _as_root_then_user(change: Callable[[str], Awaitable], owner: Owner):
    """`change(ROOT)`; if root is denied and the container has a user of its own, `change` as that user."""
    try:
        return await change(ROOT)
    except FsError as e:
        if not _denied(e) or owner is None or owner[0] == 0:
            raise
    return await change(AS_CONTAINER_USER)


# ---- uploads ----------------------------------------------------------------------------------------

# In folder "$1", create the empty file "$2" (never an existing one).
_PROBE = 'cd -- "$1" || exit 1; ( set -C; : > "$2" ) || exit 1'

# In folder "$1": part "$2" must have "$3" bytes; give it owner "$5" (if any; best effort, as root
# without CAP_CHOWN can't), then move it onto "$4" unless that is a folder (`mv` would move it into it).
# The part is removed whenever it isn't moved.
_PLACE = (
    'cd -- "$1" || exit 1; '
    'if [ "$(wc -c < "$2")" -ne "$3" ]; then rm -f -- "$2"; echo "The upload didn\'t arrive whole" >&2; exit 1; fi; '
    'if [ -d "$4" ]; then rm -f -- "$2"; echo "$4 is a folder" >&2; exit 1; fi; '
    'if [ -n "$5" ]; then chown -- "$5" "$2" 2>/dev/null; fi; '
    'mv -f -- "$2" "$4" || { rm -f -- "$2"; exit 1; }'
)

# The same, with the part's "$3" bytes read from the input first. umask: an exec starts with 0, the archive
# API gives new files 644 and folders 755 (also in _SAVE, _MKDIR).
_RECEIVE = 'umask 022; cd -- "$1" || exit 1; if ! ( set -C; head -c "$3" > "$2" ); then rm -f -- "$2"; exit 1; fi; ' + _PLACE


async def upload(cid: str, directory: str, name: str, size: int, body: AsyncIterator[bytes], root: str = "/", owner: Owner = None) -> str:
    directory = confine(root, directory)
    if size > MAX_UPLOAD:
        raise FsError("Files larger than 4 GB can't be uploaded here", 413)
    name = _check_name(name)
    target = posixpath.join(directory, name)
    owner = owner or await default_owner(cid)
    user, fast = await _as_root_then_user(lambda user: _probe(cid, directory, user), owner)
    part = _temp_name("part")
    chunks = _Body(body, size)
    if fast:
        info = _new_entry(part, owner)
        info.size = size
        try:
            await _put_archive(cid, directory, _tar(info, chunks), keep_owner=owner is not None)
        except Exception as e:
            await _remove(cid, posixpath.join(directory, part), user)
            raise chunks.error or _put_failed(e)
        await run_script(_runner(cid, user), _PLACE, directory, part, str(size), name, "", path=target, what="Putting the upload in place")
    else:
        try:
            await run_script(_runner(cid, user, chunks), _RECEIVE, directory, part, str(size), name, _chown_arg(user, owner), path=target, what="The upload")
        except FsError as e:
            raise chunks.error or e
    return target


async def _probe(cid: str, directory: str, user: str) -> tuple[str, bool]:
    """(user, whether the archive API sees `directory` as the container does). Asked with a new empty file
    created there through exec, as `user`; if the archive API finds that same file, it writes where the
    container looks. The probe is always removed."""
    probe = _temp_name("probe")
    await run_script(_runner(cid, user), _PROBE, directory, probe, path=directory, what="Preparing the upload")
    try:
        return user, await _archive_has(cid, posixpath.join(directory, probe))
    finally:
        await _remove(cid, posixpath.join(directory, probe), user)


async def _archive_has(cid: str, path: str) -> bool:
    """Whether the archive API finds `path`. Anything unexpected counts as no: the slower exec path is
    right everywhere."""
    try:
        async with get_docker()._query(f"containers/{cid}/archive", method="HEAD", params={"path": path}) as resp:
            return resp.status == 200
    except Exception:  # 404; aiodocker also fails to parse a HEAD answer's missing error body (ValueError)
        return False


async def _remove(cid: str, path: str, user: str) -> None:
    """Remove a temporary file with plain `rm` (no shell needed). Never raises: the change's own error is
    the one to report."""
    try:
        await run_in(cid, ["rm", "-f", "--", path], user=user)
    except Exception:
        pass


def _new_entry(name: str, owner: Owner) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.mode = 0o644
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


async def _tar(info: tarfile.TarInfo, chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """A one-entry tar of `info.size` bytes from `chunks`, built on the fly (large files never sit in memory)."""
    yield info.tobuf(format=tarfile.PAX_FORMAT)  # PAX: long names and big sizes
    async for chunk in chunks:
        yield chunk
    yield b"\0" * ((512 - info.size % 512) % 512) + b"\0" * 1024  # padding + end-of-archive


def _put_failed(e: Exception) -> FsError:
    if isinstance(e, FsError):
        return e
    message = e.message if isinstance(getattr(e, "message", None), str) else str(e)
    status = getattr(e, "status", None)
    return FsError(f"The upload failed: {message}", status if isinstance(status, int) and 400 <= status < 500 else 502)


class _Body:
    """The upload's chunks (see _checked), remembering why they stopped: aiohttp reports a failing
    request body only as a connection error, which would hide "the upload was interrupted"."""

    def __init__(self, body: AsyncIterator[bytes], size: int) -> None:
        self._chunks = _checked(body, size)
        self.error: FsError | None = None

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self._chunks.__anext__()
        except StopAsyncIteration:
            raise
        except Exception as e:  # FsError from _checked, or the client went away (ClientDisconnect)
            self.error = e if isinstance(e, FsError) else FsError("The upload was interrupted")
            raise self.error


async def _checked(body: AsyncIterator[bytes], size: int) -> AsyncIterator[bytes]:
    """The upload's chunks, failing if it brings more or fewer bytes than announced. Each chunk is passed
    on only once the next one (or the end) has arrived, so the receiver never has all `size` bytes of an
    upload that turns out larger than announced."""
    received = 0
    held = None
    async for chunk in body:
        received += len(chunk)
        if received > size:
            raise FsError("The upload is larger than announced")
        if held is not None:
            yield held
        held = chunk
    if received != size:
        raise FsError("The upload was interrupted")
    if held is not None:
        yield held


# ---- edits and new folders --------------------------------------------------------------------------

# What "$2" in folder "$1" is, without following a link: "link" + its target, "new", "file" + size, "other".
_KIND = (
    'cd -- "$1" || exit 1; F="$2"; '
    'if [ -L "$F" ]; then echo link; readlink -- "$F"; elif [ ! -e "$F" ]; then echo new; '
    'elif [ -f "$F" ]; then echo file; wc -c < "$F"; else echo other; fi'
)

# In folder "$1": the "$4" bytes of the input into part "$3" first, so file "$2" is changed only once all
# of it is there. An existing file is written in place (keeps owner, mode and hard links); a new one is
# the part moved into place, given owner "$5" (if any; best effort). Prints "created" or "changed".
_SAVE = (
    'umask 022; cd -- "$1" || exit 1; F="$2"; T="$3"; '
    'if ! ( set -C; head -c "$4" > "$T" ); then rm -f -- "$T"; exit 1; fi; '
    'if [ "$(wc -c < "$T")" -ne "$4" ]; then rm -f -- "$T"; echo "The edit didn\'t arrive whole" >&2; exit 1; fi; '
    'if [ -L "$F" ]; then rm -f -- "$T"; echo "$F was replaced by a link meanwhile" >&2; exit 1; fi; '
    'if [ -e "$F" ]; then cat -- "$T" > "$F" || { rm -f -- "$T"; exit 1; }; rm -f -- "$T"; echo changed; '
    'else if [ -n "$5" ]; then chown -- "$5" "$T" 2>/dev/null; fi; mv -f -- "$T" "$F" || { rm -f -- "$T"; exit 1; }; echo created; fi'
)


async def save_text(cid: str, path: str, content: str, root: str = "/", owner: Owner = None) -> dict:
    """Overwrite (or create) a text file, keeping owner and mode of an existing one."""
    full = confine(root, path)
    if full == root:
        raise FsError("Choose a file")
    raw = content.encode("utf-8")
    if len(raw) > MAX_EDIT:
        raise FsError("Edited files are limited to 1 MB", 413)
    folder, name = posixpath.split(full)
    owner = owner or await default_owner(cid)

    async def save(user: str) -> bool:
        out = await run_script(_runner(cid, user), _KIND, folder, name, path=full, what="Looking at the file")
        kind, _, rest = out.decode("utf-8", "surrogateescape").partition("\n")
        if kind == "link":
            raise FsError(f"This is a link to {rest.strip() or 'another path'}; open the target to edit it", 409)
        if kind == "other":
            raise FsError("Only regular files can be edited", 409)
        size = rest.split()
        if kind not in ("new", "file") or (kind == "file" and not (size and size[0].isdigit())):
            raise FsError(f"Can't look at {full}: {out.decode('utf-8', 'replace').strip() or 'no answer'}", 502)
        if kind == "file" and int(size[0]) > MAX_EDIT:
            raise FsError("Files larger than 1 MB can't be edited here; download, edit and upload it instead", 413)
        out = await run_script(_runner(cid, user, raw), _SAVE, folder, name, _temp_name("part"), str(len(raw)), _chown_arg(user, owner), path=full, what="Saving")
        return out.strip().endswith(b"created")

    created = await _as_root_then_user(save, owner)
    return {"path": full, "size": len(raw), "created": created}


_MKDIR = 'umask 022; cd -- "$1" || exit 1; mkdir -- "$2" || exit 1; if [ -n "$3" ]; then chown -- "$3" "$2" 2>/dev/null; fi; true'


async def make_dir(cid: str, path: str, root: str = "/", owner: Owner = None) -> dict:
    full = confine(root, path)
    if full == root:
        raise FsError("Choose a name for the folder")
    folder, name = posixpath.split(full)
    name = _check_name(name)
    owner = owner or await default_owner(cid)

    async def make(user: str) -> None:
        await run_script(_runner(cid, user), _MKDIR, folder, name, _chown_arg(user, owner), path=full, what="Creating the folder")

    await _as_root_then_user(make, owner)
    return {"path": full}


# ---- delete, permissions --------------------------------------------------------------------------
# As the container's own user, as before: root may lack the rights it has (--cap-drop ALL).


async def delete(cid: str, path: str, root: str = "/") -> dict:
    """Delete a file or a folder with everything in it (never the root itself)."""
    full = confine(root, path)
    if full == root:
        raise FsError("The top folder can't be deleted")
    await run_script(lambda cmd: run_in(cid, cmd), 'rm -rf -- "$1"', full, path=path, what="Deleting")
    return {"path": full}


async def chmod(cid: str, path: str, mode: str, recursive: bool = False, root: str = "/") -> dict:
    """Set permission bits (octal, e.g. "644" or "2755") on a file or folder; `recursive` includes its contents."""
    full = confine(root, path)
    mode = mode.strip()
    if not (3 <= len(mode) <= 4) or any(ch not in "01234567" for ch in mode):
        raise FsError("Permissions must be 3 or 4 octal digits, like 644 or 0755")
    script = 'chmod -R "$1" -- "$2"' if recursive else 'chmod "$1" -- "$2"'
    await run_script(lambda cmd: run_in(cid, cmd), script, mode, full, path=path, what="Changing permissions")
    return {"path": full, "mode": mode}


async def owner_of(cid: str, directory: str, root: str) -> Owner:
    """uid/gid of a folder, for new entries created in it."""
    full = confine(root, directory)
    # Decided by the output, which must be exactly "uid gid" (Docker may record the exit code late).
    code, out, _err = await run_in(cid, ["stat", "-c", "%u %g", full])
    if code not in (0, None):
        return None
    try:
        uid, gid = (int(x) for x in out.decode().split())
        return uid, gid
    except ValueError:
        return None
