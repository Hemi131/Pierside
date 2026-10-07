"""stdio transport for the MCP server: `docker exec -i <pierside backend> python -m app.mcp_stdio`.

MCP clients such as Claude Code start this process and exchange newline-delimited JSON-RPC messages
with it. Each message is forwarded to the backend's own /mcp endpoint inside this container.
Running here instead of talking to the backend's host port keeps a client's configuration valid when
that port changes, and lets the backend recognise the caller as local.

The bridge also announces `notifications/tools/list_changed` to the client when the tools this
connection may use change (the user edited its permissions, or Pierside was updated): every answer
from the backend carries a fingerprint of the tool list, and a quiet ping every 30 seconds keeps it
current between calls.

Two ways to say which connection this is:
  * `--profile <id>`: no secret; the user allows the session in Pierside's UI;
  * PIERSIDE_MCP_TOKEN: a token-mode connection, for unattended use.
"""

import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.request

from app.config import TCP_PORT

URL = f"http://127.0.0.1:{TCP_PORT}/mcp"


POLL_S = 30
_lock = threading.Lock()  # one writer to stdout at a time
_busy = threading.Lock()  # held while the client's own message is at the backend
_state = {"tools": None}  # fingerprint of the tool list as of the last answer


def _post(auth: dict, line: bytes) -> tuple[int, bytes]:
    req = urllib.request.Request(URL, data=line, method="POST", headers={"Content-Type": "application/json", "Accept": "application/json", **auth})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:  # a call may wait for the user's approval
            status, body, headers = resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        status, body, headers = e.code, e.read(), e.headers
    _note_tools(headers.get("X-Pierside-Tools") if headers else None)
    return status, body


def _write(data: bytes) -> None:
    with _lock:
        sys.stdout.buffer.write(data + b"\n")
        sys.stdout.buffer.flush()


def _note_tools(fingerprint: str | None) -> None:
    if not fingerprint:
        return
    known = _state["tools"]
    _state["tools"] = fingerprint
    if known is not None and known != fingerprint:
        _announce()


def _announce() -> None:
    _write(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}).encode())


def _poll(auth: dict) -> None:
    """Between calls, notice a changed tool list too (a ping needs no approval)."""
    ping = json.dumps({"jsonrpc": "2.0", "id": "pierside-tools-check", "method": "ping"}).encode()
    while True:
        threading.Event().wait(POLL_S)
        # Not while a call of the client's is under way: its answer carries the fingerprint anyway,
        # and a check that started before it could report the older list after it.
        if not _busy.acquire(blocking=False):
            continue
        try:
            _post(auth, ping)
        except OSError:
            pass
        finally:
            _busy.release()


def _failure(line: bytes, message: str) -> bytes | None:
    """A JSON-RPC error for a request that couldn't be forwarded (notifications get no answer)."""
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    if not isinstance(msg, dict) or "id" not in msg:
        return None
    return json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": message}}).encode()


def main() -> None:
    token = os.environ.get("PIERSIDE_MCP_TOKEN", "")
    profile = sys.argv[sys.argv.index("--profile") + 1] if "--profile" in sys.argv[1:-1] else ""
    if token:
        auth = {"Authorization": f"Bearer {token}"}
    else:
        # One id per run of this process = one session the user approves.
        auth = {"X-Pierside-Profile": profile, "X-Pierside-Session": secrets.token_hex(16)}
    threading.Thread(target=_poll, args=(auth,), daemon=True).start()
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            with _busy:
                status, body = _post(auth, line)
        except OSError as e:
            status, body = 0, str(e).encode()
        if b'"notifications/initialized"' in line:
            # A client that reconnects may go on with the tool list it had before (Claude Code does,
            # when the reconnect happens on a tool call), and that list was for another session.
            # Have it ask again; for a client that lists anyway this costs one more request.
            _announce()
        if status == 200:
            answer = body.replace(b"\n", b" ")
        elif status == 202:
            continue
        elif status == 401:
            answer = _failure(line, "Pierside refused this connection: it was removed or switched off, or its access token was replaced. Copy the connection command again from Pierside's AI access page.")
        else:
            answer = _failure(line, f"Pierside's backend answered {status or 'nothing'}: {body[:200].decode('utf-8', 'replace')}")
        if answer:
            _write(answer)


if __name__ == "__main__":
    main()
