"""Port forwards: make a port reachable at localhost:<hostPort> on this computer.

  kind "container": a local container's port that isn't published (Docker can't add ports to a
                    running container).
  kind "remote":    a port of a container on an SSH engine's server.

Every forward is a helper container on the LOCAL engine (whatever engine is active) that publishes
127.0.0.1:<hostPort>, which Rancher forwards to the host like any published port, and runs a tiny TCP
proxy (app/fwdproxy.py, from Pierside's own image):
  container: the helper joins the target's network and proxies to it (by name on user-defined
             networks; by IP on the default bridge, re-created if the IP changes);
  remote:    the helper proxies to a relay in this backend (on the extension's own network), which
             carries each connection over a dedicated SSH connection to the server
             (direct-tcpip: to the published port on the server, or straight to the container's IP).

Definitions are kept in /data/forwards.json. Helpers exist only while the backend runs: removed on
shutdown (e.g. uninstall) and re-created on startup; stale ones from a crash are cleaned up first.
A forward whose target container is removed goes away with it.
"""

import asyncio
import json
import logging
import os
import secrets
import socket
import time
from urllib.parse import quote

import aiodocker

from app.services.engines import DATA_DIR, LOCAL_ID, LOCAL_URL, EngineError, docker_get_via, engines, key_path, ssh_connect

log = logging.getLogger("pierside.forwards")

STORE = os.path.join(DATA_DIR, "forwards.json")
FORWARD_LABEL = "com.pierside.forward"
HELPER_LABEL = "com.pierside.helper"  # hides helpers in the containers list; value "forward", so the
# volume/debug helper cleanup (which removes com.pierside.helper=true) leaves these alone
PROXY_PORT = 7000  # inside each helper
RELAY_PORTS = range(9100, 9200)  # inside this backend, for remote forwards (not published)
CHECK_EVERY_S = 10


class ForwardError(Exception):
    pass


class Forwards:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self.status: dict[str, str] = {}  # id -> "" (ok) or a problem
        self._relays: dict[str, asyncio.base_events.Server] = {}
        self._ssh: dict[str, object] = {}  # engine id -> asyncssh connection
        self._ssh_lock = asyncio.Lock()
        self._docker: aiodocker.Docker | None = None
        self._self: dict | None = None
        self._task: asyncio.Task | None = None
        self._startup: asyncio.Future | None = None
        self._stopped = False
        self._lock = asyncio.Lock()

    # ---- plumbing ----------------------------------------------------------------------------------
    @property
    def docker(self) -> aiodocker.Docker:
        # Always the local engine: the helpers publish ports on this computer.
        if self._docker is None:
            self._docker = aiodocker.Docker(url=LOCAL_URL)
        return self._docker

    async def _me(self) -> dict:
        """This backend's image, network and name on it (for helpers and relays)."""
        if self._self is None:
            info = await self.docker._query_json(f"containers/{socket.gethostname()}/json")
            nets = (info.get("NetworkSettings") or {}).get("Networks") or {}
            labels = (info.get("Config") or {}).get("Labels") or {}
            self._self = {
                "image": (info.get("Config") or {}).get("Image"),
                "network": next(iter(nets), None),
                "alias": labels.get("com.docker.compose.service") or socket.gethostname(),
            }
        return self._self

    def _load(self) -> None:
        try:
            with open(STORE, encoding="utf-8") as f:
                self.items = {x["id"]: x for x in json.load(f)}
        except FileNotFoundError:
            self.items = {}
        except Exception as e:
            log.error("cannot read %s: %s", STORE, e)

    def _save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = STORE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(list(self.items.values()), f, indent=2)
        os.replace(tmp, STORE)

    async def _helpers(self) -> list[dict]:
        return await self.docker._query_json("containers/json", params={"all": "1", "filters": json.dumps({"label": [FORWARD_LABEL]})})

    async def _remove_helper(self, fid: str) -> None:
        for c in await self._helpers():
            if (c.get("Labels") or {}).get(FORWARD_LABEL) == fid:
                try:
                    await self.docker.containers.container(c["Id"]).delete(force=True)
                except aiodocker.DockerError:
                    pass

    # ---- lifecycle ---------------------------------------------------------------------------------
    async def startup(self) -> None:
        # Runs once per uvicorn server (socket + TCP), concurrently: both wait for the same startup.
        if self._startup is None:
            self._startup = asyncio.ensure_future(self._do_startup())
        await asyncio.shield(self._startup)

    async def _do_startup(self) -> None:
        self._load()
        try:
            for c in await self._helpers():  # left over from a crash
                await self.docker.containers.container(c["Id"]).delete(force=True)
        except Exception as e:
            log.warning("cleaning up old forward helpers failed: %s", e)
        for fid in list(self.items):
            try:
                await self._start(self.items[fid])
            except Exception as e:
                self.status[fid] = str(e)
                log.warning("forward %s not restored: %s", fid, e)
        self._task = asyncio.create_task(self._watch(), name="forwards-watch")

    async def shutdown(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._task:
            self._task.cancel()
        for fid in list(self.items):
            await self._stop(fid)
        for conn in self._ssh.values():
            conn.close()  # type: ignore[attr-defined]
        if self._docker is not None:
            await self._docker.close()
            self._docker = None

    # ---- starting / stopping one forward ---------------------------------------------------------
    async def _start(self, f: dict) -> None:
        me = await self._me()
        if f["kind"] == "remote":
            relay_port = await self._start_relay(f)
            upstream, network = (me["alias"], relay_port), me["network"]
        else:
            upstream, network = await self._container_upstream(f)
        await self._check_host_port(f["hostPort"], f["id"])
        config = {
            "Image": me["image"],
            "Cmd": ["python", "-m", "app.fwdproxy", str(PROXY_PORT), str(upstream[0]), str(upstream[1])],
            "Labels": {HELPER_LABEL: "forward", FORWARD_LABEL: f["id"]},
            "ExposedPorts": {f"{PROXY_PORT}/tcp": {}},
            "HostConfig": {
                "PortBindings": {f"{PROXY_PORT}/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(f["hostPort"])}]},
                "NetworkMode": network,
                "RestartPolicy": {"Name": "no"},
            },
        }
        c = await self.docker.containers.create(config, name=f"pierside-forward-{f['hostPort']}-{f['id'][:6]}")
        try:
            await c.start()
        except aiodocker.DockerError as e:
            await c.delete(force=True)
            msg = (e.message.get("message") if isinstance(e.message, dict) else str(e.message)) or str(e)
            raise ForwardError(f"Port {f['hostPort']} can't be used: {msg}") from e
        f["_upstream"] = list(upstream)
        self.status[f["id"]] = ""

    async def _stop(self, fid: str) -> None:
        await self._remove_helper(fid)
        server = self._relays.pop(fid, None)
        if server:
            server.close()

    async def _check_host_port(self, port: int, own_id: str) -> None:
        for other in self.items.values():
            if other["id"] != own_id and other["hostPort"] == port:
                raise ForwardError(f"Port {port} is already used by another forward")
        for c in await self.docker._query_json("containers/json"):
            if (c.get("Labels") or {}).get(FORWARD_LABEL) == own_id:
                continue
            if any(p.get("PublicPort") == port for p in c.get("Ports") or []):
                name = (c.get("Names") or ["/"])[0].lstrip("/")
                raise ForwardError(f'Port {port} is already published by container "{name}"')

    async def _container_upstream(self, f: dict) -> tuple[tuple[str, int], str]:
        try:
            info = await self.docker._query_json(f"containers/{f['target']['id']}/json")
        except aiodocker.DockerError as e:
            raise ForwardError("The container no longer exists") from e
        mode = (info.get("HostConfig") or {}).get("NetworkMode") or ""
        if mode in ("host", "none") or mode.startswith("container:"):
            raise ForwardError(f"The container uses network mode '{mode}'; its ports can't be forwarded")
        nets = (info.get("NetworkSettings") or {}).get("Networks") or {}
        if not nets:
            raise ForwardError("The container isn't on any network (is it running?)")
        net = mode if mode in nets else next(iter(nets))
        name = info["Name"].lstrip("/")
        if net == "bridge" or mode == "default":  # no DNS on the default bridge: use the IP
            ip = nets[net].get("IPAddress")
            if not ip:
                raise ForwardError("The container isn't running")
            return (ip, f["targetPort"]), net
        return (name, f["targetPort"]), net

    # ---- remote relays -----------------------------------------------------------------------------
    async def _ssh_conn(self, engine_id: str):
        async with self._ssh_lock:
            conn = self._ssh.get(engine_id)
            if conn is not None and not conn.is_closed():  # type: ignore[attr-defined]
                return conn
            cfg = engines.registry.engines.get(engine_id)
            if cfg is None:
                raise ForwardError("That SSH engine was removed")
            key_text = None
            if cfg.hasKey:
                with open(key_path(cfg.id), encoding="utf-8") as fh:
                    key_text = fh.read()
            try:
                conn = await ssh_connect(cfg.host, cfg.port, cfg.user, key_text=key_text, passphrase=cfg.passphrase, password=cfg.password, host_key=cfg.hostKey)
            except EngineError as e:
                raise ForwardError(str(e)) from e
            self._ssh[engine_id] = conn
            return conn

    async def _start_relay(self, f: dict) -> int:
        old = self._relays.pop(f["id"], None)
        if old:
            old.close()
        remote = f["remote"]

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            host, port = remote["host"], remote["port"]
            try:
                conn = await self._ssh_conn(remote["engineId"])
                # Where the container is now: a recreated container has a new IP (or published port),
                # and its old IP may belong to another container by now.
                target = await self._remote_target(conn, f)
                if target is None:
                    log.info("container of forward %s removed on the server: removing the forward", f["id"])
                    writer.close()
                    asyncio.ensure_future(self.remove(f["id"]))
                    return
                host, port = target
                r2, w2 = await conn.open_connection(host, port)  # type: ignore[attr-defined]
                self.status[f["id"]] = ""
            except Exception as e:
                self.status[f["id"]] = f"Can't reach {host}:{port} on the server: {e}"
                writer.close()
                return

            async def pipe(r, w):
                try:
                    while data := await r.read(65536):
                        w.write(data)
                        await w.drain()
                except Exception:
                    pass
                finally:
                    try:
                        w.write_eof() if w.can_write_eof() else w.close()
                    except Exception:
                        pass

            await asyncio.gather(pipe(reader, w2), pipe(r2, writer))
            writer.close()
            w2.close()

        used = {s.sockets[0].getsockname()[1] for s in self._relays.values() if s.sockets}
        for port in RELAY_PORTS:
            if port in used:
                continue
            try:
                self._relays[f["id"]] = await asyncio.start_server(handle, "0.0.0.0", port)
                return port
            except OSError:
                continue
        raise ForwardError("No free relay port")

    async def _remote_target(self, conn, f: dict) -> tuple[str, int] | None:
        """(host, port) to dial on the server for a remote forward, looked up now; None if the container is gone.
        By id, else by name (Compose keeps the name when it recreates a container)."""
        cfg = engines.registry.engines.get(f["remote"]["engineId"])
        if cfg is None:
            raise ForwardError("That SSH engine was removed")
        info = None
        for ref in dict.fromkeys([f["target"]["id"], f["target"]["name"]]):
            status, body = await docker_get_via(conn, cfg.mode, cfg.socketPath, f"/containers/{quote(ref, safe='')}/json")
            if status == 200 and isinstance(body, dict):
                info = body
                break
            if status != 404:
                raise ForwardError(f"the Docker API on the server answered {status}")
        if info is None:
            return None
        if info["Id"] != f["target"]["id"]:
            f["target"]["id"] = info["Id"]
            self._save()
        host, port = remote_endpoint(info, f["targetPort"])
        f["remote"]["host"], f["remote"]["port"] = host, port
        return host, port

    # ---- keeping container forwards current ------------------------------------------------------
    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(CHECK_EVERY_S)
            for fid, f in list(self.items.items()):
                if f["kind"] != "container":
                    continue
                try:
                    async with self._lock:
                        try:
                            upstream, _ = await self._container_upstream(f)
                        except ForwardError as e:
                            if "no longer exists" in str(e):
                                log.info("container of forward %s removed: removing the forward", fid)
                                await self._stop(fid)
                                self.items.pop(fid, None)
                                self.status.pop(fid, None)
                                self._save()
                            else:
                                self.status[fid] = str(e)
                            continue
                        if list(upstream) != f.get("_upstream") or self.status.get(fid):
                            await self._stop(fid)  # new IP after a restart, or recovering
                            await self._start(f)
                except Exception as e:
                    self.status[fid] = str(e)

    # ---- API ---------------------------------------------------------------------------------------
    def list(self) -> list[dict]:
        return [{**{k: v for k, v in f.items() if not k.startswith("_")}, "problem": self.status.get(f["id"], "")} for f in self.items.values()]

    async def add_container(self, container_id: str, target_port: int, host_port: int) -> dict:
        info = await self.docker._query_json(f"containers/{container_id}/json")
        f = {
            "id": secrets.token_hex(6),
            "kind": "container",
            "hostPort": host_port,
            "targetPort": target_port,
            "target": {"id": info["Id"], "name": info["Name"].lstrip("/")},
            "createdAt": time.time(),
        }
        return await self._add(f)

    async def add_remote(self, engine_id: str, container: dict, target_port: int, host_port: int) -> dict:
        """`container`: the inspect data from the SSH engine (the active engine when this is called)."""
        cfg = engines.registry.engines.get(engine_id)
        if engine_id == LOCAL_ID or cfg is None:
            raise ForwardError("Remote forwards need an SSH engine")
        host, port = remote_endpoint(container, target_port)
        f = {
            "id": secrets.token_hex(6),
            "kind": "remote",
            "hostPort": host_port,
            "targetPort": target_port,
            "target": {"id": container["Id"], "name": container["Name"].lstrip("/")},
            "remote": {"engineId": engine_id, "engineName": cfg.name, "host": host, "port": port},
            "createdAt": time.time(),
        }
        return await self._add(f)

    async def _add(self, f: dict) -> dict:
        async with self._lock:
            try:
                await self._start(f)
            except Exception:
                await self._stop(f["id"])
                raise
            self.items[f["id"]] = f
            self._save()
        return {k: v for k, v in f.items() if not k.startswith("_")}

    async def remove(self, fid: str) -> None:
        async with self._lock:
            await self._stop(fid)
            self.items.pop(fid, None)
            self.status.pop(fid, None)
            self._save()

    async def remove_for_engine(self, engine_id: str) -> None:
        for fid, f in list(self.items.items()):
            if f["kind"] == "remote" and f["remote"]["engineId"] == engine_id:
                await self.remove(fid)
        conn = self._ssh.pop(engine_id, None)
        if conn is not None:
            conn.close()  # type: ignore[attr-defined]


def remote_endpoint(container: dict, target_port: int) -> tuple[str, int]:
    """Where to reach a container's port on its server: the published port if there is one, else its IP."""
    for b in ((container.get("NetworkSettings") or {}).get("Ports") or {}).get(f"{target_port}/tcp") or []:
        if b.get("HostPort"):
            return "127.0.0.1", int(b["HostPort"])
    nets = (container.get("NetworkSettings") or {}).get("Networks") or {}
    ip = next((n.get("IPAddress") for n in nets.values() if n.get("IPAddress")), None)
    if not ip:
        raise ForwardError("The container has no IP address on the server (is it running?)")
    return ip, target_port


forwards = Forwards()
