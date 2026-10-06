"""Safe container start: host-port conflicts are reported before Docker is asked to start.

Why not just call start and parse the error: when dockerd (seen on 29.x) fails a start with "port is
already allocated", it also drops the container's endpoint on its primary network. Every later start
then "succeeds" without that network, so the ports aren't published and the container loses its DNS
name on that network, silently. So:
  * conflicts with ports other containers publish are detected up front (409 + `portConflict`), and
    the container is never started into the failure;
  * before every start, a primary network that went missing is reconnected (with the compose service
    alias), which also repairs containers damaged earlier (e.g. by `docker compose up`).
Conflicts with non-container processes can only be seen in the start error; that is still reported.
"""

import logging
import re

import aiodocker
from fastapi import HTTPException

from app.services.containers import PROJECT_LABEL, SERVICE_LABEL
from app.services.docker_client import query_json

log = logging.getLogger("pierside.start")

# dockerd: "Bind for 0.0.0.0:8088 failed: port is already allocated" (another container),
# "listen tcp4 0.0.0.0:8088: bind: address already in use" (some other process on the host).
_ALLOCATED_RE = re.compile(r"Bind for \[?[0-9a-fA-F.:]*\]?:(\d+) failed: port is already allocated")
_IN_USE_RE = re.compile(r"listen (?:tcp|udp)[46]? \[?[0-9a-fA-F.:]*\]?:(\d+): bind: address already in use")
_ANY_IP = ("", "0.0.0.0", "::")


def docker_message(e: aiodocker.DockerError) -> str:
    return (e.message.get("message") if isinstance(e.message, dict) else str(e.message)) or ""


def _cname(c: dict) -> str:
    return (c.get("Names") or ["/"])[0].lstrip("/")


def _holder(c: dict) -> dict:
    return {"id": c["Id"], "name": _cname(c), "project": (c.get("Labels") or {}).get(PROJECT_LABEL)}


def describe_conflict(conflict: dict) -> str:
    holder = conflict["holder"]
    who = f'container "{holder["name"]}"' if holder else "another program on the host"
    return f"Port {conflict['port']} is already in use by {who}."


def _conflict_error(conflict: dict) -> HTTPException:
    return HTTPException(409, {"message": describe_conflict(conflict), "portConflict": conflict})


async def find_port_conflict(message: str, exclude_id: str | None = None) -> dict | None:
    """{"port", "holder": {id, name, project} | None} if a start error `message` is a host-port conflict."""
    m = _ALLOCATED_RE.search(message) or _IN_USE_RE.search(message)
    if not m:
        return None
    port = int(m.group(1))
    holder = None
    try:
        for c in await query_json("containers/json"):  # running containers only
            if c["Id"] != exclude_id and any(p.get("PublicPort") == port for p in c.get("Ports") or []):
                holder = _holder(c)
                break
    except Exception:
        pass
    return {"port": port, "holder": holder}


def _wanted_ports(info: dict) -> list[tuple[int, str, str]]:
    """Fixed host ports the container publishes: (port, proto, host ip)."""
    out = []
    for key, binds in ((info.get("HostConfig") or {}).get("PortBindings") or {}).items():
        proto = key.split("/", 1)[1] if "/" in key else "tcp"
        for b in binds or []:
            hp = (b.get("HostPort") or "").strip()
            if hp.isdigit() and int(hp) > 0:  # "" = Docker picks one; ranges are left to Docker
                out.append((int(hp), proto, b.get("HostIp") or ""))
    return out


async def _precheck_ports(info: dict) -> None:
    wanted = _wanted_ports(info)
    if not wanted:
        return
    running = await query_json("containers/json")
    for port, proto, ip in wanted:
        for c in running:
            if c["Id"] == info["Id"]:
                continue
            for p in c.get("Ports") or []:
                if p.get("PublicPort") != port or (p.get("Type") or "tcp") != proto:
                    continue
                other_ip = p.get("IP") or ""
                if ip in _ANY_IP or other_ip in _ANY_IP or ip == other_ip:
                    name = (info.get("Name") or "").lstrip("/")
                    raise _conflict_error({"port": port, "holder": _holder(c), "container": {"id": info["Id"], "name": name}})


async def _repair_primary_network(info: dict) -> None:
    mode = (info.get("HostConfig") or {}).get("NetworkMode") or "default"
    if mode in ("host", "none") or mode.startswith("container:"):
        return
    net = "bridge" if mode == "default" else mode
    attached = ((info.get("NetworkSettings") or {}).get("Networks") or {}).keys()
    if net in attached:
        return
    labels = (info.get("Config") or {}).get("Labels") or {}
    endpoint = {"Aliases": [labels[SERVICE_LABEL]]} if labels.get(SERVICE_LABEL) and net != "bridge" else {}
    name = (info.get("Name") or "").lstrip("/")
    log.warning("container %s lost its network %s (failed earlier start?); reconnecting", name, net)
    try:
        await query_json(f"networks/{net}/connect", method="POST", data={"Container": info["Id"], "EndpointConfig": endpoint})
    except Exception as e:
        log.warning("reconnecting %s to %s failed: %s", name, net, e)


async def safe_start(cid: str, action: str = "start") -> None:
    """start / restart with the port pre-check and network repair (see module docstring)."""
    info = await query_json(f"containers/{cid}/json")
    if not (info.get("State") or {}).get("Running"):
        await _precheck_ports(info)
        await _repair_primary_network(info)
    try:
        await query_json(f"containers/{cid}/{action}", method="POST")
    except aiodocker.DockerError as e:
        conflict = await find_port_conflict(docker_message(e), exclude_id=info["Id"])
        if conflict is None:
            raise
        conflict["container"] = {"id": info["Id"], "name": (info.get("Name") or "").lstrip("/")}
        raise _conflict_error(conflict) from e
