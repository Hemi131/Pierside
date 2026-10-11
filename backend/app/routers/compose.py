"""Compose projects Pierside remembers, and running `docker compose` for remote engines.

On the local engine the UI runs the real `docker compose` on the user's machine itself (through
Rancher's docker CLI, in the project folder), since that's where the compose files are. For an SSH
engine the files are on the server, so the backend runs `docker compose` there over the engine's
SSH connection, as a background job the UI polls for output.
"""

import asyncio
import secrets
import shlex
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import containers as containers_svc
from app.services.composereg import registry
from app.services.engines import engines

router = APIRouter(prefix="/compose", tags=["compose"])

MAX_LINES = 5000
JOB_TTL_S = 600


@router.get("/projects")
async def list_projects():
    """Remembered projects of the active engine with their live state (also ones that are down)."""
    containers = await containers_svc.list_containers(all=True)
    registry.observe(engines.active_id, containers)
    live: dict[str, list[dict]] = {}
    for c in containers:
        if c.get("project") and not c.get("isExtension"):
            live.setdefault(c["project"], []).append(c)
    out = []
    for name, entry in registry.projects(engines.active_id).items():
        cs = live.get(name, [])
        out.append(
            {
                "name": name,
                "configFiles": entry.get("configFiles", []),
                "workingDir": entry.get("workingDir", ""),
                "options": entry.get("options", {}),
                "lastSeen": entry.get("lastSeen"),
                "containers": len(cs),
                "running": sum(1 for c in cs if c["state"] == "running"),
                "services": sorted({c["service"] for c in cs if c.get("service")}),
            }
        )
    meta = engines.active_meta()
    return {"engine": {"id": meta["id"], "type": meta["type"]}, "projects": sorted(out, key=lambda p: p["name"])}


class ProjectUpdate(BaseModel):
    configFiles: list[str] | None = None
    workingDir: str | None = None
    options: dict | None = None


@router.put("/projects/{name}")
async def update_project(name: str, body: ProjectUpdate):
    if not name.strip():
        raise HTTPException(400, "A project name is required")
    return registry.upsert(engines.active_id, name, body.configFiles, body.workingDir, body.options)


@router.delete("/projects/{name}")
async def forget_project(name: str):
    registry.forget(engines.active_id, name)
    return {"ok": True}


# ---- remote runner ----------------------------------------------------------------------------

_jobs: dict[str, dict] = {}


class RunCompose(BaseModel):
    args: list[str]  # everything after `docker compose`
    cwd: str = ""


def _prune() -> None:
    now = time.monotonic()
    for jid, job in list(_jobs.items()):
        if job["state"] != "running" and now - job["finished"] > JOB_TTL_S:
            _jobs.pop(jid, None)


async def _run(job: dict, command: str) -> None:
    try:
        conn = await engines.tunnel._connection()  # the active SSH engine's connection
        proc = await conn.create_process(command, encoding="utf-8", errors="replace")
        job["proc"] = proc

        async def pump(stream, kind: str) -> None:
            async for line in stream:
                job["lines"].append({"s": kind, "m": line.rstrip("\r\n")})
                over = len(job["lines"]) - MAX_LINES
                if over > 0:
                    del job["lines"][:over]
                    job["offset"] += over  # `since` stays an absolute line number

        await asyncio.gather(pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"))
        result = await proc.wait()
        job["code"] = result.exit_status if result.exit_status is not None else -1
        job["state"] = "done"
    except asyncio.CancelledError:
        job["state"] = "cancelled"
        proc = job.get("proc")
        if proc is not None:
            proc.close()  # closes the channel, so docker compose doesn't run on unseen
        raise
    except Exception as e:
        job["lines"].append({"s": "stderr", "m": f"Pierside: {e}"})
        job["code"] = -1
        job["state"] = "done"
    finally:
        job["finished"] = time.monotonic()
        job.pop("proc", None)


@router.post("/run")
async def run_remote(body: RunCompose):
    if engines.is_local or engines.tunnel is None:
        raise HTTPException(400, "On the local engine, Pierside runs docker compose from the UI")
    _prune()
    # Talk to the same daemon as the engine (rootless Docker or a custom socket path), not whatever the
    # server's docker CLI defaults to.
    socket_path = engines.tunnel.cfg.socketPath or "/var/run/docker.sock"
    command = f"DOCKER_HOST={shlex.quote('unix://' + socket_path)} docker compose " + " ".join(shlex.quote(a) for a in body.args)
    if body.cwd.strip():
        command = f"cd {shlex.quote(body.cwd.strip())} && {command}"
    jid = secrets.token_hex(6)
    job = {"id": jid, "state": "running", "code": None, "lines": [], "offset": 0, "finished": 0.0, "command": command}
    _jobs[jid] = job
    job["task"] = asyncio.create_task(_run(job, command), name=f"compose-{jid}")
    return {"id": jid}


@router.get("/run/{jid}")
async def run_status(jid: str, since: int = 0):
    job = _jobs.get(jid)
    if job is None:
        raise HTTPException(404, "Unknown job")
    lines, offset = job["lines"], job["offset"]
    return {"state": job["state"], "code": job["code"], "lines": lines[max(0, since - offset) :], "next": offset + len(lines)}


@router.delete("/run/{jid}")
async def run_cancel(jid: str):
    job = _jobs.get(jid)
    if job is None or job["state"] != "running":
        return {"cancelled": False}
    proc = job.get("proc")
    if proc is not None:
        try:
            proc.terminate()  # an SSH signal request; sshd may ignore it, so the channel is closed too
        except Exception:
            pass
        proc.close()
    job["task"].cancel()
    return {"cancelled": True}
