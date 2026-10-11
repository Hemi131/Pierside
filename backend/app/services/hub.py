"""EngineHub: one Docker events subscription + per-container stats, fanned out to WS clients.

Messages (JSON, `type` field):
  {"type": "engine", "ok": bool, "error"?: str, "info"?: {...}}
  {"type": "containers", "containers": [...]}        full snapshot, after changes (debounced)
  {"type": "stats", "stats": {id: {...}}, "totals": {...}}   every ~2 s while clients connected
  {"type": "event", "event": {"type", "action", "id", "name", "detail"?, "exitCode"?}}  engine events
  {"type": "event", "event": {"type": "alert", "action": kind, "severity", "name", "id", "detail": text, "serviceId"?}}
      a problem found in those events or in the Swarm tasks (see alerts.py)
"""

import asyncio
import logging
import time
from typing import Any

from app.services import containers as containers_svc
from app.services.alerts import _timestamp, alerts
from app.services.composereg import registry as composereg
from app.services.docker_client import get_docker, query_json, stream_json_lines
from app.services.engines import engines

log = logging.getLogger("pierside.hub")

DEBOUNCE_S = 0.15
STATS_INTERVAL_S = 2.0
IDLE_SHUTDOWN_S = 10.0
SWARM_WATCH_S = 30.0  # how often the Swarm tasks are looked at for ones that keep failing
_IGNORED_ACTIONS = ("exec_create", "exec_start", "exec_die", "top", "attach", "resize", "commit", "archive-path", "extract-to-dir")


def cpu_percent(s: dict) -> float:
    cpu, pre = s.get("cpu_stats") or {}, s.get("precpu_stats") or {}
    try:
        cpu_delta = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"]["total_usage"]
        sys_delta = cpu["system_cpu_usage"] - pre["system_cpu_usage"]
    except (KeyError, TypeError):
        return 0.0
    online = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage") or []) or 1
    if sys_delta > 0 and cpu_delta >= 0:
        return cpu_delta / sys_delta * online * 100.0
    return 0.0


def mem_usage(s: dict) -> tuple[int, int]:
    m = s.get("memory_stats") or {}
    usage = m.get("usage") or 0
    st = m.get("stats") or {}
    # Same as the docker CLI: subtract page cache (cgroup v2: inactive_file, v1: total_inactive_file).
    cache = st.get("inactive_file", st.get("total_inactive_file", 0)) or 0
    return max(usage - cache, 0), m.get("limit") or 0


class EngineHub:
    def __init__(self) -> None:
        self.clients: set[asyncio.Queue] = set()
        self.containers: list[dict] = []
        self.engine: dict[str, Any] = {"type": "engine", "ok": False, "error": "connecting"}
        self.stats: dict[str, dict] = {}
        self.info: dict[str, Any] = {}
        self._tasks: list[asyncio.Task] = []
        self._stat_tasks: dict[str, asyncio.Task] = {}
        self._dirty = asyncio.Event()
        self._idle_handle: asyncio.TimerHandle | None = None
        self._lock = asyncio.Lock()

    # ---- client management -------------------------------------------------
    async def add_client(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self.clients.add(q)
        if self._idle_handle:
            self._idle_handle.cancel()
            self._idle_handle = None
        async with self._lock:
            if not self._tasks:
                self._start()
        q.put_nowait(self.engine)
        if self.engine.get("ok"):
            q.put_nowait({"type": "containers", "containers": self.containers})
            if self.stats:
                q.put_nowait(self._stats_msg())
        return q

    def remove_client(self, q: asyncio.Queue) -> None:
        self.clients.discard(q)
        if not self.clients and self._idle_handle is None:
            # Keep running briefly so tab switches / StrictMode remounts don't restart everything.
            self._idle_handle = asyncio.get_running_loop().call_later(IDLE_SHUTDOWN_S, lambda: asyncio.ensure_future(self._stop_if_idle()))

    def broadcast(self, msg: dict) -> None:
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # Slow client: drop its backlog, it will get the next snapshot.
                while not q.empty():
                    q.get_nowait()
                q.put_nowait(msg)

    # ---- lifecycle -----------------------------------------------------------
    def _start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._events_loop(), name="hub-events"),
            asyncio.create_task(self._refresh_loop(), name="hub-refresh"),
            asyncio.create_task(self._stats_broadcast_loop(), name="hub-stats"),
            asyncio.create_task(self._swarm_watch_loop(), name="hub-swarm-watch"),
        ]

    async def _stop_if_idle(self) -> None:
        self._idle_handle = None
        if self.clients:
            return
        async with self._lock:
            for t in self._tasks + list(self._stat_tasks.values()):
                t.cancel()
            await asyncio.gather(*self._tasks, *self._stat_tasks.values(), return_exceptions=True)
            self._tasks, self._stat_tasks, self.stats = [], {}, {}
            log.info("hub idle: stopped")

    async def restart(self) -> None:
        """Engine switched: drop all state and streams, reconnect to the new engine."""
        async with self._lock:
            for t in self._tasks + list(self._stat_tasks.values()):
                t.cancel()
            await asyncio.gather(*self._tasks, *self._stat_tasks.values(), return_exceptions=True)
            self._tasks, self._stat_tasks, self.stats, self.containers = [], {}, {}, []
            containers_svc.invalidate()
            alerts.reset()
            self.engine = {"type": "engine", "ok": False, "error": "switching engine", "engine": engines.active_meta()}
            self.broadcast(self.engine)
            self.broadcast({"type": "containers", "containers": []})
            if self.clients:
                self._start()

    def refresh_engine_meta(self) -> None:
        """The active engine's name/colour changed: push it without reconnecting."""
        self.engine = {**self.engine, "engine": engines.active_meta()}
        self.broadcast(self.engine)

    async def shutdown(self) -> None:
        self.clients.clear()
        await self._stop_if_idle()

    # ---- engine events -------------------------------------------------------
    async def _events_loop(self) -> None:
        backoff = 1.0
        while True:
            try:
                ver = await get_docker().version()
                info = await query_json("info")
                self.info = {"ncpu": info.get("NCPU"), "memTotal": info.get("MemTotal"), "name": info.get("Name"), "os": info.get("OperatingSystem")}
                self.engine = {"type": "engine", "ok": True, "version": ver.get("Version"), "info": self.info, "engine": engines.active_meta()}
                self.broadcast(self.engine)
                self._dirty.set()
                backoff = 1.0
                async for ev in stream_json_lines("events"):
                    self._on_event(ev)
                raise ConnectionError("event stream ended")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("events loop error: %s", e)
                err = engines.error or (engines.tunnel.last_error if engines.tunnel else None) or str(e) or type(e).__name__
                self.engine = {"type": "engine", "ok": False, "error": err, "engine": engines.active_meta()}
                self.broadcast(self.engine)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    def _on_event(self, ev: dict) -> None:
        etype = ev.get("Type")
        action, _, detail = (ev.get("Action") or "").partition(":")
        actor = ev.get("Actor") or {}
        attrs = actor.get("Attributes") or {}
        if action in _IGNORED_ACTIONS:
            return
        problem = alerts.on_event(ev)
        if problem and problem["kind"] == "check-oom":
            asyncio.ensure_future(self._check_oom(problem["containerId"], problem["name"]))
        elif problem:
            self._alert(problem)
        if etype == "container":
            containers_svc.invalidate(actor.get("ID"))
            self._dirty.set()
        elif etype == "volume":
            from app.routers.volumes import invalidate_sizes  # late import: routers depend on services

            invalidate_sizes()
        self.broadcast(
            {
                "type": "event",
                "event": {
                    "type": etype,
                    "action": action,
                    "id": actor.get("ID"),
                    "name": attrs.get("name"),
                    # e.g. "unhealthy" for health_status, the exit code for die
                    **({"detail": detail.strip()} if detail else {}),
                    **({"exitCode": attrs["exitCode"]} if "exitCode" in attrs else {}),
                },
            }
        )

    async def _check_oom(self, cid: str, name: str) -> None:
        try:
            info = await query_json(f"containers/{cid}/json")
        except Exception:
            return  # gone already
        if (info.get("State") or {}).get("OOMKilled"):
            problem = alerts.out_of_memory(cid, name)
            if problem:
                self._alert(problem)

    def _alert(self, problem: dict) -> None:
        log.info("alert: %s", problem["message"])
        self.broadcast(
            {
                "type": "event",
                "event": {
                    "type": "alert",
                    "action": problem["kind"],
                    "severity": problem["severity"],
                    "id": problem.get("containerId") or "",
                    "name": problem["name"],
                    "detail": problem["message"],
                    **({"serviceId": problem["serviceId"]} if problem.get("serviceId") else {}),
                },
            }
        )

    async def _swarm_watch_loop(self) -> None:
        """A failing Swarm task gets a new container each time, maybe on another node, so the
        container events above can't show a service that keeps failing: look at the tasks."""
        while True:
            await asyncio.sleep(SWARM_WATCH_S)
            try:
                info = await query_json("info")
                swarm = info.get("Swarm") or {}
                if swarm.get("LocalNodeState") != "active" or not swarm.get("ControlAvailable"):
                    continue
                tasks, services = await asyncio.gather(query_json("tasks"), query_json("services"))
                names = {s["ID"]: (s.get("Spec") or {}).get("Name") or s["ID"][:12] for s in services}
                now = _timestamp(info.get("SystemTime")) or time.time()
                for problem in alerts.swarm_alerts(tasks, names, now):
                    self._alert(problem)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.debug("swarm watch: %s", e)

    async def _refresh_loop(self) -> None:
        while True:
            await self._dirty.wait()
            await asyncio.sleep(DEBOUNCE_S)
            self._dirty.clear()
            try:
                self.containers = await containers_svc.list_containers(all=True)
            except Exception as e:
                log.warning("refresh failed: %s", e)
                continue
            self.broadcast({"type": "containers", "containers": self.containers})
            try:
                composereg.observe(engines.active_id, self.containers)  # remember compose file locations
            except Exception as e:
                log.warning("compose registry update failed: %s", e)
            self._sync_stat_streams()

    # ---- stats -----------------------------------------------------------------
    def _sync_stat_streams(self) -> None:
        running = {c["id"] for c in self.containers if c["state"] in ("running", "paused", "restarting")}
        for cid in list(self._stat_tasks):
            if cid not in running:
                self._stat_tasks.pop(cid).cancel()
                self.stats.pop(cid, None)
        for cid in running - self._stat_tasks.keys():
            self._stat_tasks[cid] = asyncio.create_task(self._stats_stream(cid), name=f"stats-{cid[:12]}")

    async def _stats_stream(self, cid: str) -> None:
        try:
            async for s in stream_json_lines(f"containers/{cid}/stats", params={"stream": "1"}):
                mem, limit = mem_usage(s)
                self.stats[cid] = {"cpu": round(cpu_percent(s), 2), "mem": mem, "memLimit": limit, "t": time.time()}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.debug("stats stream %s ended: %s", cid[:12], e)
        finally:
            self._stat_tasks.pop(cid, None)
            self.stats.pop(cid, None)

    def _stats_msg(self) -> dict:
        cpu = sum(v["cpu"] for v in self.stats.values())
        mem = sum(v["mem"] for v in self.stats.values())
        return {
            "type": "stats",
            "stats": {k: {"cpu": v["cpu"], "mem": v["mem"], "memLimit": v["memLimit"]} for k, v in self.stats.items()},
            "totals": {"cpu": round(cpu, 2), "mem": mem, "ncpu": self.info.get("ncpu"), "memTotal": self.info.get("memTotal")},
        }

    async def _stats_broadcast_loop(self) -> None:
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            if self.engine.get("ok"):
                self.broadcast(self._stats_msg())


hub = EngineHub()
