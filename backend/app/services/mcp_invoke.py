"""One tool call of the MCP server, checked and carried out.

`invoke` does everything a tools/call needs except presenting the result: it looks up the tool,
checks the profile's action, picks the engine, refuses arguments the tool doesn't know, lists the call
in the activity list, asks the user where an approval-mode profile says so, runs the tool and turns
every failure into a typed outcome. routers/mcp.py renders the outcome for the client (text, and
structuredContent for clients that asked for it).

Outcomes:
  * ok: the tool did its work; `out` is its result;
  * denied: the connection doesn't allow it (action, engine, container, path, an unsafe name);
  * refused: the user refused it in Pierside, or didn't answer in time;
  * error: the call can't be carried out (unknown tool or argument, bad input, Docker refused it);
  * unreachable: the engine can't be reached (its client is dropped, so the next call reconnects);
  * internal: a bug in Pierside (logged; the assistant is told to look in the backend log);
  * planned: a call made by a script's planning run, recorded but not carried out (see `Via`).
`message` is the text the assistant reads for every outcome but ok and planned.

A call a script makes (services/mcp_scripts.py) passes a `Via`: it is marked in the activity list as
coming from that script, and its `gate` decides about the user's approval instead of the questions a
direct call asks (`_approved`). Every other check is the same as for a direct call.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

import aiodocker
import aiohttp

from app.services import mcp_tools
from app.services.engines import EngineError
from app.services.mcp_access import APPROVAL_WAIT_S, Profile, UnsafePath, approvals, begin, clients, record, session_code, waiting

log = logging.getLogger("pierside.mcp")

OUTCOMES = ("ok", "denied", "refused", "error", "unreachable", "internal", "planned")
PLANNED = object()  # a gate's answer: record the call, don't carry it out


@dataclass
class Called:
    outcome: str  # one of OUTCOMES
    message: str = ""  # what the assistant is told when the outcome isn't ok
    out: mcp_tools.Out | None = None  # the tool's result when it is


@dataclass
class Via:
    """A call made by a script. `label` marks its activity row ("script 3fa2"). `gate(name, args,
    level, target, row, engine_id)` runs after the checks that come before the user's approval (action, engine,
    arguments) and returns None to go ahead, PLANNED to record the call without carrying it out, or the
    text of a refusal. It may pin `args["container"]` to the id it checked; the tool gets those args."""

    label: str
    gate: Callable[[str, dict, str, str, dict, str], Awaitable[object]]


def _engine(profile: Profile, ref) -> str:
    """The engine a call names (id or name), or the profile's default."""
    allowed = profile.engine_ids()
    if not allowed:
        raise mcp_tools.ToolError("This connection has no engine any more; the user must edit it in Pierside under AI access")
    if ref in (None, ""):
        return allowed[0]
    engine_id = mcp_tools.find_engine(ref, allowed)
    if engine_id:
        return engine_id
    other = mcp_tools.find_engine(ref, mcp_tools.known_engines())
    if other:
        raise mcp_tools.Denied(mcp_tools.engine_no_permission(profile, other, named=True))
    raise mcp_tools.Denied(f"the engine {ref!r} isn't one this connection may use (see list_engines)")


def needs_confirm(profile: Profile, level: str) -> bool:
    """Whether the profile's `confirm` setting asks the user before a call of this level. Never for
    run_script's own level: it asks about the script itself (services/mcp_scripts.py)."""
    if level == "script":
        return False
    return (profile.confirm == "all" and level != "read") or (profile.confirm == "destructive" and level == "destroy")


def call_detail(args: dict) -> str:
    """A call's arguments as the user reads them in a question (content by its length only)."""
    detail = "\n".join(f"{k}: {v}" for k, v in args.items() if k not in ("container", "content") and v not in (None, ""))
    if "content" in args:
        detail += f"\ncontent: {len(str(args['content']))} characters"
    return detail


async def _approved(profile: Profile, session: str, name: str, args: dict, target: str, row: dict) -> str | None:
    """Approval-mode profiles: ask the user where needed. Returns why not, or None to go ahead."""
    where = "Pierside (Rancher Desktop) under AI access"
    if not approvals.session_ok(profile, session):
        waiting(row, True)
        answer = await approvals.ask(profile, session, "session", name, target, "")
        waiting(row, False)
        if answer == "deny":
            return f"The user refused this connection in {where}."
        if answer == "timeout":
            return (
                f"The user has to allow this connection first. Tell them now, in your reply, that the code is {session_code(session)}: "
                f"they open {where}, check that the request there shows the same code, and allow it. "
                "Then call the tool again; that call waits up to a minute for their answer."
            )
    if needs_confirm(profile, mcp_tools.call_level(name, args)):
        waiting(row, True)
        answer = await approvals.ask(profile, session, "call", name, target, call_detail(args))
        waiting(row, False)
        if answer == "deny":
            return "The user refused this action."
        if answer == "timeout":
            return f"The user didn't answer within {APPROVAL_WAIT_S} seconds. Ask them to open {where}, then call the tool again; they are asked each time."
    return None


def _not_allowed(profile: Profile, session: str) -> str:
    """Why a tool's permission is missing. After an edit of the connection took back what was allowed
    for this session only, say so: the tool may have worked a moment ago."""
    ask = " ask again with request_access if the task still needs it" if profile.can_ask() else " they can allow it in Pierside under AI access"
    if session and approvals.withdrawn(session):
        return "the user changed the connection, which withdrew what they had allowed for this session only;" + ask + "."
    return "the user hasn't allowed this for the connection." + (" Ask for it with request_access if the task needs it." if profile.can_ask() else " They can change that in Pierside under AI access.")


def _target(args) -> str:
    """What the call is about, for the activity list and the user's prompt."""
    if not isinstance(args, dict):
        return ""
    target = str(args.get("container") or "")
    for key in ("project", "volume", "network", "image", "service"):
        if not target and args.get(key):
            target = str(args[key])
    if args.get("path"):
        target += f":{args['path']}"
    return target


async def invoke(profile: Profile, session: str, name, args, via: Via | None = None) -> Called:
    """One tool call. `profile` is the connection as it applies to this session (Approvals.effective);
    `name` and `args` are as the client (or the script, `via`) sent them."""
    entry = mcp_tools.TOOLS.get(name) if isinstance(name, str) else None
    target = _target(args)
    if via is not None and name in mcp_tools.NOT_IN_SCRIPTS:
        return Called("error", f"{name} can't be called from a script")  # not listed in the activity: nothing was tried
    if entry is None or not isinstance(args, dict):
        return Called("error", f"Unknown tool {name!r}")  # not listed either
    args = dict(args)
    engine_id = profile.engine_ids()[0] if profile.engine_ids() else ""
    row = begin(profile, name, target, via.label if via else None)  # shown in the activity list from now, as running
    try:
        if entry.action is not None and not profile.allows(entry.action):
            raise mcp_tools.Denied(_not_allowed(profile, session))
        engine_id = _engine(profile, args.pop("engine", None) if name not in mcp_tools.NO_ENGINE else None)
        # Reject what the tool doesn't know, rather than ignore it: a misspelt `timeout` must not
        # quietly run a command with the default limit.
        unknown = sorted(set(args) - set(entry.schema["properties"]))
        if unknown:
            accepted = ", ".join(sorted(entry.schema["properties"]) + ([] if name in mcp_tools.NO_ENGINE else ["engine"]))
            raise mcp_tools.ToolError(f"Unknown argument{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}. {name} accepts: {accepted}")
        if len(profile.engine_ids()) > 1 and name not in mcp_tools.NO_ENGINE:
            target = row["target"] = f"[{mcp_tools.engine_name(engine_id)}] {target}".strip()
        if via is not None:
            decision = await via.gate(name, args, mcp_tools.call_level(name, args), target, row, engine_id)
            if decision is PLANNED:
                record(row, "planned")
                return Called("planned")
            if decision:
                record(row, "denied", str(decision))
                return Called("refused", str(decision))
        elif profile.auth == "approval":
            refusal = await _approved(profile, session, name, args, target, row)
            if refusal:
                record(row, "denied", refusal)
                return Called("refused", refusal)
        # Tools that aren't about one engine don't use its client: an unreachable default engine
        # mustn't fail them (connection_info, list_engines, request_access, run_script).
        docker = None if name in mcp_tools.NO_ENGINE else await clients.get(engine_id)
        if name == "request_access":
            waiting(row, True)  # the whole call is a question to the user
        out = await entry.fn(mcp_tools.Ctx(profile, engine_id, docker, session, row), args)
        # From here the tool has done its work: nothing may report it as failed.
        record(row, "ok")
        return Called("ok", out=out)
    except (mcp_tools.Denied, UnsafePath) as e:
        record(row, "denied", str(e))
        return Called("denied", f"Not allowed: {e}")
    except mcp_tools.ToolError as e:
        record(row, "error", str(e))
        return Called("error", str(e))
    except aiodocker.DockerError as e:
        message = e.message if isinstance(e.message, str) else json.dumps(e.message)
        record(row, "error", message)
        return Called("error", f"Docker refused: {message}")
    except (EngineError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as e:
        await clients.drop(engine_id)  # reconnect on the next call
        record(row, "error", str(e))
        return Called("unreachable", f"The Docker engine can't be reached: {e or type(e).__name__}")
    except Exception as e:  # a bug in a tool must not take the whole exchange down
        log.exception("MCP tool %s failed", name)
        record(row, "error", f"{type(e).__name__}: {e}")
        return Called("internal", f"Pierside hit an internal error running this tool ({type(e).__name__}); the user can find details in the backend log.")
    finally:
        if row["outcome"] in ("running", "waiting"):  # the request was dropped (the client went away)
            record(row, "error", "The script was stopped before this call finished" if via else "The assistant stopped waiting for the answer")
