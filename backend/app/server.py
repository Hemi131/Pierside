"""Entry point: serve the app on the Rancher guest-services socket and on TCP, both behind the token guard."""

import asyncio
import logging
import os
import re

import uvicorn

from app.config import SOCKET_PATH, TCP_HOST, TCP_PORT
from app.main import app
from app.security import Guard, write_token_file

log = logging.getLogger("pierside")

_TOKEN_RE = re.compile(r"(token=)[^&\s\"']+")


class RedactTokens(logging.Filter):
    """uvicorn logs WebSocket URLs (with ?token=) on accept; keep the token out of container logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args:
            record.args = tuple(_TOKEN_RE.sub(r"\1***", a) if isinstance(a, str) else a for a in record.args)
        if isinstance(record.msg, str):
            record.msg = _TOKEN_RE.sub(r"\1***", record.msg)
        return True


for _name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    logging.getLogger(_name).addFilter(RedactTokens())


async def main() -> None:
    write_token_file()  # the extension UI reads it via the local docker CLI
    servers = []
    sock_dir = os.path.dirname(SOCKET_PATH)
    if os.path.isdir(sock_dir):
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        # Not trusted: Rancher's rdx-proxy publishes this path on all interfaces (see security.py).
        servers.append(uvicorn.Server(uvicorn.Config(Guard(app, "socket"), uds=SOCKET_PATH, log_level="info", access_log=False)))
    else:
        log.warning("%s missing; not serving on unix socket", sock_dir)
    # Access logs off: WS URLs carry the token as a query parameter.
    servers.append(uvicorn.Server(uvicorn.Config(Guard(app, "tcp"), host=TCP_HOST, port=TCP_PORT, log_level="info", access_log=False)))
    await asyncio.gather(*(s.serve() for s in servers))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
