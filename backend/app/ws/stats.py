"""WS /ws/stats/{id}: live container stats, ~1 message/s.

server -> {"type": "stats", "t": epoch_s, "cpu": pct, "ncpu": n, "mem": bytes, "memLimit": bytes,
           "netRx": B/s, "netTx": B/s, "blkRead": B/s, "blkWrite": B/s, "pids": n}
          {"type": "status", "state": "stopped"}   (container not running; stream ends)
          {"type": "error", "message": str}
"""

import time

import aiodocker
from fastapi import APIRouter, WebSocket

from app.services.docker_client import stream_json_lines
from app.services.hub import cpu_percent, mem_usage
from app.ws.common import accept_authorized
from app.ws.logs import run_until_disconnect

router = APIRouter()


def _net(s: dict) -> tuple[int, int]:
    nets = s.get("networks") or {}
    return sum(n.get("rx_bytes", 0) for n in nets.values()), sum(n.get("tx_bytes", 0) for n in nets.values())


def _blk(s: dict) -> tuple[int, int]:
    rd = wr = 0
    for e in (s.get("blkio_stats") or {}).get("io_service_bytes_recursive") or []:
        op = (e.get("op") or "").lower()
        if op == "read":
            rd += e.get("value", 0)
        elif op == "write":
            wr += e.get("value", 0)
    return rd, wr


@router.websocket("/ws/stats/{cid}")
async def ws_stats(ws: WebSocket, cid: str):
    if not await accept_authorized(ws):
        return

    async def produce():
        prev: tuple[float, int, int, int, int] | None = None
        async for s in stream_json_lines(f"containers/{cid}/stats", params={"stream": "1"}):
            if not s.get("read") or s["read"].startswith("0001-"):
                await ws.send_json({"type": "status", "state": "stopped"})
                return
            now = time.time()
            rx, tx = _net(s)
            rd, wr = _blk(s)
            rates = {"netRx": 0.0, "netTx": 0.0, "blkRead": 0.0, "blkWrite": 0.0}
            if prev:
                dt = max(now - prev[0], 1e-3)
                # Counters reset on restart: clamp negatives to 0.
                rates = {
                    "netRx": max(rx - prev[1], 0) / dt,
                    "netTx": max(tx - prev[2], 0) / dt,
                    "blkRead": max(rd - prev[3], 0) / dt,
                    "blkWrite": max(wr - prev[4], 0) / dt,
                }
            prev = (now, rx, tx, rd, wr)
            mem, limit = mem_usage(s)
            cpu_stats = s.get("cpu_stats") or {}
            await ws.send_json(
                {
                    "type": "stats",
                    "t": now,
                    "cpu": round(cpu_percent(s), 2),
                    "ncpu": cpu_stats.get("online_cpus") or 1,
                    "mem": mem,
                    "memLimit": limit,
                    "pids": (s.get("pids_stats") or {}).get("current"),
                    **{k: round(v, 1) for k, v in rates.items()},
                }
            )
        await ws.send_json({"type": "status", "state": "stopped"})

    try:
        await run_until_disconnect(ws, produce())
    except aiodocker.DockerError as e:
        msg = e.message.get("message") if isinstance(e.message, dict) else str(e.message)
        try:
            await ws.send_json({"type": "error", "message": msg})
        except Exception:
            pass
