# Troubleshooting

## "Engine unavailable" or a message about the container engine

Pierside needs the **dockerd (moby)** engine. Check **Preferences → Container Engine** in Rancher Desktop, and that Rancher Desktop has finished starting.

## The footer says "Polling"

Live updates use a WebSocket to Pierside's backend on a localhost port. If that connection can't be made, Pierside refreshes every 3 seconds instead; logs, shell and stats may not work. This can happen right after installing while Rancher Desktop is still starting. Restart Rancher Desktop, or uninstall and install Pierside again.

## Installing didn't give me the new version

Rancher Desktop reuses the image already on your machine. Follow [Update](install-and-update.md#update): `docker pull`, uninstall, install.

## `invalid extension metadata` / `422 Unprocessable Entity` when installing

Rancher Desktop could not download the image, usually because of a network or DNS problem, and reports it this way. Download it yourself to see the real error, then install:

```sh
docker pull ghcr.io/hemi131/pierside:latest
rdctl extension install ghcr.io/hemi131/pierside:latest
```

If `docker pull` fails with a timeout, try again in a moment or check your network, VPN or DNS.

## A container has no shell

Minimal images have no `sh`. The Exec tab offers a **debug shell**: a helper container that shares the container's processes and network and starts in its filesystem. It is removed when you close the session.

## Compose actions are greyed out

On the local engine, Compose commands run through Rancher Desktop and are only available in the Pierside tab inside Rancher Desktop, not in the separate browser window. See [Compose projects](compose.md) and [What works where](what-works-where.md).

## `unknown flag: --ansi` when running Compose on a server

The server has no `docker compose` plugin. Install it on the server.

## Swarm services aren't reachable on their published port

Rancher Desktop doesn't support Swarm's ingress routing mesh. Publish ports with `mode: host`. Pierside flags ingress ports.

## Backend logs

```sh
docker ps --filter label=com.pierside.backend=true
docker logs <container id>
```

Include these when you [report a problem](https://github.com/Hemi131/Pierside/issues).
