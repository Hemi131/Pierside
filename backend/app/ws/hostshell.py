"""WS /ws/host-shell: an interactive shell on the active SSH engine's server (the terminal panel).

The same protocol as /ws/exec: client -> {"type": "input", "data"} | {"type": "resize", "cols", "rows"};
server -> binary output, {"type": "ready", "root": bool} | {"type": "exit", "code"} | {"type": "error", "message"}.
Normally it runs as the engine's SSH user, over the engine's SSH connection, with a terminal (PTY), so
full-screen programs work. With the server's Root terminal switch on (hostfs.root_terminal) it is a root
shell on the server, through a privileged helper container: the terminal is Docker's, so no SSH PTY is
needed. Removing that helper ends everything started in the session, except what a service manager took
over. The local engine has no equivalent: an extension may only run the docker CLI there, which the UI
does itself (the Docker console).
"""

import asyncio
import json
import logging

import aiodocker
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services import hostfs
from app.services.docker_client import get_docker
from app.services.engines import engines
from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image
from app.ws.common import accept_authorized

router = APIRouter()
log = logging.getLogger("pierside.hostshell")

ROOT_HELPER_MAX_S = 7 * 24 * 3600  # if the backend ever dies with a session open, the helper ends by itself
ROOT_NOTICE = "\x1b[33mEverything started here ends when this terminal closes or loses its connection, tmux and nohup too.\r\nFor long jobs like upgrades use systemd-run.\x1b[0m\r\n"
# Runs on the server, in its namespaces: root's own shell as a login shell, with a clean environment
# (not the helper's). Not `su`: its PAM rules vary, and an account without a shell would fail it.
ROOT_LAUNCH = r"""
s=$(sed -n 's/^root:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\(.*\)$/\1/p' /etc/passwd)
case "$s" in ""|*nologin|*false) s=/bin/sh ;; esac
[ -x "$s" ] || s=/bin/sh
cd /root 2>/dev/null || cd /
exec env -i HOME=/root USER=root LOGNAME=root SHELL="$s" TERM=xterm-256color COLORTERM=truecolor \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$s" -l
"""


def _int(v, default: int) -> int:
    try:
        return max(1, min(int(v or default), 1000))
    except (TypeError, ValueError):
        return default


class _SshShell:
    """The login shell of the engine's SSH user."""

    root = False

    def __init__(self, proc) -> None:
        self.proc = proc

    @classmethod
    async def open(cls, cols: int, rows: int) -> "_SshShell":
        conn = await engines.tunnel._connection()
        # No command: the user's login shell, with a PTY.
        return cls(await conn.create_process(term_type="xterm-256color", term_size=(cols, rows), encoding=None))

    async def read(self) -> bytes:
        return await self.proc.stdout.read(8192)

    async def write(self, data: bytes) -> None:
        self.proc.stdin.write(data)

    async def resize(self, cols: int, rows: int) -> None:
        self.proc.change_terminal_size(cols, rows)

    async def exit_code(self) -> int | None:
        return (await self.proc.wait()).exit_status

    async def close(self) -> None:
        self.proc.close()  # closes the SSH channel: the shell gets SIGHUP


class _RootShell:
    """Root on the server: a privileged helper in the server's PID namespace enters the namespaces of its
    PID 1. The shell stays in the helper's cgroup, so removing the helper ends it and what it started."""

    root = True

    def __init__(self, docker, helper: str) -> None:
        self.docker = docker  # the session's engine, also if the active one changes meanwhile
        self.helper = helper
        self.exe = None
        self.stream = None

    @classmethod
    async def open(cls, cols: int, rows: int) -> "_RootShell":
        docker = get_docker()
        await _ensure_image()
        c = await docker.containers.create(
            {
                "Image": HELPER_IMAGE,
                "Cmd": ["sleep", str(ROOT_HELPER_MAX_S)],
                "Labels": {HELPER_LABEL: "true", f"{HELPER_LABEL}.rootshell": "true"},
                "NetworkDisabled": True,
                "HostConfig": {"Privileged": True, "PidMode": "host", "NetworkMode": "none", "AutoRemove": True},
            }
        )
        self = cls(docker, c.id)
        try:
            await c.start()
            self.exe = await c.exec(["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c", ROOT_LAUNCH], stdin=True, tty=True)
            self.stream = self.exe.start(detach=False)
            await self.stream.__aenter__()
            try:
                await self.exe.resize(h=rows, w=cols)
            except aiodocker.DockerError:
                pass  # not up yet; the client sends its size again
        except BaseException:
            await self.close()
            raise
        return self

    async def read(self) -> bytes:
        msg = await self.stream.read_out()
        return b"" if msg is None else msg.data

    async def write(self, data: bytes) -> None:
        await self.stream.write_in(data)

    async def resize(self, cols: int, rows: int) -> None:
        try:
            await self.exe.resize(h=rows, w=cols)
        except aiodocker.DockerError:
            pass

    async def exit_code(self) -> int | None:
        try:
            return (await self.exe.inspect()).get("ExitCode")
        except Exception:
            return None

    async def close(self) -> None:
        if self.stream is not None:
            try:
                await self.stream.close()
            except Exception:
                pass
        try:
            await self.docker.containers.container(self.helper).delete(force=True)
        except Exception:
            pass


async def _open(ws: WebSocket, cols: int, rows: int):
    """The shell this server is set to. When root isn't possible the user is told why and gets the normal
    shell, which the panel shows without its root mark."""
    if hostfs.root_terminal():
        try:
            problem = await hostfs.docker_problem()
            if problem:
                raise RuntimeError(problem)
            return await _RootShell.open(cols, rows)
        except Exception as e:
            log.warning("root terminal failed: %s", e)
            why = e.message.get("message") if isinstance(e, aiodocker.DockerError) and isinstance(e.message, dict) else str(e)
            await ws.send_bytes(f"\x1b[31mNo root terminal: {why or type(e).__name__}.\x1b[0m\r\nOpening your normal shell.\r\n".encode())
    return await _SshShell.open(cols, rows)


@router.websocket("/ws/host-shell")
async def ws_host_shell(ws: WebSocket):
    if not await accept_authorized(ws):
        return
    q = ws.query_params
    cols, rows = _int(q.get("cols"), 80), _int(q.get("rows"), 24)
    shell = None
    try:
        if engines.is_local or engines.tunnel is None:
            await ws.send_json({"type": "error", "message": "A server shell is available for SSH engines only."})
            return
        shell = await _open(ws, cols, rows)
        if shell.root:
            await ws.send_bytes(ROOT_NOTICE.encode())
        await ws.send_json({"type": "ready", "root": shell.root})

        async def pump_out():
            while True:
                data = await shell.read()
                if not data:
                    break
                await ws.send_bytes(data)
            await ws.send_json({"type": "exit", "code": await shell.exit_code()})

        async def pump_in():
            while True:
                m = await ws.receive()
                if m["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(m.get("code", 1000))
                if m.get("bytes") is not None:
                    await shell.write(m["bytes"])
                    continue
                data = json.loads(m.get("text") or "{}")
                if data.get("type") == "input":
                    await shell.write(data.get("data", "").encode())
                elif data.get("type") == "resize":
                    await shell.resize(_int(data.get("cols"), cols), _int(data.get("rows"), rows))

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
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("host shell failed: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e) or type(e).__name__})
        except Exception:
            pass
    finally:
        if shell is not None:
            await shell.close()
        try:
            await ws.close()
        except Exception:
            pass
