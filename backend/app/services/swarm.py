"""Swarm helpers: state, init address selection, service/stack normalisation."""

import re
from typing import Any

import aiodocker

from app.services.docker_client import query_json

STACK_LABEL = "com.docker.stack.namespace"
SERVICE_NAME_LABEL = "com.docker.swarm.service.name"
SERVICE_ID_LABEL = "com.docker.swarm.service.id"
TASK_ID_LABEL = "com.docker.swarm.task.id"


async def swarm_state() -> dict[str, Any]:
    info = (await query_json("info")).get("Swarm") or {}
    state = info.get("LocalNodeState", "inactive")
    out: dict[str, Any] = {
        "state": state,  # inactive | pending | active | error | locked
        "active": state == "active",
        "isManager": bool(info.get("ControlAvailable")),
        "nodeId": info.get("NodeID") or None,
        "nodeAddr": info.get("NodeAddr") or None,
        "nodes": info.get("Nodes"),
        "managers": info.get("Managers"),
        "error": info.get("Error") or None,
    }
    if out["isManager"]:
        try:
            sw = await query_json("swarm")
            out["clusterId"] = sw.get("ID")
            out["createdAt"] = sw.get("CreatedAt")
            out["joinTokens"] = {"worker": (sw.get("JoinTokens") or {}).get("Worker"), "manager": (sw.get("JoinTokens") or {}).get("Manager")}
        except aiodocker.DockerError:
            pass
    return out


_ADDR_RE = re.compile(r"([0-9.]+) on ([\w.-]+)")


def pick_advertise_addr(error_message: str) -> str | None:
    """Docker refuses to guess with multiple interfaces and lists them in the error:
    '... (192.168.143.1 on veth-rd-ns and 192.168.127.2 on eth0) ...'. Prefer eth0, then any non-veth."""
    cands = _ADDR_RE.findall(error_message or "")
    for addr, iface in cands:
        if iface == "eth0":
            return addr
    for addr, iface in cands:
        if not iface.startswith(("veth", "docker", "br-", "cni")):
            return addr
    return cands[0][0] if cands else None


def _ports(endpoint: dict) -> list[dict]:
    out = []
    for p in (endpoint.get("Ports") or []):
        out.append(
            {
                "published": p.get("PublishedPort"),
                "target": p.get("TargetPort"),
                "protocol": p.get("Protocol", "tcp"),
                "mode": p.get("PublishMode", "ingress"),
            }
        )
    return out


def normalise_service(s: dict) -> dict:
    spec = s.get("Spec") or {}
    labels = spec.get("Labels") or {}
    mode = spec.get("Mode") or {}
    status = s.get("ServiceStatus") or {}
    container = ((spec.get("TaskTemplate") or {}).get("ContainerSpec") or {})
    image = (container.get("Image") or "").split("@")[0]
    if "Replicated" in mode:
        kind, desired = "replicated", (mode["Replicated"] or {}).get("Replicas", 0)
    elif "Global" in mode:
        kind, desired = "global", status.get("DesiredTasks")
    elif "ReplicatedJob" in mode:
        kind, desired = "replicated-job", (mode["ReplicatedJob"] or {}).get("TotalCompletions")
    else:
        kind, desired = "global-job", status.get("DesiredTasks")
    upd = s.get("UpdateStatus") or {}
    return {
        "id": s["ID"],
        "name": spec.get("Name"),
        "stack": labels.get(STACK_LABEL),
        "image": image,
        "mode": kind,
        "desired": desired,
        "running": status.get("RunningTasks"),
        "ports": _ports(s.get("Endpoint") or {}),
        "createdAt": s.get("CreatedAt"),
        "updatedAt": s.get("UpdatedAt"),
        "version": (s.get("Version") or {}).get("Index"),
        "update": {"state": upd.get("State"), "message": upd.get("Message")} if upd else None,
        "hasPrevious": bool(s.get("PreviousSpec")),
        "tty": bool(container.get("TTY")),
    }


def normalise_task(t: dict, nodes: dict[str, str]) -> dict:
    status = t.get("Status") or {}
    cs = status.get("ContainerStatus") or {}
    return {
        "id": t["ID"],
        "serviceId": t.get("ServiceID"),
        "slot": t.get("Slot"),
        "nodeId": t.get("NodeID"),
        "node": nodes.get(t.get("NodeID") or "", t.get("NodeID")),
        "state": status.get("State"),
        "desiredState": t.get("DesiredState"),
        "message": status.get("Message"),
        "error": status.get("Err"),
        "timestamp": status.get("Timestamp"),
        "containerId": cs.get("ContainerID"),
        "exitCode": cs.get("ExitCode"),
        "createdAt": t.get("CreatedAt"),
    }


async def node_names() -> dict[str, str]:
    try:
        return {n["ID"]: (n.get("Description") or {}).get("Hostname", n["ID"][:12]) for n in await query_json("nodes")}
    except aiodocker.DockerError:
        return {}
