"""Compose projects, derived from container labels (no compose CLI needed)."""

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, HTTPException

from app.services import containers as svc
from app.services.conflicts import safe_start
from app.services.containers import PROJECT_LABEL
from app.services.docker_client import query_json

router = APIRouter(prefix="/projects", tags=["projects"])


async def _containers(name: str) -> list[dict]:
    raw = await svc.project_containers(name)
    if not raw:
        raise HTTPException(404, f"No containers found for project '{name}'")
    return raw


async def _each(ids: list[str], fn) -> dict:
    results = await asyncio.gather(*(fn(cid) for cid in ids), return_exceptions=True)
    for cid in ids:
        svc.invalidate(cid)
    # A port conflict keeps its details (which container holds the port) so the UI can offer to stop it.
    for r in results:
        if isinstance(r, HTTPException) and r.status_code == 409:
            raise r
    errors = [f"{cid[:12]}: {getattr(r, 'detail', r)}" for cid, r in zip(ids, results) if isinstance(r, Exception)]
    if errors:
        raise HTTPException(500, "; ".join(errors))
    return {"ok": True, "count": len(ids)}


@router.get("")
async def list_projects():
    projects: dict[str, dict] = {}
    for c in await svc.list_containers(all=True):
        p = c.get("project")
        if not p:
            continue
        entry = projects.setdefault(p, {"name": p, "workingDir": c.get("projectWorkingDir"), "configFiles": c.get("projectConfigFiles"), "containers": []})
        entry["containers"].append(c)
    for p in projects.values():
        p["running"] = sum(1 for c in p["containers"] if c["state"] == "running")
        p["total"] = len(p["containers"])
    return sorted(projects.values(), key=lambda p: p["name"])


@router.post("/{name}/{action}")
async def project_action(name: str, action: Literal["start", "stop", "restart", "pause", "unpause"]):
    raw = await _containers(name)
    if action == "start":
        # Not `compose run` one-offs: they ran once and aren't part of the project's services.
        ids = [c["Id"] for c in raw if c["State"] in ("created", "exited", "dead") and (c.get("Labels") or {}).get("com.docker.compose.oneoff") != "True"]
    elif action == "stop":
        ids = [c["Id"] for c in raw if c["State"] in ("running", "paused", "restarting")]
    elif action == "pause":
        ids = [c["Id"] for c in raw if c["State"] == "running"]
    elif action == "unpause":
        ids = [c["Id"] for c in raw if c["State"] == "paused"]
    else:
        ids = [c["Id"] for c in raw]
    if action in ("start", "restart"):
        return await _each(ids, lambda cid: safe_start(cid, action))
    return await _each(ids, lambda cid: query_json(f"containers/{cid}/{action}", method="POST"))


@router.delete("/{name}")
async def delete_project(name: str, volumes: bool = False):
    """Like `compose down`: force-remove the project's containers, then its networks."""
    raw = await _containers(name)
    result = await _each(
        [c["Id"] for c in raw],
        lambda cid: query_json(f"containers/{cid}", method="DELETE", params={"force": "true", "v": str(volumes).lower()}),
    )
    nets = await query_json("networks", params={"filters": json.dumps({"label": [f"{PROJECT_LABEL}={name}"]})})
    await asyncio.gather(*(query_json(f"networks/{n['Id']}", method="DELETE") for n in nets), return_exceptions=True)
    return result
