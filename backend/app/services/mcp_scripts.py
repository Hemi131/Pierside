"""run_script ("code mode"): an assistant sends a Python script that calls the other tools, and only what
the script prints goes back to it. Logs, listings and inspect output are filtered in the script
instead of passing through the assistant's context, and loops over many containers or engines take
one call instead of dozens.

Where it runs: a sandbox container on the local engine (Pierside's own machinery, whatever engines the
connection uses), made from Pierside's own image for each run and removed after it: no network, no
Docker socket, no mounts, read-only root (a small /tmp), user nobody, every capability dropped,
no-new-privileges, an init, one CPU, 256 MB, 16 processes. Its only way out is the exec's stdin /
stdout, where mcp_script_runner.py speaks a JSON-lines protocol (see there). Every call it asks for
goes through mcp_invoke.invoke with the connection looked up again (`_refresh`), exactly as a direct
call, so a script can never do more than the assistant could do call by call.

Nothing that comes out of the sandbox is taken as fact: the script shares the runner's process and
can write protocol lines itself. The calls made, the changes made, the time used are this module's
own records; a line from the sandbox can only ask for a call (checked like any), add printed text, or
end its own run. A line that isn't the protocol ends the run.

Time: the run limit (`timeout_seconds`) doesn't count waiting for the user's answers; the wall limit
(WALL_S, everything from the start of the call) keeps the answer ahead of the stdio bridge giving up
(mcp_stdio.HTTP_TIMEOUT_S). At a limit a read call in progress is cancelled; a change is never cut
halfway: it finishes in the background and the answer says it was still running.

Approvals (approval-mode profiles; a token profile is never asked):
  * `scriptConfirm`: the user sees the script and allows it before it runs;
  * changes inside the script, where the profile's confirm setting asks for them (`scriptWrites`):
      plan: a first run with PLANNING = True records every change instead of making it (reads are
            real); the user allows the list once (changes the confirm setting doesn't ask about are
            listed too); a second run, in a fresh sandbox with its own run limit, may make only
            those changes, each once, with exactly the same arguments, on the same containers
            (`_same_container`: a name the user approved must not have come to mean another
            container in between); any other change stops it;
      kind: asked at the first change of each tool, with "allow the rest of this tool in this run";
      each: asked for every change, as for direct calls.
"""

import asyncio
import json
import logging
import os
import secrets
import socket
import time
from contextlib import asynccontextmanager

import aiodocker

from app.services.engines import LOCAL_URL
from app.services.helper import HELPER_LABEL, OWNER_LABEL, install_id
from app.services.mcp_access import APPROVAL_WAIT_S, Profile, approvals, clients, profiles, waiting
from app.services.mcp_invoke import PLANNED, Called, Via, _target, call_detail, invoke, needs_confirm
from app.services.mcp_tools import (
    NOT_IN_SCRIPTS,
    RESULT_CHARS,
    TOOLS,
    Ctx,
    Denied,
    Out,
    ToolError,
    _add_truncated,
    _arr,
    _bound,
    _cut_text,
    _enum,
    _I,
    _int,
    _N,
    _null,
    _obj,
    _opt,
    _resolve,
    _S,
    _size,
    _strs,
    _truncated,
    _TRUNCATED,
    allowed_tools,
    call_level,
    tool,
)

log = logging.getLogger("pierside.mcp")

with open(os.path.join(os.path.dirname(__file__), "mcp_script_runner.py"), encoding="utf-8") as _f:
    RUNNER = _f.read()

SCRIPT_MAX_CHARS = 20_000  # the longest script taken (the user may be shown it whole)
DEFAULT_TIMEOUT_S = 60
MAX_TIMEOUT_S = 120
# Everything, from the start of the call: waiting for a sandbox, every question, both runs of a planned
# script. Below mcp_stdio.HTTP_TIMEOUT_S (300) with room to answer: an answer after the bridge gave up
# is lost, and the assistant might run the script again.
WALL_S = 270
MAX_CALLS = 500  # tool calls per run
MAX_LINE_BYTES = 8 * 1024 * 1024  # one protocol line from the sandbox
SLOTS = 3  # sandboxes at a time
SLOT_WAIT_S = 30
OTHER_OUTPUT_CHARS = 4000  # what the sandbox wrote below Python (stderr stream), kept from the end
REMOVE_WAIT_S = 10  # how long the answer waits for the sandbox's removal (it goes on afterwards)
SANDBOX_USER = "65534:65534"  # nobody
MAX_PLAN = 100  # changes one plan may ask the user about (they read each)
PLAN_ANSWER_MIN_S = 30  # a planned script's two runs leave the user at least this long to answer the plan
_PLAN_RUN_MAX_S = (WALL_S - PLAN_ANSWER_MIN_S - 2 * REMOVE_WAIT_S) // 2  # each run of a planned script (see _run_seconds)
PLAN_LINE_CHARS = 1000  # one planned change as the user reads it
SANDBOX_LABEL = "script"  # HELPER_LABEL's value: not "true", so remove_all_helpers (engine switches) leaves running scripts alone

_slots = asyncio.Semaphore(SLOTS)
_background: set[asyncio.Task] = set()  # changes left to finish after their run ended (see _call)


async def _take_slot(wait: float, busy: str) -> None:
    """One of the SLOTS sandboxes, waiting at most SLOT_WAIT_S (and `wait`); ToolError(busy) if none."""
    try:
        await asyncio.wait_for(_slots.acquire(), max(0.0, min(SLOT_WAIT_S, wait)))
    except asyncio.TimeoutError:
        raise ToolError(busy)

STOPS = ("time", "wall", "calls", "connection", "protocol", "sandbox", "offPlan")
_STOP_TEXT = {
    "time": "The script reached its time limit and was stopped.",
    "wall": f"The script was stopped: everything together (waiting for the user included) may take at most {WALL_S} seconds.",
    "calls": f"The script made more than {MAX_CALLS} tool calls and was stopped.",
    "connection": "The connection was switched off, removed or changed in Pierside (AI access), or this session is no longer allowed, so the script was stopped.",
    "protocol": "The script wrote something to Pierside's channel that isn't its protocol, so it was stopped.",
    "sandbox": "The script ended without finishing (out of memory, processes or CPU time, or its sandbox failed).",
    "offPlan": "The script made a change that isn't in the plan the user allowed, so it was stopped.",
}
CHANGE_OUTCOMES = ("made", "failed", "refused", "stillRunning")
_PLANNING_NOTE = ("This was the planning run (PLANNING = True): its {changes} only recorded (each returned {{'planned': True, 'tool': name}}), "
                  "none was made, and the script didn't run again.")


def _planning_note(planned: int) -> str:
    """The note for a planning run that ended early; none when it had recorded no change, because a
    script that changes nothing has no second run and its reads were real."""
    if not planned:
        return ""
    return _PLANNING_NOTE.format(changes="change was" if planned == 1 else f"{planned} changes were")


class _Stop(Exception):
    def __init__(self, reason: str, note: str = "") -> None:
        super().__init__(reason)
        self.reason, self.note = reason, note


class _Clock:
    """The run limit, which doesn't count time spent waiting for the user (`hold` / `release`), within
    the wall limit, which counts everything."""

    def __init__(self, run_s: float, wall_end: float) -> None:
        self.run_end = time.monotonic() + run_s
        self.wall_end = wall_end
        self.held_at: float | None = None

    def hold(self) -> None:
        if self.held_at is None:
            self.held_at = time.monotonic()

    def release(self) -> None:
        if self.held_at is not None:
            self.run_end += time.monotonic() - self.held_at
            self.held_at = None

    def run_left(self) -> float:
        return self.run_end - (self.held_at if self.held_at is not None else time.monotonic())

    def wall_left(self) -> float:
        return self.wall_end - time.monotonic()

    def left(self) -> float:
        return min(self.run_left(), self.wall_left())

    def reason(self) -> str:
        return "wall" if self.wall_left() <= self.run_left() else "time"


# ---- the sandbox ---------------------------------------------------------------------------------------


async def _image(docker: aiodocker.Docker) -> str:
    """Pierside's own image, which has Python: the tag the backend was started from, or its image id
    when the tag is gone (a rebuild or an update can leave either missing). Nothing is pulled."""
    try:
        info = await docker._query_json(f"containers/{socket.gethostname()}/json")
    except aiodocker.DockerError as e:
        raise ToolError(f"Pierside can't find its own container on the local engine, which scripts run from ({e.message})")
    for ref in ((info.get("Config") or {}).get("Image"), info.get("Image")):
        if not ref:
            continue
        try:
            await docker._query_json(f"images/{ref}/json")
            return ref
        except aiodocker.DockerError as e:
            if e.status != 404:
                raise
    raise ToolError("Pierside's own image is missing on the local engine, so scripts can't run; reinstalling Pierside brings it back")


def _sandbox_config(image: str) -> dict:
    return {
        "Image": image,
        "Entrypoint": ["sleep"],
        "Cmd": [str(WALL_S + 60)],  # a backstop only: the run removes it, startup and shutdown sweep it
        "User": SANDBOX_USER,
        "WorkingDir": "/tmp",
        "Env": ["HOME=/tmp"],
        "Labels": {HELPER_LABEL: SANDBOX_LABEL, OWNER_LABEL: install_id()},
        "NetworkDisabled": True,
        "HostConfig": {
            "AutoRemove": True,
            "Init": True,  # reaps orphans: with `sleep` as PID 1 a fork bomb's zombies keep the pids limit full
            "NetworkMode": "none",
            "ReadonlyRootfs": True,
            "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=16m"},
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges"],
            "Memory": 256 * 1024 * 1024,
            "MemorySwap": 256 * 1024 * 1024,
            "PidsLimit": 16,
            "NanoCpus": 1_000_000_000,
        },
    }


async def _remove(docker: aiodocker.Docker, cid: str | None) -> None:
    try:
        if cid:
            try:
                await docker._query_json(f"containers/{cid}", method="DELETE", params={"force": "true", "v": "true"})
            except aiodocker.DockerError as e:
                if e.status not in (404, 409):  # gone already, or AutoRemove under way
                    log.warning("can't remove script sandbox %s: %s", cid[:12], e)
    finally:
        await docker.close()


@asynccontextmanager
async def _sandbox():
    """A fresh sandbox; removed whatever way the run ends (also when the call is cancelled)."""
    docker = aiodocker.Docker(url=LOCAL_URL)
    cid = None
    try:
        image = await _image(docker)
        try:
            created = await docker._query_json("containers/create", method="POST", data=json.dumps(_sandbox_config(image)), headers={"Content-Type": "application/json"})
            cid = created["Id"]
            await docker._query_json(f"containers/{cid}/start", method="POST")
        except aiodocker.DockerError as e:
            raise ToolError(f"The script's sandbox couldn't be started: {e.message}")
        yield docker, cid
    finally:
        removal = asyncio.ensure_future(_remove(docker, cid))
        try:
            await asyncio.wait_for(asyncio.shield(removal), REMOVE_WAIT_S)
        except asyncio.TimeoutError:
            _keep(removal)  # goes on; the answer doesn't wait for a slow engine
        except asyncio.CancelledError:
            _keep(removal)
            raise  # the call was cancelled meanwhile: nothing after this run may happen (plan question, second run)


def _keep(task: asyncio.Task) -> None:
    """Let a task finish in the background (held, so it isn't collected half-way)."""
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _reap(task: asyncio.Task) -> None:
    """Wait for a task just cancelled. Its own CancelledError is swallowed; a cancellation of the caller
    that lands meanwhile is not."""
    try:
        await task
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if current is not None and current.cancelling():
            raise
    except Exception:
        pass


async def remove_sandboxes() -> None:
    """Remove script sandboxes this install left behind (startup, shutdown), and unlabelled old ones;
    never another install's. On the local engine, where they always run, whatever engine is active."""
    try:
        async with aiodocker.Docker(url=LOCAL_URL) as docker:
            found = await docker._query_json("containers/json", params={"all": "1", "filters": json.dumps({"label": [f"{HELPER_LABEL}={SANDBOX_LABEL}"]})})
            for c in found:
                if (c.get("Labels") or {}).get(OWNER_LABEL) not in (None, install_id()):
                    continue
                try:
                    await docker._query_json(f"containers/{c['Id']}", method="DELETE", params={"force": "true", "v": "true"})
                except aiodocker.DockerError:
                    pass
    except Exception as e:  # never hold up startup or shutdown for this
        log.debug("can't clean up script sandboxes: %s", e)


# ---- one run -------------------------------------------------------------------------------------------


class ScriptRun:
    def __init__(self, cx: Ctx, code: str, timeout: int) -> None:
        self.cx = cx
        self.code = code
        self.timeout = timeout
        self.session = cx.session
        self.profile: Profile = cx.profile  # as it applies now (see _refresh)
        self._as = (cx.profile.id, cx.profile.auth, cx.profile.tokenHash)
        self.label = f"script {secrets.token_hex(2)}"
        self.started = time.monotonic()
        self.wall_end = self.started + WALL_S
        self.run_s = float(timeout)  # each run's limit (see _run_seconds)
        self.clock = _Clock(timeout, self.wall_end)  # started again for each run, once it has a sandbox slot
        self.ended = False  # stopped or cancelled: a call still on its way to the gate is refused there
        self.names = sorted(t.name for t in allowed_tools(cx.profile) if t.name not in NOT_IN_SCRIPTS)
        self.planning = False
        self.calls = 0
        self.planning_calls = 0
        self.output: list[str] = []
        self.output_chars = 0
        self.output_omitted = 0
        self.error: str | None = None
        self.other = ""
        self.stopped: _Stop | None = None
        self.changes: list[dict] = []
        self._in_gate = False
        self.mode = cx.profile.scriptWrites if cx.profile.auth == "approval" else None  # as it was when the run started
        self.kinds: set[str] = set()  # kind mode: tools the user allowed for the rest of the run
        # The planning run's changes: {key, line, needs, tool, engine}, and for a change naming a container
        # also `container` (its id then, None if none had that name) and `ref` (the name as given);
        # `newName` for a rename.
        self.plan: list[dict] = []
        self.seen: dict[str, set[str]] = {}  # every container id on an engine when the plan first named a container there
        self.left: list[dict] = []  # the second run: planned changes still to be made
        self.planned_run = False  # this is the second run of a planned script
        self._off_plan = False
        self.plan_size = 0
        self.note = ""

    # -- the connection, looked up again before every call --

    def _refresh(self) -> Profile:
        pid, auth, token_hash = self._as
        stored = profiles.get(pid)
        if stored is None or not stored.enabled or stored.auth != auth or (auth == "token" and stored.tokenHash != token_hash):
            raise _Stop("connection")
        if auth == "approval" and not approvals.session_ok(stored, self.session):
            raise _Stop("connection")
        effective = approvals.effective(stored, self.session)
        if not effective.allows("scripts"):
            raise _Stop("connection")
        self.profile = effective
        return effective

    # -- questions --

    async def _ask(self, kind: str, row: dict | None, limit: float | None = None, **kwargs) -> str:
        """A question to the user; the run limit doesn't count the wait, the wall limit does (and
        `limit`, if given, too)."""
        wait = self.wall_end - time.monotonic()
        if limit is not None:
            wait = min(wait, limit)
        self.clock.hold()
        if row is not None:
            waiting(row, True)
        try:
            return await approvals.ask(self.profile, self.session, kind, wait=max(0.0, wait), **kwargs)
        finally:
            if row is not None:
                waiting(row, False)
            self.clock.release()

    def _may_ask(self) -> bool:
        """Could a change this script can make need the user's approval? If not, planning is pointless.
        run_container counts at its highest level (destructive with a host folder, see call_level)."""
        return any(needs_confirm(self.profile, "destroy" if t.name == "run_container" else t.level) for t in allowed_tools(self.profile) if t.name not in NOT_IN_SCRIPTS)

    async def _container(self, engine: str, ref) -> str | None:
        """The id of the shared container `ref` names on that engine now (as the tools resolve it), or None."""
        cx = Ctx(self.profile, engine, await clients.get(engine), self.session)
        try:
            return (await _resolve(cx, ref))["Id"]
        except (ToolError, Denied):
            return None

    def _same_container(self, entry: dict, now: str | None) -> bool:
        """Does the container a planned change names now count as the one the user approved? The same
        one; or one that didn't exist when the plan was made where the plan accounts for it: it named
        no container then (or one the plan deletes) and a planned run_container creates this name, or
        a planned recreate_container replaced the one it named; or it is a container the plan itself
        renamed to this name, where the name meant no container then or one the plan deletes. A name
        that has come to mean another existing container (renamed by anyone between the runs, or by the
        script outside the plan) never does. None now: the tool will say it isn't there."""
        if "container" not in entry or now is None or now == entry["container"]:
            return True
        engine = entry["engine"]
        plan = [e for e in self.plan if e["engine"] == engine]
        old = entry["container"]
        # The name was free then, or the plan frees it.
        freed = old is None or any(e["tool"] == "delete_container" and e.get("container") == old for e in plan)
        if now not in self.seen.get(engine, set()):  # created since the plan was made
            if old is not None and any(e["tool"] == "recreate_container" and e.get("container") == old for e in plan):
                return True
            # A container nothing in the plan creates under this name was made by someone else.
            return freed and (old is None or any(e.get("creates") == entry["ref"] for e in plan))
        return freed and any(e.get("newName") == entry["ref"] and e.get("container") == now for e in plan)

    async def _gate(self, name: str, args: dict, level: str, target: str, row: dict, engine: str) -> object:
        """Decides about the user's approval for a call of this script (mcp_invoke.Via): None to go
        ahead, PLANNED to record it (planning run), else the refusal."""
        self._in_gate = True
        try:
            p = self.profile
            if self.ended:  # the run is over (stopped, or its call cancelled): nothing more is done for it
                return "The script was stopped before this change; nothing was done."
            if level == "read":
                return None
            if self.planning:
                # Only checks that reveal nothing about the engine (invoke has checked the action, the
                # engine and unknown arguments); containers and paths are checked when it is made, since
                # an earlier planned change may create what a later one uses.
                missing = [k for k in TOOLS[name].schema.get("required") or [] if args.get(k) in (None, "")]
                if missing:
                    raise ToolError(f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} required")
                entry = {"key": _key(name, args, engine), "line": _plan_line(name, args, target), "needs": p.auth == "approval" and needs_confirm(p, level), "tool": name, "engine": engine}
                if "container" in args:
                    # Which container the user approves is the one the name means now (the script
                    # learns nothing from it: the answer is PLANNED either way).
                    if engine not in self.seen:
                        self.seen[engine] = await _all_ids(engine)
                    entry["ref"] = _ref(args["container"])
                    entry["container"] = await self._container(engine, args["container"])
                    if name == "rename_container":
                        entry["newName"] = _ref(args.get("new_name"))
                if name == "run_container" and _ref(args.get("name")):
                    entry["creates"] = _ref(args.get("name"))
                self.plan.append(entry)
                return PLANNED
            if self.planned_run:
                # Every change of the second run is one the plan listed (asked about or not), each once,
                # on the container it meant: the user saw them all, so nothing else may happen without
                # asking either.
                key = _key(name, args, engine)
                now = await self._container(engine, args["container"]) if "container" in args else None
                match = next((e for e in self.left if e["key"] == key and self._same_container(e, now)), None)
                if match is not None:
                    self.left.remove(match)  # each allowed change once
                    if now is not None:
                        args["container"] = now  # the tool acts on the container compared, whatever renames follow
                    return None
                self._off_plan = True
                if any(e["key"] == key for e in self.left):
                    return f"{_ref(args['container'])} is no longer the container it was when the user allowed the plan, so this change wasn't made, and the script was stopped."
                return "This change isn't in the plan the user allowed, so it wasn't made, and the script was stopped."
            if p.auth != "approval" or not needs_confirm(p, level):
                return None
            if self.mode == "kind" and name in self.kinds:
                return None
            answer = await self._ask("call", row, tool=name, target=target, detail=call_detail(args), via=self.label, kind_option=self.mode == "kind")
            if answer == "allow_kind" and self.mode == "kind":
                self.kinds.add(name)
                return None
            if answer == "allow":
                return None
            if answer == "timeout":
                return f"The user didn't answer within {APPROVAL_WAIT_S} seconds; nothing was done."
            return "The user refused this action."
        finally:
            self._in_gate = False

    # -- one call --

    def _change(self, name: str, args: dict, outcome: str, message: str = "") -> None:
        entry = {"tool": name, "target": _target(args), "outcome": outcome}
        if message:
            entry["message"] = message[:500]
        self.changes.append(entry)

    async def _call(self, msg: dict) -> dict:
        """One tool call the script asked for -> the answer it gets. _Stop ends the run."""
        rid, name, args = msg.get("id"), msg.get("tool"), msg.get("args")
        self.calls += 1
        if self.calls > MAX_CALLS:
            raise _Stop("calls")
        profile = self._refresh()
        if not isinstance(name, str) or not isinstance(args, dict):
            return {"id": rid, "ok": False, "kind": "error", "message": "A call names a tool and gives its arguments by name"}
        try:
            level = call_level(name, args) if name in TOOLS else "read"
        except Exception:  # arguments call_level can't read: the call itself will say what is wrong
            level = TOOLS[name].level
        task = asyncio.ensure_future(invoke(profile, self.session, name, args, Via(self.label, self._gate)))
        try:
            while not task.done():
                left = self.clock.left()
                if left <= 0:
                    reason = self.clock.reason()
                    if self._let_go(task, level):
                        self._change(name, args, "stillRunning", "still running when the script was stopped; its outcome is in Pierside's activity list")
                    else:
                        try:
                            await task
                        except (asyncio.CancelledError, Exception):
                            pass
                    raise _Stop(reason)
                await asyncio.wait({task}, timeout=min(1.0, left))
        except asyncio.CancelledError:
            # The run_script call itself was cancelled (the client went away, shutdown): the same as a
            # stop, so a question still open is withdrawn and a late "allow" runs nothing.
            if not task.done():
                self._let_go(task, level)
            raise
        called: Called = task.result()
        if level != "read" and called.outcome != "planned":
            outcome = {"ok": "made", "refused": "refused"}.get(called.outcome, "failed")
            self._change(name, args, outcome, called.message)
        if self._off_plan:
            raise _Stop("offPlan")
        if called.outcome == "ok":
            return {"id": rid, "ok": True, "data": called.out.data if called.out is not None else None}
        if called.outcome == "planned":
            return {"id": rid, "ok": True, "data": {"planned": True, "tool": name}}
        return {"id": rid, "ok": False, "kind": called.outcome, "message": called.message}

    def _let_go(self, task: asyncio.Task, level: str) -> bool:
        """The run ends while a call of it is still going. A read, or a change still waiting for the
        user's answer (nothing done yet), is cancelled: cancelling the question withdraws it. A change
        under way is never cut halfway: it finishes in the background (its activity row says how);
        True then. A change that hasn't reached the gate yet is refused there (`ended`)."""
        self.ended = True
        if level == "read" or self._in_gate:
            task.cancel()
            return False
        _keep(task)
        return True

    # -- printed output --

    def _printed(self, text) -> None:
        if not isinstance(text, str):
            raise _Stop("protocol")
        room = RESULT_CHARS - self.output_chars
        if room > 0:
            self.output.append(text[:room])
            self.output_chars += min(len(text), room)
        self.output_omitted += max(0, len(text) - max(0, room))

    # -- the protocol --

    async def _send(self, stream, message: dict) -> None:
        try:
            line = (json.dumps(message, allow_nan=False) + "\n").encode()
        except (TypeError, ValueError):
            log.exception("run_script: a result can't be passed to the script")
            line = (json.dumps({"id": message.get("id"), "ok": False, "kind": "internal", "message": "Pierside couldn't pass this result to the script"}) + "\n").encode()
        left = self.clock.left()
        if left <= 0:
            raise _Stop(self.clock.reason())
        try:
            await asyncio.wait_for(stream.write_in(line), left)
        except asyncio.TimeoutError:  # the runner doesn't read its input
            raise _Stop(self.clock.reason())
        except (ConnectionError, OSError, RuntimeError):
            raise _Stop("sandbox")

    async def _execute(self, docker: aiodocker.Docker, cid: str) -> None:
        """One run of the script in the sandbox, until the runner says it is done. _Stop otherwise."""
        exe = await docker.containers.container(cid).exec(["python", "-I", "-B", "-c", RUNNER], stdin=True, stdout=True, stderr=True, tty=False, user=SANDBOX_USER, workdir="/tmp")
        first = {"v": 1, "code": self.code, "tools": self.names, "planning": self.planning, "cpuSeconds": int(self.run_s) + 5, "maxCalls": MAX_CALLS}
        frames: asyncio.Queue = asyncio.Queue()

        async with exe.start(detach=False) as stream:

            async def pump() -> None:
                try:
                    while True:
                        msg = await stream.read_out()
                        await frames.put(msg and (msg.stream, msg.data))
                        if msg is None:
                            return
                except Exception as e:  # the stream broke: the run is over
                    log.debug("run_script stream: %s", e)
                    await frames.put(None)

            reader = asyncio.ensure_future(pump())
            try:
                await self._send(stream, first)
                buf = bytearray()
                expected = 1
                while True:
                    item = await self._next(frames)
                    if item is None:
                        raise _Stop("sandbox")
                    kind, data = item
                    if kind == 2:
                        self.other = (self.other + data.decode("utf-8", "replace"))[-OTHER_OUTPUT_CHARS:]
                        continue
                    buf += data
                    while True:
                        end = buf.find(b"\n")
                        if end < 0:
                            if len(buf) > MAX_LINE_BYTES:
                                raise _Stop("protocol")
                            break
                        line = bytes(buf[:end])
                        del buf[: end + 1]
                        if len(line) > MAX_LINE_BYTES:
                            raise _Stop("protocol")
                        try:
                            msg = _utf8(json.loads(line))
                        except (ValueError, RecursionError):
                            raise _Stop("protocol")
                        if not isinstance(msg, dict):
                            raise _Stop("protocol")
                        t = msg.get("t")
                        if t == "print":
                            self._printed(msg.get("text"))
                        elif t == "done":
                            error = msg.get("error")
                            self.error = error[:5000] if isinstance(error, str) else None
                            await self._drain(frames)
                            return
                        elif t == "call" and msg.get("id") == expected:
                            expected += 1
                            await self._send(stream, await self._call(msg))
                        else:
                            raise _Stop("protocol")
            finally:
                reader.cancel()
                await _reap(reader)

    async def _drain(self, frames: asyncio.Queue) -> None:
        """After "done": stderr comes through its own pipe and can arrive after it. The runner exits
        right away, so read until the stream ends (a second at most); stdout is no longer read."""
        end = time.monotonic() + min(1.0, max(0.0, self.clock.wall_left()))
        while (left := end - time.monotonic()) > 0:
            try:
                item = await asyncio.wait_for(frames.get(), left)
            except asyncio.TimeoutError:
                return
            if item is None:
                return
            if item[0] == 2:
                self.other = (self.other + item[1].decode("utf-8", "replace"))[-OTHER_OUTPUT_CHARS:]

    async def _next(self, frames: asyncio.Queue):
        """The next frame from the sandbox, within the limits; the connection is checked every second."""
        while True:
            left = self.clock.left()
            if left <= 0:
                raise _Stop(self.clock.reason())
            try:
                return await asyncio.wait_for(frames.get(), min(1.0, left))
            except asyncio.TimeoutError:
                self._refresh()

    # -- the whole call --

    async def run(self) -> Out:
        cx, p = self.cx, self.cx.profile
        if cx.row is not None:
            cx.row["target"] = self.label
        if p.auth == "approval" and p.scriptConfirm:
            answer = await self._ask("script", cx.row, tool="run_script", target=self.label, detail="", script=self.code, via=self.label)
            if answer == "timeout":
                raise ToolError(f"The user didn't answer within {APPROVAL_WAIT_S} seconds. Ask them to look at Pierside (AI access), then send the script again; it is shown to them each time.")
            if answer != "allow":
                raise Denied("the user refused to run this script")
        await _take_slot(self.wall_end - time.monotonic(), f"Pierside is running {SLOTS} scripts already; try again in a moment")
        try:
            self.planning = self.mode == "plan" and self._may_ask()
            self.run_s = self._run_seconds()
            self.clock = _Clock(self.run_s, self.wall_end)  # waiting for the user and for a slot didn't count
            await self._one_run()
        finally:
            _slots.release()  # also while the user reads a plan: no sandbox runs then
        if self.planning:
            return await self._after_planning()
        return self._result()

    def _run_seconds(self) -> float:
        """Each run's limit: timeout_seconds. A planned script runs twice with the user's answer in
        between, all within the wall limit, so each run gets at most half of what is left of it after
        PLAN_ANSWER_MIN_S for the answer and the two sandboxes' removal: the second run always has its
        whole limit."""
        if not self.planning:
            return float(self.timeout)
        room = (self.wall_end - time.monotonic() - PLAN_ANSWER_MIN_S - 2 * REMOVE_WAIT_S) / 2
        return max(5.0, min(float(self.timeout), room))

    async def _one_run(self) -> None:
        """One run of the script in a fresh sandbox; how it ended is in self.error / self.stopped."""
        async with _sandbox() as (docker, cid):
            try:
                self._refresh()
                await self._execute(docker, cid)
            except _Stop as e:
                self.stopped = e

    async def _after_planning(self) -> Out:
        """The planning run is over: ask about its changes, then run the script again to make them."""
        if self.error or self.stopped:
            self.note = _planning_note(len(self.plan))
            return self._result()
        if not self.plan:  # it changes nothing, and its reads were real: that was the run
            self.planning = False
            return self._result()
        asked = [e for e in self.plan if e["needs"]]
        also = [e["line"] for e in self.plan if not e["needs"]]
        if len(asked) > MAX_PLAN:
            raise ToolError(f"The script would make {len(asked)} changes that need the user's approval; at most {MAX_PLAN} in one plan. Nothing was changed; split the work.")
        long = next((e["line"] for e in self.plan if len(e["line"]) > PLAN_LINE_CHARS), None)
        if long:
            raise ToolError(f"A planned change is too long to show the user ({long[:200]}…). Nothing was changed; pass smaller arguments.")
        if asked:
            # The second run keeps its whole limit: the answer may take what is left beyond it.
            wait = min(APPROVAL_WAIT_S, self.wall_end - time.monotonic() - self.run_s - REMOVE_WAIT_S)
            answer = await self._ask("plan", self.cx.row, limit=wait, tool="run_script", target=self.label, detail="", items=[e["line"] for e in asked], also=also, script=self.code, via=self.label)
            if answer == "timeout":
                raise ToolError(f"The user didn't answer within {max(0, round(wait))} seconds; nothing was changed. Ask them to look at Pierside (AI access), then send the script again.")
            if answer != "allow":
                raise Denied(f"the user refused the script's {len(asked)} change{'s' if len(asked) != 1 else ''}; nothing was changed")
        # Every change the plan lists may be made once, also those the user wasn't asked about (see _gate).
        self.left = list(self.plan)
        self.plan_size = len(self.plan)
        # The slot was given back while the user read the plan.
        await _take_slot(
            min(SLOT_WAIT_S, self.wall_end - time.monotonic() - self.run_s),
            f"Pierside is running {SLOTS} scripts already, so the script didn't run again and nothing was changed; send it again in a moment",
        )
        try:
            # The second run starts afresh, with its own run limit: what the planning run printed or
            # left behind, and the time it took, don't count.
            self.planning, self.planned_run, self.planning_calls, self.calls = False, True, self.calls, 0
            self.output, self.output_chars, self.output_omitted, self.error, self.other, self.changes = [], 0, 0, None, "", []
            self.clock = _Clock(self.run_s, self.wall_end)
            await self._one_run()
        finally:
            _slots.release()
        return self._result()

    def _result(self) -> Out:
        data: dict = {"output": "", "error": self.error, "toolCalls": self.calls, "seconds": round(time.monotonic() - self.started, 1), "changes": self.changes}
        if self.planning_calls:
            data["planningToolCalls"] = self.planning_calls
        if self.other.strip():
            data["otherOutput"] = self.other
        if self.stopped:
            data["stopped"] = self.stopped.reason
            note = self.stopped.note
            if self.stopped.reason == "time" and self.run_s < self.timeout:
                note = f"A script that is planned first runs twice within the {WALL_S}-second limit, so each run had {round(self.run_s)} seconds."
            data["stopNote"] = _STOP_TEXT[self.stopped.reason] + (f" {note}" if note else "")
        if self.note:
            data["note"] = self.note
        _bound(data, "changes", "changes", RESULT_CHARS // 4)
        if self.planned_run:
            # Up to MAX_CALLS lines of up to PLAN_LINE_CHARS each: bounded like any list of the answer.
            unused = {"unused": [e["line"] for e in self.left]}
            _bound(unused, "unused", "planned changes that weren't made", RESULT_CHARS // 4)
            data["plan"] = {"approved": self.plan_size, "unused": unused["unused"]}
            if unused.get("truncated"):
                _add_truncated(data, unused["truncated"])
        _bound_output(data, "".join(self.output), self.output_omitted)
        return Out(data, _text(data))


def _utf8(value):
    """A protocol line's value with every lone surrogate replaced ("?"). json.loads takes "\\udcff" (and
    raw surrogate bytes, which it decodes with surrogatepass), and such text can't be encoded as UTF-8:
    printed, in a call's arguments or a failure, it would break the HTTP answer, the activity list and
    the events sent to the UI."""
    if isinstance(value, str):
        if value.isascii():
            return value
        try:
            value.encode("utf-8")
            return value
        except UnicodeEncodeError:
            return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, dict):
        return {_utf8(k): _utf8(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_utf8(v) for v in value]
    return value


def _key(name: str, args: dict, engine: str) -> str:
    """A change as the plan knows it: tool, engine and exact arguments."""
    return json.dumps([name, engine, args], sort_keys=True, ensure_ascii=False)


def _ref(value) -> str:
    """A container name as _resolve reads it."""
    return value.strip().lstrip("/") if isinstance(value, str) else ""


async def _all_ids(engine: str) -> set[str]:
    """Every container's id on the engine, shared or not (only to tell old containers from new ones)."""
    docker = await clients.get(engine)
    return {c["Id"] for c in await docker._query_json("containers/json", params={"all": "1"})}


def _plan_line(name: str, args: dict, target: str) -> str:
    """A planned change as the user reads it (content by its length only, as in a call's question)."""
    detail = "; ".join(call_detail(args).splitlines())
    return " ".join(x for x in (name.replace("_", " "), target, f"({detail})" if detail else "") if x)


def _bound_output(data: dict, text: str, omitted_before: int) -> None:
    """The printed output that fits in what is left of the answer: whole lines from the start (a single
    line longer than all of it: its start), and a `truncated` entry for the rest."""
    budget = max(0, RESULT_CHARS - _size({k: v for k, v in data.items() if k != "output"}))
    kept, used = [], 0
    lines = text.splitlines(keepends=True)
    for line in lines:
        used += len(json.dumps(line, ensure_ascii=False)) - 2
        if used > budget:
            break
        kept.append(line)
    if lines and not kept:
        kept = [_cut_text(lines[0], budget)]
    shown = "".join(kept)
    left_out = len(text) - len(shown) + omitted_before
    data["output"] = shown
    if left_out:
        _add_truncated(data, _truncated("printed output", "first", left_out, f"{left_out} more characters the script printed are not shown; print less (filter or summarise in the script)"))


def _text(data: dict) -> str:
    parts = [data["output"].rstrip("\n") or "(the script printed nothing)"]
    if data.get("truncated"):
        parts.append(f"… {data['truncated']['note']}")
    if data["error"]:
        parts.append(f"The script failed:\n{data['error'].rstrip()}")
    if data.get("stopped"):
        parts.append(data["stopNote"])
    if data.get("note"):
        parts.append(data["note"])
    if data.get("plan"):
        plan = data["plan"]
        parts.append(f"The plan had {plan['approved']} change{'s' if plan['approved'] != 1 else ''}" + (f"; not made: {'; '.join(plan['unused'])}" if plan["unused"] else "") + ".")
    if data.get("otherOutput"):
        parts.append(f"Other output (below Python):\n{data['otherOutput'].rstrip()}")
    if data["changes"]:
        parts.append("Changes: " + "; ".join(" ".join(x for x in (c["tool"], c["target"]) if x) + f": {c['outcome']}" for c in data["changes"]))
    calls = data["toolCalls"]
    planning = f" (and {data['planningToolCalls']} in the planning run)" if data.get("planningToolCalls") else ""
    parts.append(f"— {calls} tool call{'s' if calls != 1 else ''}{planning}, {data['seconds']} s")
    return "\n".join(parts)


# ---- the tool ------------------------------------------------------------------------------------------

_INTRO = (
    "Run a Python script that calls the tools above, for work that takes many calls or reads a lot: only what the script prints "
    "comes back to you, so filter and summarise in the script. In it, `tools.<name>(**arguments)` calls a tool you can use "
    "(same names and arguments, `engine` included) and returns its result as data (shapes below; every list result may carry "
    "`truncated` = {what, kept, omitted, note, next}). `pages(name, **arguments)` yields each page, following `truncated.next`. "
    "Never write back file content from a read whose `complete` isn't true. A failed call raises ToolFailed (.kind: denied, refused, "
    "error, unreachable or internal; .message). `tools.names()` lists the tools. Standard library only; no network, no files "
    f"outside /tmp; one CPU, 256 MB; at most {MAX_CALLS} tool calls and `timeout_seconds` of running (waiting for the user doesn't "
    f"count), {WALL_S} seconds in all. Every call is checked like a direct one, and changes may need the user's approval "
    "(connection_info, userConfirmation.scripts). When a plan is asked for, the script first runs with PLANNING = True: reads are "
    "real and see the world before any change, a change (run_command included) only returns"
    "{'planned': True, 'tool': name}, so read nothing else from its result while PLANNING, and once the user allowed the "
    "list the script runs again and may make only those changes, with exactly the same arguments (a different change stops it); "
    f"each of the two runs gets `timeout_seconds`, at most {_PLAN_RUN_MAX_S} and less when the wait before it was long. "
    "So keep it deterministic, don't let a later step depend on an earlier change, and don't let the output depend on PLANNING "
    "(a script that changes nothing runs only once). "
    "Example: for c in tools.list_containers()['containers']: print(c['name'], c['state'])"
)
_SHAPES_CHARS = 9000


def _shape(schema: dict, depth: int) -> str:
    """A compact picture of an output schema: object keys (? = may be missing), lists as [item]."""
    if "anyOf" in schema:
        return " | ".join(_shape(s, depth) for s in schema["anyOf"] if s.get("type") != "null")
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), None)
    if kind == "array":  # a list doesn't use up depth: its items' keys are what a script needs
        return f"[{_shape(schema.get('items') or {}, depth)}]"
    if kind == "object" and schema.get("properties"):
        if depth <= 0:
            return "{…}"
        required = set(schema.get("required") or [])
        keys = []
        for key, sub in schema["properties"].items():
            name = key + ("" if key in required else "?")
            inner = "" if key == "truncated" else _shape(sub, depth - 1)  # described once, in the intro
            keys.append(f"{name}: {inner}" if inner.startswith(("{", "[")) and inner != "{…}" else name)
        return "{" + ", ".join(keys) + "}"
    return ""


def describe(profile: Profile) -> str:
    """run_script's description for this profile: the rules and the shapes of the tools it may call."""
    usable = [t for t in allowed_tools(profile) if t.name not in NOT_IN_SCRIPTS]
    for depth in (2, 1):
        shapes = "\n".join(f"{t.name} -> {_shape(t.out, depth)}" for t in usable)
        if len(shapes) <= _SHAPES_CHARS:
            break
    return f"{_INTRO}\nResult shapes:\n{shapes}"


_OUT = _obj(
    output=_S,
    error=_null(_S),
    otherOutput=_opt(_S),
    truncated=_TRUNCATED,
    toolCalls=_I,
    planningToolCalls=_opt(_I),
    seconds=_N,
    stopped=_opt(_enum(*STOPS)),
    stopNote=_opt(_S),
    note=_opt(_S),
    changes=_arr(_obj(tool=_S, target=_S, outcome=_enum(*CHANGE_OUTCOMES), message=_opt(_S))),
    plan=_opt(_obj(approved=_I, unused=_strs())),
)


@tool(
    "run_script",
    "scripts",
    "script",
    _INTRO,
    {
        "code": {"type": "string", "description": f"The Python script (up to {SCRIPT_MAX_CHARS} characters)"},
        "timeout_seconds": {"type": "integer", "description": f"Time limit for running, 5 to {MAX_TIMEOUT_S} (default {DEFAULT_TIMEOUT_S}); time waiting for the user doesn't count. A script planned first gets it for each of its two runs, at most {_PLAN_RUN_MAX_S}"},
    },
    ("code",),
    out=_OUT,
)
async def run_script(cx: Ctx, args: dict) -> Out:
    code = args.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ToolError("code is required")
    if len(code) > SCRIPT_MAX_CHARS:
        raise ToolError(f"The script is {len(code)} characters; at most {SCRIPT_MAX_CHARS}")
    return await ScriptRun(cx, code, _int(args, "timeout_seconds", DEFAULT_TIMEOUT_S, 5, MAX_TIMEOUT_S)).run()


TOOLS["run_script"].describe = describe
