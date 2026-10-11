"""Engine management: list, probe (host-key + docker check), add, remove, activate; and a short
status of any engine without switching to it."""

import asyncio
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.services import containers as containers_svc
from app.services import docker_client
from app.services.mcp_access import clients as mcp_clients, profiles as mcp_profiles
from app.services.engines import LOCAL_ID, EngineConfig, EngineError, engines, probe, server_host_key
from app.services.helper import remove_all_helpers
from app.services.hub import hub
from app.services.composereg import registry as composereg
from app.services.forwards import forwards

router = APIRouter(prefix="/engines", tags=["engines"])


class SshParams(BaseModel):
    name: str = ""
    host: str
    port: int = 22
    user: str = "root"
    privateKey: str = ""
    passphrase: str = ""
    password: str = ""
    socketPath: str = "/var/run/docker.sock"
    mode: str = "auto"  # auto | socket | stdio
    publicHost: str = ""


def _check_color(v: str | None) -> str | None:
    """Engine colour: "#rrggbb", or "" for none."""
    if not v:
        return v
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
        raise ValueError("color must be #rrggbb")
    return v.lower()


class AddEngine(SshParams):
    hostKey: str  # confirmed by the user after /probe
    resolvedMode: str  # socket | stdio, as returned by /probe
    color: str = ""

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return _check_color(v)


class UpdateEngine(BaseModel):
    name: str | None = None
    color: str | None = None

    @field_validator("color")
    @classmethod
    def _color(cls, v: str | None) -> str | None:
        return _check_color(v)


def _err(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


@router.get("")
async def list_engines():
    return {"engines": engines.list(), "active": engines.active_meta(), "error": engines.error}


class HostKeyParams(BaseModel):
    host: str
    port: int = 22


@router.post("/host-key")
async def host_key(p: HostKeyParams):
    """Step 1 of adding an engine: the server's host key, without logging in."""
    try:
        return await server_host_key(p.host.strip(), p.port)
    except EngineError as e:
        raise _err(e)


class ProbeParams(SshParams):
    hostKey: str  # confirmed by the user after /host-key: credentials go only to this server


@router.post("/probe")
async def probe_engine(p: ProbeParams):
    if not p.privateKey and not p.password:
        raise HTTPException(400, "Provide a private key or a password")
    try:
        return await probe(p.host.strip(), p.port, p.user.strip(), p.privateKey or None, p.passphrase, p.password, p.socketPath.strip(), p.mode, p.hostKey.strip())
    except EngineError as e:
        raise _err(e)
    except Exception as e:  # never a bare 500 for a connection test
        raise HTTPException(400, f"Connection test failed: {e or type(e).__name__}")


@router.post("")
async def add_engine(p: AddEngine):
    if p.resolvedMode not in ("socket", "stdio"):
        raise HTTPException(400, "Invalid connection mode")
    cfg = EngineConfig(
        id="",
        name=p.name.strip() or f"{p.user}@{p.host}",
        host=p.host.strip(),
        port=p.port,
        user=p.user.strip(),
        socketPath=p.socketPath.strip(),
        mode=p.resolvedMode,
        publicHost=p.publicHost.strip(),
        hostKey=p.hostKey.strip(),
        passphrase=p.passphrase,
        password=p.password,
        color=p.color,
    )
    return engines.add(cfg, p.privateKey or None).public()


@router.patch("/{engine_id}")
async def update_engine(engine_id: str, p: UpdateEngine):
    try:
        engines.update(engine_id, p.name, p.color)
    except EngineError as e:
        raise _err(e)
    if engine_id == engines.active_id:
        hub.refresh_engine_meta()
    return {"ok": True}


@router.delete("/{engine_id}")
async def remove_engine(engine_id: str):
    if engine_id == LOCAL_ID:
        raise HTTPException(400, "The local engine can't be removed")
    try:
        engines.remove(engine_id)
    except EngineError as e:
        raise _err(e)
    composereg.forget_engine(engine_id)  # its remembered compose projects go with it
    await forwards.remove_for_engine(engine_id)  # and its port forwards
    mcp_profiles.forget_engine(engine_id)  # and the AI access connections set up for it
    await mcp_clients.drop(engine_id)
    return {"ok": True}


OVERVIEW_TIMEOUT_S = 20
_RECENTLY = re.compile(r"Exited \((\d+)\) .*(second|minute|hour)s? ago|Exited \((\d+)\) Less than")
_UNHEALTHY = "(unhealthy)"
_JUST_STARTED = re.compile(r"Up (Less than|\d+ seconds?|About a minute|[1-4] minutes)")
LOOP_RESTARTS = 3


@router.get("/{engine_id}/overview")
async def engine_overview(engine_id: str):
    """How one engine is doing, for the Engines page: reachable or not, how many containers run, and
    which need attention. It doesn't switch engines: the active one is asked through the connection
    Pierside already has, any other through a separate one that is closed again when idle (the same
    connections AI access uses)."""
    from app.services.mcp_tools import _name, _protected  # late: the tools module is large

    if engine_id != LOCAL_ID and engine_id not in engines.registry.engines:
        raise HTTPException(404, "Unknown engine")
    out: dict = {"id": engine_id, "reachable": False, "error": None}
    try:
        if engine_id == engines.active_id:
            docker = docker_client.get_docker()
        else:
            docker = await asyncio.wait_for(mcp_clients.get(engine_id), OVERVIEW_TIMEOUT_S)
        info, raw = await asyncio.wait_for(asyncio.gather(docker._query_json("info"), docker._query_json("containers/json", params={"all": "1"})), OVERVIEW_TIMEOUT_S)
    except Exception as e:
        if engine_id != engines.active_id:
            await mcp_clients.drop(engine_id)
        out["error"] = (str(e) or type(e).__name__)[:300]
        return out
    mine = [c for c in raw if not _protected(c)]  # without Pierside's, other extensions' and Kubernetes' containers
    # A container in a restart loop is "restarting" only between two attempts; in between it looks
    # freshly started or just exited. Those few are asked how often Docker has restarted them.
    maybe = [c for c in mine if c.get("State") == "restarting" or _JUST_STARTED.match(c.get("Status") or "") or _RECENTLY.match(c.get("Status") or "")][:20]

    async def restarts(c: dict) -> tuple[str, int]:
        try:
            return c["Id"], int((await docker._query_json(f"containers/{c['Id']}/json")).get("RestartCount") or 0)
        except Exception:
            return c["Id"], 0

    try:
        looping = {cid for cid, n in await asyncio.wait_for(asyncio.gather(*(restarts(c) for c in maybe)), OVERVIEW_TIMEOUT_S) if n >= LOOP_RESTARTS}
    except asyncio.TimeoutError:
        looping = set()
    problems = []
    for c in mine:
        status, state = c.get("Status") or "", c.get("State")
        if c["Id"] in looping or state == "restarting":
            problems.append({"name": _name(c), "what": "restarting"})
        elif state == "dead":
            problems.append({"name": _name(c), "what": "dead"})
        elif _UNHEALTHY in status:
            problems.append({"name": _name(c), "what": "unhealthy"})
        else:
            m = _RECENTLY.match(status)
            code = (m.group(1) or m.group(3)) if m else None
            if code and code not in ("0", "137", "143"):  # stopped on purpose looks like 0 / 137 / 143
                problems.append({"name": _name(c), "what": f"exited with code {code}"})
    out.update(
        reachable=True,
        version=info.get("ServerVersion"),
        os=info.get("OperatingSystem"),
        cpus=info.get("NCPU"),
        memory=info.get("MemTotal"),
        images=info.get("Images"),
        swarm=(info.get("Swarm") or {}).get("LocalNodeState") == "active",
        running=sum(1 for c in mine if c.get("State") == "running"),
        paused=sum(1 for c in mine if c.get("State") == "paused"),
        stopped=sum(1 for c in mine if c.get("State") in ("exited", "created", "dead")),
        total=len(mine),
        problems=problems[:50],
    )
    return out


async def _switch(url: str) -> None:
    # Old client still points at the previous engine: clean up our helpers there first.
    try:
        await remove_all_helpers()
    except Exception:
        pass
    await docker_client.close_docker()  # next get_docker() connects to `url`
    containers_svc.invalidate()
    try:
        from app.routers.volumes import invalidate_sizes

        invalidate_sizes()
    except Exception:
        pass
    await hub.restart()


@router.post("/{engine_id}/activate")
async def activate_engine(engine_id: str):
    try:
        await engines.activate(engine_id, _switch)
    except EngineError as e:
        raise _err(e)
    except Exception as e:
        raise HTTPException(502, f"Couldn't connect: {e}")
    return {"ok": True, "active": engines.active_meta()}
