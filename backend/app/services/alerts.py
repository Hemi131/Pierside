"""Problems worth telling the user about, found in the active engine's events (see hub.py):

  * a container killed for running out of memory;
  * a container turning unhealthy;
  * a container in a restart loop: it exits by itself and Docker starts it again, over and over,
    whether it crashes (non-zero exit) or its command simply finishes (exit 0);
  * a Swarm service whose task keeps failing (found by looking at the tasks, as a failing task gets
    a new container each time, possibly on another node, so container events can't show it).

What tells a restart loop from the user stopping and starting a container: Docker reports a `kill`
before the `die` of anything stopped, restarted or killed on purpose (docker stop / restart / kill,
Compose, Pierside's own buttons, Swarm scaling down). A container that exits by itself has no `kill`.
And Docker only restarts a container whose restart policy says so: one that keeps dying without
such a policy is being started again by something else (a CI runner reusing its containers across
a job's stages, a script), which is no loop. The caller looks that up (docker_restarts).
Docker waits longer between restarts each time (up to a minute), hence the wide window.

One alert per problem, not per event: a container (or Swarm service) that was reported stays quiet,
whatever else goes wrong with it, while it keeps failing. It is reported again once it has been quiet
for QUIET_S and then fails again, or as a reminder every REMIND_S if it never stops. (A restart loop
also turns the container unhealthy after each start, and a Swarm service fails in every replica: those
used to be separate alerts, each repeated on its own.)
"""

import time
import re
from collections import deque
from datetime import datetime

LOOP_WINDOW_S = 5 * 60
LOOP_DEATHS = 3
KILL_MEMORY_S = 120  # how long a `kill` explains the `die` that follows (stop timeouts can be long)
QUIET_S = 15 * 60  # a reported problem is over after this long without a failure…
REMIND_S = 2 * 3600  # …and while it goes on, it is reported again only this often
SWARM_SERVICE_LABEL = "com.docker.swarm.service.name"


class Alerts:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Another engine, or a fresh start: forget what was counted."""
        self._deaths: dict[str, deque[tuple[float, str]]] = {}
        self._killed: dict[str, float] = {}
        self._open: dict[str, dict[str, float]] = {}  # problem key -> since / last failure / last told

    def _quiet(self, key: str, now: float) -> bool:
        """Whether a report about `key` now would be swallowed (it is going on and was told lately)."""
        p = self._open.get(key)
        return p is not None and now - p["seen"] < QUIET_S and now - p["told"] < REMIND_S

    def _touch(self, key: str, now: float) -> None:
        """Another failure: a problem going on isn't over yet. One quiet for QUIET_S was over, so this
        failure starts a new one (forgotten now, or the old one would swallow it)."""
        p = self._open.get(key)
        if p is not None and now - p["seen"] >= QUIET_S:
            del self._open[key]
        elif p is not None:
            p["seen"] = now

    def report(self, key: str, now: float | None = None) -> str | None:
        """Tell about `key` now? None: no (it was told and is still going on). Otherwise the text to add:
        "" for a new problem, a sentence saying how long it has gone on for a reminder."""
        now = time.time() if now is None else now
        p = self._open.get(key)
        if p is None or now - p["seen"] >= QUIET_S:
            self._open[key] = {"since": now, "seen": now, "told": now}
            return ""
        p["seen"] = now
        if now - p["told"] < REMIND_S:
            return None
        p["told"] = now
        return f" This has been going on for {_duration(now - p['since'])}."

    def on_event(self, ev: dict, now: float | None = None) -> dict | None:
        """One engine event in; an alert out when it completes a problem."""
        if ev.get("Type") != "container":
            return None
        now = time.time() if now is None else now
        action = (ev.get("Action") or "").partition(":")[0]
        detail = (ev.get("Action") or "").partition(":")[2].strip()
        actor = ev.get("Actor") or {}
        cid, attrs = actor.get("ID") or "", actor.get("Attributes") or {}
        name = attrs.get("name") or cid[:12]
        if not cid or any(k.startswith("com.pierside.") for k in attrs):
            return None  # Pierside's own helpers come and go
        if action == "kill":
            self._killed[cid] = now
        elif action == "destroy":
            self._deaths.pop(cid, None)
            self._killed.pop(cid, None)
        elif action == "oom":
            return self.out_of_memory(cid, name, now)
        elif action == "health_status" and detail == "unhealthy":
            more = self.report(f"container:{cid}", now)
            if more is not None:
                return _alert("unhealthy", "warning", name, cid, f'"{name}" is unhealthy: its health check is failing.{more}')
        elif action == "die":
            killed = self._killed.pop(cid, None)
            if killed is not None and now - killed < KILL_MEMORY_S:
                return None  # stopped, restarted or killed on purpose
            if SWARM_SERVICE_LABEL in attrs:
                return None  # counted per service task instead (swarm_alerts)
            deaths = self._deaths.setdefault(cid, deque(maxlen=20))
            deaths.append((now, str(attrs.get("exitCode", ""))))
            self._touch(f"container:{cid}", now)
            recent = [d for d in deaths if now - d[0] < LOOP_WINDOW_S]
            if len(recent) >= LOOP_DEATHS and not self._quiet(f"container:{cid}", now):
                code = recent[-1][1]
                minutes = max(1, round((now - recent[0][0]) / 60))
                span = "in the last minute" if minutes == 1 else f"in the last {minutes} minutes"
                if code == "0":
                    text = (
                        f'"{name}" keeps restarting: its command finishes (exit code 0) and Docker starts it again, {len(recent)} times {span}. '
                        'If it is meant to run once, change its restart policy to "no" or "on-failure".'
                    )
                else:
                    text = f'"{name}" keeps crashing: it exited {len(recent)} times {span} (exit code {code or "unknown"}) and Docker restarts it each time. Check its logs.'
                # Not yet an alert: only if Docker itself is what keeps starting it (see docker_restarts).
                return {"kind": "check-loop", "containerId": cid, "name": name, "exitCode": code, "key": f"container:{cid}", "alert": _alert("loop", "warning", name, cid, text)}
            if str(attrs.get("exitCode", "")) == "137":
                # Killed, but not by anyone using Docker: perhaps the kernel, for using too much memory.
                # Docker normally reports that with an `oom` event; where it doesn't, the caller can
                # look at the container (State.OOMKilled) and call out_of_memory().
                return {"kind": "check-oom", "containerId": cid, "name": name}
        return None

    def out_of_memory(self, cid: str, name: str, now: float | None = None) -> dict | None:
        """The container was found killed for running out of memory (not announced by an `oom` event)."""
        now = time.time() if now is None else now
        more = self.report(f"container:{cid}", now)
        if more is not None:
            return _alert("oom", "error", name, cid, f'"{name}" ran out of memory and was killed (OOM). Raise its memory limit or check for a leak.')
        return None

    def swarm_alerts(self, tasks: list[dict], services: dict[str, str], engine_now: float) -> list[dict]:
        """Services with a task that failed LOOP_DEATHS times in the window, in the same slot (or on the same
        node for global services): one alert per service, however many of its slots fail. `services` maps
        service id -> name; `engine_now` is the engine's clock."""
        failed: dict[tuple[str, str], list[tuple[float, dict]]] = {}
        for t in tasks:
            status = t.get("Status") or {}
            if status.get("State") not in ("failed", "rejected"):
                continue
            when = _timestamp(status.get("Timestamp"))
            if when is None or engine_now - when > LOOP_WINDOW_S:
                continue
            slot = str(t.get("Slot") or t.get("NodeID") or "")
            failed.setdefault((t.get("ServiceID") or "", slot), []).append((when, t))
        out = []
        for service_id in sorted({s for s, _slot in failed}):
            slots = {slot: items for (s, slot), items in failed.items() if s == service_id}
            key = f"service:{service_id}"
            self._touch(key, engine_now)  # any failure keeps a reported service from being over
            looping = {slot: items for slot, items in slots.items() if len(items) >= LOOP_DEATHS}
            if not looping:
                continue
            more = self.report(key, engine_now)
            if more is None:
                continue
            slot, items = max(looping.items(), key=lambda kv: len(kv[1]))
            items.sort(key=lambda x: x[0])
            status = items[-1][1].get("Status") or {}
            reason = (status.get("Err") or "").strip()
            code = (status.get("ContainerStatus") or {}).get("ExitCode")
            why = reason or (f"exit code {code}" if code is not None else status.get("Message") or "no reason given")
            name = services.get(service_id) or service_id[:12]
            label = f"{name}.{slot}" if items[-1][1].get("Slot") else name
            others = f" (and {len(looping) - 1} more of its tasks)" if len(looping) > 1 else ""
            text = f'Swarm service "{name}": task {label}{others} keeps failing, {len(items)} times in the last {LOOP_WINDOW_S // 60} minutes ({why}). Swarm starts a new one each time. Check the service\'s tasks and logs.{more}'
            out.append({**_alert("service", "warning", name, "", text), "serviceId": service_id})
        return out


MEMORY_LOW = 0.10  # available share of RAM below this…
SWAP_BYTES_S = 1024 * 1024  # …swapping faster than this…
LOAD_PER_CPU = 1.5  # …or a 5-minute load above this per CPU, on several checks in a row, is reported
DISK_FULL, DISK_CRITICAL = 90.0, 97.0  # percent of a filesystem
REPEAT_SERVER_S = 30 * 60
REPEAT_DISK_S = 6 * 3600


class ServerRules:
    """Server alerts of one SSH engine (watched with "Alert me about this server"), from one check of its
    whole-server figures every half minute or so. A short spike isn't reported: memory and swapping must
    show on two checks in a row, load on three."""

    def __init__(self) -> None:
        self._streak: dict[str, int] = {}
        self._last: dict[str, float] = {}

    def _once(self, key: str, every: float, now: float) -> bool:
        if key in self._last and now - self._last[key] < every:
            return False
        self._last[key] = now
        return True

    def _held(self, key: str, condition: bool, checks: int) -> bool:
        self._streak[key] = self._streak.get(key, 0) + 1 if condition else 0
        return self._streak[key] >= checks

    def check(self, server: str, mem: dict, swap_rate: float, load5: float, cpus: int, filesystems: list[dict], now: float | None = None) -> list[dict]:
        """mem: total / available bytes; swap_rate: bytes per second; filesystems: parse_df rows."""
        now = time.time() if now is None else now
        out = []
        total = mem.get("total") or 0
        if total and self._held("memory", mem.get("available", 0) / total < MEMORY_LOW, 2) and self._once("memory", REPEAT_SERVER_S, now):
            pct = mem.get("available", 0) * 100 // total
            out.append(_alert("server-memory", "error", server, "", f'Server "{server}": memory is almost full ({pct} % available). Server performance shows what uses it.'))
        if self._held("swap", swap_rate > SWAP_BYTES_S, 2) and self._once("swap", REPEAT_SERVER_S, now):
            out.append(_alert("server-swap", "warning", server, "", f'Server "{server}": it is swapping ({swap_rate / 1048576:.1f} MB/s), so memory is short and processes are slowed down.'))
        if cpus and self._held("load", load5 > cpus * LOAD_PER_CPU, 3) and self._once("load", REPEAT_SERVER_S, now):
            out.append(_alert("server-load", "warning", server, "", f'Server "{server}": high load ({load5:.1f} over 5 minutes on {cpus} CPUs); processes are waiting for their turn.'))
        for fs in filesystems:
            pct = fs.get("percent") or 0
            severity = "error" if pct >= DISK_CRITICAL else "warning"
            # Per severity: a disk that was reported at 91 % is reported again when it reaches 97 %.
            if pct >= DISK_FULL and self._once(f"disk:{fs['mount']}:{severity}", REPEAT_DISK_S, now):
                out.append(_alert("server-disk", severity, server, "", f'Server "{server}": the disk at {fs["mount"]} is {pct:g} % full. Server disk shows what takes the space.'))
        return out


def docker_restarts(policy: str | None, exit_code: str) -> bool:
    """Whether Docker restarts a container with this restart policy after this exit."""
    if policy in ("always", "unless-stopped"):
        return True
    if policy == "on-failure":
        return exit_code != "0"
    return False  # "no" / none: whatever starts it again, it isn't Docker


async def confirm(problem: dict, inspect, alerts: "Alerts") -> dict | None:
    """Settle a check-oom / check-loop answer of on_event by looking at the container
    (`inspect(cid)` -> its inspect JSON, from whichever engine it is on). The alert, or None."""
    try:
        info = await inspect(problem["containerId"])
    except Exception:
        return None  # removed already: whoever runs it cleans up, so not a container stuck restarting
    if problem["kind"] == "check-oom":
        return alerts.out_of_memory(problem["containerId"], problem["name"]) if (info.get("State") or {}).get("OOMKilled") else None
    policy = ((info.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name")
    if not docker_restarts(policy, problem["exitCode"]):
        return None
    more = alerts.report(problem["key"])
    return None if more is None else {**problem["alert"], "message": problem["alert"]["message"] + more}


def _duration(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} minutes"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min" if minutes else f"{hours} h"


def _alert(kind: str, severity: str, name: str, cid: str, message: str) -> dict:
    return {"kind": kind, "severity": severity, "name": name, "containerId": cid, "message": message, "at": time.time()}


_RFC3339 = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?")


def _timestamp(text: str | None) -> float | None:
    """Docker's RFC 3339 time with nanoseconds and an offset -> epoch seconds. The offset matters:
    `info.SystemTime` carries the daemon's local one (e.g. +02:00), task times are in UTC."""
    m = _RFC3339.fullmatch((text or "").strip())
    if not m:
        return None
    head, frac, offset = m.groups()
    try:
        when = datetime.fromisoformat(head + ("+00:00" if offset in (None, "Z") else offset))
    except ValueError:
        return None
    return when.timestamp() + (float("0." + frac[:6]) if frac else 0.0)


alerts = Alerts()
