"""Port forwards (services/forwards.py): list, add (for the active engine's container), remove."""

import aiodocker
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.docker_client import get_docker
from app.services.engines import engines
from app.services.forwards import ForwardError, forwards

router = APIRouter(prefix="/forwards", tags=["forwards"])


@router.get("")
async def list_forwards():
    return {"forwards": forwards.list()}


@router.get("/free-port")
async def free_port(start: int = 8080):
    """A suggestion for the local port: `start` or the next one that no container/forward uses."""
    used = {f["hostPort"] for f in forwards.list()}
    for c in await forwards.docker._query_json("containers/json"):
        used.update(p.get("PublicPort") for p in c.get("Ports") or [] if p.get("PublicPort"))
    port = max(1, min(start, 65535))
    while port in used and port < 65535:
        port += 1
    return {"port": port}


class AddForward(BaseModel):
    containerId: str
    targetPort: int = Field(ge=1, le=65535)
    hostPort: int = Field(ge=1, le=65535)


@router.post("")
async def add_forward(body: AddForward):
    try:
        if engines.is_local:
            return await forwards.add_container(body.containerId, body.targetPort, body.hostPort)
        info = await get_docker()._query_json(f"containers/{body.containerId}/json")
        return await forwards.add_remote(engines.active_id, info, body.targetPort, body.hostPort)
    except ForwardError as e:
        raise HTTPException(409, str(e))
    except aiodocker.DockerError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 500, str(e.message))


@router.delete("/{fid}")
async def remove_forward(fid: str):
    await forwards.remove(fid)
    return {"ok": True}

