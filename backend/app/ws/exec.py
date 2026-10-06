"""WS /ws/exec/{id}: interactive TTY shell via the Docker exec API.

Query: shell=auto|sh|bash|debug|<path>, user=, workdir=, cols=, rows=

shell=debug: for containers without a shell (distroless, scratch). A helper container (alpine) joins
the target's PID and network namespaces, and the shell runs there, starting in /proc/1/root: the
target's filesystem. The helper is removed when the session ends.
client -> text JSON  {"type": "input", "data": str} | {"type": "resize", "cols": n, "rows": n}
server -> binary     raw terminal output bytes (UTF-8 may be split across frames; xterm handles it)
          text JSON  {"type": "ready", "execId": str} | {"type": "exit", "code": n|null} | {"type": "error", "message": str}

When the socket closes, the exec is cleaned up: if its process is still running (e.g. `top`, `vim`)
it gets SIGHUP, then SIGKILL. Signalling needs `pid: host` on the backend service (the exec's Pid is
a VM-namespace PID); without it we log a warning.
"""

import asyncio
import json
import logging
import os
import signal

import aiodocker
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.docker_client import get_docker
from app.services.engines import engines
from app.ws.common import accept_authorized

router = APIRouter()
log = logging.getLogger("pierside.exec")

_live_execs: set[str] = set()

# ---- shell integration -------------------------------------------------------------------------
# The prompt gets an invisible OSC 133;B marker ("prompt ends, user input starts") so the UI knows
# exactly where the editable command line begins and when the shell (not some program) is waiting.
#   bash:        PROMPT_COMMAND appends the marker to whatever PS1 the rc files set (every prompt).
#   busybox sh:  PS1 is exported with the marker (its default prompt, `\w \$ `, plus the marker).
#   dash & co.:  no prompt escapes -> no integration; the UI falls back gracefully.
BASH_PROMPT_COMMAND = r'case "$PS1" in *"133;B"*) ;; *) PS1="$PS1\[\e]133;B\a\]";; esac'
BUSYBOX_PS1 = r"\w \$ \[\033]133;B\007\]"
_LAUNCH = (
    '{try_bash}case "$(readlink -f /bin/sh 2>/dev/null)" in *busybox*) export PS1="$PIERSIDE_ASH_PS1";; esac; '
    "unset PIERSIDE_ASH_PS1; exec /bin/sh"
)


def _command(shell: str) -> list[str]:
    if shell in ("", "auto"):
        return ["/bin/sh", "-c", _LAUNCH.format(try_bash="[ -x /bin/bash ] && exec /bin/bash; ")]
    if shell == "sh":
        return ["/bin/sh", "-c", _LAUNCH.format(try_bash="")]
    if shell == "bash":
        return ["/bin/bash"]
    return [shell]


DEBUG_PS1 = r"[debug] \w \$ \[\033]133;B\007\]"
_DEBUG_LAUNCH = (
    'printf "\033[2mPierside debug shell: this container has no shell, so these tools come from a helper container.\\n'
    'Its processes and network are the container\'s own; its files are under /proc/1/root (you start there).\033[0m\\n"; '
    'cd /proc/1/root 2>/dev/null; export PS1="$PIERSIDE_ASH_PS1"; unset PIERSIDE_ASH_PS1; exec /bin/sh'
)


async def _debug_helper(target: str) -> str:
    """Start a helper sharing the target's PID + network namespaces; returns its id."""
    from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image

    info = await get_docker().containers.container(target).show()
    if not (info.get("State") or {}).get("Running"):
        raise RuntimeError("Start the container to debug it.")
    await _ensure_image()
    c = await get_docker().containers.create(
        {
            "Image": HELPER_IMAGE,
            "Cmd": ["sleep", "3600"],  # AutoRemove + this timeout: gone even if the backend dies
            "Labels": {HELPER_LABEL: "true", f"{HELPER_LABEL}.debug": info["Id"]},
            "HostConfig": {
                "AutoRemove": True,
                "PidMode": f"container:{info['Id']}",
                "NetworkMode": f"container:{info['Id']}",
                "CapAdd": ["SYS_PTRACE"],  # to read /proc/<pid>/root of the target's processes
            },
        }
    )
    await c.start()
    return c.id


async def _remove_helper(cid: str) -> None:
    try:
        await get_docker().containers.container(cid).delete(force=True)
    except Exception:
        pass


def _int(v: str | None, default: int) -> int:
    try:
        return max(1, min(int(v or default), 1000))
    except ValueError:
        return default


async def _kill_via_container(pid: int, sig: int) -> None:
    """`kill` from a short-lived container in the engine host's PID namespace (remote engines)."""
    from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image

    try:
        await _ensure_image()
        c = await get_docker().containers.create(
            {
                "Image": HELPER_IMAGE,
                "Cmd": ["kill", f"-{int(sig)}", str(int(pid))],
                "Labels": {HELPER_LABEL: "true"},
                "NetworkDisabled": True,
                "HostConfig": {"PidMode": "host", "AutoRemove": True, "NetworkMode": "none"},
            }
        )
        await c.start()
    except Exception as e:
        log.warning("remote exec cleanup failed for pid %s: %s", pid, e)


async def _cleanup(exe) -> None:
    try:
        info = await exe.inspect()
    except Exception:
        return
    if not info.get("Running"):
        return
    pid = info.get("Pid")
    if not pid:
        return
    for sig, wait in ((signal.SIGHUP, 1.0), (signal.SIGKILL, 0.5)):
        if not engines.is_local:
            # The process lives on another machine: signal it from a throwaway container there.
            await _kill_via_container(pid, sig)
        else:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
            except PermissionError:
                log.warning("cannot signal exec pid %s (is the backend running with pid: host?)", pid)
                return
        await asyncio.sleep(wait)
        try:
            if not (await exe.inspect()).get("Running"):
                return
        except Exception:
            return
    log.warning("exec %s still running after SIGKILL", exe.id[:12])


@router.websocket("/ws/exec/{cid}")
async def ws_exec(ws: WebSocket, cid: str):
    if not await accept_authorized(ws):
        return
    q = ws.query_params
    cols, rows = _int(q.get("cols"), 80), _int(q.get("rows"), 24)
    exe = None
    stream = None
    debug_helper = None
    debug = q.get("shell") == "debug"
    try:
        if debug:
            debug_helper = await _debug_helper(cid)
        container = get_docker().containers.container(debug_helper or cid)
        exe = await container.exec(
            ["/bin/sh", "-c", _DEBUG_LAUNCH] if debug else _command(q.get("shell", "auto")),
            stdin=True,
            tty=True,
            user="" if debug else q.get("user", ""),
            workdir=None if debug else (q.get("workdir") or None),
            environment={
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "PROMPT_COMMAND": BASH_PROMPT_COMMAND,
                "PIERSIDE_ASH_PS1": DEBUG_PS1 if debug else BUSYBOX_PS1,
            },
        )
        _live_execs.add(exe.id)
        stream = exe.start(detach=False)
        await stream.__aenter__()
        try:
            await exe.resize(h=rows, w=cols)
        except aiodocker.DockerError:
            pass  # process may not be up yet; the client re-sends its size on ready
        await ws.send_json({"type": "ready", "execId": exe.id})

        async def pump_out():
            head = b""  # start of the output, to recognise a shell that couldn't start
            while True:
                msg = await stream.read_out()
                if msg is None:
                    break
                if len(head) < 2048:
                    head += msg.data
                await ws.send_bytes(msg.data)
            code = None
            try:
                code = (await exe.inspect()).get("ExitCode")
            except Exception:
                pass
            # The runtime reports a missing shell as terminal output (+ exit 126/127), not as an API
            # error: pass it on as an error so the UI can explain it (and offer the debug shell).
            if code in (126, 127) and b"OCI runtime exec failed" in head:
                await _send_error(ws, head.decode("utf-8", "replace").strip())
            await ws.send_json({"type": "exit", "code": code})

        async def pump_in():
            while True:
                m = await ws.receive()
                if m["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(m.get("code", 1000))
                if m.get("bytes") is not None:
                    await stream.write_in(m["bytes"])
                    continue
                data = json.loads(m.get("text") or "{}")
                if data.get("type") == "input":
                    await stream.write_in(data.get("data", "").encode())
                elif data.get("type") == "resize":
                    try:
                        await exe.resize(h=_int(str(data.get("rows")), rows), w=_int(str(data.get("cols")), cols))
                    except aiodocker.DockerError:
                        pass

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
    except aiodocker.DockerError as e:
        msg = e.message.get("message") if isinstance(e.message, dict) else str(e.message)
        await _send_error(ws, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("exec ws failed")
        await _send_error(ws, str(e))
    finally:
        if stream is not None:
            try:
                await stream.close()
            except Exception:
                pass
        if exe is not None:
            await _cleanup(exe)
            _live_execs.discard(exe.id)
        if debug_helper is not None:
            await _remove_helper(debug_helper)
        try:
            await ws.close()
        except Exception:
            pass


async def _send_error(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_json({"type": "error", "message": message})
    except Exception:
        pass


@router.get("/exec/sessions")
async def live_sessions():
    """Debug: exec sessions currently bridged (should be empty when no shell tab is open)."""
    return {"sessions": sorted(_live_execs)}
