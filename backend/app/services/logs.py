"""Container log streaming with multiplex demuxing, line assembly and restart-following."""

import asyncio
import calendar
import logging
import struct
import time
from collections.abc import AsyncIterator
from typing import TypedDict

import aiodocker
import aiohttp

from app.services.docker_client import get_docker, query_json, STREAM_TIMEOUT

def transient(e: BaseException) -> bool:
    """A failure that passes: the stream is reopened from where it was (an SSH channel drop, a reset,
    an engine briefly unreachable, which aiodocker reports as status 900, or a gateway error)."""
    if isinstance(e, aiodocker.DockerError):
        # Not every 5xx: 501 "logging driver does not support reading" (--log-driver none, remote
        # drivers) is permanent and must show as an error, not reopen every second.
        return e.status in (900, 502, 503, 504)
    return isinstance(e, (aiohttp.ClientError, asyncio.TimeoutError, OSError))

log = logging.getLogger("pierside.logs")

STREAMS = {0: "stdin", 1: "stdout", 2: "stderr"}
MAX_LINE = 64 * 1024  # force-split pathological lines without newlines


class LogLine(TypedDict):
    t: str  # RFC3339Nano timestamp from the engine
    k: int  # sort key: ns since epoch
    s: str  # stdout | stderr
    m: str  # message (may contain ANSI escapes)


def ts_key(ts: str) -> int:
    """RFC3339Nano ('2026-09-24T18:32:19.843247697Z') -> ns since epoch. Tolerates missing fraction."""
    try:
        main, _, frac = ts.rstrip("Z").partition(".")
        # Docker always reports UTC ('Z'); strip any offset defensively.
        main = main[:19]
        secs = calendar.timegm(time.strptime(main, "%Y-%m-%dT%H:%M:%S"))
        ns = int((frac.rstrip("Z")[:9]).ljust(9, "0")) if frac else 0
        return secs * 1_000_000_000 + ns
    except Exception:
        return 0


class _LineAssembler:
    def __init__(self) -> None:
        self.buf: dict[str, bytes] = {}

    def feed(self, stream: str, data: bytes) -> list[tuple[str, str]]:
        buf = self.buf.get(stream, b"") + data
        out = []
        while True:
            i = buf.find(b"\n")
            if i < 0:
                if len(buf) > MAX_LINE:
                    out.append((stream, buf[:MAX_LINE]))
                    buf = buf[MAX_LINE:]
                    continue
                break
            out.append((stream, buf[:i]))
            buf = buf[i + 1 :]
        self.buf[stream] = buf
        return [(s, b.decode("utf-8", "replace").rstrip("\r")) for s, b in out]

    def flush(self) -> list[tuple[str, str]]:
        out = [(s, b.decode("utf-8", "replace").rstrip("\r")) for s, b in self.buf.items() if b]
        self.buf.clear()
        return out


def _to_line(stream: str, raw: str) -> LogLine:
    # With timestamps=1 every line starts with "<RFC3339Nano> ".
    ts, sep, msg = raw.partition(" ")
    if not sep or not ts[:4].isdigit():
        return {"t": "", "k": 0, "s": stream, "m": raw}
    return {"t": ts, "k": ts_key(ts), "s": stream, "m": msg}


async def raw_log_lines(cid: str, tty: bool, params: dict, path: str | None = None) -> AsyncIterator[list[LogLine]]:
    """Stream + demux + assemble lines from a logs endpoint (containers/{id}/logs by default)."""
    asm = _LineAssembler()
    async with get_docker()._query(path or f"containers/{cid}/logs", params=params, timeout=STREAM_TIMEOUT) as resp:
        if tty:
            async for chunk in resp.content.iter_any():
                lines = asm.feed("stdout", chunk)
                if lines:
                    yield [_to_line(s, m) for s, m in lines]
        else:
            # Multiplexed: [stream(1) 0 0 0 size(4, BE)] + payload, frames can span chunks.
            pending = b""
            async for chunk in resp.content.iter_any():
                pending += chunk
                lines: list[tuple[str, str]] = []
                while len(pending) >= 8:
                    stype, size = pending[0], struct.unpack(">I", pending[4:8])[0]
                    if len(pending) < 8 + size:
                        break
                    payload, pending = pending[8 : 8 + size], pending[8 + size :]
                    lines.extend(asm.feed(STREAMS.get(stype, "stdout"), payload))
                if lines:
                    yield [_to_line(s, m) for s, m in lines]
    tail = asm.flush()
    if tail:
        yield [_to_line(s, m) for s, m in tail]


async def follow_container_logs(
    cid: str, *, tail: str = "1000", on_status=None, follow_restarts: bool = True
) -> AsyncIterator[list[LogLine]]:
    """Yield batches of log lines. When the container stops, wait for it to start again and
    resume from the last seen timestamp (deduplicated), so restarts don't break the view."""
    last_key = 0
    first = True
    # After a reopen, lines up to `seen` came with the previous stream already. Within one stream nothing
    # is dropped: stdout and stderr are timestamped separately, so their lines can arrive slightly out of
    # timestamp order, and a "newer than the last line" filter would lose some of them.
    seen = 0
    while True:
        try:
            info = await query_json(f"containers/{cid}/json")
        except Exception as e:
            if isinstance(e, aiodocker.DockerError) and e.status == 404:
                if on_status:
                    await on_status("removed")
                return
            if not transient(e):
                raise
            await asyncio.sleep(2.0)  # the engine is briefly unreachable: ask again
            continue
        tty = bool((info.get("Config") or {}).get("Tty"))
        running = (info.get("State") or {}).get("Running", False)
        params = {"follow": "1", "stdout": "1", "stderr": "1", "timestamps": "1"}
        if first:
            params["tail"] = tail
        else:
            # `since` is inclusive at 1 s granularity in practice; filter duplicates by key below.
            params["since"] = f"{last_key // 1_000_000_000}.{last_key % 1_000_000_000:09d}"
            seen = last_key
        if on_status:
            await on_status("streaming" if running else "stopped")
        try:
            async for batch in raw_log_lines(cid, tty, params):
                if seen:
                    batch = [l for l in batch if l["k"] > seen or l["k"] == 0]
                if batch:
                    last_key = max(last_key, max(l["k"] for l in batch))
                    yield batch
        except Exception as e:
            if not transient(e):
                raise
            # The stream broke, not the container: reopen from the last line (not the whole tail again).
            log.info("log stream of %s broke (%s); reopening", cid[:12], e)
            first = first and last_key == 0
            await asyncio.sleep(1.0)
            continue
        first = False
        if not follow_restarts:
            return
        # Stream ended: container stopped (or removed). Wait for a restart.
        if on_status:
            await on_status("stopped")
        while True:
            await asyncio.sleep(1.0)
            try:
                info = await query_json(f"containers/{cid}/json")
            except Exception as e:
                if isinstance(e, aiodocker.DockerError) and e.status == 404:
                    if on_status:
                        await on_status("removed")
                    return
                if not transient(e):
                    raise
                continue  # one failed look isn't a removed container
            if (info.get("State") or {}).get("Running"):
                break
