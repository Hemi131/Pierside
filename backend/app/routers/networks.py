"""Networks: list with member containers, inspect, create, delete, prune, connect / disconnect."""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import containers as containers_svc
from app.services.containers import PROJECT_LABEL
from app.services.docker_client import query_json

router = APIRouter(prefix="/networks", tags=["networks"])

# Created by the engine itself; can't be removed.
BUILTIN = {"bridge", "host", "none", "docker_gwbridge", "ingress"}


async def _members() -> dict[str, list[dict]]:
    """network id -> containers attached to it (running or not)."""
    members: dict[str, list[dict]] = {}
    for c in await query_json("containers/json", params={"all": "1"}):
        labels = c.get("Labels") or {}
        for net_name, ep in ((c.get("NetworkSettings") or {}).get("Networks") or {}).items():
            nid = ep.get("NetworkID")
            if not nid:
                continue
            members.setdefault(nid, []).append(
                {
                    "id": c["Id"],
                    "name": (c.get("Names") or ["/"])[0].lstrip("/"),
                    "state": c.get("State"),
                    "project": labels.get(PROJECT_LABEL),
                    "ipv4": ep.get("IPAddress") or None,
                    "ipv6": ep.get("GlobalIPv6Address") or None,
                    "mac": ep.get("MacAddress") or None,
                    "aliases": [],  # the list API doesn't carry them; filled in for the detail view
                }
            )
    return members


def _normalise(n: dict, members: list[dict]) -> dict:
    labels = n.get("Labels") or {}
    ipam = (n.get("IPAM") or {}).get("Config") or []
    return {
        "id": n["Id"],
        "name": n["Name"],
        "driver": n.get("Driver"),
        "scope": n.get("Scope"),
        "internal": bool(n.get("Internal")),
        "attachable": bool(n.get("Attachable")),
        "ingress": bool(n.get("Ingress")),
        "ipv6": bool(n.get("EnableIPv6")),
        "created": n.get("Created"),
        "subnets": [c.get("Subnet") for c in ipam if c.get("Subnet")],
        "gateways": [c.get("Gateway") for c in ipam if c.get("Gateway")],
        "labels": labels,
        "project": labels.get(PROJECT_LABEL),
        "builtin": n["Name"] in BUILTIN,
        "containers": members,
    }


@router.get("")
async def list_networks():
    nets, members = await asyncio.gather(query_json("networks"), _members())
    return [_normalise(n, members.get(n["Id"], [])) for n in nets]


async def _fill_aliases(net_name: str, members: list[dict]) -> None:
    async def one(m: dict) -> None:
        try:
            info = await query_json(f"containers/{m['id']}/json")
        except Exception:
            return
        ep = ((info.get("NetworkSettings") or {}).get("Networks") or {}).get(net_name) or {}
        m["aliases"] = [a for a in ep.get("Aliases") or [] if a != m["id"][:12]]

    await asyncio.gather(*(one(m) for m in members))


@router.get("/{nid}")
async def inspect_network(nid: str):
    raw, members = await asyncio.gather(query_json(f"networks/{nid}"), _members())
    own = members.get(raw["Id"], [])
    await _fill_aliases(raw["Name"], own)
    return {"network": _normalise(raw, own), "inspect": raw}


class CreateNetwork(BaseModel):
    name: str
    driver: str = "bridge"
    subnet: str = ""
    gateway: str = ""
    internal: bool = False
    attachable: bool = False
    ipv6: bool = False


@router.post("")
async def create_network(body: CreateNetwork):
    if not body.name.strip():
        raise HTTPException(400, "A network name is required")
    config: dict = {
        "Name": body.name.strip(),
        "Driver": body.driver or "bridge",
        "Internal": body.internal,
        "Attachable": body.attachable,
        "EnableIPv6": body.ipv6,
        "CheckDuplicate": True,
    }
    if body.subnet.strip():
        pool = {"Subnet": body.subnet.strip()}
        if body.gateway.strip():
            pool["Gateway"] = body.gateway.strip()
        config["IPAM"] = {"Driver": "default", "Config": [pool]}
    return await query_json("networks/create", method="POST", data=config)


@router.post("/prune")
async def prune_networks():
    res = await query_json("networks/prune", method="POST")
    return {"deleted": res.get("NetworksDeleted") or []}


@router.delete("/{nid}")
async def delete_network(nid: str):
    await query_json(f"networks/{nid}", method="DELETE")
    return {"ok": True}


class Connect(BaseModel):
    container: str
    aliases: list[str] = []
    ipv4: str = ""


@router.post("/{nid}/connect")
async def connect_container(nid: str, body: Connect):
    endpoint: dict = {}
    aliases = [a.strip() for a in body.aliases if a.strip()]
    if aliases:
        endpoint["Aliases"] = aliases
    if body.ipv4.strip():
        endpoint["IPAMConfig"] = {"IPv4Address": body.ipv4.strip()}
    await query_json(f"networks/{nid}/connect", method="POST", data={"Container": body.container, "EndpointConfig": endpoint})
    containers_svc.invalidate(body.container)
    return {"ok": True}


class Disconnect(BaseModel):
    container: str
    force: bool = False


@router.post("/{nid}/disconnect")
async def disconnect_container(nid: str, body: Disconnect):
    await query_json(f"networks/{nid}/disconnect", method="POST", data={"Container": body.container, "Force": body.force})
    containers_svc.invalidate(body.container)
    return {"ok": True}
