import secrets

from fastapi import WebSocket

from app.config import WS_TOKEN


async def accept_authorized(ws: WebSocket) -> bool:
    """Accept the socket if the token matches; otherwise close with 4401."""
    token = ws.query_params.get("token", "")
    if not secrets.compare_digest(token, WS_TOKEN):
        await ws.close(code=4401)
        return False
    await ws.accept()
    return True
