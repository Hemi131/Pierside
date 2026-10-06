"""Reconstruct an approximate `docker run` command from container + image inspect data."""

import shlex
from typing import Any

from app.services.docker_client import query_json

_SKIP_LABEL_PREFIXES = ("com.docker.compose.", "org.opencontainers.", "desktop.docker.io/")


def _q(s: str) -> str:
    return shlex.quote(s)


async def docker_run_command(cid: str) -> str:
    c = await query_json(f"containers/{cid}/json")
    cfg: dict[str, Any] = c.get("Config") or {}
    host: dict[str, Any] = c.get("HostConfig") or {}
    try:
        img = await query_json(f"images/{c.get('Image')}/json")
        icfg = img.get("Config") or {}
    except Exception:
        icfg = {}

    parts = ["docker run -d"]
    name = (c.get("Name") or "").lstrip("/")
    if name:
        parts.append(f"--name {_q(name)}")

    rp = host.get("RestartPolicy") or {}
    if rp.get("Name") and rp["Name"] != "no":
        v = rp["Name"] + (f":{rp['MaximumRetryCount']}" if rp["Name"] == "on-failure" and rp.get("MaximumRetryCount") else "")
        parts.append(f"--restart {v}")
    if host.get("AutoRemove"):
        parts.append("--rm")
    if host.get("Init"):
        parts.append("--init")
    if host.get("Privileged"):
        parts.append("--privileged")

    net = host.get("NetworkMode")
    if net and net not in ("default", "bridge"):
        parts.append(f"--network {_q(net)}")

    for cport, bindings in sorted((host.get("PortBindings") or {}).items()):
        port, _, proto = cport.partition("/")
        suffix = "" if proto in ("", "tcp") else f"/{proto}"
        for b in bindings or [{}]:
            hip, hport = b.get("HostIp") or "", b.get("HostPort") or ""
            spec = ":".join(x for x in (hip, hport) if x)
            parts.append(f"-p {spec + ':' if spec else ''}{port}{suffix}")

    for m in c.get("Mounts") or []:
        src = m.get("Name") if m.get("Type") == "volume" else m.get("Source")
        if not src:
            continue
        ro = "" if m.get("RW", True) else ":ro"
        parts.append(f"-v {_q(f'{src}:{m.get('Destination')}{ro}')}")

    image_env = set(icfg.get("Env") or [])
    for e in cfg.get("Env") or []:
        if e not in image_env:
            parts.append(f"-e {_q(e)}")

    image_labels = icfg.get("Labels") or {}
    for k, v in (cfg.get("Labels") or {}).items():
        if k.startswith(_SKIP_LABEL_PREFIXES) or image_labels.get(k) == v:
            continue
        parts.append(f"--label {_q(f'{k}={v}')}")

    if cfg.get("User") and cfg.get("User") != icfg.get("User"):
        parts.append(f"--user {_q(cfg['User'])}")
    if cfg.get("WorkingDir") and cfg.get("WorkingDir") != icfg.get("WorkingDir"):
        parts.append(f"-w {_q(cfg['WorkingDir'])}")
    if cfg.get("Tty"):
        parts.append("-t")
    if cfg.get("OpenStdin"):
        parts.append("-i")

    entry = cfg.get("Entrypoint") or []
    if entry != (icfg.get("Entrypoint") or []):
        parts.append(f"--entrypoint {_q(' '.join(entry))}")

    parts.append(_q(cfg.get("Image") or c.get("Image") or ""))

    cmd = cfg.get("Cmd") or []
    if cmd and cmd != (icfg.get("Cmd") or []):
        parts.append(" ".join(_q(x) for x in cmd))

    return " \\\n  ".join(parts)
