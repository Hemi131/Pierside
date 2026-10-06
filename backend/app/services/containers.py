"""Container listing, normalised for the UI (Docker Desktop–style columns)."""

import asyncio
import re
from typing import Any

from app.services.docker_client import query_json

PROJECT_LABEL = "com.docker.compose.project"
SERVICE_LABEL = "com.docker.compose.service"
WORKDIR_LABEL = "com.docker.compose.project.working_dir"
CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"
NUMBER_LABEL = "com.docker.compose.container-number"

# id -> subset of inspect data that list/json doesn't provide (StartedAt etc.).
# Invalidated by EngineHub on every container event for that id.
_inspect_cache: dict[str, dict[str, Any]] = {}
_inspect_sem = asyncio.Semaphore(16)

_HEALTH_RE = re.compile(r"\((healthy|unhealthy|health: starting)\)")


def invalidate(container_id: str | None = None) -> None:
    if container_id is None:
        _inspect_cache.clear()
    else:
        _inspect_cache.pop(container_id, None)


async def _inspect_extra(cid: str) -> dict[str, Any]:
    cached = _inspect_cache.get(cid)
    if cached is not None:
        return cached
    async with _inspect_sem:
        try:
            data = await query_json(f"containers/{cid}/json")
        except Exception:
            return {}
    state = data.get("State") or {}
    extra = {
        "startedAt": _nz_time(state.get("StartedAt")),
        "finishedAt": _nz_time(state.get("FinishedAt")),
        "exitCode": state.get("ExitCode"),
        "restartCount": data.get("RestartCount", 0),
        "oomKilled": bool(state.get("OOMKilled")),
    }
    _inspect_cache[cid] = extra
    return extra


def _nz_time(t: str | None) -> str | None:
    # Docker uses 0001-01-01T00:00:00Z for "never".
    if not t or t.startswith("0001-"):
        return None
    return t


def _ports(raw: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for p in raw or []:
        public = p.get("PublicPort")
        key = (public, p.get("PrivatePort"), p.get("Type"))
        # Docker lists 0.0.0.0 and :: bindings separately; show one.
        if key in seen:
            continue
        seen.add(key)
        out.append({"ip": p.get("IP"), "private": p.get("PrivatePort"), "public": public, "type": p.get("Type", "tcp")})
    out.sort(key=lambda p: (p["public"] is None, p["public"] or 0, p["private"] or 0))
    return out


def _normalise(c: dict, extra: dict) -> dict:
    labels = c.get("Labels") or {}
    status = c.get("Status") or ""
    m = _HEALTH_RE.search(status)
    name = (c.get("Names") or ["/"])[0].lstrip("/")
    return {
        "id": c["Id"],
        "name": name,
        "image": c.get("Image"),
        "imageId": c.get("ImageID"),
        "command": c.get("Command"),
        "created": c.get("Created"),
        "state": c.get("State"),  # created|running|paused|restarting|removing|exited|dead
        "status": status,
        "health": m.group(1).replace("health: ", "") if m else None,
        "ports": _ports(c.get("Ports")),
        "project": labels.get(PROJECT_LABEL),
        "service": labels.get(SERVICE_LABEL),
        "containerNumber": labels.get(NUMBER_LABEL),
        "projectWorkingDir": labels.get(WORKDIR_LABEL),
        "projectConfigFiles": labels.get(CONFIG_FILES_LABEL),
        # Swarm task containers (grouped under their stack / service in the UI).
        "stack": labels.get("com.docker.stack.namespace"),
        "swarmService": labels.get("com.docker.swarm.service.name"),
        "swarmServiceId": labels.get("com.docker.swarm.service.id"),
        "swarmTaskId": labels.get("com.docker.swarm.task.id"),
        # Hidden by default in the UI, like Docker Desktop's "show system/extension containers".
        "isSystem": "io.kubernetes.pod.name" in labels or name.startswith("k8s_"),
        "isExtension": (labels.get(PROJECT_LABEL) or "").startswith("rd-extension-")
        or "com.docker.desktop.extension.api.version" in labels
        or "com.pierside.helper" in labels,
        "mounts": [
            {"type": m.get("Type"), "name": m.get("Name"), "source": m.get("Source"), "destination": m.get("Destination"), "rw": m.get("RW")}
            for m in c.get("Mounts") or []
        ],
        **extra,
    }


async def list_containers(all: bool = True) -> list[dict]:
    raw = await query_json("containers/json", params={"all": "1" if all else "0"})
    extras = await asyncio.gather(*(_inspect_extra(c["Id"]) for c in raw))
    live_ids = {c["Id"] for c in raw}
    for cid in list(_inspect_cache):
        if cid not in live_ids:
            _inspect_cache.pop(cid, None)
    return [_normalise(c, e) for c, e in zip(raw, extras)]


async def project_containers(project: str) -> list[dict]:
    raw = await query_json(
        "containers/json",
        params={"all": "1", "filters": f'{{"label":["{PROJECT_LABEL}={project}"]}}'},
    )
    return raw
