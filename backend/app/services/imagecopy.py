"""Copy an image from the active engine to another one, without a registry.

`docker save` on the source is streamed straight into `docker load` on the target (like
`docker save img | ssh host docker load`), chunk by chunk, so nothing is buffered on disk or in
memory. Runs as a background job the UI polls for progress.
"""

import asyncio
import json
import logging
import os
import secrets
import time
from urllib.parse import quote

import aiodocker

from app.services.docker_client import STREAM_TIMEOUT, get_docker
from app.services.engines import LOCAL_ID, LOCAL_URL, SOCK_DIR, EngineError, Tunnel, engines

log = logging.getLogger("pierside.imagecopy")

JOB_TTL_S = 600  # finished jobs are kept this long for the UI to read the result
_jobs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}


def _prune() -> None:
    now = time.monotonic()
    for jid, job in list(_jobs.items()):
        if job["state"] != "running" and now - job["_finished"] > JOB_TTL_S:
            _jobs.pop(jid, None)


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def get_job(jid: str) -> dict | None:
    return _jobs.get(jid)


async def _engine_info(docker: aiodocker.Docker) -> dict:
    v = await docker.version()
    return {"os": v.get("Os"), "arch": v.get("Arch"), "version": v.get("Version")}


async def _open_target(target: str, job_id: str):
    """(docker client, tunnel or None) for the target engine."""
    if target == LOCAL_ID:
        return aiodocker.Docker(url=LOCAL_URL), None
    cfg = engines.registry.engines.get(target)
    if cfg is None:
        raise EngineError("Unknown target engine")
    os.makedirs(SOCK_DIR, exist_ok=True)
    tunnel = Tunnel(cfg)
    tunnel.path = os.path.join(SOCK_DIR, f"{cfg.id}-copy-{job_id}.sock")  # separate from the active engine's tunnel
    await tunnel.start()
    return aiodocker.Docker(url=tunnel.url), tunnel


async def _run(job: dict) -> None:
    src = get_docker()
    dst, tunnel = None, None
    try:
        dst, tunnel = await _open_target(job["target"], job["id"])
        job["targetEngine"] = await _engine_info(dst)
        job["phase"] = "transferring"

        async with src._query(f"images/{quote(job['image'], safe='')}/get", timeout=STREAM_TIMEOUT) as save:

            async def body():
                async for chunk in save.content.iter_chunked(256 * 1024):
                    job["bytes"] += len(chunk)
                    yield chunk

            async with dst._query(
                "images/load", method="POST", data=body(), headers={"Content-Type": "application/x-tar"}, params={"quiet": "1"}, timeout=STREAM_TIMEOUT
            ) as load:
                job["phase"] = "loading"
                raw = await load.read()

        # docker load answers with JSON lines; errors come back inside them, not as an HTTP status.
        loaded = []
        for line in raw.decode("utf-8", "replace").splitlines():
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("error") or msg.get("errorDetail"):
                raise RuntimeError(msg.get("error") or (msg.get("errorDetail") or {}).get("message"))
            if msg.get("stream"):
                loaded.append(msg["stream"].strip())
        job["loaded"] = [m for m in loaded if m]
        job["state"] = "done"
    except asyncio.CancelledError:
        job["state"] = "cancelled"
        raise
    except aiodocker.DockerError as e:
        job["state"] = "error"
        job["error"] = (e.message.get("message") if isinstance(e.message, dict) else str(e.message)) or str(e)
    except Exception as e:
        job["state"] = "error"
        job["error"] = str(e) or type(e).__name__
        log.warning("image copy %s failed: %s", job["image"], e)
    finally:
        job["_finished"] = time.monotonic()
        job["elapsed"] = round(time.monotonic() - job["_started"], 1)
        if dst is not None:
            await dst.close()
        if tunnel is not None:
            await tunnel.stop()
        _tasks.pop(job["id"], None)


async def start_copy(image: str, target: str) -> dict:
    if target == engines.active_id:
        raise EngineError("That's the engine you're on; pick another one")
    if target != LOCAL_ID and target not in engines.registry.engines:
        raise EngineError("Unknown target engine")
    info = await get_docker().images.inspect(image)  # 404 if missing
    _prune()
    jid = secrets.token_hex(6)
    target_name = "Local (Rancher Desktop)" if target == LOCAL_ID else engines.registry.engines[target].name
    job = {
        "id": jid,
        "image": image,
        "target": target,
        "targetName": target_name,
        "imageArch": f"{info.get('Os')}/{info.get('Architecture')}",
        "state": "running",
        "phase": "connecting",
        "bytes": 0,
        "error": None,
        "loaded": [],
        "_started": time.monotonic(),
        "_finished": 0.0,
    }
    _jobs[jid] = job
    _tasks[jid] = asyncio.create_task(_run(job), name=f"imagecopy-{jid}")
    return public(job)


def cancel(jid: str) -> bool:
    task = _tasks.get(jid)
    if task is None:
        return False
    task.cancel()
    return True
