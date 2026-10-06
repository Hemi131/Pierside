"""Engine management: list, probe (host-key + docker check), add, remove, activate."""

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.services import containers as containers_svc
from app.services import docker_client
from app.services.engines import LOCAL_ID, EngineConfig, EngineError, engines, probe
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


@router.post("/probe")
async def probe_engine(p: SshParams):
    if not p.privateKey and not p.password:
        raise HTTPException(400, "Provide a private key or a password")
    try:
        return await probe(p.host.strip(), p.port, p.user.strip(), p.privateKey or None, p.passphrase, p.password, p.socketPath.strip(), p.mode)
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
    return {"ok": True}


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
