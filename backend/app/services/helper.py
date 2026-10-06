"""Short-lived helper containers for volume contents.

Browsing uses one helper per volume with the volume mounted READ-ONLY at /v (alpine, no network).
Changes (upload, edit, new file/folder, delete) go through a separate helper that mounts the volume
writable, created only when the user changes something. Both are reused while in use, removed after
HELPER_IDLE_S of inactivity, on backend shutdown, and on startup (stale ones). Safety net if the
backend dies: helpers run `sleep 3600` with AutoRemove, so they delete themselves.
"""

import asyncio
import logging
import secrets
import time

import aiodocker

from app.services.docker_client import get_docker, query_json

log = logging.getLogger("pierside.helper")

HELPER_IMAGE = "alpine:3.20"
HELPER_LABEL = "com.pierside.helper"
HELPER_IDLE_S = 60
MOUNT = "/v"

_helpers: dict[tuple[str, bool], tuple[str, float]] = {}  # (volume, writable) -> (container id, last used)
_locks: dict[str, asyncio.Lock] = {}
_reaper: asyncio.Task | None = None


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
        "Labels": {HELPER_LABEL: "true", f"{HELPER_LABEL}.volume": volume, f"{HELPER_LABEL}.mode": "rw" if writable else "ro"},
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
            if now - last > HELPER_IDLE_S:
                _helpers.pop(key, None)
                await _remove(cid)


async def remove_all_helpers() -> None:
    """Remove every helper container we know of, plus any stale labelled ones."""
    _helpers.clear()
    try:
        stale = await query_json("containers/json", params={"all": "1", "filters": f'{{"label":["{HELPER_LABEL}=true"]}}'})
    except Exception:
        return
    await asyncio.gather(*(_remove(c["Id"]) for c in stale), return_exceptions=True)


async def release_volume(volume: str) -> None:
    """Drop the helpers for a volume (e.g. before deleting the volume)."""
    for writable in (False, True):
        entry = _helpers.pop((volume, writable), None)
        if entry:
            await _remove(entry[0])
