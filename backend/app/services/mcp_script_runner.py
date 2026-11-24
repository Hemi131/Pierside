"""Runs an assistant's script in Pierside's script sandbox (see mcp_scripts.py). Standard library only.

The backend passes this file to `python -I -B -c` in a container with no network, no Docker socket,
no mounts, a read-only root and no capabilities. The container is the security boundary, not this
file: the script shares this process and can read or change anything here. The backend therefore
takes nothing from it as fact. It checks every call it is asked to make exactly like a direct call,
and keeps its own count of calls, changes and time.

Protocol, one JSON object per line on the exec's stdin / stdout. Nothing in it is Python-specific, so
a runner for another language can speak it too:
  backend -> runner, first line: {"v": 1, "code", "tools": [names], "planning": bool, "cpuSeconds", "maxCalls"}
  runner -> backend: {"t": "call", "id": n, "tool", "args"}   a tool call (ids 1, 2, 3 …); the script waits
  backend -> runner: {"id": n, "ok": true, "data"} | {"id": n, "ok": false, "kind", "message"}
  runner -> backend: {"t": "print", "text"}                    what the script printed since the last one
  runner -> backend: {"t": "done", "error": null | text}       the end (error: its traceback)
"""

import json
import os
import sys
import threading
import time
import traceback

MEMORY_BYTES = 512 * 1024 * 1024  # per process (the engine's memory limit may not hold: no swap limit)
PRINT_FLUSH_CHARS = 64 * 1024
PRINT_FLUSH_S = 1.0
MAX_PAGES = 50
TRACEBACK_CHARS = 4000


class ToolFailed(Exception):
    """A tool call that didn't succeed. kind: denied (the connection doesn't allow it), refused (the
    user said no), error (bad input, missing item, Docker refused), unreachable (the engine), internal
    (a bug in Pierside). `message` is what a direct call would have answered."""

    def __init__(self, tool: str, kind: str, message: str) -> None:
        super().__init__(f"{tool}: {message}")
        self.tool, self.kind, self.message = tool, kind, message


class _Stopped(BaseException):
    """The backend went away: the run is over (not catchable as Exception)."""


def main() -> None:
    # The protocol gets its own copy of stdout; fd 1 itself now goes to stderr, so whatever writes to
    # it below Python (a subprocess, C code) can't land in the middle of the protocol by accident.
    proto = os.dup(1)
    os.dup2(2, 1)
    stdin = sys.stdin.buffer

    lock = threading.RLock()  # one writer at a time: the script and the flusher thread
    finished = [False]

    def write_line(text: str) -> None:
        data = (text + "\n").encode("ascii")
        with lock:
            if finished[0]:
                return
            while data:
                data = data[os.write(proto, data) :]

    def send(msg: dict) -> None:
        write_line(json.dumps(msg))

    first = json.loads(stdin.readline())
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        cpu = int(first.get("cpuSeconds") or 60)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    except (ImportError, ValueError, OSError):
        pass

    class Printed:
        """sys.stdout / sys.stderr of the script: sent to the backend before each call, at the end, and
        every second or 64 KB in between (so a run stopped at its limit still returns what it printed)."""

        encoding = "utf-8"

        def __init__(self) -> None:
            self.parts: list[str] = []
            self.size = 0

        def write(self, text) -> int:
            text = str(text)
            with lock:
                self.parts.append(text)
                self.size += len(text)
                if self.size >= PRINT_FLUSH_CHARS:
                    self.send()
            return len(text)

        def flush(self) -> None:
            pass

        def isatty(self) -> bool:
            return False

        def send(self) -> None:
            with lock:
                if self.parts:
                    text, self.parts, self.size = "".join(self.parts), [], 0
                    # One protocol line per PRINT_FLUSH_CHARS, however much one print() wrote: the
                    # backend stops a run whose line is over its limit.
                    for i in range(0, len(text), PRINT_FLUSH_CHARS):
                        send({"t": "print", "text": text[i : i + PRINT_FLUSH_CHARS]})

    printed = Printed()

    def flusher() -> None:
        """Sends what was printed every second, also while the script computes without printing more."""
        while True:
            time.sleep(PRINT_FLUSH_S)
            printed.send()

    threading.Thread(target=flusher, daemon=True).start()
    names = set(first.get("tools") or [])
    counter = [0]

    def call(tool: str, args: dict | None = None, **kwargs):
        """Call a tool by name: call("container_logs", container="web", tail=50). Returns its data."""
        if not isinstance(tool, str):
            raise TypeError("call() takes the tool's name first")
        message = {"t": "call", "id": counter[0] + 1, "tool": tool, "args": {**(args or {}), **kwargs}}
        line = json.dumps(message)  # arguments that aren't JSON fail here, in the script
        counter[0] += 1
        with lock:  # what was printed before the call arrives before it
            printed.send()
            write_line(line)
        answer = stdin.readline()
        if not answer:
            raise _Stopped("Pierside stopped the script")
        answer = json.loads(answer)
        if answer.get("ok"):
            return answer.get("data")
        raise ToolFailed(tool, answer.get("kind") or "error", answer.get("message") or "failed")

    class Tools:
        """tools.<name>(**arguments) for each tool this connection may use; tools.names() lists them."""

        def __getattr__(self, name: str):
            if name.startswith("_"):
                raise AttributeError(name)
            if name not in names:
                raise AttributeError(f"{name} isn't a tool this connection can use (see tools.names())")
            return lambda **args: call(name, args)

        def __dir__(self):
            return sorted(names)

        def names(self) -> list[str]:
            return sorted(names)

    def pages(tool: str, **args):
        """Each page of a tool's result, following `truncated.next` (at most 50 pages)."""
        for _ in range(MAX_PAGES):
            data = call(tool, args)
            yield data
            following = ((data.get("truncated") or {}).get("next") if isinstance(data, dict) else None) or None
            if not isinstance(following, dict):
                return
            args = {**args, **following}
        raise RuntimeError(f"{tool} has more than {MAX_PAGES} pages; narrow the request")

    scope = {"__name__": "__main__", "tools": Tools(), "call": call, "pages": pages, "ToolFailed": ToolFailed, "PLANNING": bool(first.get("planning"))}
    error = None
    sys.stdout = sys.stderr = printed
    try:
        exec(compile(first["code"], "<script>", "exec"), scope)
    except SystemExit as e:
        if e.code not in (None, 0):
            error = f"The script exited with {e.code}"
    except _Stopped:
        return
    except BaseException as e:
        # Only the script's own lines: the runner's frames mean nothing to whoever wrote the script.
        tb = traceback.TracebackException.from_exception(e)
        seen, todo = set(), [tb]
        while todo:  # the exception and those chained to it (raised while handling, `from`)
            one = todo.pop()
            if one is None or id(one) in seen:
                continue
            seen.add(id(one))
            one.stack = traceback.StackSummary.from_list([f for f in one.stack if f.filename == "<script>"])
            todo += [one.__cause__, one.__context__]
        text = "".join(tb.format())
        error = text if len(text) <= TRACEBACK_CHARS else "…" + text[-TRACEBACK_CHARS:]
    with lock:
        printed.send()
        send({"t": "done", "error": error})
        finished[0] = True


if __name__ == "__main__":
    main()
