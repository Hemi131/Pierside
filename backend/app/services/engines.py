"""Docker engines: the local Rancher engine plus remote engines reached over SSH.

A remote engine is exposed to the rest of the backend as a *local unix socket* (one per engine,
under /tmp/pierside-engines). Every connection aiodocker opens on it is bridged over a single
shared SSH connection to the remote Docker socket, using either:
  * "socket": SSH stream-local forwarding (direct-streamlocal) to the remote socket path, or
  * "stdio":  `docker system dial-stdio` on the remote host (needs the docker CLI there).
Mode "auto" is resolved to one of those when the engine is probed.

Host keys are pinned on first use: /engines/probe returns the server's key + fingerprint, the user
confirms, and later connections only accept exactly that key.

Registry and private keys live in /data (a named volume), keys with 0600 permissions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import asyncssh

log = logging.getLogger("pierside.engines")

DATA_DIR = os.environ.get("PIERSIDE_DATA", "/data")
REGISTRY = os.path.join(DATA_DIR, "engines.json")
KEYS_DIR = os.path.join(DATA_DIR, "keys")
SOCK_DIR = "/tmp/pierside-engines"
LOCAL_ID = "local"
LOCAL_URL = "unix:///var/run/docker.sock"
UNAVAILABLE_URL = "unix:///run/pierside-engine-not-connected.sock"
CONNECT_TIMEOUT = 10


@dataclass
class EngineConfig:
    id: str
    name: str
    host: str
    port: int = 22
    user: str = "root"
    socketPath: str = "/var/run/docker.sock"
    mode: str = "socket"  # socket | stdio
    publicHost: str = ""  # host used for port links; defaults to `host`
    hostKey: str = ""  # pinned OpenSSH public key of the server
    color: str = ""  # "#rrggbb": frame + banner around the UI while this engine is active ("" = none)
    hasKey: bool = False
    passphrase: str = ""
    password: str = ""
    createdAt: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("passphrase", None)
        d.pop("password", None)
        d["hasPassword"] = bool(self.password)
        d["type"] = "ssh"
        d["fingerprint"] = fingerprint(self.hostKey) if self.hostKey else None
        return d


def fingerprint(openssh_key: str) -> str:
    try:
        return asyncssh.import_public_key(openssh_key).get_fingerprint()
    except Exception:
        return "?"


# ---- registry --------------------------------------------------------------------------------


class Registry:
    def __init__(self) -> None:
        self.engines: dict[str, EngineConfig] = {}
        self.active: str = LOCAL_ID
        self.local_color: str = ""

    def load(self) -> None:
        try:
            with open(REGISTRY, encoding="utf-8") as f:
                raw = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            log.error("cannot read %s: %s", REGISTRY, e)
            return
        known = set(EngineConfig.__dataclass_fields__)
        self.engines = {e["id"]: EngineConfig(**{k: v for k, v in e.items() if k in known}) for e in raw.get("engines", [])}
        self.active = raw.get("active", LOCAL_ID)
        self.local_color = raw.get("localColor", "")
        if self.active != LOCAL_ID and self.active not in self.engines:
            self.active = LOCAL_ID

    def save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = REGISTRY + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"active": self.active, "localColor": self.local_color, "engines": [asdict(e) for e in self.engines.values()]}, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, REGISTRY)


def key_path(engine_id: str) -> str:
    return os.path.join(KEYS_DIR, f"{engine_id}.key")


def store_key(engine_id: str, key_text: str) -> None:
    os.makedirs(KEYS_DIR, exist_ok=True)
    os.chmod(KEYS_DIR, 0o700)
    path = key_path(engine_id)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key_text.strip() + "\n")


def delete_key(engine_id: str) -> None:
    try:
        os.unlink(key_path(engine_id))
    except FileNotFoundError:
        pass


# ---- SSH connection helpers --------------------------------------------------------------------


class EngineError(Exception):
    pass


def _client_keys(key_text: str | None, passphrase: str) -> list | None:
    if not key_text:
        return None
    try:
        return [asyncssh.import_private_key(key_text, passphrase or None)]
    except (asyncssh.KeyImportError, ValueError) as e:
        raise EngineError(f"Can't read the private key: {e}. If it's encrypted, enter its passphrase.")


async def ssh_connect(host: str, port: int, user: str, *, key_text: str | None, passphrase: str, password: str, host_key: str | None):
    """Only the pinned host key is accepted (host_key=None would accept any; nothing passes None)."""
    known_hosts: Any = None if host_key is None else ([asyncssh.import_public_key(host_key)], [], [])
    try:
        return await asyncio.wait_for(
            asyncssh.connect(
                host,
                port=port,
                username=user,
                client_keys=_client_keys(key_text, passphrase),
                password=password or None,
                known_hosts=known_hosts,
                agent_path=None,
                keepalive_interval=30,
                keepalive_count_max=3,
            ),
            CONNECT_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise EngineError(f"Timed out connecting to {host}:{port}")
    except asyncssh.HostKeyNotVerifiable:
        raise EngineError("The server's host key doesn't match the pinned key. If the host was reinstalled, remove and re-add the engine.")
    except asyncssh.PermissionDenied:
        raise EngineError(f"SSH authentication failed for {user}@{host}")
    except (OSError, asyncssh.Error) as e:
        raise EngineError(f"SSH connection to {host}:{port} failed: {e}")


async def _open_channel(conn, mode: str, socket_path: str):
    """Return (reader, writer) of a byte stream to the remote Docker API."""
    if mode == "stdio":
        proc = await conn.create_process("docker system dial-stdio", encoding=None)
        return proc.stdout, proc.stdin
    return await conn.open_unix_connection(socket_path)


async def _http_over(reader, writer, request: bytes) -> bytes:
    writer.write(request)
    out = b""
    while True:
        chunk = await asyncio.wait_for(reader.read(65536), 10)
        if not chunk:
            break
        out += chunk
        if b"\r\n\r\n" in out:
            head, _, body = out.partition(b"\r\n\r\n")
            length = next((int(h.split(b":")[1]) for h in head.split(b"\r\n") if h.lower().startswith(b"content-length:")), None)
            if length is not None and len(body) >= length:
                break
    return out


def _dechunk(body: bytes) -> bytes:
    """Decode an HTTP chunked body."""
    out, rest = b"", body
    while rest:
        size_line, _, rest = rest.partition(b"\r\n")
        size = int(size_line.split(b";")[0].strip() or b"0", 16)
        if size == 0:
            break
        out, rest = out + rest[:size], rest[size + 2 :]
    return out


async def docker_get_via(conn, mode: str, socket_path: str, path: str) -> tuple[int, object]:
    """GET a Docker API path over an SSH connection: (status, parsed JSON body or None)."""
    reader, writer = await _open_channel(conn, mode, socket_path)
    try:
        raw = await _http_over(reader, writer, f"GET {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n".encode())
    finally:
        writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    try:
        status = int(head.split(b"\r\n", 1)[0].split(b" ", 2)[1])
    except (IndexError, ValueError):
        raise EngineError("the Docker API on the server gave no answer")
    if b"transfer-encoding: chunked" in head.lower():
        body = _dechunk(body)
    try:
        return status, json.loads(body) if body.strip() else None
    except ValueError:
        return status, None


_PERMISSION_HINT = "Permission denied on {path}. Add the SSH user to the 'docker' group (or use rootless Docker's socket)."


async def docker_version_via(conn, mode: str, socket_path: str) -> dict:
    stderr_reader = None
    try:
        if mode == "stdio":
            proc = await conn.create_process("docker system dial-stdio", encoding=None)
            reader, writer, stderr_reader = proc.stdout, proc.stdin, proc.stderr
        else:
            reader, writer = await conn.open_unix_connection(socket_path)
    except asyncssh.ChannelOpenError as e:
        raise EngineError(
            f"the SSH server refused to open {socket_path} ({e.reason}): either socket forwarding is disabled in sshd "
            "(AllowStreamLocalForwarding / AllowTcpForwarding) or the user has no access to the socket"
        )
    try:
        raw = await _http_over(reader, writer, b"GET /version HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n")
    finally:
        writer.close()
    if not raw:
        # Nothing came back: the far end closed immediately. dial-stdio explains why on stderr.
        err = ""
        if stderr_reader is not None:
            try:
                err = (await asyncio.wait_for(stderr_reader.read(4096), 3)).decode(errors="replace").strip()
            except Exception:
                pass
        if "permission denied" in err.lower():
            raise EngineError(_PERMISSION_HINT.format(path=socket_path))
        if "not found" in err.lower() and "docker" in err.lower():
            raise EngineError("the docker CLI isn't installed on the host (needed for dial-stdio)")
        raise EngineError(err[:300] or "the connection to the Docker socket closed without a response")
    head, _, body = raw.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0]
    if status_line.split(b" ", 2)[1:2] != [b"200"]:
        msg = body.decode(errors="replace").strip()[:300]
        if b"permission denied" in raw.lower():
            msg = _PERMISSION_HINT.format(path=socket_path)
        raise EngineError(msg or f"Docker API returned {status_line.decode(errors='replace')}")
    if b"transfer-encoding: chunked" in head.lower():
        # Tiny chunked body: strip chunk-size lines.
        parts = body.split(b"\r\n")
        body = b"".join(parts[i] for i in range(1, len(parts), 2))
    return json.loads(body)


async def server_host_key(host: str, port: int) -> dict:
    """The server's host key, fetched without logging in, so the user can check it before any password
    or key is sent (like ssh asking about an unknown host)."""
    try:
        key = await asyncio.wait_for(asyncssh.get_server_host_key(host, port), CONNECT_TIMEOUT)
    except asyncio.TimeoutError:
        raise EngineError(f"Timed out connecting to {host}:{port}")
    except (OSError, asyncssh.Error) as e:
        raise EngineError(f"SSH connection to {host}:{port} failed: {e}")
    if key is None:
        raise EngineError(f"{host}:{port} sent no host key")
    return {"hostKey": key.export_public_key().decode().strip(), "fingerprint": key.get_fingerprint()}


async def probe(host: str, port: int, user: str, key_text: str | None, passphrase: str, password: str, socket_path: str, mode: str, host_key: str) -> dict:
    """Log in with the host key the user confirmed (see server_host_key) and check Docker access."""
    try:
        pinned = asyncssh.import_public_key(host_key)
    except (asyncssh.KeyImportError, ValueError):
        raise EngineError("Check the server's host key first")
    conn = await ssh_connect(host, port, user, key_text=key_text, passphrase=passphrase, password=password, host_key=host_key)
    try:
        server_key = conn.get_server_host_key() or pinned
        host_key = server_key.export_public_key().decode().strip()
        tried: list[str] = []
        errors: list[str] = []
        for m in (["socket", "stdio"] if mode == "auto" else [mode]):
            tried.append(m)
            try:
                version = await docker_version_via(conn, m, socket_path)
                return {
                    "hostKey": host_key,
                    "fingerprint": server_key.get_fingerprint(),
                    "mode": m,
                    "docker": {"version": version.get("Version"), "apiVersion": version.get("ApiVersion"), "os": version.get("Os"), "arch": version.get("Arch")},
                }
            except (EngineError, asyncssh.Error, OSError, asyncio.TimeoutError) as e:
                errors.append(f"{m}: {e or type(e).__name__}")
        raise EngineError("Connected over SSH but couldn't reach Docker. " + " | ".join(errors))
    finally:
        conn.close()


# ---- tunnels ---------------------------------------------------------------------------------


class Tunnel:
    """Local unix socket -> shared SSH connection -> remote Docker API."""

    def __init__(self, cfg: EngineConfig) -> None:
        self.cfg = cfg
        self.path = os.path.join(SOCK_DIR, f"{cfg.id}.sock")
        self.conn = None
        self.server: asyncio.AbstractServer | None = None
        self.lock = asyncio.Lock()
        self.last_error: str | None = None

    @property
    def url(self) -> str:
        return f"unix://{self.path}"

    async def _connection(self):
        async with self.lock:
            if self.conn is not None and not self.conn.is_closed():
                return self.conn
            key_text = None
            if self.cfg.hasKey:
                with open(key_path(self.cfg.id), encoding="utf-8") as f:
                    key_text = f.read()
            try:
                self.conn = await ssh_connect(
                    self.cfg.host, self.cfg.port, self.cfg.user, key_text=key_text, passphrase=self.cfg.passphrase, password=self.cfg.password, host_key=self.cfg.hostKey
                )
                self.last_error = None
            except EngineError as e:
                self.last_error = str(e)
                raise
            return self.conn

    async def start(self) -> None:
        os.makedirs(SOCK_DIR, exist_ok=True)
        if os.path.exists(self.path):
            os.unlink(self.path)
        self.server = await asyncio.start_unix_server(self._handle, path=self.path)
        # Fail fast (and surface the reason) instead of on the first API call.
        conn = await self._connection()
        await docker_version_via(conn, self.cfg.mode, self.cfg.socketPath)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            conn = await self._connection()
            r2, w2 = await _open_channel(conn, self.cfg.mode, self.cfg.socketPath)
        except Exception as e:
            log.warning("tunnel %s: cannot open channel: %s", self.cfg.name, e)
            writer.close()
            return

        async def pump(src, dst, close_dst):
            try:
                while True:
                    data = await src.read(65536)
                    if not data:
                        break
                    dst.write(data)
                    if hasattr(dst, "drain"):
                        await dst.drain()
            except Exception:
                pass
            finally:
                try:
                    close_dst()
                except Exception:
                    pass

        # Half-close towards the remote on client EOF so hijacked streams (exec) end cleanly.
        up = asyncio.create_task(pump(reader, w2, lambda: w2.write_eof() if w2.can_write_eof() else w2.close()))
        down = asyncio.create_task(pump(r2, writer, writer.close))
        await asyncio.wait([up, down], return_when=asyncio.ALL_COMPLETED)
        w2.close()

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            self.server = None
        if self.conn is not None:
            self.conn.close()
            self.conn = None
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


# ---- manager ---------------------------------------------------------------------------------


class EngineManager:
    def __init__(self) -> None:
        self.registry = Registry()
        self.tunnel: Tunnel | None = None
        self.switching = asyncio.Lock()
        self.error: str | None = None
        self._startup: asyncio.Task | None = None

    @property
    def active_id(self) -> str:
        return self.registry.active

    @property
    def is_local(self) -> bool:
        return self.registry.active == LOCAL_ID

    def url(self) -> str:
        if self.is_local:
            return LOCAL_URL
        if self.tunnel is None:
            # A remote engine is selected but not connected (yet): fail loudly rather than quietly
            # managing the local engine under the remote engine's name.
            return UNAVAILABLE_URL
        return self.tunnel.url

    def active_meta(self) -> dict:
        if self.is_local:
            return {"id": LOCAL_ID, "name": "Local (Rancher Desktop)", "type": "local", "publicHost": "localhost", "color": self.registry.local_color}
        cfg = self.registry.engines[self.registry.active]
        return {"id": cfg.id, "name": cfg.name, "type": "ssh", "publicHost": cfg.publicHost or cfg.host, "target": f"{cfg.user}@{cfg.host}:{cfg.port}", "color": cfg.color}

    def list(self) -> list[dict]:
        local = {"id": LOCAL_ID, "name": "Local (Rancher Desktop)", "type": "local", "active": self.is_local, "color": self.registry.local_color}
        remote = [{**e.public(), "active": e.id == self.registry.active} for e in self.registry.engines.values()]
        return [local, *sorted(remote, key=lambda e: e["name"].lower())]

    async def startup(self) -> None:
        # Called from the app lifespan, which runs once per uvicorn server (socket + TCP), concurrently.
        # Both must wait for the same startup: returning early let the second server use the Docker
        # client before the remote engine's tunnel existed, which then stayed on the local engine.
        if self._startup is None:
            self._startup = asyncio.ensure_future(self._do_startup())
        await asyncio.shield(self._startup)

    async def _do_startup(self) -> None:
        self.registry.load()
        if not self.is_local:
            try:
                await self._open(self.registry.engines[self.registry.active])
            except Exception as e:
                # Keep the selection (it may be a transient outage); UI shows the error and can switch.
                self.error = str(e)
                log.warning("active remote engine unavailable at startup: %s", e)

    async def _open(self, cfg: EngineConfig) -> None:
        tunnel = Tunnel(cfg)
        try:
            await tunnel.start()
        except Exception:
            await tunnel.stop()
            raise
        self.tunnel = tunnel

    async def activate(self, engine_id: str, on_switch) -> None:
        """Switch the backend to another engine. `on_switch(url)` rewires docker client + hub."""
        if engine_id != LOCAL_ID and engine_id not in self.registry.engines:
            raise EngineError("Unknown engine")
        async with self.switching:
            old_tunnel = self.tunnel
            new_tunnel = None
            if old_tunnel is not None and old_tunnel.cfg.id == engine_id:
                # Switching to the engine that is active already (a reconnect): both tunnels would use
                # the same socket file, and stopping the old one afterwards would delete the new one's.
                await old_tunnel.stop()
                self.tunnel = old_tunnel = None
            if engine_id != LOCAL_ID:
                cfg = self.registry.engines[engine_id]
                new_tunnel = Tunnel(cfg)
                try:
                    await new_tunnel.start()
                except Exception:
                    await new_tunnel.stop()
                    raise
            self.tunnel = new_tunnel
            self.registry.active = engine_id
            self.registry.save()
            self.error = None
            await on_switch(self.url())
            if old_tunnel:
                await old_tunnel.stop()

    def add(self, cfg: EngineConfig, key_text: str | None) -> EngineConfig:
        cfg.id = cfg.id or secrets.token_hex(6)
        if key_text:
            store_key(cfg.id, key_text)
            cfg.hasKey = True
        self.registry.engines[cfg.id] = cfg
        self.registry.save()
        return cfg

    def update(self, engine_id: str, name: str | None, color: str | None) -> None:
        if engine_id == LOCAL_ID:
            if color is not None:
                self.registry.local_color = color
        else:
            cfg = self.registry.engines.get(engine_id)
            if cfg is None:
                raise EngineError("Unknown engine")
            if name is not None:
                cfg.name = name.strip() or f"{cfg.user}@{cfg.host}"  # cleared: back to the default
            if color is not None:
                cfg.color = color
        self.registry.save()

    def remove(self, engine_id: str) -> None:
        if engine_id == self.registry.active:
            raise EngineError("Switch to another engine before removing the active one")
        self.registry.engines.pop(engine_id, None)
        delete_key(engine_id)
        self.registry.save()


engines = EngineManager()
