"""This build's version, the check for a newer release, and removal of old Pierside images.

Release check: at most once a day, and only when the UI asks, the backend reads the newest release
of the public repository from GitHub's API. Nothing about this installation is sent. It can be
switched off (About dialog, or PIERSIDE_UPDATE_CHECK=off), and builds that aren't a release
(`dev`, `edge-…`) never check.

Old images: Rancher never deletes an extension's previous image, so every update leaves one behind
on the local engine. At start-up the backend removes Pierside images (recognised by their title
label) that no container uses and that are either untagged, or an older release from the repository
this copy was installed from.
"""

import asyncio
import json
import logging
import os
import re
import socket
import time

import aiodocker
import aiohttp

from app.services.engines import DATA_DIR, LOCAL_URL

log = logging.getLogger("pierside.updates")

VERSION = os.environ.get("PIERSIDE_VERSION") or "dev"
REPOSITORY = "Hemi131/Pierside"
RELEASES_API = os.environ.get("PIERSIDE_RELEASES_API") or f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPOSITORY}/releases"
TITLE_LABEL = "org.opencontainers.image.title=Pierside"
SETTINGS = os.path.join(DATA_DIR, "updates.json")
CHECK_EVERY = 24 * 3600
RETRY_AFTER_ERROR = 3600

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(text: str | None) -> tuple[int, int, int] | None:
    m = _SEMVER.match((text or "").strip())
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def split_ref(ref: str) -> tuple[str, str]:
    """"ghcr.io/owner/name:1.2.3" -> ("ghcr.io/owner/name", "1.2.3"); a registry port is not a tag."""
    ref = ref.split("@", 1)[0]
    head, sep, tail = ref.rpartition(":")
    return (head, tail) if sep and "/" not in tail else (ref, "latest")


async def _own_container() -> dict | None:
    """This backend's container, always on the local engine."""
    try:
        async with aiodocker.Docker(url=LOCAL_URL) as docker:
            return await docker._query_json(f"containers/{socket.gethostname()}/json")
    except Exception as e:
        log.debug("can't inspect own container: %s", e)
        return None


# ---- release check ----------------------------------------------------------------------------------


def check_enabled() -> bool:
    if os.environ.get("PIERSIDE_UPDATE_CHECK", "").lower() in ("off", "0", "false", "no"):
        return False
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return bool(json.load(f).get("check", True))
    except (OSError, ValueError):
        return True


def set_check_enabled(enabled: bool) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump({"check": enabled}, f)


_latest: dict = {"at": 0.0, "version": None, "url": None, "error": None}
_lock = asyncio.Lock()


async def _refresh_latest() -> None:
    async with _lock:
        age = time.time() - _latest["at"]
        if age < (RETRY_AFTER_ERROR if _latest["error"] else CHECK_EVERY):
            return
        _latest["at"] = time.time()
        try:
            headers = {"Accept": "application/vnd.github+json", "User-Agent": "Pierside"}
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as http:
                async with http.get(RELEASES_API, headers=headers) as resp:
                    if resp.status == 404:  # no release published yet
                        _latest.update(version=None, url=None, error=None)
                        return
                    resp.raise_for_status()
                    release = await resp.json()
            _latest.update(version=(release.get("tag_name") or "").lstrip("v") or None, url=release.get("html_url"), error=None)
        except Exception as e:
            _latest["error"] = str(e) or type(e).__name__
            log.info("release check failed: %s", _latest["error"])


async def version_info() -> dict:
    current = parse_version(VERSION)
    enabled = check_enabled()
    info: dict = {"version": VERSION, "release": current is not None, "check": enabled, "latest": None, "updateAvailable": False, "releaseUrl": RELEASES_PAGE, "commands": [], "error": None}
    if not enabled or current is None:
        return info
    await _refresh_latest()
    info["latest"], info["error"] = _latest["version"], _latest["error"]
    newest = parse_version(_latest["version"])
    if newest and newest > current:
        info["updateAvailable"] = True
        info["releaseUrl"] = _latest["url"] or RELEASES_PAGE
        me = await _own_container()
        repo, tag = split_ref((me or {}).get("Config", {}).get("Image") or "ghcr.io/hemi131/pierside:latest")
        if parse_version(tag):
            # Installed by version: the new tag has never been on this machine, so install pulls it.
            info["commands"] = [f"rdctl extension uninstall {repo}:{tag}", f"rdctl extension install {repo}:{_latest['version']}"]
        else:
            # A moving tag (latest): Rancher reuses the local image and never pulls, so pull first.
            info["commands"] = [f"docker pull {repo}:{tag}", f"rdctl extension uninstall {repo}:{tag}", f"rdctl extension install {repo}:{tag}"]
    return info


# ---- old images -------------------------------------------------------------------------------------

_cleanup_started = False


def start_image_cleanup() -> None:
    """Fire and forget, once per process (the lifespan runs for both servers)."""
    global _cleanup_started
    if _cleanup_started:
        return
    _cleanup_started = True
    asyncio.ensure_future(_remove_old_images())


async def _remove_old_images() -> None:
    try:
        async with aiodocker.Docker(url=LOCAL_URL) as docker:
            me = await docker._query_json(f"containers/{socket.gethostname()}/json")
            my_id = me["Image"]
            my_repo, _tag = split_ref(me["Config"]["Image"])
            current = parse_version(VERSION)
            containers = await docker._query_json("containers/json", params={"all": "true"})
            used = {c.get("ImageID") for c in containers}
            images = await docker._query_json("images/json", params={"filters": json.dumps({"label": [TITLE_LABEL]})})
            for image in images:
                if image["Id"] == my_id or image["Id"] in used:
                    continue
                tags = [t for t in image.get("RepoTags") or [] if t != "<none>:<none>"]
                if not tags:
                    targets = [image["Id"]]  # left untagged by a newer pull or build
                elif current and all(split_ref(t)[0] == my_repo and (parse_version(split_ref(t)[1]) or current) < current for t in tags):
                    targets = tags  # an older release of this same extension
                else:
                    continue
                for target in targets:
                    try:
                        await docker._query_json(f"images/{target}", method="DELETE")  # not forced
                        log.info("removed old Pierside image %s", target)
                    except Exception as e:
                        log.info("old Pierside image %s kept: %s", target, e)
    except Exception as e:
        log.info("old image clean-up skipped: %s", e)
