"""Swarm: init/leave, services, stacks, tasks, nodes, secrets, configs."""

import asyncio
import json
from typing import Literal

import aiodocker
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.docker_client import query_json
from app.services.swarm import STACK_LABEL, node_names, normalise_service, normalise_task, pick_advertise_addr, swarm_state

router = APIRouter(prefix="/swarm", tags=["swarm"])


def _msg(e: aiodocker.DockerError) -> str:
    return (e.message.get("message") if isinstance(e.message, dict) else str(e.message)) or ""


async def _require_manager() -> None:
    st = await swarm_state()
    if not st["active"]:
        raise HTTPException(409, "Swarm mode is not active on this engine")
    if not st["isManager"]:
        raise HTTPException(409, "This node is not a swarm manager")


@router.get("")
async def get_swarm():
    return await swarm_state()


class InitBody(BaseModel):
    advertiseAddr: str = ""


@router.post("/init")
async def init_swarm(body: InitBody):
    data = {"ListenAddr": "0.0.0.0:2377", "AdvertiseAddr": body.advertiseAddr}
    try:
        await query_json("swarm/init", method="POST", data=data)
    except aiodocker.DockerError as e:
        addr = pick_advertise_addr(_msg(e)) if not body.advertiseAddr else None
        if not addr:
            raise
        # Rancher's VM has several interfaces; retry with the one Docker listed on eth0.
        await query_json("swarm/init", method="POST", data={**data, "AdvertiseAddr": addr})
    return await swarm_state()


@router.post("/leave")
async def leave_swarm(force: bool = False):
    await query_json("swarm/leave", method="POST", params={"force": str(force).lower()})
    return await swarm_state()


# ---- services --------------------------------------------------------------------------------


@router.get("/services")
async def list_services():
    await _require_manager()
    services = await query_json("services", params={"status": "true"})
    return sorted((normalise_service(s) for s in services), key=lambda s: s["name"] or "")


async def _service(sid: str) -> dict:
    return await query_json(f"services/{sid}", params={"insertDefaults": "false"})


async def _tasks(filters: dict) -> list[dict]:
    tasks, nodes = await asyncio.gather(query_json("tasks", params={"filters": json.dumps(filters)}), node_names())
    out = [normalise_task(t, nodes) for t in tasks]
    # Newest first within each slot, like `docker service ps`.
    out.sort(key=lambda t: (t["slot"] or 0, t["createdAt"] or ""), reverse=False)
    return out


@router.get("/services/{sid}")
async def service_details(sid: str):
    await _require_manager()
    raw, tasks = await asyncio.gather(_service(sid), _tasks({"service": [sid]}))
    services = await query_json("services", params={"status": "true", "filters": json.dumps({"id": [raw["ID"]]})})
    svc = normalise_service(services[0] if services else raw)
    return {"service": svc, "tasks": tasks, "inspect": raw}


async def _update(sid: str, mutate=None, params: dict | None = None) -> dict:
    raw = await _service(sid)
    spec = raw["Spec"]
    if mutate:
        mutate(spec)
    version = raw["Version"]["Index"]
    return await query_json(f"services/{raw['ID']}/update", method="POST", params={"version": str(version), **(params or {})}, data=spec)


class ScaleBody(BaseModel):
    replicas: int


@router.post("/services/{sid}/scale")
async def scale_service(sid: str, body: ScaleBody):
    if body.replicas < 0:
        raise HTTPException(400, "Replicas must be >= 0")

    def mutate(spec):
        mode = spec.get("Mode") or {}
        if "Replicated" not in mode:
            raise HTTPException(400, "Only replicated services can be scaled")
        mode["Replicated"]["Replicas"] = body.replicas

    return await _update(sid, mutate)


@router.post("/services/{sid}/restart")
async def restart_service(sid: str):
    """Like `docker service update --force`: recreate all tasks with the same spec."""

    def mutate(spec):
        tt = spec.setdefault("TaskTemplate", {})
        tt["ForceUpdate"] = int(tt.get("ForceUpdate", 0)) + 1

    return await _update(sid, mutate)


@router.post("/services/{sid}/rollback")
async def rollback_service(sid: str):
    raw = await _service(sid)
    if not raw.get("PreviousSpec"):
        raise HTTPException(409, "This service has no previous version to roll back to")
    return await _update(sid, params={"rollback": "previous"})


@router.delete("/services/{sid}")
async def delete_service(sid: str):
    await query_json(f"services/{sid}", method="DELETE")
    return {"ok": True}


# ---- stacks ----------------------------------------------------------------------------------


@router.get("/stacks")
async def list_stacks():
    services = await list_services()
    stacks: dict[str, dict] = {}
    for s in services:
        if not s["stack"]:
            continue
        st = stacks.setdefault(s["stack"], {"name": s["stack"], "services": 0, "running": 0, "desired": 0, "createdAt": s["createdAt"], "updating": False})
        st["services"] += 1
        st["running"] += s["running"] or 0
        st["desired"] += s["desired"] or 0
        st["createdAt"] = min(st["createdAt"] or s["createdAt"], s["createdAt"] or "")
        st["updating"] = st["updating"] or (s["update"] or {}).get("state") in ("updating", "rollback_started")
    return sorted(stacks.values(), key=lambda s: s["name"])


@router.get("/stacks/{name}")
async def stack_details(name: str):
    services = [s for s in await list_services() if s["stack"] == name]
    if not services:
        raise HTTPException(404, f"Stack '{name}' not found")
    tasks = await _tasks({"label": [f"{STACK_LABEL}={name}"]})
    return {"name": name, "services": services, "tasks": tasks}


# Tasks started in the background are kept referenced until done (the loop only holds weak references).
_background: set[asyncio.Task] = set()


@router.delete("/stacks/{name}")
async def delete_stack(name: str):
    """Like `docker stack rm`: services, then networks, secrets and configs with the stack label."""
    await _require_manager()
    label = json.dumps({"label": [f"{STACK_LABEL}={name}"]})
    services = await query_json("services", params={"filters": label})
    if not services:
        raise HTTPException(404, f"Stack '{name}' not found")
    results = await asyncio.gather(*(query_json(f"services/{s['ID']}", method="DELETE") for s in services), return_exceptions=True)
    failed = [f"service {s.get('Spec', {}).get('Name', s['ID'][:12])}: {r}" for s, r in zip(services, results) if isinstance(r, Exception)]
    if len(failed) == len(services):
        raise HTTPException(502, "Couldn't delete the stack's services: " + "; ".join(failed[:5]))
    for kind in ("secrets", "configs"):
        items = await query_json(kind, params={"filters": label})
        results = await asyncio.gather(*(query_json(f"{kind}/{i['ID']}", method="DELETE") for i in items), return_exceptions=True)
        failed += [f"{kind[:-1]} {i.get('Spec', {}).get('Name', i['ID'][:12])}: {r}" for i, r in zip(items, results) if isinstance(r, Exception)]
    # Networks can only be removed once their tasks are gone; retry briefly in the background.
    _background.add(t := asyncio.create_task(_remove_stack_networks(label)))
    t.add_done_callback(_background.discard)
    if failed:
        raise HTTPException(502, "The stack was only partly deleted: " + "; ".join(failed[:5]))
    return {"ok": True, "services": len(services)}


async def _remove_stack_networks(label: str) -> None:
    for _ in range(20):
        nets = await query_json("networks", params={"filters": label})
        if not nets:
            return
        await asyncio.gather(*(query_json(f"networks/{n['Id']}", method="DELETE") for n in nets), return_exceptions=True)
        await asyncio.sleep(1.5)


# ---- nodes -----------------------------------------------------------------------------------


@router.get("/nodes")
async def list_nodes():
    await _require_manager()
    out = []
    for n in await query_json("nodes"):
        spec, desc, status, mgr = n.get("Spec") or {}, n.get("Description") or {}, n.get("Status") or {}, n.get("ManagerStatus") or {}
        res = desc.get("Resources") or {}
        out.append(
            {
                "id": n["ID"],
                "hostname": desc.get("Hostname"),
                "role": spec.get("Role"),
                "availability": spec.get("Availability"),
                "state": status.get("State"),
                "addr": status.get("Addr"),
                "leader": bool(mgr.get("Leader")),
                "reachability": mgr.get("Reachability"),
                "engine": (desc.get("Engine") or {}).get("EngineVersion"),
                "os": f"{(desc.get('Platform') or {}).get('OS', '')}/{(desc.get('Platform') or {}).get('Architecture', '')}",
                "cpus": (res.get("NanoCPUs") or 0) / 1e9,
                "memory": res.get("MemoryBytes"),
                "labels": spec.get("Labels") or {},
            }
        )
    return out


class AvailabilityBody(BaseModel):
    availability: Literal["active", "pause", "drain"]


@router.post("/nodes/{nid}/availability")
async def set_availability(nid: str, body: AvailabilityBody):
    node = await query_json(f"nodes/{nid}")
    spec = node["Spec"]
    spec["Availability"] = body.availability
    await query_json(f"nodes/{nid}/update", method="POST", params={"version": str(node["Version"]["Index"])}, data=spec)
    return {"ok": True}


# ---- secrets & configs -----------------------------------------------------------------------


def _meta(i: dict) -> dict:
    spec = i.get("Spec") or {}
    labels = spec.get("Labels") or {}
    return {"id": i["ID"], "name": spec.get("Name"), "createdAt": i.get("CreatedAt"), "updatedAt": i.get("UpdatedAt"), "stack": labels.get(STACK_LABEL), "labels": labels}


@router.get("/secrets")
async def list_secrets():
    await _require_manager()
    return sorted((_meta(s) for s in await query_json("secrets")), key=lambda s: s["name"] or "")


@router.get("/configs")
async def list_configs():
    await _require_manager()
    return sorted((_meta(c) for c in await query_json("configs")), key=lambda c: c["name"] or "")


@router.delete("/{kind}/{iid}")
async def delete_secret_or_config(kind: Literal["secrets", "configs"], iid: str):
    await query_json(f"{kind}/{iid}", method="DELETE")
    return {"ok": True}
