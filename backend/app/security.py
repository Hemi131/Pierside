"""Request guard for both of the backend's listeners. Every request needs the session token.

Two doors lead into the same app, and NEITHER is trusted:
  * "socket": the unix socket behind Rancher's vm.service. Rancher reaches it through its injected
    rdx-proxy container, whose port Rancher publishes on ALL interfaces with no authentication (and
    installs firewall rules allowing it even on Public networks). So this door is reachable from
    the LAN, and any header, including Origin, can be forged there.
  * "tcp": 127.0.0.1:<published port> (WebSockets, downloads, the standalone window, the dev server). Only
    local processes and the user's browser can reach it.

Rules (both doors unless noted):
  * a foreign Origin (some website) is rejected;
  * a valid token is required (`X-Pierside-Token` header or `?token=`), compared in constant time;
  * no token needed for: POST /diag (append-only error sink), POST /standalone/redeem (needs a
    one-time ticket instead), GET /app/* (the public UI files of the standalone window), and CORS
    preflights;
  * tcp only: the Vite dev server origin needs no token (the dev UI has no way to get it). On the
    socket door that exemption would be forgeable from the network, so it doesn't exist there.

How the UI gets the token: the backend writes it to TOKEN_FILE (root-only, inside its container);
the extension UI reads it with Rancher's *local* docker CLI (`docker exec <backend> cat ...`), a
channel only the local user with Docker access has. See ui/src/api/ddclient.ts.
"""

import logging
import os
import secrets
from urllib.parse import parse_qs

from app.config import WS_TOKEN, public_port

log = logging.getLogger("pierside.security")

TOKEN_FILE = os.environ.get("PIERSIDE_TOKEN_FILE", "/run/pierside-token")
DEV_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
EXTENSION_ORIGIN_PREFIX = "x-rd-extension://"


def write_token_file() -> None:
    """Publish the token to the extension UI via the container filesystem (0600, root)."""
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(WS_TOKEN)


def _origin_ok(origin: str) -> bool:
    # The standalone window is served from the TCP port itself.
    self_origins = {f"http://localhost:{public_port()}", f"http://127.0.0.1:{public_port()}"}
    return not origin or origin in DEV_ORIGINS or origin in self_origins or origin.startswith(EXTENSION_ORIGIN_PREFIX)


class Guard:
    def __init__(self, app, door: str) -> None:
        assert door in ("socket", "tcp")
        self.app = app
        self.door = door

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        origin = headers.get("origin", "")
        token = headers.get("x-pierside-token") or (parse_qs(scope.get("query_string", b"").decode()).get("token") or [""])[0]
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        http = scope["type"] == "http"

        allowed = _origin_ok(origin) and (
            secrets.compare_digest(token, WS_TOKEN)
            or (self.door == "tcp" and origin in DEV_ORIGINS)
            or (http and path == "/diag" and method == "POST")
            or (http and path == "/standalone/redeem" and method == "POST")
            or (http and method == "GET" and (path == "/app" or path.startswith("/app/")))
            or (http and method == "OPTIONS")  # CORS preflight (dev origin only, see CORS config)
        )
        if allowed:
            return await self.app(scope, receive, send)

        log.warning("rejected %s %s %s via %s (origin=%r, token=%s)", scope["type"], method, path, self.door, origin, "present" if token else "missing")
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"detail":"Forbidden"}'})
