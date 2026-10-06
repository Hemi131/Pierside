"""Filesystem browsing through `docker exec` of busybox/coreutils tools (ls via find+stat, head, cat).

Used for volume helpers (and, later, running containers). All paths are normalised and confined to
`root` inside the target container.
"""

import posixpath
from collections.abc import AsyncIterator

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


async def list_dir(cid: str, root: str, path: str) -> dict:
    full = confine(root, path)
    # %F type | %s size | %Y mtime | %A mode | %U user | %G group | %n name (last: may contain SEP-free '|')
    fmt = SEP.join(["%F", "%s", "%Y", "%A", "%U", "%G", "%n"])
    # "$P/" (trailing slash) makes find follow the start path when it is a symlink to a directory.
    script = (
        'P="$1"; [ -d "$P" ] || { echo "not a directory" >&2; exit 2; }; '
        'find "$P/" -mindepth 1 -maxdepth 1 -exec stat -c "$2" {} + 2>/dev/null; '
        # For symlinks, report whether the target is a directory (so the UI can navigate into it).
        'find "$P/" -mindepth 1 -maxdepth 1 -type l -exec sh -c \'for l; do [ -d "$l" ] && echo "@@LINKDIR@@$l"; done\' _ {} + 2>/dev/null; true'
    )
    code, out, err = await _exec(cid, ["sh", "-c", script, "sh", full, fmt])
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


async def read_preview(cid: str, root: str, path: str) -> dict:
    full = confine(root, path)
    script = 'F="$1"; [ -f "$F" ] || { echo "not a regular file" >&2; exit 2; }; stat -c %s "$F"; head -c "$2" "$F"'
    code, out, err = await _exec(cid, ["sh", "-c", script, "sh", full, str(PREVIEW_LIMIT + 1)])
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
