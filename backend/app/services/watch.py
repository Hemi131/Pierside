"""Engines at a glance, and engines watched in the background.

Every engine has a snapshot: reachable or not, how many containers run, which need attention, and
the CPU / memory its running containers use. Snapshots are taken every `interval` seconds:
  * for every engine while the Engines at a glance page is open (it reads GET /glance every few
    seconds, which counts as looking);
  * always for engines the user watches in the background.

A watched engine also has its Docker events followed, over a connection of its own, with its own
copy of the alert rules (alerts.py), so its problems are reported while another engine is active.
The hub then leaves the active engine's alerts to this module when that engine is watched, so
nothing is reported twice. A watched engine that can't be reached is reported too, and again when
it is back. Every alert, from here or from the hub, goes through emit(): it is recorded for the
page's recent alerts and pushed to the UI.

Alerts are shown by the UI (toast / desktop notification), so only while a Pierside page is open;
the recent alerts keep what happened in between.
"""

import asyncio
import json
import logging
import os
import re
import time
from collections import deque

import aiodocker

from app.services import docker_client
from app.services.alerts import Alerts, ServerRules, _timestamp, confirm
from app.services.engines import DATA_DIR, engines
from app.services.mcp_access import EngineClients
from app.services.store import write_json

log = logging.getLogger("pierside.watch")

SETTINGS_FILE = os.path.join(DATA_DIR, "glance.json")
INTERVALS = (0, 10, 30, 60, 300)  # seconds; 0: only when asked (the Refresh button)
DEFAULT_INTERVAL = 30
VIEW_TTL_S = 15  # the page reads GET /glance every few seconds; this long after the last read it's closed
IDLE_CLOSE_S = 600  # connection of an engine that is neither watched nor looked at
TIMEOUT_S = 20
SWARM_WATCH_S = 30.0
SERVER_CHECK_S = 30.0  # server alerts: how often memory / swap / load / disks are looked at
DOWN_AFTER_FAILURES = 2  # failed connection attempts in a row before a watched engine is reported
STATS_CONCURRENCY = 6
STATS_MAX_CONTAINERS = 100
SAMPLE_TIMEOUT_S = 5

_RECENTLY = re.compile(r"Exited \((\d+)\) .*(second|minute|hour)s? ago|Exited \((\d+)\) Less than")
_UNHEALTHY = "(unhealthy)"
_JUST_STARTED = re.compile(r"Up (Less than|\d+ seconds?|About a minute|[1-4] minutes)")
LOOP_RESTARTS = 3


async def overview(docker: aiodocker.Docker) -> tuple[dict, list[str]]:
    """How one engine is doing, and the ids of its running containers."""
    from app.services.mcp_tools import _name, _protected  # late: the tools module is large

    info, raw = await asyncio.wait_for(asyncio.gather(docker._query_json("info"), docker._query_json("containers/json", params={"all": "1"})), TIMEOUT_S)
    mine = [c for c in raw if not _protected(c)]  # without Pierside's, other extensions' and Kubernetes' containers
    # A container in a restart loop is "restarting" only between two attempts; in between it looks
    # freshly started or just exited. Those few are asked how often Docker has restarted them.
    # (Not ones that exited: Docker keeps RestartCount, so a container that looped hours ago and stopped
    # would still count. Those show as "exited with code …" below.)
    maybe = [c for c in mine if c.get("State") == "restarting" or _JUST_STARTED.match(c.get("Status") or "")][:20]

    async def restarts(c: dict) -> tuple[str, int]:
        try:
            return c["Id"], int((await docker._query_json(f"containers/{c['Id']}/json")).get("RestartCount") or 0)
        except Exception:
            return c["Id"], 0

    try:
        looping = {cid for cid, n in await asyncio.wait_for(asyncio.gather(*(restarts(c) for c in maybe)), TIMEOUT_S) if n >= LOOP_RESTARTS}
    except asyncio.TimeoutError:
        looping = set()
    problems = []
    for c in mine:
        status, state = c.get("Status") or "", c.get("State")
        if c["Id"] in looping or state == "restarting":
            problems.append({"name": _name(c), "id": c["Id"], "what": "restarting"})
        elif state == "dead":
            problems.append({"name": _name(c), "id": c["Id"], "what": "dead"})
        elif _UNHEALTHY in status:
            problems.append({"name": _name(c), "id": c["Id"], "what": "unhealthy"})
        else:
            m = _RECENTLY.match(status)
            code = (m.group(1) or m.group(3)) if m else None
            if code and code not in ("0", "137", "143"):  # stopped on purpose looks like 0 / 137 / 143
                problems.append({"name": _name(c), "id": c["Id"], "what": f"exited with code {code}"})
    out = {
        "reachable": True,
        "error": None,
        "version": info.get("ServerVersion"),
        "os": info.get("OperatingSystem"),
        "cpus": info.get("NCPU"),
        "memory": info.get("MemTotal"),
        "images": info.get("Images"),
        "swarm": (info.get("Swarm") or {}).get("LocalNodeState") == "active",
        "running": sum(1 for c in mine if c.get("State") == "running"),
        "paused": sum(1 for c in mine if c.get("State") == "paused"),
        "stopped": sum(1 for c in mine if c.get("State") in ("exited", "created", "dead")),
        "total": len(mine),
        "problems": problems[:50],
    }
    return out, [c["Id"] for c in mine if c.get("State") == "running"]


async def usage(docker: aiodocker.Docker, running: list[str]) -> tuple[float, int, bool]:
    """CPU (100 = one core) and memory used by these containers, from one stats sample each
    (Docker takes about a second per sample, so a few at a time, each with its own time limit).
    The third value says some samples are missing (failed, too slow, or past the first 100)."""
    from app.services.hub import cpu_percent, mem_usage

    sem = asyncio.Semaphore(STATS_CONCURRENCY)

    async def one(cid: str) -> tuple[float, int] | None:
        async with sem:
            try:
                s = await asyncio.wait_for(docker._query_json(f"containers/{cid}/stats", params={"stream": "false"}), SAMPLE_TIMEOUT_S)
            except Exception:
                return None
            return cpu_percent(s), mem_usage(s)[0]

    samples = await asyncio.gather(*(one(c) for c in running[:STATS_MAX_CONTAINERS]))
    got = [s for s in samples if s is not None]
    partial = len(got) < len(running)
    return round(sum(c for c, _ in got), 2), sum(m for _, m in got), partial


class Watch:
    def __init__(self) -> None:
        self.interval = DEFAULT_INTERVAL
        self.background: list[str] = []
        self.server_alerts: list[str] = []  # SSH engines whose server is checked for memory / swap / load / disk
        self._server_checks: dict[str, asyncio.Task] = {}
        self.snaps: dict[str, dict] = {}
        self.recent: deque[dict] = deque(maxlen=100)
        self._viewed = 0.0
        self._last_poll: dict[str, float] = {}
        self._polling: set[str] = set()
        self._forced: set[str] = set()
        self._used: dict[str, float] = {}
        self._followers: dict[str, asyncio.Task] = {}
        self._down: set[str] = set()
        self._clients = EngineClients("watch", idle_close_s=None)
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None

    # ---- settings ----------------------------------------------------------------------------
    def _load(self) -> None:
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            log.warning("cannot read %s: %s", SETTINGS_FILE, e)
            return
        if data.get("interval") in INTERVALS:
            self.interval = data["interval"]
        self.background = [str(x) for x in data.get("background") or []]
        self.server_alerts = [str(x) for x in data.get("serverAlerts") or []]

    def _save(self) -> None:
        write_json(SETTINGS_FILE, {"interval": self.interval, "background": self.background, "serverAlerts": self.server_alerts}, indent=None)

    def configure(self, interval: int | None = None, watch: dict[str, bool] | None = None, server_alerts: dict[str, bool] | None = None) -> None:
        if interval is not None:
            if interval not in INTERVALS:
                raise ValueError(f"interval must be one of {INTERVALS}")
            self.interval = interval
        for engine_id, on in (watch or {}).items():
            if on and engine_id not in self.background:
                self.background.append(engine_id)
            elif not on and engine_id in self.background:
                self.background.remove(engine_id)
        for engine_id, on in (server_alerts or {}).items():
            if on and engine_id not in self.server_alerts:
                if engine_id not in {e["id"] for e in engines.list() if e["type"] == "ssh"}:
                    raise ValueError("Server alerts are for SSH engines")
                self.server_alerts.append(engine_id)
            elif not on and engine_id in self.server_alerts:
                self.server_alerts.remove(engine_id)
        self._save()
        self._wake.set()

    # ---- lifecycle ---------------------------------------------------------------------------
    def start(self) -> None:
        # The app lifespan runs once per uvicorn server (socket and TCP): start only once.
        if self._task is None:
            self._load()
            self._task = asyncio.create_task(self._loop(), name="watch")

    async def stop(self) -> None:
        tasks = [t for t in [self._task, *self._followers.values(), *self._server_checks.values()] if t]
        self._task, self._followers, self._server_checks = None, {}, {}
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._clients.shutdown()

    # ---- what the page and the hub ask -------------------------------------------------------
    def viewed(self) -> None:
        was_closed = time.monotonic() - self._viewed >= VIEW_TTL_S
        self._viewed = time.monotonic()
        if was_closed:
            self._wake.set()

    def refresh(self) -> None:
        self._forced = {e["id"] for e in engines.list()}
        self._wake.set()

    async def forget(self, engine_id: str) -> None:
        """An engine was removed: stop following it and close its connection now."""
        for tasks in (self._followers, self._server_checks):
            task = tasks.pop(engine_id, None)
            if task:
                task.cancel()
        self._down.discard(engine_id)
        self.snaps.pop(engine_id, None)
        self._used.pop(engine_id, None)
        if engine_id in self.background or engine_id in self.server_alerts:
            self.background = [i for i in self.background if i != engine_id]
            self.server_alerts = [i for i in self.server_alerts if i != engine_id]
            self._save()
        await self._clients.close(engine_id)

    def covers(self, engine_id: str) -> bool:
        """Whether this module reports the engine's alerts itself."""
        t = self._followers.get(engine_id)
        return t is not None and not t.done()

    def state(self) -> dict:
        out = []
        for e in engines.list():
            snap = self.snaps.get(e["id"]) or {}
            out.append(
                {
                    **snap,
                    "id": e["id"],
                    "name": e["name"],
                    "type": e["type"],
                    "color": e.get("color") or "",
                    "active": e["active"],
                    "target": f"{e['user']}@{e['host']}" if e["type"] == "ssh" else None,
                    "watched": e["id"] in self.background,
                    "polling": e["id"] in self._polling,
                    "down": e["id"] in self._down,
                }
            )
        return {"interval": self.interval, "intervals": list(INTERVALS), "engines": out, "recent": list(self.recent)[::-1]}

    def emit(self, engine_id: str, problem: dict) -> None:
        """One alert about an engine: recorded, and pushed to the UI."""
        from app.services.hub import hub  # late: hub imports this module

        name = next((e["name"] for e in engines.list() if e["id"] == engine_id), engine_id)
        log.info("alert (%s): %s", name, problem["message"])
        self.recent.append({**problem, "engineId": engine_id, "engineName": name})
        hub.broadcast(
            {
                "type": "event",
                "event": {
                    "type": "alert",
                    "action": problem["kind"],
                    "severity": problem["severity"],
                    "id": problem.get("containerId") or "",
                    "name": problem["name"],
                    "detail": problem["message"],
                    "engineId": engine_id,
                    "engineName": name,
                    **({"serviceId": problem["serviceId"]} if problem.get("serviceId") else {}),
                },
            }
        )

    # ---- snapshots ---------------------------------------------------------------------------
    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("watch loop: %s", e)
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), 1.0)
            except asyncio.TimeoutError:
                pass

    async def _tick(self) -> None:
        now = time.monotonic()
        ids = [e["id"] for e in engines.list()]
        self.background = [i for i in self.background if i in ids]  # engines removed in the meantime
        for gone in [i for i in self.snaps if i not in ids]:
            self.snaps.pop(gone, None)
        self._sync_followers(ids)
        viewing = now - self._viewed < VIEW_TTL_S
        forced, self._forced = self._forced, set()
        for engine_id in ids:
            if engine_id in self._polling:
                continue
            wanted = viewing or engine_id in self.background
            due = self.interval and wanted and now - self._last_poll.get(engine_id, -1e9) >= self.interval
            # The first snapshot is taken even with updates only on Refresh: there's nothing to show otherwise.
            first = wanted and engine_id not in self.snaps
            if due or first or engine_id in forced:
                self._last_poll[engine_id] = now
                self._polling.add(engine_id)
                asyncio.create_task(self._poll(engine_id), name=f"watch-poll-{engine_id}")
        # Connections of engines nobody looks at or watches any more, or that were removed.
        for engine_id, used in list(self._used.items()):
            if engine_id not in ids or (
                engine_id not in self.background and engine_id not in self.server_alerts and engine_id not in self._polling and now - used > IDLE_CLOSE_S
            ):
                self._used.pop(engine_id, None)
                await self._clients.close(engine_id)

    async def _docker_for(self, engine_id: str) -> aiodocker.Docker:
        if engine_id == engines.active_id:
            return docker_client.get_docker()
        self._used[engine_id] = time.monotonic()
        return await asyncio.wait_for(self._clients.get(engine_id), TIMEOUT_S)

    async def _poll(self, engine_id: str) -> None:
        try:
            docker = await self._docker_for(engine_id)
            snap, running = await overview(docker)
            # Counts and problems take a moment, CPU and memory several seconds (a sample per container):
            # show the first right away, with the previous CPU / memory (if any) until the new ones are in.
            prev = self.snaps.get(engine_id) or {}
            self.snaps[engine_id] = {**snap, "cpu": prev.get("cpu"), "mem": prev.get("mem"), "usagePartial": prev.get("usagePartial"), "updatedAt": time.time()}
            snap["cpu"], snap["mem"], snap["usagePartial"] = await self._usage(engine_id, docker, running)
        except Exception as e:
            # A followed engine's connection belongs to its event follower, which reconnects by itself;
            # dropping it here would also cut the event stream (and lose the events in the gap).
            if engine_id != engines.active_id and not self.covers(engine_id):
                await self._clients.drop(engine_id)
            snap = {"reachable": False, "error": (str(e) or type(e).__name__)[:300]}
        finally:
            self._polling.discard(engine_id)
        self.snaps[engine_id] = {**snap, "updatedAt": time.time()}

    async def _usage(self, engine_id: str, docker: aiodocker.Docker, running: list[str]) -> tuple[float, int, bool]:
        from app.services.hub import hub

        # The active engine's stats are streamed anyway while a page is open: use those, for the same
        # containers as on any other engine (`running` leaves out Kubernetes, extensions and Pierside's).
        ids = set(running)
        fresh = [s for cid, s in hub.stats.items() if cid in ids and time.time() - s.get("t", 0) < 10]
        if engine_id == engines.active_id and hub.clients and fresh:
            return round(sum(s["cpu"] for s in fresh), 2), sum(s["mem"] for s in fresh), len(fresh) < len(ids)
        return await usage(docker, running)

    # ---- following watched engines -----------------------------------------------------------
    def _sync_followers(self, ids: list[str]) -> None:
        wanted = {i for i in self.background if i in ids}
        for engine_id in list(self._followers):
            if engine_id not in wanted:
                self._followers.pop(engine_id).cancel()
                self._down.discard(engine_id)
                if engine_id not in self.server_alerts:  # still used for the server checks otherwise
                    asyncio.create_task(self._clients.close(engine_id))
        for engine_id in wanted - self._followers.keys():
            self._followers[engine_id] = asyncio.create_task(self._follow(engine_id), name=f"watch-follow-{engine_id}")
        # Server alerts: one check task per SSH engine that has them switched on.
        checked = {i for i in self.server_alerts if i in ids}
        for engine_id in list(self._server_checks):
            if engine_id not in checked:
                self._server_checks.pop(engine_id).cancel()
                if engine_id not in self.background:
                    asyncio.create_task(self._clients.close(engine_id))
        for engine_id in checked - self._server_checks.keys():
            self._server_checks[engine_id] = asyncio.create_task(self._check_server(engine_id), name=f"watch-server-{engine_id}")

    async def _check_server(self, engine_id: str) -> None:
        """Every SERVER_CHECK_S: the server's memory, swapping, load and disks (ServerRules), over this
        module's own SSH connection to it, whichever engine is active."""
        from app.services.hostdisk import DF_COMMAND, parse_df
        from app.services.hostperf import SYSTEM_SCRIPT, _sections, new_marker, parse_system, with_marker

        rules = ServerRules()
        prev_vm: dict | None = None
        prev_at = 0.0
        while True:
            try:
                conn = await asyncio.wait_for(self._clients.ssh(engine_id), TIMEOUT_S)
                # The script on stdin, with its own marker (see hostperf: never in a command line).
                marker = new_marker()
                script = with_marker(marker, SYSTEM_SCRIPT + "\nmark df; " + DF_COMMAND)
                result = await asyncio.wait_for(conn.run("sh -s", input=script, check=False), TIMEOUT_S)
                out = result.stdout
                text = out if isinstance(out, str) else (out or b"").decode("utf-8", "replace")
                sec = _sections(text, marker)
                system = parse_system(sec)
                now = time.monotonic()
                swap_rate = 0.0
                if prev_vm is not None and now > prev_at:
                    pages = sum(max(0, system["vm"].get(k, 0) - prev_vm.get(k, 0)) for k in ("pswpin", "pswpout"))
                    swap_rate = pages * system["page"] / (now - prev_at)
                prev_vm, prev_at = system["vm"], now
                mem = system["mem"]
                memory = {"total": mem.get("MemTotal", 0), "available": mem.get("MemAvailable", mem.get("MemFree", 0))}
                cpus = len([k for k in system["cpus"] if k != "cpu"])
                name = next((e["name"] for e in engines.list() if e["id"] == engine_id), engine_id)
                # parse_df skips the first line (df's header); the section starts with df's own header.
                for problem in rules.check(name, memory, swap_rate, system["load"][1], cpus, parse_df(sec.get("df", ""))):
                    self.emit(engine_id, problem)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.info("server check %s: %s", engine_id, e)  # an unreachable server is the follower's to report
                # A followed engine's connection belongs to its event follower (which reconnects itself):
                # dropping it here would cut the event stream every time a check fails.
                if not self.covers(engine_id):
                    await self._clients.drop(engine_id)
            await asyncio.sleep(SERVER_CHECK_S)

    async def _follow(self, engine_id: str) -> None:
        rules = Alerts()
        failures = 0
        while True:
            swarm: asyncio.Task | None = None
            try:
                docker = await asyncio.wait_for(self._clients.get(engine_id), TIMEOUT_S)
                await asyncio.wait_for(docker._query_json("version"), TIMEOUT_S)
                failures = 0
                if engine_id in self._down:
                    self._down.discard(engine_id)
                    self.emit(engine_id, _engine_alert("engine-up", "info", engine_id, "can be reached again."))
                swarm = asyncio.create_task(self._swarm_watch(engine_id, docker, rules))
                async for ev in docker_client.stream_json_lines("events", docker=docker):
                    problem = rules.on_event(ev)
                    if problem and problem["kind"] in ("check-oom", "check-loop"):
                        asyncio.create_task(self._confirm(engine_id, docker, problem, rules))
                    elif problem:
                        self.emit(engine_id, problem)
                raise ConnectionError("the event stream ended")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                failures += 1
                log.info("watch %s: %s", engine_id, e)
                await self._clients.drop(engine_id)
                if failures >= DOWN_AFTER_FAILURES and engine_id not in self._down:
                    self._down.add(engine_id)
                    self.emit(engine_id, _engine_alert("engine-down", "error", engine_id, f"can't be reached: {(str(e) or type(e).__name__)[:200]}"))
                await asyncio.sleep(min(5 * failures, 30))
            finally:
                if swarm:
                    swarm.cancel()

    async def _confirm(self, engine_id: str, docker: aiodocker.Docker, problem: dict, rules: Alerts) -> None:
        alert = await confirm(problem, lambda cid: docker._query_json(f"containers/{cid}/json"), rules)
        if alert:
            self.emit(engine_id, alert)

    async def _swarm_watch(self, engine_id: str, docker: aiodocker.Docker, rules: Alerts) -> None:
        """As the hub does for the active engine: Swarm services whose task keeps failing."""
        while True:
            await asyncio.sleep(SWARM_WATCH_S)
            try:
                info = await docker._query_json("info")
                swarm = info.get("Swarm") or {}
                if swarm.get("LocalNodeState") != "active" or not swarm.get("ControlAvailable"):
                    continue
                tasks, services = await asyncio.gather(docker._query_json("tasks"), docker._query_json("services"))
                names = {s["ID"]: (s.get("Spec") or {}).get("Name") or s["ID"][:12] for s in services}
                now = _timestamp(info.get("SystemTime")) or time.time()
                for problem in rules.swarm_alerts(tasks, names, now):
                    self.emit(engine_id, problem)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.debug("watch %s swarm: %s", engine_id, e)


def _engine_alert(kind: str, severity: str, engine_id: str, text: str) -> dict:
    name = next((e["name"] for e in engines.list() if e["id"] == engine_id), engine_id)
    return {"kind": kind, "severity": severity, "name": name, "containerId": "", "message": f'Engine "{name}" {text}', "at": time.time()}


watch = Watch()
