"""The user's shell command palette (Exec tab): labelled commands, each offered everywhere or only
for matching containers (image pattern, Compose project / service).

One list for the whole extension, kept in the backend so the Rancher view and the separate window
see the same commands on every engine. The UI matches the scopes and types the command into the
open shell; nothing is run here, and the MCP server doesn't see this list.
"""

import json
import logging
import os
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.engines import DATA_DIR

router = APIRouter(prefix="/commands", tags=["commands"])
log = logging.getLogger("pierside.commands")

COMMANDS_FILE = os.path.join(DATA_DIR, "commands.json")
MAX_COMMANDS = 500


class Scope(BaseModel):
    kind: Literal["all", "image", "compose"] = "all"
    # Glob patterns (* and ?), matched case-insensitively by the UI. Empty means any.
    image: str = Field("", max_length=300)
    project: str = Field("", max_length=200)
    service: str = Field("", max_length=200)


class Command(BaseModel):
    id: str = Field("", max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    command: str = Field(..., min_length=1, max_length=8000)
    # True: type it and press Enter. False: only type it, so it can be edited first.
    run: bool = False
    scope: Scope = Field(default_factory=Scope)


def _read() -> list[dict]:
    try:
        with open(COMMANDS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as e:
        log.warning("cannot read %s: %s", COMMANDS_FILE, e)
        return []


@router.get("")
async def list_commands():
    return _read()


@router.put("")
async def save_commands(commands: list[Command]):
    if len(commands) > MAX_COMMANDS:
        raise HTTPException(413, f"At most {MAX_COMMANDS} commands")
    out = []
    for c in commands:
        if not c.id:
            c.id = uuid.uuid4().hex[:12]
        out.append(c.model_dump())
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = COMMANDS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(tmp, COMMANDS_FILE)
    return out
