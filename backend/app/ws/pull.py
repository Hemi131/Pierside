"""WS /ws/images/pull?ref=...: pull with progress.

server -> {"type": "progress", "status": str, "layers": {id: {"status", "current", "total"}}}   (throttled)
          {"type": "done", "status": str} | {"type": "error", "message": str}
"""

import asyncio
import time

from fastapi import APIRouter, WebSocket

from app.routers.images import split_ref
from app.services.docker_client import stream_json_lines
from app.ws.common import accept_authorized
from app.ws.logs import run_until_disconnect

router = APIRouter()


@router.websocket("/ws/images/pull")
async def ws_pull(ws: WebSocket):
    if not await accept_authorized(ws):
        return
    ref = (ws.query_params.get("ref") or "").strip()
    if not ref:
        await ws.send_json({"type": "error", "message": "No image reference given"})
        await ws.close()
        return
    repo, tag = split_ref(ref)
    params = {"fromImage": repo} if tag == "<digest>" else {"fromImage": repo, "tag": tag}
    if tag == "<digest>":
        params["fromImage"] = ref

    async def pull():
        layers: dict[str, dict] = {}
        status = ""
        last_sent = 0.0
        # POST images/create streams JSON progress lines.
        async for ev in stream_json_lines("images/create", params=params, method="POST"):
            if "error" in ev:
                await ws.send_json({"type": "error", "message": ev.get("error")})
                return
            lid = ev.get("id")
            detail = ev.get("progressDetail") or {}
            if lid and lid != tag and ev.get("status") not in (None, "Pulling from " + repo):
                layer = layers.setdefault(lid, {"status": "", "current": 0, "total": 0})
                layer["status"] = ev.get("status", "")
                if detail.get("total"):
                    layer["current"], layer["total"] = detail.get("current", 0), detail["total"]
                if layer["status"] in ("Pull complete", "Already exists", "Download complete") and layer["total"]:
                    layer["current"] = layer["total"]
            else:
                status = ev.get("status", status)
            now = time.monotonic()
            if now - last_sent > 0.15:
                last_sent = now
                await ws.send_json({"type": "progress", "status": status, "layers": layers})
        await ws.send_json({"type": "progress", "status": status, "layers": layers})
        await ws.send_json({"type": "done", "status": status})
        await asyncio.sleep(0.2)

    try:
        await run_until_disconnect(ws, pull())
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
