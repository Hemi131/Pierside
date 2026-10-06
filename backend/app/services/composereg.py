"""Remembered compose projects, per engine: where their files are, and the options last used.

Compose labels every container with its project's config files and working directory, but those
labels vanish with the containers (`docker compose down`). This registry records them while the
project exists, so Pierside can bring a project back up later, and keeps the Up/Down options the
user chose. Stored in the extension's data volume next to the engine registry.
"""

import json
import logging
import os
import time

from app.services.engines import DATA_DIR

log = logging.getLogger("pierside.compose")

REGISTRY = os.path.join(DATA_DIR, "compose.json")


class ComposeRegistry:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, dict]] = {}  # engine id -> project name -> entry
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(REGISTRY, encoding="utf-8") as f:
                self.data = json.load(f)
        except FileNotFoundError:
            pass
        except Exception as e:
            log.error("cannot read %s: %s", REGISTRY, e)

    def _save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = REGISTRY + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2)
        os.replace(tmp, REGISTRY)

    def observe(self, engine_id: str, containers: list[dict]) -> None:
        """Record the compose projects seen in a container listing (saves only when something changed)."""
        self._load()
        projects = self.data.setdefault(engine_id, {})
        changed = False
        now = time.time()
        for c in containers:
            name = c.get("project")
            files = c.get("projectConfigFiles")
            if not name or not files or c.get("isExtension"):
                continue
            entry = projects.get(name)
            config_files = [f for f in files.split(",") if f]
            working_dir = c.get("projectWorkingDir") or ""
            if entry is None:
                projects[name] = {"configFiles": config_files, "workingDir": working_dir, "options": {}, "lastSeen": now}
                changed = True
            else:
                if entry.get("configFiles") != config_files or entry.get("workingDir") != working_dir:
                    entry["configFiles"], entry["workingDir"] = config_files, working_dir
                    changed = True
                entry["lastSeen"] = now
        if changed:
            self._save()

    def projects(self, engine_id: str) -> dict[str, dict]:
        self._load()
        return self.data.get(engine_id, {})

    def upsert(self, engine_id: str, name: str, config_files: list[str] | None, working_dir: str | None, options: dict | None) -> dict:
        self._load()
        entry = self.data.setdefault(engine_id, {}).setdefault(name, {"configFiles": [], "workingDir": "", "options": {}, "lastSeen": 0})
        if config_files is not None:
            entry["configFiles"] = config_files
        if working_dir is not None:
            entry["workingDir"] = working_dir
        if options is not None:
            entry["options"] = options
        self._save()
        return entry

    def forget_engine(self, engine_id: str) -> None:
        self._load()
        if self.data.pop(engine_id, None) is not None:
            self._save()

    def forget(self, engine_id: str, name: str) -> None:
        self._load()
        if self.data.get(engine_id, {}).pop(name, None) is not None:
            self._save()


registry = ComposeRegistry()
