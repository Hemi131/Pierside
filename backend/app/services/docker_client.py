"""Shared aiodocker client and low-level helpers."""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import aiodocker
import aiohttp

_docker: aiodocker.Docker | None = None

# For long-lived streams (events, logs, stats): no total/read timeout.
STREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_read=None, sock_connect=10)


_docker_url: str | None = None


def get_docker() -> aiodocker.Docker:
    """Client for the *active* engine (local socket, or an SSH tunnel's local socket)."""
    global _docker, _docker_url
    from app.services.engines import engines  # late import (engines imports nothing from here)

    url = engines.url()
    if _docker is not None and _docker_url != url:
        # Never keep talking to a different engine than the active one (e.g. a client created
        # before the remote engine's tunnel was up).
        stale = _docker
        asyncio.get_running_loop().create_task(stale.close())
        _docker = None
    if _docker is None:
        _docker = aiodocker.Docker(url=url)
        _docker_url = url
    return _docker


async def close_docker() -> None:
    global _docker
    if _docker is not None:
        await _docker.close()
        _docker = None


async def query_json(path: str, method: str = "GET", params: dict | None = None, data: Any = None) -> Any:
    kwargs: dict[str, Any] = {"method": method, "params": params}
    if data is not None:
        kwargs["data"] = json.dumps(data)
        kwargs["headers"] = {"Content-Type": "application/json"}
    return await get_docker()._query_json(path, **kwargs)


async def stream_json_lines(path: str, params: dict | None = None, method: str = "GET", docker: aiodocker.Docker | None = None) -> AsyncIterator[dict]:
    """Iterate a newline-delimited JSON stream from the engine (events, stats, pull progress); the
    active engine unless another engine's client is given."""
    async with (docker or get_docker())._query(path, method=method, params=params, timeout=STREAM_TIMEOUT) as resp:
        buf = b""
        async for chunk in resp.content.iter_any():
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    yield json.loads(line)
