"""WS /ws/logs/container/{id}: live logs as batched JSON.

server -> {"type": "lines", "lines": [{t, k, s, m}, ...]}
          {"type": "status", "state": "streaming" | "stopped" | "removed"}
          {"type": "dropped", "count": n}      client too slow; oldest pending lines dropped
          {"type": "error", "message": str}
"""

import asyncio
import json
import logging
import time

import aiodocker
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.containers import SERVICE_LABEL, project_containers
from app.services.docker_client import query_json
from app.services.logs import LogLine, follow_container_logs, raw_log_lines
from app.ws.common import accept_authorized

router = APIRouter()
log = logging.getLogger("pierside.ws.logs")

FLUSH_S = 0.05
MAX_PENDING = 20_000


class BatchedSender:
    """Coalesces lines and sends at most every FLUSH_S; drops oldest if the client can't keep up."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.pending: list[LogLine] = []
        self.dropped = 0
        self.wake = asyncio.Event()

    def add(self, lines: list[LogLine]) -> None:
        self.pending.extend(lines)
        if len(self.pending) > MAX_PENDING:
            over = len(self.pending) - MAX_PENDING
            del self.pending[:over]
            self.dropped += over
        self.wake.set()

    async def run(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            await asyncio.sleep(FLUSH_S)
            if self.dropped:
                await self.ws.send_json({"type": "dropped", "count": self.dropped})
                self.dropped = 0
            while self.pending:
                chunk, self.pending = self.pending[:5000], self.pending[5000:]
                await self.ws.send_json({"type": "lines", "lines": chunk})


async def run_until_disconnect(ws: WebSocket, *coros) -> None:
    """Run producer coroutines until they finish or the client disconnects, then cancel all."""

    async def drain():
        while True:
            await ws.receive_text()

    tasks = [asyncio.create_task(c) for c in coros] + [asyncio.create_task(drain())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                raise exc
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/ws/logs/container/{cid}")
async def ws_container_logs(ws: WebSocket, cid: str):
    if not await accept_authorized(ws):
        return
    tail = ws.query_params.get("tail", "1000")
    sender = BatchedSender(ws)

    async def status(state: str):
        # Flush lines first so status ordering is preserved.
        sender.wake.set()
        await asyncio.sleep(FLUSH_S * 2)
        await ws.send_json({"type": "status", "state": state})

    async def produce():
        async for batch in follow_container_logs(cid, tail=tail, on_status=status):
            sender.add(batch)
        # Container removed: keep the socket open (client shows the state) until it disconnects.
        await asyncio.Event().wait()

    try:
        await run_until_disconnect(ws, produce(), sender.run())
    except aiodocker.DockerError as e:
        await _send_error(ws, e.message if isinstance(e.message, str) else str(e.message))
    except Exception as e:
        log.exception("logs ws failed")
        await _send_error(ws, str(e))


REORDER_HOLD_S = 0.3  # lines are held this long so streams that arrive slightly late sort correctly
PROJECT_POLL_S = 2.0


class ReorderBuffer:
    """Holds lines briefly and releases them sorted by engine timestamp (ties: arrival order)."""

    def __init__(self, sink: BatchedSender) -> None:
        self.sink = sink
        self.pending: list[tuple[float, int, LogLine]] = []
        self.seq = 0

    def add(self, lines: list[LogLine]) -> None:
        now = time.monotonic()
        for line in lines:
            self.pending.append((now, self.seq, line))
            self.seq += 1

    async def run(self) -> None:
        while True:
            await asyncio.sleep(0.1)
            if not self.pending:
                continue
            cutoff = time.monotonic() - REORDER_HOLD_S
            ready = [p for p in self.pending if p[0] <= cutoff]
            if not ready:
                continue
            self.pending = [p for p in self.pending if p[0] > cutoff]
            ready.sort(key=lambda p: (p[2]["k"], p[1]))
            self.sink.add([p[2] for p in ready])


def _service_labels(containers: list[dict]) -> dict[str, str]:
    """container id -> display name: service, or service-N when a service has several replicas."""
    by_service: dict[str, list[dict]] = {}
    for c in containers:
        svc = (c.get("Labels") or {}).get(SERVICE_LABEL) or (c.get("Names") or ["/?"])[0].lstrip("/")
        by_service.setdefault(svc, []).append(c)
    out = {}
    for svc, cs in by_service.items():
        for c in cs:
            num = (c.get("Labels") or {}).get("com.docker.compose.container-number")
            out[c["Id"]] = f"{svc}-{num}" if len(cs) > 1 and num else svc
    return out


@router.websocket("/ws/logs/project/{name}")
async def ws_project_logs(ws: WebSocket, name: str):
    """Merged logs of all containers in a compose project; each line carries `svc`."""
    if not await accept_authorized(ws):
        return
    tail = ws.query_params.get("tail", "1000")
    sender = BatchedSender(ws)
    reorder = ReorderBuffer(sender)
    followers: dict[str, asyncio.Task] = {}

    async def follow(cid: str, label_of: dict[str, str]):
        try:
            async for batch in follow_container_logs(cid, tail=tail):
                svc = label_of.get(cid, cid[:12])
                for line in batch:
                    line["svc"] = svc  # type: ignore[typeddict-unknown-key]
                reorder.add(batch)
        except aiodocker.DockerError:
            pass  # container removed
        finally:
            followers.pop(cid, None)

    async def watch_project():
        labels: dict[str, str] = {}
        sent: list[str] | None = None
        while True:
            containers = await project_containers(name)
            labels.clear()
            labels.update(_service_labels(containers))
            for c in containers:
                if c["Id"] not in followers:
                    followers[c["Id"]] = asyncio.create_task(follow(c["Id"], labels))
            services = sorted(set(labels.values()))
            if services != sent:
                sent = services
                await ws.send_json({"type": "services", "services": services})
            await asyncio.sleep(PROJECT_POLL_S)

    try:
        await run_until_disconnect(ws, watch_project(), reorder.run(), sender.run())
    except Exception as e:
        log.exception("project logs ws failed")
        await _send_error(ws, str(e))
    finally:
        for t in list(followers.values()):
            t.cancel()
        await asyncio.gather(*followers.values(), return_exceptions=True)


async def _send_error(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_json({"type": "error", "message": message})
        await ws.close()
    except Exception:
        pass


# ---- Swarm service / stack logs ----------------------------------------------------------------

_DETAILS_PREFIX = "com.docker.swarm."


def _split_details(line: LogLine) -> dict[str, str]:
    """With details=1, service log messages start with 'k=v,k=v <message>'."""
    msg = line["m"]
    if not msg.startswith(_DETAILS_PREFIX):
        return {}
    details, _, rest = msg.partition(" ")
    line["m"] = rest
    out = {}
    for kv in details.split(","):
        k, _, v = kv.partition("=")
        out[k] = v
    return out


async def _follow_service(sid: str, tail: str, on_batch, label_for_task) -> None:
    """Follow one service's logs (all tasks), reopening after the stream ends while the service exists."""
    # A service stream interleaves its tasks with slightly out-of-order timestamps, so dedupe per
    # task (only relevant after a reopen) instead of against one global watermark.
    last_by_task: dict[str, int] = {}
    seen_by_task: dict[str, int] = {}  # as of the last reopen: only those lines are duplicates
    first = True
    while True:
        try:
            svc = await query_json(f"services/{sid}")
        except aiodocker.DockerError:
            return  # service removed
        tty = bool(((svc.get("Spec") or {}).get("TaskTemplate") or {}).get("ContainerSpec", {}).get("TTY"))
        params = {"follow": "1", "stdout": "1", "stderr": "1", "timestamps": "1", "details": "1"}
        if first:
            params["tail"] = tail
        else:
            seen_by_task = dict(last_by_task)
            since = max(max(last_by_task.values(), default=0) - 2_000_000_000, 0)
            params["since"] = f"{since // 1_000_000_000}.{since % 1_000_000_000:09d}"
        async for batch in raw_log_lines(sid, tty, params, path=f"services/{sid}/logs"):
            out = []
            for line in batch:
                task = _split_details(line).get("com.docker.swarm.task.id", "")
                if line["k"] and line["k"] <= seen_by_task.get(task, 0):
                    continue
                if line["k"]:
                    last_by_task[task] = max(line["k"], last_by_task.get(task, 0))
                line["svc"] = await label_for_task(task)  # type: ignore[typeddict-unknown-key]
                out.append(line)
            if out:
                on_batch(out)
        first = False
        await asyncio.sleep(1.0)


class _TaskLabels:
    """task id -> 'service.slot' (service name without the stack prefix), refreshed on unknown ids."""

    def __init__(self, filters: dict) -> None:
        self.filters = filters
        self.map: dict[str, str] = {}
        self.active: set[str] = set()
        self.lock = asyncio.Lock()
        self.last_refresh = 0.0

    async def refresh(self) -> None:
        services = {s["ID"]: s for s in await query_json("services", params={"filters": json.dumps({k: v for k, v in self.filters.items() if k != "service"})})}
        tasks = await query_json("tasks", params={"filters": json.dumps(self.filters)})
        fresh: dict[str, str] = {}
        self.active: set[str] = set()
        for t in tasks:
            svc = services.get(t.get("ServiceID")) or {}
            spec = svc.get("Spec") or {}
            name = spec.get("Name") or t.get("ServiceID", "")[:12]
            stack = (spec.get("Labels") or {}).get("com.docker.stack.namespace")
            if stack and name.startswith(stack + "_"):
                name = name[len(stack) + 1 :]
            slot = t.get("Slot")
            label = f"{name}.{slot}" if slot else f"{name}.{(t.get('NodeID') or '')[:6]}"
            fresh[t["ID"]] = label
            if t.get("DesiredState") == "running":
                self.active.add(label)
        self.map = fresh
        self.last_refresh = time.monotonic()

    async def __call__(self, task_id: str) -> str:
        if task_id not in self.map and time.monotonic() - self.last_refresh > 1.0:
            async with self.lock:
                if task_id not in self.map:
                    await self.refresh()
        return self.map.get(task_id, task_id[:12] or "?")


async def _swarm_logs(ws: WebSocket, service_ids_fn, task_filters: dict) -> None:
    tail = ws.query_params.get("tail", "500")
    sender = BatchedSender(ws)
    reorder = ReorderBuffer(sender)
    labels = _TaskLabels(task_filters)
    followers: dict[str, asyncio.Task] = {}

    async def watch():
        sent = None
        while True:
            ids = await service_ids_fn()
            for sid in ids:
                if sid not in followers or followers[sid].done():
                    followers[sid] = asyncio.create_task(_follow_service(sid, tail, reorder.add, labels))
            await labels.refresh()
            names = sorted(labels.active)
            if names != sent:
                sent = names
                await ws.send_json({"type": "services", "services": names})
            await asyncio.sleep(PROJECT_POLL_S)

    try:
        await run_until_disconnect(ws, watch(), reorder.run(), sender.run())
    except Exception as e:
        log.exception("swarm logs ws failed")
        await _send_error(ws, str(e))
    finally:
        for t in followers.values():
            t.cancel()
        await asyncio.gather(*followers.values(), return_exceptions=True)


@router.websocket("/ws/logs/service/{sid}")
async def ws_service_logs(ws: WebSocket, sid: str):
    if not await accept_authorized(ws):
        return
    try:
        svc = await query_json(f"services/{sid}")
    except aiodocker.DockerError as e:
        await _send_error(ws, str(e.message))
        return

    async def ids():
        return [svc["ID"]]

    labels = (svc.get("Spec") or {}).get("Labels") or {}
    stack = labels.get("com.docker.stack.namespace")
    filters = {"service": [svc["ID"]]}
    if stack:
        filters["label"] = [f"com.docker.stack.namespace={stack}"]
    await _swarm_logs(ws, ids, filters)


@router.websocket("/ws/logs/stack/{name}")
async def ws_stack_logs(ws: WebSocket, name: str):
    if not await accept_authorized(ws):
        return
    label = {"label": [f"com.docker.stack.namespace={name}"]}

    async def ids():
        return [s["ID"] for s in await query_json("services", params={"filters": json.dumps(label)})]

    await _swarm_logs(ws, ids, label)
