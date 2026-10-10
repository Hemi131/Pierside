"""Disk usage of the active SSH engine's server ("Server disk").

Two cheap pieces instead of one scan of the whole disk:
  * the filesystems with their used and free space (`df`, immediate);
  * the size of ONE folder at a time (`du -s`), asked for by the UI for each child of the folder the
    user is looking at, so the list fills in row by row and nothing runs that the user didn't open.

Measuring is read-only, stays on the folder's own filesystem (`-x`), runs at the lowest CPU and disk
priority, is stopped after SIZE_SECONDS, and at most MAX_PARALLEL run at once. It runs as the SSH
user; where that user can't read everything, and the user allowed Docker for this server (the same
answer as for Server files, see hostfs.py), the folder is measured through a read-only helper
container instead, as root.
"""

import asyncio
import logging
import shlex
import time

from app.services import fsbrowse, hostfs
from app.services.engines import engines
from app.services.fsbrowse import FsError
from app.services.helper import _remove

log = logging.getLogger("pierside.hostdisk")

SIZE_SECONDS = 120
MAX_PARALLEL = 2
# Not real storage, or not the server's own: left out of the overview.
_PSEUDO_TYPES = {"tmpfs", "devtmpfs", "squashfs", "proc", "sysfs", "efivarfs", "cgroup", "cgroup2", "devpts", "mqueue", "shm", "nsfs", "tracefs", "debugfs", "securityfs", "ramfs", "iso9660"}
_PSEUDO_MOUNTS = ("/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/docker/", "/var/lib/containers/", "/var/lib/kubelet/", "/boot/efi", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts")

_slots = asyncio.Semaphore(MAX_PARALLEL)
_running: set = set()  # SSH processes measuring right now
_generation = 0  # raised by cancel(): measurements queued before it give up


async def filesystems() -> list[dict]:
    """The server's real filesystems: device, type, mount point, size / used / free in bytes."""
    code, out, _err = await hostfs.ssh_run(["sh", "-c", "df -P -k -T 2>/dev/null || df -P -k"])
    if code != 0 and not out:
        raise FsError("Couldn't read the server's filesystems (df failed)", 502)
    rows: dict[str, dict] = {}
    for line in out.decode("utf-8", "replace").splitlines()[1:]:
        parts = line.split()
        # With -T: device type blocks used available capacity mount…  Without: no type column.
        typed = len(parts) >= 7 and not parts[1].isdigit()
        if len(parts) < (7 if typed else 6):
            continue
        device, fstype = parts[0], (parts[1] if typed else "")
        numbers = parts[2:5] if typed else parts[1:4]
        mount = " ".join(parts[6:] if typed else parts[5:])
        if not all(n.isdigit() for n in numbers) or int(numbers[0]) == 0:
            continue
        if fstype in _PSEUDO_TYPES or device in ("tmpfs", "devtmpfs", "none", "shm", "udev") or any(mount.startswith(p) if p.endswith("/") else (mount == p or mount.startswith(p + "/")) for p in _PSEUDO_MOUNTS):
            continue
        size, used, free = (int(n) * 1024 for n in numbers)
        row = {"device": device, "type": fstype, "mount": mount, "size": size, "used": used, "free": free, "percent": round(used * 100 / (used + free), 1) if used + free else 0}
        # One device mounted in several places (bind mounts): keep the shortest mount point.
        known = rows.get(device)
        if known is None or len(mount) < len(known["mount"]):
            rows[device] = row
    return sorted(rows.values(), key=lambda r: r["mount"])


# Lowest priorities and a time limit, with whatever of nice / ionice / timeout the system has.
_DU = (
    'N=""; command -v nice >/dev/null 2>&1 && N="nice -n 19"; I=""; command -v ionice >/dev/null 2>&1 && I="ionice -c3"; '
    'T=""; command -v timeout >/dev/null 2>&1 && T="timeout $2"; $T $N $I du -sxk -- "$1" 2>&1; echo "@@EXIT@@$?"'
)


def _parse(text: str) -> tuple[int | None, bool, bool]:
    """du's output -> (bytes or None, some of it couldn't be read, it was stopped at the time limit)."""
    total, unreadable, timed_out = None, False, False
    for line in text.splitlines():
        if line.startswith("@@EXIT@@"):
            timed_out = line[len("@@EXIT@@") :].strip() in ("124", "143", "137")
        elif "\t" in line and line.split("\t", 1)[0].isdigit():
            total = int(line.split("\t", 1)[0]) * 1024
        elif "Permission denied" in line or "cannot read" in line or "cannot access" in line:
            unreadable = True
    return total, unreadable, timed_out


async def _du_ssh(path: str) -> str:
    conn = await engines.tunnel._connection()
    proc = await conn.create_process(shlex.join(["sh", "-c", _DU, "sh", path, str(SIZE_SECONDS)]), encoding="utf-8", errors="replace")
    _running.add(proc)
    try:
        out, _err = await asyncio.wait_for(proc.communicate(), SIZE_SECONDS + 15)
        return out or ""
    except asyncio.TimeoutError:
        proc.terminate()
        return "@@EXIT@@124"
    finally:
        _running.discard(proc)


async def size(path: str) -> dict:
    """How much disk space one folder (or file) takes, in bytes."""
    path = hostfs._norm(path)
    hostfs.engine_id()
    generation = _generation
    started = time.monotonic()
    async with _slots:
        if generation != _generation:
            raise FsError("Stopped", 409)
        total, unreadable, timed_out = _parse(await _du_ssh(path))
        result = {"path": path, "bytes": total, "partial": unreadable or timed_out, "timedOut": timed_out, "via": "ssh", "needsConsent": False}
        if unreadable and not timed_out and generation == _generation:
            allowed = hostfs.consent()
            if allowed is None:
                result["needsConsent"] = True
            elif allowed and not await hostfs.docker_problem():
                try:
                    cid, mounted = await hostfs._helper(path, False)
                except FsError:
                    cid = None  # a folder Pierside doesn't mount (/, /proc, …): keep the user's own figure
                if cid:
                    inner = fsbrowse.confine(hostfs.MOUNT, hostfs._inside(mounted, path))
                    _code, out, _err = await fsbrowse.run_in(cid, ["sh", "-c", _DU, "sh", inner, str(SIZE_SECONDS)])
                    total2, unreadable2, timed_out2 = _parse(out.decode("utf-8", "replace"))
                    if total2 is not None:
                        result.update(bytes=total2, partial=unreadable2 or timed_out2, timedOut=timed_out2, via="docker")
        result["seconds"] = round(time.monotonic() - started, 1)
        return result


async def cancel() -> None:
    """Stop what is being measured, and what is waiting for its turn."""
    global _generation
    _generation += 1
    for proc in list(_running):
        try:
            proc.terminate()
        except Exception as e:  # already gone
            log.debug("couldn't stop a measurement: %s", e)
    # Measurements inside helpers end with their container.
    for key, (cid, _last) in list(hostfs._helpers.items()):
        if key[0] == engines.active_id and not key[2]:
            hostfs._helpers.pop(key, None)
            await _remove(cid)
