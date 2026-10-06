"""Disk usage (docker system df) per category, with one-click cleanup per category."""

import json
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.services import containers as containers_svc
from app.services import helper, updates
from app.services.docker_client import query_json

router = APIRouter(prefix="/system", tags=["system"])

TOP = 8  # largest items listed per category


def _name(c: dict) -> str:
    return (c.get("Names") or ["/"])[0].lstrip("/")


def _image_name(i: dict) -> str:
    tags = [t for t in i.get("RepoTags") or [] if t != "<none>:<none>"]
    if tags:
        return tags[0]
    digests = i.get("RepoDigests") or []
    if digests:
        return digests[0].split("@", 1)[0] + ":<none>"
    return i["Id"].removeprefix("sha256:")[:12]


def _size(v) -> int:
    return v if isinstance(v, int) and v > 0 else 0


def _daemon_totals(df: dict, key: str, fallback: dict) -> dict:
    """Newer engines (API >= 1.52) compute totals themselves (`ImageUsage` etc.); prefer those."""
    u = df.get(key)
    if not isinstance(u, dict) or "TotalSize" not in u:
        return fallback
    return {"count": u.get("TotalCount", fallback["count"]), "active": u.get("ActiveCount", 0), "size": u.get("TotalSize", 0), "reclaimable": u.get("Reclaimable", 0)}


@router.get("/version")
async def version():
    """This build's version and, unless switched off, whether a newer release exists."""
    return await updates.version_info()


class UpdateCheck(BaseModel):
    check: bool


@router.put("/version")
async def set_update_check(body: UpdateCheck):
    updates.set_check_enabled(body.check)
    return await updates.version_info()


@router.get("/df")
async def disk_usage():
    """Slow on big engines (walks container layers and volumes); the UI shows a spinner."""
    df = await query_json("system/df")
    images = df.get("Images") or []
    containers = df.get("Containers") or []
    volumes = df.get("Volumes") or []
    cache = df.get("BuildCache") or []

    # Fallback for older engines: the same arithmetic the docker CLI used.
    img_total = _size(df.get("LayersSize"))
    img_used = sum(_size(i.get("Size")) - _size(i.get("SharedSize")) for i in images if i.get("Containers"))
    ctr_total = sum(_size(c.get("SizeRw")) for c in containers)
    ctr_reclaim = sum(_size(c.get("SizeRw")) for c in containers if c.get("State") != "running")
    vol_size = lambda v: _size((v.get("UsageData") or {}).get("Size"))  # noqa: E731
    vol_refs = lambda v: (v.get("UsageData") or {}).get("RefCount") or 0  # noqa: E731
    cache_own = [b for b in cache if not b.get("Shared")]

    return {
        "images": {
            **_daemon_totals(
                df,
                "ImageUsage",
                {
                    "count": len(images),
                    "active": sum(1 for i in images if i.get("Containers")),
                    "size": img_total,
                    "reclaimable": max(img_total - img_used, 0),
                },
            ),
            "top": [
                {"id": i["Id"], "name": _image_name(i), "size": _size(i.get("Size")), "inUse": bool(i.get("Containers"))}
                for i in sorted(images, key=lambda i: _size(i.get("Size")), reverse=True)[:TOP]
            ],
        },
        "containers": {
            **_daemon_totals(
                df,
                "ContainerUsage",
                {
                    "count": len(containers),
                    "active": sum(1 for c in containers if c.get("State") == "running"),
                    "size": ctr_total,
                    "reclaimable": ctr_reclaim,
                },
            ),
            "top": [
                {"id": c["Id"], "name": _name(c), "size": _size(c.get("SizeRw")), "inUse": c.get("State") == "running", "state": c.get("State")}
                for c in sorted(containers, key=lambda c: _size(c.get("SizeRw")), reverse=True)[:TOP]
            ],
        },
        "volumes": {
            **_daemon_totals(
                df,
                "VolumeUsage",
                {
                    "count": len(volumes),
                    "active": sum(1 for v in volumes if vol_refs(v)),
                    "size": sum(vol_size(v) for v in volumes),
                    "reclaimable": sum(vol_size(v) for v in volumes if not vol_refs(v)),
                },
            ),
            "top": [
                {"id": v["Name"], "name": v["Name"], "size": vol_size(v), "inUse": bool(vol_refs(v))}
                for v in sorted(volumes, key=vol_size, reverse=True)[:TOP]
            ],
        },
        "buildCache": {
            **_daemon_totals(
                df,
                "BuildCacheUsage",
                {
                    "count": len(cache),
                    "active": sum(1 for b in cache if b.get("InUse")),
                    "size": sum(_size(b.get("Size")) for b in cache_own),
                    "reclaimable": sum(_size(b.get("Size")) for b in cache_own if not b.get("InUse")),
                },
            ),
            "top": [
                {
                    "id": b.get("ID"),
                    "name": (b.get("Description") or b.get("Type") or b.get("ID") or "")[:120],
                    "size": _size(b.get("Size")),
                    "inUse": bool(b.get("InUse")),
                    "lastUsed": b.get("LastUsedAt"),
                }
                for b in sorted(cache_own, key=lambda b: _size(b.get("Size")), reverse=True)[:TOP]
            ],
        },
    }


@router.post("/prune/{kind}")
async def prune(kind: Literal["containers", "images", "volumes", "buildCache"]):
    if kind == "containers":
        res = await query_json("containers/prune", method="POST")
        containers_svc.invalidate()
        return {"deleted": len(res.get("ContainersDeleted") or []), "spaceReclaimed": res.get("SpaceReclaimed", 0)}
    if kind == "images":
        res = await query_json("images/prune", method="POST", params={"filters": json.dumps({"dangling": ["false"]})})
        deleted = [d for d in res.get("ImagesDeleted") or [] if d.get("Deleted")]
        return {"deleted": len(deleted), "spaceReclaimed": res.get("SpaceReclaimed", 0)}
    if kind == "volumes":
        from app.routers.volumes import prune_unused

        res = await prune_unused()  # never extension volumes
        return {"deleted": len(res["deleted"]), "spaceReclaimed": res["spaceReclaimed"]}
    res = await query_json("build/prune", method="POST", params={"all": "true"})
    return {"deleted": len(res.get("CachesDeleted") or []), "spaceReclaimed": res.get("SpaceReclaimed", 0)}
