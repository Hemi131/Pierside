"""Standalone window: the UI served by the backend itself (http://localhost:<published port>/app/).

Rancher Desktop embeds the extension next to its own navigation, which an extension can't hide.
"Open in separate window" opens the same UI in the user's browser instead. To avoid putting the
session token into a URL (browser history), the extension asks for a one-time ticket over the
token-authenticated vm.service path, the browser page redeems it once for the token, then drops it
from the URL.
"""

import json
import logging
import os
import secrets
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import WS_TOKEN, public_port
from app.services.engines import DATA_DIR
from app.services.store import write_json

router = APIRouter(prefix="/standalone", tags=["standalone"])

TICKET_TTL_S = 60
_tickets: dict[str, float] = {}  # ticket -> expiry (monotonic)


def _prune() -> None:
    now = time.monotonic()
    for t, exp in list(_tickets.items()):
        if exp < now:
            _tickets.pop(t, None)


@router.post("/ticket")
async def create_ticket():
    """Requires the session token like every other endpoint (see security.py)."""
    _prune()
    ticket = secrets.token_urlsafe(24)
    _tickets[ticket] = time.monotonic() + TICKET_TTL_S
    return {"url": f"http://localhost:{public_port()}/app/?ticket={ticket}", "expiresIn": TICKET_TTL_S}


class Redeem(BaseModel):
    ticket: str


# ---- the separate window's view settings ------------------------------------------------------
# Rancher's view keeps its settings (sidebar, filters, column widths, ...) in its browser storage.
# The separate window can't: its address includes the backend's host port, which Docker picks anew
# when the backend container is recreated, and browser storage is per address. So its settings live
# here instead, in their own file: still separate from Rancher's view, but they survive that.

log = logging.getLogger("pierside.standalone")
PREFS_FILE = os.path.join(DATA_DIR, "window-prefs.json")
MAX_PREFS_BYTES = 256 * 1024


@router.get("/prefs")
async def get_prefs():
    try:
        with open(PREFS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("cannot read %s: %s", PREFS_FILE, e)
        return {}


@router.put("/prefs")
async def put_prefs(prefs: dict):
    data = json.dumps(prefs)
    if len(data) > MAX_PREFS_BYTES:
        raise HTTPException(413, "Too many settings")
    write_json(PREFS_FILE, data)  # already serialised (its size was checked)
    return {"ok": True}


@router.post("/redeem")
async def redeem_ticket(body: Redeem):
    """Exchange a one-time ticket for the session token (allowed without a token, see security.py)."""
    _prune()
    exp = _tickets.pop(body.ticket, None)
    if exp is None:
        raise HTTPException(403, "This link has expired or was already used. Open the window again from Pierside in Rancher Desktop.")
    return {"token": WS_TOKEN, "port": public_port()}
