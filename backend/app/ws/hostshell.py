"""WS /ws/host-shell: an interactive shell on the active SSH engine's server (the terminal panel).

The same protocol as /ws/exec: client -> {"type": "input", "data"} | {"type": "resize", "cols", "rows"};
server -> binary output, {"type": "ready"} | {"type": "exit", "code"} | {"type": "error", "message"}.
It runs as the engine's SSH user, over the engine's SSH connection, with a terminal (PTY), so full-screen
programs work. The local engine has no equivalent: an extension may only run the docker CLI there,
which the UI does itself (the Docker console).
"""

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.engines import engines
from app.ws.common import accept_authorized

router = APIRouter()
log = logging.getLogger("pierside.hostshell")


def _int(v, default: int) -> int:
    try:
        return max(1, min(int(v or default), 1000))
    except (TypeError, ValueError):
        return default


@router.websocket("/ws/host-shell")
async def ws_host_shell(ws: WebSocket):
    if not await accept_authorized(ws):
        return
    q = ws.query_params
    cols, rows = _int(q.get("cols"), 80), _int(q.get("rows"), 24)
    proc = None
    try:
        if engines.is_local or engines.tunnel is None:
            await ws.send_json({"type": "error", "message": "A server shell is available for SSH engines only."})
            return
        conn = await engines.tunnel._connection()
        # No command: the user's login shell, with a PTY.
        proc = await conn.create_process(term_type="xterm-256color", term_size=(cols, rows), encoding=None)
        await ws.send_json({"type": "ready"})

        async def pump_out():
            while True:
                data = await proc.stdout.read(8192)
                if not data:
                    break
                await ws.send_bytes(data)
            result = await proc.wait()
            await ws.send_json({"type": "exit", "code": result.exit_status})

        async def pump_in():
            while True:
                m = await ws.receive()
                if m["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(m.get("code", 1000))
                if m.get("bytes") is not None:
                    proc.stdin.write(m["bytes"])
                    continue
                data = json.loads(m.get("text") or "{}")
                if data.get("type") == "input":
                    proc.stdin.write(data.get("data", "").encode())
                elif data.get("type") == "resize":
                    proc.change_terminal_size(_int(data.get("cols"), cols), _int(data.get("rows"), rows))

        tasks = [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                exc = t.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("host shell failed: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e) or type(e).__name__})
        except Exception:
            pass
    finally:
        if proc is not None:
            proc.close()  # closes the SSH channel: the shell gets SIGHUP
        try:
            await ws.close()
        except Exception:
            pass
