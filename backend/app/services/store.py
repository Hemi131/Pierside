"""Pierside's small JSON files in /data (engines, port forwards, Compose locations, …)."""

import json
import logging
import os
import shutil
import time

log = logging.getLogger("pierside.store")


def write_json(path: str, data, mode: int | None = None, indent: int | None = 2) -> None:
    """Write atomically and durably: a temporary file, flushed to disk, then renamed over the old one."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    # Created with `mode` from the start (secrets never sit in a readable file, even briefly).
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        if isinstance(data, str):
            f.write(data)
        else:
            json.dump(data, f, indent=indent)
        f.flush()
        os.fsync(f.fileno())
    if mode is not None:
        os.chmod(tmp, mode)  # a leftover .tmp from before keeps its old mode otherwise
    os.replace(tmp, path)


def keep_unreadable(path: str, error: Exception) -> None:
    """A file that can't be read would be overwritten by the next save (with what's in memory: nothing).
    Keep a copy next to it first, so its contents can still be recovered."""
    copy = f"{path}.unreadable-{time.strftime('%Y%m%d-%H%M%S')}"
    try:
        shutil.copy2(path, copy)
        log.error("cannot read %s (%s); kept a copy as %s", path, error, copy)
    except OSError as e:
        log.error("cannot read %s (%s), nor keep a copy: %s", path, error, e)
