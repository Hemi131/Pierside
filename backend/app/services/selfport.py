"""Find the host port Docker published for this container's TCP listener (see config.public_port)."""

import logging
import socket

import aiodocker

from app.config import TCP_PORT, public_port, set_public_port
from app.services.engines import LOCAL_URL

log = logging.getLogger("pierside.selfport")


async def discover_public_port() -> None:
    if public_port():
        return  # pinned via PIERSIDE_PUBLIC_WS_PORT
    # Always the local engine (this container runs there), whatever engine the UI has selected.
    try:
        async with aiodocker.Docker(url=LOCAL_URL) as docker:
            info = await docker._query_json(f"containers/{socket.gethostname()}/json")
    except Exception as e:
        log.error("can't inspect own container to find the published port: %s", e)
        return
    bindings = (info.get("NetworkSettings") or {}).get("Ports") or {}
    for b in bindings.get(f"{TCP_PORT}/tcp") or []:
        if b.get("HostPort"):
            set_public_port(int(b["HostPort"]))
            log.info("TCP listener published on host port %s", b["HostPort"])
            return
    log.error("port %s/tcp isn't published; WebSockets won't work (live updates fall back to polling)", TCP_PORT)
