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
Docker waits longer between restarts each time (up to a minute), hence the wide window.
"""

import time
from collections import deque
from datetime import datetime, timezone

LOOP_WINDOW_S = 5 * 60
LOOP_DEATHS = 3
KILL_MEMORY_S = 120  # how long a `kill` explains the `die` that follows (stop timeouts can be long)
REPEAT_S = 5 * 60  # the same alert about the same thing at most this often…
REPEAT_LOOP_S = 30 * 60  # …and a loop that just goes on, less often
SWARM_SERVICE_LABEL = "com.docker.swarm.service.name"


class Alerts:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Another engine, or a fresh start: forget what was counted."""
        self._deaths: dict[str, deque[tuple[float, str]]] = {}
        self._killed: dict[str, float] = {}
        self._last: dict[str, float] = {}

    def _once(self, key: str, every: float, now: float) -> bool:
        if key in self._last and now - self._last[key] < every:
            return False
        self._last[key] = now
        return True

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
            if self._once(f"oom:{cid}", REPEAT_S, now):
                return _alert("oom", "error", name, cid, f'"{name}" ran out of memory and was killed (OOM). Raise its memory limit or check for a leak.')
        elif action == "health_status" and detail == "unhealthy":
            if self._once(f"health:{cid}", REPEAT_S, now):
                return _alert("unhealthy", "warning", name, cid, f'"{name}" is unhealthy: its health check is failing.')
        elif action == "die":
            killed = self._killed.pop(cid, None)
            if killed is not None and now - killed < KILL_MEMORY_S:
                return None  # stopped, restarted or killed on purpose
            if SWARM_SERVICE_LABEL in attrs:
                return None  # counted per service task instead (swarm_alerts)
            deaths = self._deaths.setdefault(cid, deque(maxlen=20))
            deaths.append((now, str(attrs.get("exitCode", ""))))
            recent = [d for d in deaths if now - d[0] < LOOP_WINDOW_S]
            if len(recent) >= LOOP_DEATHS and self._once(f"loop:{cid}", REPEAT_LOOP_S, now):
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
                return _alert("loop", "warning", name, cid, text)
            if str(attrs.get("exitCode", "")) == "137":
                # Killed, but not by anyone using Docker: perhaps the kernel, for using too much memory.
                # Docker normally reports that with an `oom` event; where it doesn't, the caller can
                # look at the container (State.OOMKilled) and call out_of_memory().
                return {"kind": "check-oom", "containerId": cid, "name": name}
        return None

    def out_of_memory(self, cid: str, name: str, now: float | None = None) -> dict | None:
        """The container was found killed for running out of memory (not announced by an `oom` event)."""
        now = time.time() if now is None else now
        if self._once(f"oom:{cid}", REPEAT_S, now):
            return _alert("oom", "error", name, cid, f'"{name}" ran out of memory and was killed (OOM). Raise its memory limit or check for a leak.')
        return None

    def swarm_alerts(self, tasks: list[dict], services: dict[str, str], engine_now: float) -> list[dict]:
        """Service tasks that failed LOOP_DEATHS times in the window, in the same slot (or on the same
        node for global services). `services` maps service id -> name; `engine_now` is the engine's clock."""
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
        for (service_id, slot), items in failed.items():
            if len(items) < LOOP_DEATHS or not self._once(f"service:{service_id}:{slot}", REPEAT_LOOP_S, engine_now):
                continue
            items.sort(key=lambda x: x[0])
            status = items[-1][1].get("Status") or {}
            reason = (status.get("Err") or "").strip()
            code = (status.get("ContainerStatus") or {}).get("ExitCode")
            why = reason or (f"exit code {code}" if code is not None else status.get("Message") or "no reason given")
            name = services.get(service_id) or service_id[:12]
            label = f"{name}.{slot}" if items[-1][1].get("Slot") else name
            text = f'Swarm service "{name}": task {label} keeps failing, {len(items)} times in the last {LOOP_WINDOW_S // 60} minutes ({why}). Swarm starts a new one each time. Check the service\'s tasks and logs.'
            out.append({**_alert("service", "warning", name, "", text), "serviceId": service_id})
        return out


def _alert(kind: str, severity: str, name: str, cid: str, message: str) -> dict:
    return {"kind": kind, "severity": severity, "name": name, "containerId": cid, "message": message, "at": time.time()}


def _timestamp(text: str | None) -> float | None:
    """Docker's RFC 3339 time with nanoseconds -> epoch seconds."""
    if not text:
        return None
    head, _, frac = text.rstrip("Z").partition(".")
    try:
        return datetime.fromisoformat(head).replace(tzinfo=timezone.utc).timestamp() + (float("0." + frac[:6]) if frac[:6].isdigit() else 0.0)
    except ValueError:
        return None


alerts = Alerts()
