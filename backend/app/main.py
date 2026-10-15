import logging
import os
from contextlib import asynccontextmanager

import aiodocker
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import WS_TOKEN, public_port
from app.security import DEV_ORIGINS
from app.routers import commands, compose, glance, containers, engines as engines_router, forwards as forwards_router, hostdisk, hostfs, images, mcp, networks, projects, standalone, swarm, system, volumes
from app.services.docker_client import close_docker, get_docker
from app.services.engines import engines
from app.services.hub import hub
from app.services.forwards import forwards
from app.services.selfport import discover_public_port
from app.services.helper import remove_all_helpers
from app.services.mcp_access import clients as mcp_clients
from app.services.updates import start_image_cleanup
from app.services.watch import watch
from app.ws import events, exec as exec_ws, hostshell, logs, pull, stats

log = logging.getLogger("pierside")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await discover_public_port()
    await engines.startup()
    await forwards.startup()
    await remove_all_helpers()  # stale helpers from a previous run
    start_image_cleanup()  # images left behind by earlier versions
    watch.start()
    yield
    await watch.stop()
    await hub.shutdown()
    await forwards.shutdown()
    await mcp_clients.shutdown()
    await remove_all_helpers()
    await close_docker()


app = FastAPI(title="Pierside backend", lifespan=lifespan)
# CORS for the Vite dev server, and for the extension frame (x-rd-extension://…) when it calls the TCP port
# directly (downloads, uploads) and must read the response. Every request still needs the token (security.py).
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(DEV_ORIGINS),
    allow_origin_regex=r"x-rd-extension://.*",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(aiodocker.DockerError)
async def docker_error_handler(_req: Request, exc: aiodocker.DockerError):
    msg = exc.message.get("message") if isinstance(exc.message, dict) else str(exc.message)
    return JSONResponse(status_code=exc.status if 400 <= exc.status < 600 else 500, content={"detail": msg})


@app.exception_handler(OSError)
async def engine_unreachable_handler(_req: Request, exc: OSError):
    return JSONResponse(status_code=503, content={"detail": f"Docker engine unreachable: {exc}"})


@app.get("/health")
async def health():
    try:
        version = await get_docker().version()
        return {"ok": True, "engine": version.get("Version"), "os": version.get("Os")}
    except Exception as e:  # docker socket missing / wrong engine
        return {"ok": False, "error": str(e)}


@app.get("/ws-info")
async def ws_info():
    return {"port": public_port(), "token": WS_TOKEN}


_diag_reports: list[dict] = []


@app.post("/diag")
async def diag_report(report: dict):
    """Diagnostics sink: the UI posts here so results can be read from the host (ui/src/diagnostics.ts)."""
    _diag_reports.append(report)
    del _diag_reports[:-50]
    return {"ok": True}


@app.get("/diag")
async def diag_reports():
    return _diag_reports


app.include_router(containers.router)
app.include_router(projects.router)
app.include_router(compose.router)
app.include_router(forwards_router.router)
app.include_router(volumes.router)
app.include_router(hostfs.router)
app.include_router(hostdisk.router)
app.include_router(networks.router)
app.include_router(system.router)
app.include_router(images.router)
app.include_router(swarm.router)
app.include_router(engines_router.router)
app.include_router(standalone.router)
app.include_router(commands.router)
app.include_router(glance.router)
app.include_router(mcp.router)
app.include_router(mcp.admin)

# Standalone window: the same UI build Rancher loads, served at /app/ (see routers/standalone.py).
UI_DIR = os.environ.get("PIERSIDE_UI_DIR", "/ui")
if os.path.isdir(UI_DIR):
    app.mount("/app", StaticFiles(directory=UI_DIR, html=True), name="app")
app.include_router(events.router)
app.include_router(logs.router)
app.include_router(exec_ws.router)
app.include_router(hostshell.router)
app.include_router(pull.router)
app.include_router(stats.router)
