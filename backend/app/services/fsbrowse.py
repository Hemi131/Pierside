"""Filesystem browsing through `docker exec` of busybox/coreutils tools (ls via find+stat, head, cat).

Used for volume helpers and running containers, and (with `run` = a command over SSH) for files on an
SSH engine's server. All paths are normalised and confined to `root` inside the target container.
Exit code 3 from the scripts means "permission denied" (raised as FsError 403), which only happens
when they don't run as root: the server-files feature then retries through a helper container.
"""

import asyncio
import posixpath
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable

import aiodocker

from app.services.docker_client import get_docker

PREVIEW_LIMIT = 1024 * 1024  # 1 MiB
SEP = "\x1f"


class FsError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def confine(root: str, path: str) -> str:
    """Map a user path ('/a/b') to an absolute path under root, rejecting traversal."""
    norm = posixpath.normpath("/" + (path or "/").lstrip("/"))
    full = posixpath.normpath(posixpath.join(root, norm.lstrip("/"))) if norm != "/" else root
    if full != root and not full.startswith(root.rstrip("/") + "/"):
        raise FsError("Path outside of the browsable root")
    return full


async def exit_code(exe, seconds: float) -> int | None:
    """An exec's exit code once it has ended. Docker records it a moment after the output closes (on a
    slow engine later still), so this waits for up to `seconds` in all; None if it isn't recorded."""
    deadline = time.monotonic() + seconds
    while True:
        info = await exe.inspect()
        if not info.get("Running") and info.get("ExitCode") is not None:
            return info["ExitCode"]
        if time.monotonic() + 0.05 > deadline:
            return None
        await asyncio.sleep(0.05)


EXIT_WAIT_S = 3.0


async def _exec(cid: str, cmd: list[str], user: str = "", stdin: bytes | AsyncIterator[bytes] | None = None) -> tuple[int | None, bytes, bytes]:
    """Run `cmd` in the container: (exit code or None if Docker didn't record one in time, stdout, stderr).
    Don't take None as success: scripts decide by their end marker (run_script).

    `user`: as whom ("" = the container's own user). `stdin`: fed to the command before its output is
    read. Docker's input can't be half-closed without closing the output too, so the command must read
    exactly as many bytes as it is given (`head -c N`). If `stdin` itself fails (an upload broke off),
    the connection is closed, which ends the command's input early so its script can clean up; that is
    waited for, then the error is raised."""
    c = get_docker().containers.container(cid)
    exe = await c.exec(cmd, stdout=True, stderr=True, stdin=stdin is not None, tty=False, user=user)
    out, err = bytearray(), bytearray()  # grown in place: `bytes +=` copies everything per frame
    failed: Exception | None = None
    async with exe.start(detach=False) as stream:
        if stdin is not None:
            failed = await _feed(stream, stdin)
        while failed is None:
            msg = await stream.read_out()
            if msg is None:
                break
            if msg.stream == 2:
                err += msg.data
            else:
                out += msg.data
    if failed is not None:
        await exit_code(exe, 10)
        raise failed
    return await exit_code(exe, EXIT_WAIT_S), bytes(out), bytes(err)


async def _feed(stream, data: bytes | AsyncIterator[bytes]) -> Exception | None:
    """Write `data` to a command's input. Returns the error `data` itself raised, else None. A command
    that stops reading early (it failed) isn't an error here: its output says why."""

    async def chunks():
        if isinstance(data, bytes):
            yield data
        else:
            async for chunk in data:
                yield chunk

    try:
        async for chunk in chunks():
            if not chunk:
                continue
            try:
                await stream.write_in(chunk)
            except (ConnectionError, RuntimeError, OSError):
                return None
    except Exception as e:
        return e
    return None


run_in = _exec  # used by fswrite (stat) and hostdisk

Runner = Callable[[list[str]], Awaitable[tuple[int | None, bytes, bytes]]]
DENIED = 3  # the scripts' exit code for "no permission"
NO_TOOLS = 4  # the scripts' exit code for "find / stat missing"
_NO_TOOLS_TEXT = "no find or stat here"
NO_SHELL = "This container has no shell tools (sh/find/stat), so its files can't be browsed."
# Run first by scripts that list with find + stat: without them a listing would just come out empty.
_NEED_FIND_STAT = (
    'command -v find >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 || { echo "' + _NO_TOOLS_TEXT + '" >&2; exit 4; }; '
)


def _brief(text: str, keep: int = 3, line_chars: int = 300) -> str:
    """A script's messages short enough for a toast: `rm -rf` or `chmod -R` on a big tree prints one
    line per entry it couldn't change (thousands under /proc), so the first few, then how many more."""
    lines = [ln if len(ln) <= line_chars else ln[:line_chars] + "…" for ln in text.splitlines() if ln.strip()]
    if len(lines) <= keep:
        return "\n".join(lines)
    more = len(lines) - keep
    return "\n".join(lines[:keep]) + f"\n… and {more} more message{'s' if more != 1 else ''} like these"


def _failed(code: int | None, err: bytes, path: str, missing: str, what: str) -> "FsError":
    """Why a script didn't print its end marker. The exit code says it when Docker recorded one; else
    the script's own words on stderr do."""
    text = err.decode("utf-8", "replace").strip()
    if code == DENIED or (code is None and text == "permission denied"):
        return denied(path)
    if code == 2 or (code is None and missing and text == missing):
        return FsError(text or missing or "Not found", 404)
    # A missing sh is the runtime's words in the stream (no DockerError); a missing tool inside the
    # script is sh's own "…: not found", shown as it is below.
    # (current engines report it as 126 / 127 without a word).
    if code == NO_TOOLS or text == _NO_TOOLS_TEXT or "executable file not found" in text or (code in (126, 127) and not text):
        return FsError(NO_SHELL, 501)
    if text:
        return FsError(_brief(text), 409)
    if code is None:
        return FsError(f"{what} didn't finish (Docker reported no result)", 502)
    if code == 0:
        return FsError(f"{what} ended before finishing its output", 502)
    return FsError(f"{what} failed (exit code {code})", 409)


async def run_script(run: Runner, script: str, *args: str, path: str = "", missing: str = "", what: str = "The command") -> bytes:
    """Run a shell script; its stdout if it ran to its end, else FsError.

    Success doesn't depend on the exit code (Docker may record it late): the script's last act is to
    print a marker that is new for every call, and only output that ends with it counts. The marker
    is cut off exactly, so binary output (a preview) stays as it was. The script sees its own
    arguments as $1…; an `exit`, or a failing last command, skips the marker."""
    marker = "@@END" + secrets.token_hex(8)
    wrapped = 'E="$1"; shift; {\n' + script + '\n} && printf "\\n%s\\n" "$E"'
    code, out, err = await run(["sh", "-c", wrapped, "sh", marker, *args])
    end = b"\n" + marker.encode() + b"\n"
    if out.endswith(end):
        return out[: -len(end)]
    raise _failed(code, err, path, missing, what)
# Tells "doesn't exist" from "can't get there": climbs to the nearest folder above that exists; if
# that one can be entered, the path really is missing, otherwise it is out of reach.
_MISSING_OR_DENIED = (
    '{ D="$P"; while [ "$D" != / ]; do D=$(dirname "$D"); [ -e "$D" ] && break; done; '
    'if [ -x "$D" ] || [ ! -d "$D" ]; then echo "$3" >&2; exit 2; fi; echo "permission denied" >&2; exit 3; }'
)


def denied(path: str) -> "FsError":
    return FsError(f"Permission denied: {path}", 403)


_TYPES = {
    "directory": "dir",
    "regular file": "file",
    "regular empty file": "file",
    "symbolic link": "link",
    "fifo": "other",
    "socket": "other",
    "character special file": "other",
    "block special file": "other",
}


async def list_dir(cid: str | None, root: str, path: str, run: Runner | None = None) -> dict:
    full = confine(root, path)
    # %F type | %s size | %Y mtime | %A mode | %U user | %G group | %n name (last: may contain SEP-free '|')
    fmt = SEP.join(["%F", "%s", "%Y", "%A", "%U", "%G", "%n"])
    # "$P/" (trailing slash) makes find follow the start path when it is a symlink to a directory.
    script = (
        'P="$1"; [ -d "$P" ] || ' + _MISSING_OR_DENIED + '; [ -r "$P" ] && [ -x "$P" ] || { echo "permission denied" >&2; exit 3; }; '
        + _NEED_FIND_STAT
        + 'find "$P/" -mindepth 1 -maxdepth 1 -exec stat -c "$2" {} + 2>/dev/null; '
        # For symlinks, report whether the target is a directory (so the UI can navigate into it).
        'find "$P/" -mindepth 1 -maxdepth 1 -type l -exec sh -c \'for l; do [ -d "$l" ] && echo "@@LINKDIR@@$l"; done\' _ {} + 2>/dev/null; true'
    )
    runner = run or (lambda cmd: _exec(cid, cmd))
    out = await run_script(runner, script, full, fmt, "not a directory", path=path, missing="not a directory", what="Listing the folder")
    entries = []
    link_dirs = set()
    for line in out.decode(errors="replace").splitlines():
        if line.startswith("@@LINKDIR@@"):
            link_dirs.add(posixpath.normpath(line[len("@@LINKDIR@@") :]))
            continue
        parts = line.split(SEP, 6)
        if len(parts) != 7:
            continue
        ftype, size, mtime, mode, user, group, name = parts
        name = posixpath.normpath(name)
        entries.append(
            {
                "name": posixpath.basename(name),
                "path": "/" + posixpath.relpath(name, root) if name != root else "/",
                "type": _TYPES.get(ftype, "other"),
                "size": int(size) if size.isdigit() else None,
                "mtime": int(mtime) if mtime.isdigit() else None,
                "mode": mode,
                "owner": f"{user}:{group}",
                "_full": name,
            }
        )
    for e in entries:
        e["linkToDir"] = e["type"] == "link" and e.pop("_full") in link_dirs
        e.pop("_full", None)
    entries.sort(key=lambda e: (not (e["type"] == "dir" or e["linkToDir"]), e["name"].lower()))
    rel = "/" + posixpath.relpath(full, root) if full != root else "/"
    return {"path": rel, "entries": entries}


SEARCH_LIMIT = 500  # most matches returned
SEARCH_SECONDS = 20  # where the system has `timeout`; the search is stopped there after this long
_GLOB = str.maketrans({"\\": "\\\\", "*": "\\*", "?": "\\?", "[": "\\["})


def _entry(line: str, root: str) -> dict | None:
    """One line of `stat -c` output in list_dir's format as an entry (path relative to root)."""
    parts = line.split(SEP, 6)
    if len(parts) != 7:
        return None
    ftype, size, mtime, mode, user, group, name = parts
    name = posixpath.normpath(name)
    return {
        "name": posixpath.basename(name),
        "path": "/" + posixpath.relpath(name, root) if name != root else "/",
        "type": _TYPES.get(ftype, "other"),
        "size": int(size) if size.isdigit() else None,
        "mtime": int(mtime) if mtime.isdigit() else None,
        "mode": mode,
        "owner": f"{user}:{group}",
        "linkToDir": False,
    }


async def search_names(cid: str | None, root: str, path: str, query: str, run: Runner | None = None) -> dict:
    """Files and folders below `path` whose name contains `query` (any case), at most SEARCH_LIMIT.
    Never looks into /proc, /sys or /dev, doesn't follow symbolic links, and leaves out what the
    user running it may not read ("skipped" says that happened)."""
    full = confine(root, path)
    query = query.strip()
    if len(query) < 2 or len(query) > 100 or "/" in query or "\0" in query:
        raise FsError("Type at least two characters of the name (without /)")
    runner = run or (lambda cmd: _exec(cid, cmd))
    # find itself prints (so it stops when `head` has enough); its exit code goes to the last line.
    # 124 (GNU) and 143 (BusyBox) are `timeout`'s "took too long".
    script = (
        'P="$1"; [ -d "$P" ] || ' + _MISSING_OR_DENIED + '; [ -r "$P" ] && [ -x "$P" ] || { echo "permission denied" >&2; exit 3; }; '
        + _NEED_FIND_STAT
        + 'T=""; command -v timeout >/dev/null 2>&1 && T="timeout $4"; '
        # From "/" find prints "//proc", hence both spellings. Its complaints come along on the same
        # stream (they start with "find:", paths with "/"), which tells us when folders were skipped.
        '{ $T find "$P/" -mindepth 1 \\( -path /proc -o -path /sys -o -path /dev -o -path //proc -o -path //sys -o -path //dev \\) -prune -o -iname "$2" -print 2>&1; '
        'echo "@@EXIT@@$?"; } | head -n "$5"; true'
    )
    pattern = "*" + query.translate(_GLOB) + "*"
    out = await run_script(
        runner, script, full, pattern, "not a directory", str(SEARCH_SECONDS), str(SEARCH_LIMIT + 3), path=path, missing="not a directory", what="Searching"
    )
    found, timed_out, skipped, finished = [], False, False, False
    for line in out.decode(errors="replace").splitlines():
        if line.startswith("@@EXIT@@"):
            finished = True
            timed_out = line[len("@@EXIT@@") :].strip() in ("124", "143", "137")
        elif not line.startswith("/"):
            skipped = skipped or "Permission denied" in line
        else:
            found.append(posixpath.normpath("/" + line.lstrip("/")))
    truncated = len(found) > SEARCH_LIMIT or not finished
    found = found[:SEARCH_LIMIT]
    entries: list[dict] = []
    fmt = SEP.join(["%F", "%s", "%Y", "%A", "%U", "%G", "%n"])
    for i in range(0, len(found), 100):
        _code, stat_out, _err = await runner(["stat", "-c", fmt, "--", *found[i : i + 100]])
        entries += [e for e in (_entry(line, root) for line in stat_out.decode(errors="replace").splitlines()) if e]
    rel = "/" + posixpath.relpath(full, root) if full != root else "/"
    entries.sort(key=lambda e: (e["path"].count("/"), e["path"].lower()))
    return {"path": rel, "query": query, "entries": entries, "truncated": truncated, "timedOut": timed_out, "skipped": skipped}


async def read_preview(cid: str | None, root: str, path: str, run: Runner | None = None) -> dict:
    full = confine(root, path)
    # head stops early by design (more than the preview shows), so its own exit code is what counts.
    script = 'P="$1"; [ -f "$P" ] || ' + _MISSING_OR_DENIED + '; [ -r "$P" ] || { echo "permission denied" >&2; exit 3; }; stat -c %s "$P" && head -c "$2" "$P"'
    runner = run or (lambda cmd: _exec(cid, cmd))
    out = await run_script(runner, script, full, str(PREVIEW_LIMIT + 1), "not a regular file", path=path, missing="not a regular file", what="Reading the file")
    size_line, _, data = out.partition(b"\n")
    size = int(size_line) if size_line.strip().isdigit() else None
    truncated = len(data) > PREVIEW_LIMIT
    data = data[:PREVIEW_LIMIT]
    binary = b"\x00" in data[:8192]
    text = None
    if not binary:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as e:
            # A multibyte char cut at the preview limit is fine; anything else is binary.
            if truncated and e.start >= len(data) - 4:
                text = data[: e.start].decode("utf-8")
            else:
                binary = True
    return {"path": path, "size": size, "truncated": truncated, "binary": binary, "content": text}


async def file_size(cid: str, root: str, path: str, run: Runner | None = None) -> int:
    """Size of a regular file (for Content-Length, so a download that stops short shows as failed)."""
    full = confine(root, path)
    script = 'P="$1"; [ -f "$P" ] || ' + _MISSING_OR_DENIED + '; [ -r "$P" ] || { echo "permission denied" >&2; exit 3; }; stat -c %s "$P"'
    runner = run or (lambda cmd: _exec(cid, cmd))
    out = await run_script(runner, script, full, "", "not a regular file", path=path, missing="not a regular file", what="Reading the file's size")
    if not out.strip().isdigit():
        raise FsError("Couldn't read the file's size", 502)
    return int(out.strip())


async def stream_file(cid: str, root: str, path: str) -> AsyncIterator[bytes]:
    full = confine(root, path)
    c = get_docker().containers.container(cid)
    exe = await c.exec(["cat", full], stdout=True, stderr=False, stdin=False, tty=False)
    async with exe.start(detach=False) as stream:
        while True:
            msg = await stream.read_out()
            if msg is None:
                break
            yield msg.data


async def at_most(chunks: AsyncIterator[bytes], size: int) -> AsyncIterator[bytes]:
    """The first `size` bytes of a stream. A download announces the file's size (Content-Length) before
    reading it; a file that grows meanwhile (a log being written) would otherwise send more than
    announced, which fails the whole download. A file that turns out shorter still fails, as it should."""
    left = size
    async for chunk in chunks:
        if left <= 0:
            break
        yield chunk[:left]
        left -= len(chunk)


__all__ = ["FsError", "list_dir", "read_preview", "stream_file", "file_size", "at_most", "confine", "aiodocker"]
