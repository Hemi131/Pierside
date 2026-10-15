"""Access profiles for the MCP server (AI assistants such as Claude Code).

A profile is one connection's permissions: which engines, which containers, which kinds of action,
and for files which paths. A profile with `god` set allows everything on its engines (the
containers Pierside always protects stay protected; see mcp_tools.py). How a client proves it may use a profile is the profile's `auth`:

  * "approval" (default): the client names the profile and holds no secret. It can only arrive
    through `docker exec` into this container (see routers/mcp.py), and the user allows each session
    in Pierside's UI, or trusts the connection for a period or for good. Optionally every
    state-changing call (commands, start/stop) asks again.
  * "token": for unattended use. The client sends the profile's token; only its SHA-256 hash is
    stored, so the token can be shown once (on creation or regeneration) and never again.

Everything is deny-by-default and enforced here and in mcp_tools.py, never by trusting the client.
Engine connections for MCP are separate from the UI's active engine, so a profile keeps working on
"its" engine whatever the user is looking at.
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import time
from collections import deque
from dataclasses import asdict, dataclass, field, replace
from fnmatch import fnmatchcase

import aiodocker

from app.services.engines import DATA_DIR, LOCAL_ID, LOCAL_URL, SOCK_DIR, EngineError, Tunnel, engines

log = logging.getLogger("pierside.mcp")

STORE = os.path.join(DATA_DIR, "mcp.json")
TOKEN_PREFIX = "pmcp_"

# Listing the shared containers is always allowed; everything else is opt-in per profile.
ACTIONS = (
    "logs",  # container, project and service logs
    "inspect",  # configuration, stats, processes, health, filesystem changes
    "files",  # list, read and search files (within the allowed paths)
    "filewrite",  # write, create, delete, chmod (within the allowed paths)
    "control",  # start, stop, restart, pause, kill; whole projects too
    "manage",  # create, rename and delete containers
    "exec",  # run commands inside containers
    "images",  # list and inspect images
    "imagepull",  # pull images
    "volumes",  # list and inspect volumes (their files also need "files")
    "networks",  # list and inspect networks
    "netconnect",  # connect and disconnect containers
    "ports",  # published ports and forwards
    "forward",  # create and remove port forwards
    "system",  # engine info, disk usage, events
    "swarm",  # nodes, stacks, services, tasks, secret names
    "compose",  # SSH engines: read Compose files and configuration, up, down
    "create",  # create volumes and networks
    "cleanup",  # delete images, volumes, networks; prune
    "swarmctl",  # scale, restart, update, roll back, remove services and stacks
)
CONFIRM_MODES = ("all", "destructive", "none")
MAX_LOG_LINES = 5000
AUTH_MODES = ("approval", "token")
# How long an approval can be remembered ("always" = until the user revokes it).
TRUST_SECONDS = {"day": 86400, "week": 7 * 86400, "month": 30 * 86400}
APPROVAL_WAIT_S = 60  # how long a call waits for the user's answer before giving up
SESSION_FIRST_WAIT_S = 5  # a new session's first call: just long enough for a user already at the prompt
REFUSAL_PAUSE_S = 120  # how long a session can't ask for more access after the user answered "deny and pause"
SESSION_QUESTION_S = 600 # how long a session question stays open in the UI


@dataclass
class Profile:
    id: str
    name: str
    auth: str = "approval"  # approval | token
    tokenHash: str = ""
    tokenHint: str = ""  # last characters, to tell tokens apart in the UI
    trustAlways: bool = False  # approval mode: never ask for the session
    trustedUntil: float | None = None  # approval mode: don't ask for the session until then
    # Approval mode: which calls ask the user each time. "all" = every call that changes something,
    # "destructive" = only deleting, overwriting and running commands, "none" = never.
    confirm: str = "all"
    enabled: bool = True
    mayAsk: bool = True  # approval mode: the assistant may ask the user for more access (request_access)
    god: bool = False  # everything allowed, on the profile's engines
    hostMounts: bool = False  # with god only: new containers may mount the Docker socket and host system folders
    allEngines: bool = False
    engines: list[str] = field(default_factory=lambda: [LOCAL_ID])  # the first is the default
    allContainers: bool = False
    projects: list[str] = field(default_factory=list)  # compose project names (globs)
    containers: list[str] = field(default_factory=list)  # container names (globs)
    actions: list[str] = field(default_factory=lambda: ["logs"])
    filePaths: list[str] = field(default_factory=list)  # readable paths (globs; ** crosses folders)
    showEnv: bool = False  # environment variable values in inspect output
    maxLogLines: int = 500
    createdAt: float = field(default_factory=time.time)
    lastUsedAt: float | None = None

    def public(self) -> dict:
        d = asdict(self)
        d.pop("tokenHash")
        return d

    def allows(self, action: str) -> bool:
        return self.god or action in self.actions

    def can_ask(self) -> bool:
        """Asking for more needs someone to answer, so only connections the user approves in the UI."""
        return self.auth == "approval" and self.mayAsk

    def missing(self, wanted: dict) -> dict:
        """What of `wanted` (the shape of a grant, see Approvals) this profile doesn't allow yet."""
        out: dict = {}
        actions = [a for a in ACTIONS if a in (wanted.get("actions") or []) and not self.allows(a)]
        if actions:
            out["actions"] = actions
        # A wanted entry is covered when it is in the list as it is, or names one thing (no wildcards)
        # that the list matches. A wider pattern ("/app/**" against "/app/*") is not covered, even
        # though its text happens to match.
        if not self.all_containers():
            for key in ("containers", "projects"):
                have = getattr(self, key)
                new = [n for n in dict.fromkeys(wanted.get(key) or []) if n not in have and (_has_glob(n) or not name_allowed(n, have))]
                if new:
                    out[key] = new
        patterns = self.file_patterns()
        paths = [x for x in dict.fromkeys(wanted.get("filePaths") or []) if "/**" not in patterns and x not in patterns and (_has_glob(x) or not path_allowed(x, patterns))]
        if paths:
            out["filePaths"] = paths
        engine_ids = [e for e in dict.fromkeys(wanted.get("engines") or []) if e not in self.engine_ids()]
        if engine_ids:
            out["engines"] = engine_ids
        if wanted.get("showEnv") and not self.show_env():
            out["showEnv"] = True
        return out

    def with_grant(self, grant: dict | None) -> "Profile":
        """A copy with a grant added (the stored profile is not changed)."""
        if not grant:
            return self
        return replace(
            self,
            actions=[a for a in ACTIONS if a in self.actions or a in (grant.get("actions") or [])],
            containers=list(dict.fromkeys([*self.containers, *(grant.get("containers") or [])])),
            projects=list(dict.fromkeys([*self.projects, *(grant.get("projects") or [])])),
            filePaths=list(dict.fromkeys([*self.filePaths, *(grant.get("filePaths") or [])])),
            engines=list(dict.fromkeys([*self.engines, *(grant.get("engines") or [])])),
            showEnv=self.showEnv or bool(grant.get("showEnv")),
        )

    def host_mounts(self) -> bool:
        return self.god and self.hostMounts

    def all_containers(self) -> bool:
        return self.god or self.allContainers

    def show_env(self) -> bool:
        return self.god or self.showEnv

    def log_limit(self) -> int:
        """Most log lines one request may return."""
        return MAX_LOG_LINES if self.god else max(1, min(self.maxLogLines, MAX_LOG_LINES))

    def file_patterns(self) -> list[str]:
        return ["/**", "/"] if self.god else self.filePaths

    def engine_ids(self) -> list[str]:
        """The engines this profile may use that still exist, the default first."""
        known = engines.registry.engines
        if self.allEngines:
            return [LOCAL_ID, *sorted(known, key=lambda e: known[e].name.lower())]
        return [e for e in self.engines if e == LOCAL_ID or e in known]

    def trusted(self) -> bool:
        return self.trustAlways or (self.trustedUntil is not None and self.trustedUntil > time.time())

    def trust(self, period: str) -> None:
        """period: none | day | week | month | always."""
        self.trustAlways = period == "always"
        self.trustedUntil = time.time() + TRUST_SECONDS[period] if period in TRUST_SECONDS else None


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _clean_list(values) -> list[str]:
    return [v.strip() for v in values or [] if isinstance(v, str) and v.strip()]


def path_allowed(path: str, patterns: list[str]) -> bool:
    """Glob match for absolute paths: `*` and `?` stay inside one folder, `**` crosses folders."""
    return any(_path_regex(p).fullmatch(path) for p in patterns)


def _path_regex(pattern: str) -> re.Pattern:
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out)


def _has_glob(pattern: str) -> bool:
    return any(ch in pattern for ch in "*?[")


def name_allowed(name: str, patterns: list[str]) -> bool:
    return any(fnmatchcase(name, p) for p in patterns)


STORE_VERSION = 2  # 2: `god` no longer implies every engine


class ProfileStore:
    def __init__(self) -> None:
        self.profiles: dict[str, Profile] = {}
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(STORE, encoding="utf-8") as f:
                known = Profile.__dataclass_fields__
                data = json.load(f)
                for raw in data.get("profiles", []):
                    if data.get("version", 1) < 2 and raw.get("god"):
                        raw["allEngines"] = True  # "everything" used to mean every engine; keep what such a profile had
                    if "engines" not in raw and raw.get("engine"):  # written before profiles could span engines
                        raw["engines"] = [raw["engine"]]
                    if "confirm" not in raw and "confirmRisky" in raw:
                        raw["confirm"] = "all" if raw["confirmRisky"] else "none"
                    p = Profile(**{k: v for k, v in raw.items() if k in known})
                    self.profiles[p.id] = p
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError) as e:
            log.error("can't read %s: %s", STORE, e)

    def _save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = STORE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"version": STORE_VERSION, "profiles": [asdict(p) for p in self.profiles.values()]}, f, indent=1)
        os.replace(tmp, STORE)

    def list(self) -> list[Profile]:
        self._load()
        return sorted(self.profiles.values(), key=lambda p: p.name.lower())

    def get(self, pid: str) -> Profile | None:
        self._load()
        return self.profiles.get(pid)

    def _apply(self, p: Profile, data: dict) -> None:
        if "name" in data:
            p.name = (data["name"] or "").strip()[:60] or "Unnamed"
        if "enabled" in data:
            p.enabled = bool(data["enabled"])
        if "engines" in data:
            p.engines = list(dict.fromkeys(_clean_list(data["engines"])))
        if "allEngines" in data:
            p.allEngines = bool(data["allEngines"])
        if "mayAsk" in data:
            p.mayAsk = bool(data["mayAsk"])
        if "god" in data:
            p.god = bool(data["god"])
        if "hostMounts" in data:
            p.hostMounts = bool(data["hostMounts"])
        if "allContainers" in data:
            p.allContainers = bool(data["allContainers"])
        if "projects" in data:
            p.projects = _clean_list(data["projects"])
        if "containers" in data:
            p.containers = _clean_list(data["containers"])
        if "actions" in data:
            p.actions = [a for a in ACTIONS if a in (data["actions"] or [])]
        if "filePaths" in data:
            paths = _clean_list(data["filePaths"])
            bad = [x for x in paths if not x.startswith("/")]
            if bad:
                raise ValueError(f"File paths must be absolute (start with /): {bad[0]}")
            p.filePaths = paths
        if "showEnv" in data:
            p.showEnv = bool(data["showEnv"])
        if "maxLogLines" in data:
            p.maxLogLines = max(10, min(MAX_LOG_LINES, int(data["maxLogLines"] or 500)))
        if "auth" in data:
            if data["auth"] not in AUTH_MODES:
                raise ValueError("auth must be approval or token")
            p.auth = data["auth"]
        if "confirm" in data:
            if data["confirm"] not in CONFIRM_MODES:
                raise ValueError("confirm must be all, destructive or none")
            p.confirm = data["confirm"]
        if "trust" in data:
            if data["trust"] not in ("none", "always", *TRUST_SECONDS):
                raise ValueError("Unknown trust period")
            p.trust(data["trust"])

    def _new_token(self, p: Profile) -> str:
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        p.tokenHash = _hash(token)
        p.tokenHint = token[-4:]
        return token

    def _sync_token(self, p: Profile) -> str | None:
        """Token-mode profiles have a token, the others none. Returns a newly made token."""
        if p.auth == "token":
            p.trust("none")
            return None if p.tokenHash else self._new_token(p)
        p.tokenHash, p.tokenHint = "", ""
        return None

    def create(self, data: dict) -> tuple[Profile, str | None]:
        self._load()
        p = Profile(id=secrets.token_hex(6), name="")
        self._apply(p, {"name": "", **data})
        token = self._sync_token(p)
        self.profiles[p.id] = p
        self._save()
        return p, token

    def update(self, pid: str, data: dict) -> tuple[Profile, str | None]:
        p = self.get(pid)
        if p is None:
            raise KeyError(pid)
        self._apply(p, data)
        token = self._sync_token(p)
        self._save()
        return p, token

    def regenerate(self, pid: str) -> tuple[Profile, str]:
        p = self.get(pid)
        if p is None:
            raise KeyError(pid)
        if p.auth != "token":
            raise ValueError("This connection doesn't use a token")
        token = self._new_token(p)
        self._save()
        return p, token

    def save(self) -> None:
        self._save()

    def delete(self, pid: str) -> None:
        self._load()
        if self.profiles.pop(pid, None) is not None:
            self._save()

    def add_grant(self, pid: str, grant: dict) -> None:
        """Make a grant part of the stored profile."""
        p = self.get(pid)
        if p is None:
            raise KeyError(pid)
        wider = p.with_grant(grant)
        p.actions, p.containers, p.projects, p.filePaths, p.showEnv = wider.actions, wider.containers, wider.projects, wider.filePaths, wider.showEnv
        p.engines = [e for e in wider.engines if e == LOCAL_ID or e in engines.registry.engines]
        self._save()

    def forget_engine(self, engine_id: str) -> None:
        """An engine was removed: drop it from the profiles; one left without any engine goes too."""
        self._load()
        touched = [p for p in self.profiles.values() if engine_id in p.engines]
        for p in touched:
            p.engines = [e for e in p.engines if e != engine_id]
        gone = [p.id for p in touched if not p.engines and not p.allEngines]
        if touched and not gone:
            self._save()
        for pid in gone:
            del self.profiles[pid]
        if gone:
            self._save()

    def authenticate(self, token: str) -> Profile | None:
        self._load()
        if not token.startswith(TOKEN_PREFIX):
            return None
        digest = _hash(token)
        found = None
        for p in self.profiles.values():  # no early exit: constant work per attempt
            if secrets.compare_digest(digest, p.tokenHash):
                found = p
        return found if found and found.enabled and found.auth == "token" else None

    def by_id(self, pid: str) -> Profile | None:
        """An approval-mode profile named by the client (no secret involved)."""
        p = self.get(pid)
        return p if p and p.enabled and p.auth == "approval" else None

    def touch(self, p: Profile) -> None:
        now = time.time()
        stale = p.lastUsedAt is None or now - p.lastUsedAt > 60
        p.lastUsedAt = now
        if stale:  # the file doesn't need every call
            self._save()


profiles = ProfileStore()


# ---- approvals -----------------------------------------------------------------------------------------


def session_code(session: str) -> str:
    """Short code shown both to the assistant and in Pierside's prompt, so the user can match them."""
    return base64.b32encode(hashlib.sha256(session.encode()).digest())[:4].decode()


def merge_grants(a: dict, b: dict) -> dict:
    out: dict = {k: list(dict.fromkeys([*(a.get(k) or []), *(b.get(k) or [])])) for k in ("actions", "containers", "projects", "filePaths", "engines")}
    out["showEnv"] = bool(a.get("showEnv") or b.get("showEnv"))
    return out


def _notify(action: str) -> None:
    """Tell open Pierside windows at once (over their live channel) that something here changed."""
    from app.services.hub import hub  # late import: the hub pulls in the container services

    hub.broadcast({"type": "event", "event": {"type": "mcp", "action": action, "id": "", "name": ""}})


class StaleQuestion(Exception):
    """The question was replaced (or isn't the one answered): nothing was decided."""


class Approvals:
    """Sessions the user allowed, and questions waiting for an answer in the UI (memory only)."""

    def __init__(self) -> None:
        self._sessions: dict[str, tuple[str, float]] = {}  # session id -> (profile id, when)
        self._pending: dict[str, dict] = {}
        # More access the user allowed for one session only: session id -> (profile id, grant).
        # A grant is {"actions", "containers", "projects", "filePaths", "engines": lists, "showEnv": bool}.
        self._grants: dict[str, tuple[str, dict]] = {}
        self._refused: dict[str, float] = {}  # session id -> when the user last refused more access

    def grant(self, profile: Profile, session: str) -> dict:
        entry = self._grants.get(session)
        return entry[1] if entry and entry[0] == profile.id else {}

    def effective(self, profile: Profile, session: str) -> Profile:
        """The profile as it applies to this session: with what the user allowed it on top."""
        return profile.with_grant(self.grant(profile, session))

    def refused_ago(self, session: str) -> float | None:
        when = self._refused.get(session)
        return time.time() - when if when is not None else None

    def session_ok(self, profile: Profile, session: str) -> bool:
        if profile.trusted():
            return True
        entry = self._sessions.get(session)
        return bool(entry) and entry[0] == profile.id

    def forget_profile(self, pid: str) -> None:
        self._sessions = {s: v for s, v in self._sessions.items() if v[0] != pid}
        self._grants = {s: v for s, v in self._grants.items() if v[0] != pid}
        for req in [r for r in self._pending.values() if r["profileId"] == pid]:
            self._answer(req, "deny")

    def pending(self) -> list[dict]:
        self._expire()
        return [{k: v for k, v in r.items() if k != "event"} for r in sorted(self._pending.values(), key=lambda r: r["createdAt"])]

    def _expire(self) -> None:
        # A session question outlives the call that raised it, so a slow answer still counts when the
        # assistant tries again. A question about one call ends with that call (see ask()).
        now = time.time()
        for key in [k for k, r in self._pending.items() if r["kind"] in ("session", "access") and now - r["createdAt"] > SESSION_QUESTION_S]:
            del self._pending[key]

    def _answer(self, req: dict, decision: str) -> None:
        req["decision"] = decision
        req["event"].set()
        self._pending.pop(req["id"], None)
        _notify("answered")

    def decide(self, rid: str, decision: str, created_at: float | None = None) -> None:
        """Answer a question. `created_at` names the question the user saw: a session's access question
        can be replaced by a newer one under the same id, and an answer must never apply to a question
        the user hasn't seen (StaleQuestion)."""
        self._expire()
        req = self._pending.get(rid)
        if req is None:
            raise KeyError(rid)
        if created_at is None or abs(req["createdAt"] - created_at) > 1e-6:
            raise StaleQuestion(rid)
        allowed = {"call": ("deny", "allow"), "access": ("deny", "deny_pause", "session", "permanent")}.get(req["kind"], ("deny", "once", "always", *TRUST_SECONDS))
        if decision not in allowed:
            raise ValueError("Unknown answer")
        if req["kind"] == "access":
            if decision == "deny":
                pass
            elif decision == "deny_pause":  # and the session can't ask again for a while
                self._refused[req["session"]] = time.time()
            elif decision == "permanent":
                profiles.add_grant(req["profileId"], req["grant"])
            else:
                if len(self._grants) > 500:  # like _sessions: nothing reports a session closed
                    for old in list(self._grants)[:250]:
                        del self._grants[old]
                profile = profiles.get(req["profileId"])
                if profile is None:
                    raise KeyError(rid)
                self._grants[req["session"]] = (profile.id, merge_grants(self.grant(profile, req["session"]), req["grant"]))
        if req["kind"] == "session" and decision != "deny":
            if len(self._sessions) > 500:  # sessions are never reported closed; keep the newest
                for old in sorted(self._sessions, key=lambda x: self._sessions[x][1])[:250]:
                    del self._sessions[old]
            self._sessions[req["session"]] = (req["profileId"], time.time())
            profile = profiles.get(req["profileId"])
            if profile and decision != "once":
                profile.trust(decision)
                profiles.save()
        self._answer(req, decision)

    async def ask(self, profile: Profile, session: str, kind: str, tool: str, target: str, detail: str, grant: dict | None = None, items: list[str] | None = None) -> str:
        """Put a question to the user and wait for the answer: the decision, or "timeout".
        kind: session (may this session use the connection), call (may this call run), access (may the
        session have `grant` on top; `items` describes it for the prompt)."""
        self._expire()
        key = f"{kind}:{session}" if kind in ("session", "access") else f"call:{secrets.token_hex(6)}"
        req = self._pending.get(key)
        if req is not None and kind == "access" and req["grant"] != grant:
            # One request per session: a different one replaces the one still waiting.
            self._pending.pop(key)
            req["event"].set()
            req = None
        # The first call of a new session returns quickly, so that the assistant can show the user the
        # code to compare before they answer; the question stays open and later calls wait longer.
        wait = SESSION_FIRST_WAIT_S if kind == "session" and req is None else APPROVAL_WAIT_S
        if req is None:
            req = {"id": key, "kind": kind, "profileId": profile.id, "profile": profile.name, "session": session, "code": session_code(session),
                   "tool": tool, "target": target, "detail": detail[:500], "grant": grant, "items": items or [], "createdAt": time.time(), "decision": None, "event": asyncio.Event()}
            self._pending[key] = req
            _notify("request")  # the prompt appears without waiting for the UI's next check
        try:
            await asyncio.wait_for(req["event"].wait(), wait)
        except asyncio.TimeoutError:
            if kind == "call" and self._pending.pop(key, None) is not None:  # a late "allow" must not run anything
                _notify("expired")
        return req["decision"] or "timeout"


approvals = Approvals()


# ---- engine connections ------------------------------------------------------------------------------

IDLE_CLOSE_S = 600


class EngineClients:
    """Docker clients per engine, independent of the engine the UI has active: for MCP calls, and
    (a second pool, never closed for idleness) for watching engines in the background (watch.py)."""

    def __init__(self, purpose: str = "mcp", idle_close_s: float | None = IDLE_CLOSE_S) -> None:
        self._open: dict[str, tuple[aiodocker.Docker, Tunnel | None, float]] = {}
        self._lock = asyncio.Lock()
        self._purpose = purpose
        self._idle_close_s = idle_close_s

    async def get(self, engine_id: str) -> aiodocker.Docker:
        async with self._lock:
            await self._close_idle(keep=engine_id)
            entry = self._open.get(engine_id)
            if entry:
                self._open[engine_id] = (entry[0], entry[1], time.monotonic())
                return entry[0]
            if engine_id == LOCAL_ID:
                docker, tunnel = aiodocker.Docker(url=LOCAL_URL), None
            else:
                cfg = engines.registry.engines.get(engine_id)
                if cfg is None:
                    raise EngineError("The engine this connection was set up for no longer exists in Pierside")
                tunnel = Tunnel(cfg)
                tunnel.path = os.path.join(SOCK_DIR, f"{cfg.id}-{self._purpose}.sock")  # separate from the UI's tunnel
                try:
                    await tunnel.start()
                except Exception:
                    await tunnel.stop()
                    raise
                docker = aiodocker.Docker(url=tunnel.url)
            self._open[engine_id] = (docker, tunnel, time.monotonic())
            return docker

    async def ssh(self, engine_id: str):
        """The SSH connection behind an engine's client, to run commands on the server itself."""
        await self.get(engine_id)
        tunnel = self._open[engine_id][1]
        if tunnel is None:
            raise EngineError("The local engine has no server to connect to")
        return await tunnel._connection()

    async def drop(self, engine_id: str) -> None:
        """Forget a connection that failed, so the next call reconnects."""
        async with self._lock:
            await self._close(engine_id)

    async def _close(self, engine_id: str) -> None:
        entry = self._open.pop(engine_id, None)
        if not entry:
            return
        docker, tunnel, _ = entry
        try:
            await docker.close()
        finally:
            if tunnel:
                await tunnel.stop()

    async def _close_idle(self, keep: str) -> None:
        if self._idle_close_s is None:
            return
        now = time.monotonic()
        for engine_id in [e for e, (_d, _t, used) in self._open.items() if e != keep and now - used > self._idle_close_s]:
            await self._close(engine_id)

    async def shutdown(self) -> None:
        async with self._lock:
            for engine_id in list(self._open):
                await self._close(engine_id)


clients = EngineClients()


# ---- activity ----------------------------------------------------------------------------------------

_activity: deque[dict] = deque(maxlen=200)


def begin(profile: Profile, tool: str, target: str) -> dict:
    """A call has arrived: list it as running. Finish it with record(). Kept in memory only (newest last)."""
    row = {"at": time.time(), "profileId": profile.id, "profile": profile.name, "tool": tool, "target": target, "outcome": "running", "detail": ""}
    _activity.append(row)
    # Most calls take a few milliseconds; only tell the UI about one that is still going after a moment.
    asyncio.get_running_loop().call_later(0.4, lambda: row["outcome"] in ("running", "waiting") and _notify("activity"))
    return row


def waiting(row: dict, is_waiting: bool) -> None:
    """The call is held until the user answers a question in Pierside (or no longer is)."""
    if row["outcome"] in ("running", "waiting"):
        row["outcome"] = "waiting" if is_waiting else "running"
        _notify("activity")


def record(row: dict, outcome: str, detail: str = "") -> None:
    """The call is over. outcome: ok | denied | error."""
    row["outcome"], row["detail"], row["seconds"] = outcome, detail[:200], round(time.time() - row["at"], 1)
    if outcome == "denied":
        log.warning("MCP %s denied %s on %r: %s", row["profile"], row["tool"], row["target"], detail)
    _notify("activity")


def activity() -> list[dict]:
    return list(reversed(_activity))
