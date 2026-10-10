"""Filesystem browsing through `docker exec` of busybox/coreutils tools (ls via find+stat, head, cat).

Used for volume helpers and running containers, and (with `run` = a command over SSH) for files on an
SSH engine's server. All paths are normalised and confined to `root` inside the target container.
Exit code 3 from the scripts means "permission denied" (raised as FsError 403), which only happens
when they don't run as root: the server-files feature then retries through a helper container.
"""

import posixpath
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


async def _exec(cid: str, cmd: list[str]) -> tuple[int, bytes, bytes]:
    c = get_docker().containers.container(cid)
    exe = await c.exec(cmd, stdout=True, stderr=True, stdin=False, tty=False)
    out, err = b"", b""
    async with exe.start(detach=False) as stream:
        while True:
            msg = await stream.read_out()
            if msg is None:
                break
            if msg.stream == 2:
                err += msg.data
            else:
                out += msg.data
    code = (await exe.inspect()).get("ExitCode") or 0
    return code, out, err


run_in = _exec  # used by fswrite (rm, stat)

Runner = Callable[[list[str]], Awaitable[tuple[int, bytes, bytes]]]
DENIED = 3  # the scripts' exit code for "no permission"
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
        'find "$P/" -mindepth 1 -maxdepth 1 -exec stat -c "$2" {} + 2>/dev/null; '
        # For symlinks, report whether the target is a directory (so the UI can navigate into it).
        'find "$P/" -mindepth 1 -maxdepth 1 -type l -exec sh -c \'for l; do [ -d "$l" ] && echo "@@LINKDIR@@$l"; done\' _ {} + 2>/dev/null; true'
    )
    code, out, err = await (run or (lambda cmd: _exec(cid, cmd)))(["sh", "-c", script, "sh", full, fmt, "not a directory"])
    if code == DENIED:
        raise denied(path)
    if code == 2:
        raise FsError(err.decode(errors="replace").strip() or "Not a directory", 404)
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
        'T=""; command -v timeout >/dev/null 2>&1 && T="timeout $4"; '
        # From "/" find prints "//proc", hence both spellings. Its complaints come along on the same
        # stream (they start with "find:", paths with "/"), which tells us when folders were skipped.
        '{ $T find "$P/" -mindepth 1 \\( -path /proc -o -path /sys -o -path /dev -o -path //proc -o -path //sys -o -path //dev \\) -prune -o -iname "$2" -print 2>&1; '
        'echo "@@EXIT@@$?"; } | head -n "$5"'
    )
    pattern = "*" + query.translate(_GLOB) + "*"
    code, out, err = await runner(["sh", "-c", script, "sh", full, pattern, "not a directory", str(SEARCH_SECONDS), str(SEARCH_LIMIT + 3)])
    if code == DENIED:
        raise denied(path)
    if code == 2:
        raise FsError(err.decode(errors="replace").strip() or "Not a directory", 404)
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
    script = 'P="$1"; [ -f "$P" ] || ' + _MISSING_OR_DENIED + '; [ -r "$P" ] || { echo "permission denied" >&2; exit 3; }; stat -c %s "$P"; head -c "$2" "$P"'
    code, out, err = await (run or (lambda cmd: _exec(cid, cmd)))(["sh", "-c", script, "sh", full, str(PREVIEW_LIMIT + 1), "not a regular file"])
    if code == DENIED:
        raise denied(path)
    if code == 2:
        raise FsError(err.decode(errors="replace").strip() or "Not a file", 404)
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


__all__ = ["FsError", "list_dir", "read_preview", "stream_file", "confine", "aiodocker"]
