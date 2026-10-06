import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.hub import hub
from app.ws.common import accept_authorized

router = APIRouter()


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    if not await accept_authorized(ws):
        return
    q = await hub.add_client()

    async def pump():
        while True:
            await ws.send_json(await q.get())

    async def drain():
        # We don't expect client messages, but must read to notice disconnects promptly.
        while True:
            await ws.receive_text()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        hub.remove_client(q)
