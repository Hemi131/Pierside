"""Server performance: the active SSH engine's server, like htop (see services/hostperf.py)."""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import hostfs, hostperf
from app.services.fsbrowse import FsError
from app.services.watch import watch

router = APIRouter(prefix="/hostperf", tags=["hostperf"])


async def _do(coro):
    try:
        return await coro
    except FsError as e:
        raise HTTPException(e.status, str(e))


@router.get("")
async def current():
    """The current figures, processes and history; read every 2 s by the open page, which keeps sampling going."""

    async def build():
        data = await hostperf.sample()
        eid = data["engine"]  # the engine the sample was taken on (another may be active by now)
        return {
            **data,
            "alerts": eid in watch.server_alerts,
            "useDocker": hostfs.consent(),
            "dockerProblem": await hostfs.docker_problem(),
        }

    return await _do(build())


class Action(BaseModel):
    engine: str  # the server the process was seen on: refused if another one is active now
    pid: int
    start: int  # the process's start time as reported: a reused process id is refused
    action: Literal["end", "kill", "lower"]


@router.post("/act")
async def act(body: Action):
    return await _do(hostperf.act(body.engine, body.pid, body.start, body.action))


@router.delete("")
async def leave():
    """The page was left: the helper goes in a few seconds (unless the page comes back), not after the idle time."""
    task = asyncio.create_task(hostperf.leave())
    _leaving.add(task)  # referenced until done
    task.add_done_callback(_leaving.discard)
    return {"ok": True}


_leaving: set[asyncio.Task] = set()
