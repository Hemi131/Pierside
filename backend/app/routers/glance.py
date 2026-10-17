"""Engines at a glance (services/watch.py): every engine's state, the settings, recent alerts."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.watch import watch

router = APIRouter(prefix="/glance", tags=["glance"])


class Settings(BaseModel):
    interval: int | None = None
    # engine id -> watched in the background
    watch: dict[str, bool] | None = None
    # SSH engine id -> its server checked for memory, swapping, load and full disks (server alerts)
    serverAlerts: dict[str, bool] | None = None


@router.get("")
async def glance():
    """Read every few seconds by the open page, which keeps the snapshots of all engines coming."""
    watch.viewed()
    return watch.state()


@router.put("/settings")
async def settings(body: Settings):
    try:
        watch.configure(body.interval, body.watch, body.serverAlerts)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return watch.state()


@router.post("/refresh")
async def refresh():
    watch.refresh()
    return {"ok": True}
