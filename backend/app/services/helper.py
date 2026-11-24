"""Short-lived helper containers for volume contents.

Browsing uses one helper per volume with the volume mounted READ-ONLY at /v (alpine, no network).
Changes (upload, edit, new file/folder, delete) go through a separate helper that mounts the volume
writable, created only when the user changes something. Both are reused while in use, removed after
HELPER_IDLE_S of inactivity, on backend shutdown, and on startup (stale ones). Safety net if the
backend dies: helpers run `sleep 3600` with AutoRemove, so they delete themselves.

Every helper that clean-up may remove (label `com.pierside.helper=true`, here and in hostfs, hostperf,
the debug and root shells) carries its install's id (`helper_labels`), and clean-up removes only this
install's helpers and unlabelled ones from before owner labels. Another install on the same engine (a
local build next to the published image, or another computer using the same SSH server) keeps its own,
even while they are in use; it removes them itself, and their `sleep` is the backstop.
"""

import asyncio
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager

import aiodocker

from app.services.docker_client import get_docker, query_json
from app.services.engines import DATA_DIR
from app.services.store import keep_unreadable, write_json

log = logging.getLogger("pierside.helper")

HELPER_IMAGE = "alpine:3.20"
HELPER_LABEL = "com.pierside.helper"
OWNER_LABEL = f"{HELPER_LABEL}.owner"  # the install that made the helper (install_id)
INSTALL_FILE = os.path.join(DATA_DIR, "install.json")  # /data is per install (each has its own volume)
HELPER_IDLE_S = 60
MOUNT = "/v"

_helpers: dict[tuple[str, bool], tuple[str, float]] = {}  # (volume, writable) -> (container id, last used)
_locks: dict[str, asyncio.Lock] = {}
_reaper: asyncio.Task | None = None
# Helpers in use by a request that outlives helper_for() (a download, an upload, a measurement):
# container id -> what holds it. The reapers (here and in hostfs.py) leave them alone meanwhile.
_leases: dict[str, list[str]] = {}
_install_id: str | None = None


def install_id() -> str:
    """This install's id, kept in /data so that it stays the same across restarts and updates."""
    global _install_id
    if _install_id is None:
        try:
            with open(INSTALL_FILE, encoding="utf-8") as f:
                value = json.load(f)["id"]
            if not isinstance(value, str) or not value:
                raise ValueError("no id in it")
            _install_id = value
        except FileNotFoundError:
            _install_id = _new_install_id()
        except (OSError, ValueError, KeyError, TypeError) as e:
            keep_unreadable(INSTALL_FILE, e)
            _install_id = _new_install_id()
    return _install_id


def _new_install_id() -> str:
    value = secrets.token_hex(8)
    try:
        write_json(INSTALL_FILE, {"id": value})
    except OSError as e:
        # Kept for this run only: after a restart this run's helpers look like another install's and
        # end by their own `sleep`.
        log.warning("can't keep this install's id in %s: %s", INSTALL_FILE, e)
    return value


def helper_labels(**extra: str) -> dict:
    """The labels of a helper that clean-up may remove: helper, owner (this install), and `extra`."""
    return {HELPER_LABEL: "true", OWNER_LABEL: install_id(), **extra}


def _ours(labels: dict | None) -> bool:
    """Whether clean-up may remove a helper: this install's, or one made before helpers had an owner."""
    owner = (labels or {}).get(OWNER_LABEL)
    return owner is None or owner == install_id()


def busy(cid: str, kind: str | None = None) -> bool:
    """Whether a request is using this helper (of the given kind, if given)."""
    held = _leases.get(cid) or []
    return bool(held) if kind is None else kind in held


def only_held_by(cid: str, kind: str) -> bool:
    held = _leases.get(cid) or []
    return bool(held) and all(k == kind for k in held)


@asynccontextmanager
async def lease(cid: str, kind: str = "transfer"):
    """Keep a helper while a long request uses it."""
    _leases.setdefault(cid, []).append(kind)
    try:
        yield cid
    finally:
        held = _leases.get(cid) or []
        if kind in held:
            held.remove(kind)
        if not held:
            _leases.pop(cid, None)
        _touch(cid)


def _touch(cid: str) -> None:
    """Restart the idle clock of a helper (its last request just ended)."""
    for key, (known, _last) in list(_helpers.items()):
        if known == cid:
            _helpers[key] = (cid, time.monotonic())


async def leased_stream(cid: str, chunks):
    """Yield from `chunks` while holding the helper."""
    async with lease(cid):
        async for chunk in chunks:
            yield chunk


async def _ensure_image() -> None:
    try:
        await query_json(f"images/{HELPER_IMAGE}/json")
    except aiodocker.DockerError as e:
        if e.status != 404:
            raise
        log.info("pulling %s", HELPER_IMAGE)
        await get_docker().images.pull(HELPER_IMAGE)


async def _create(volume: str, writable: bool) -> str:
    await _ensure_image()
    name = f"pierside-helper-{secrets.token_hex(4)}"
    config = {
        "Image": HELPER_IMAGE,
        "Cmd": ["sleep", "3600"],
        "Labels": helper_labels(**{f"{HELPER_LABEL}.volume": volume, f"{HELPER_LABEL}.mode": "rw" if writable else "ro"}),
        "NetworkDisabled": True,
        "HostConfig": {
            "AutoRemove": True,
            "NetworkMode": "none",
            "Mounts": [{"Type": "volume", "Source": volume, "Target": MOUNT, "ReadOnly": not writable}],
        },
    }
    c = await get_docker().containers.create(config, name=name)
    await c.start()
    return c.id


async def helper_for(volume: str, writable: bool = False) -> str:
    """Return a running helper container id for the volume (creating one if needed).
    Read-only unless `writable` (only for changing the volume's contents)."""
    _start_reaper()
    key = (volume, writable)
    lock = _locks.setdefault(f"{volume}\0{writable}", asyncio.Lock())
    async with lock:
        entry = _helpers.get(key)
        if entry:
            try:
                info = await query_json(f"containers/{entry[0]}/json")
                if (info.get("State") or {}).get("Running"):
                    _helpers[key] = (entry[0], time.monotonic())
                    return entry[0]
            except aiodocker.DockerError:
                pass
        cid = await _create(volume, writable)
        _helpers[key] = (cid, time.monotonic())
        return cid


async def _remove(cid: str) -> None:
    try:
        await query_json(f"containers/{cid}", method="DELETE", params={"force": "true"})
    except aiodocker.DockerError as e:
        if e.status not in (404, 409):
            log.warning("failed to remove helper %s: %s", cid[:12], e)


def _start_reaper() -> None:
    global _reaper
    if _reaper is None or _reaper.done():
        _reaper = asyncio.create_task(_reap_loop(), name="helper-reaper")


async def _reap_loop() -> None:
    while _helpers:
        await asyncio.sleep(10)
        now = time.monotonic()
        for key, (cid, last) in list(_helpers.items()):
            if busy(cid):
                _helpers[key] = (cid, now)  # in use: its idle time starts when the request ends
            elif now - last > HELPER_IDLE_S:
                _helpers.pop(key, None)
                await _remove(cid)


def forget_helpers() -> None:
    """After an engine switch: the volume helpers known belong to the engine left."""
    _helpers.clear()


async def remove_all_helpers() -> None:
    """Remove every helper container of this install on the active engine (see the module's docstring)."""
    _helpers.clear()
    try:
        stale = await query_json("containers/json", params={"all": "1", "filters": f'{{"label":["{HELPER_LABEL}=true"]}}'})
    except Exception:
        return
    await asyncio.gather(*(_remove(c["Id"]) for c in stale if _ours(c.get("Labels"))), return_exceptions=True)


async def remove_idle_volume_helpers() -> None:
    """Before a volume prune: the volume browser's helpers keep volumes "in use". Remove those that are
    idle, but not one serving a download or upload right now, nor any other helper (Server files and
    disk, debug shells, AI access, port forwards), which may be in use too."""
    for key, (cid, _last) in list(_helpers.items()):
        if not busy(cid):
            _helpers.pop(key, None)
    try:
        found = await query_json("containers/json", params={"all": "1", "filters": f'{{"label":["{HELPER_LABEL}=true"]}}'})
    except Exception:
        return
    idle = [c["Id"] for c in found if f"{HELPER_LABEL}.volume" in (c.get("Labels") or {}) and _ours(c.get("Labels")) and not busy(c["Id"])]
    await asyncio.gather(*(_remove(cid) for cid in idle), return_exceptions=True)


async def release_volume(volume: str) -> None:
    """Drop the helpers for a volume (e.g. before deleting the volume)."""
    for writable in (False, True):
        entry = _helpers.pop((volume, writable), None)
        if entry:
            await _remove(entry[0])
