import os
import secrets

SOCKET_PATH = os.environ.get("PIERSIDE_SOCKET", "/run/guest-services/pierside.sock")
TCP_HOST = os.environ.get("PIERSIDE_TCP_HOST", "0.0.0.0")
TCP_PORT = int(os.environ.get("PIERSIDE_TCP_PORT", "8080"))
# Host-side port of the TCP listener (WebSockets, downloads, standalone window). docker-compose.yaml
# lets Docker pick a free one, so two Pierside installs never fight over a fixed port; the backend
# looks it up at start-up (services/selfport.py). PIERSIDE_PUBLIC_WS_PORT pins it instead.
_public_port = int(os.environ.get("PIERSIDE_PUBLIC_WS_PORT", "0"))


def public_port() -> int:
    return _public_port


def set_public_port(port: int) -> None:
    global _public_port
    _public_port = port

# Random per-process token; the UI fetches it via vm.service and passes it on WS URLs.
WS_TOKEN = os.environ.get("PIERSIDE_WS_TOKEN") or secrets.token_urlsafe(24)
