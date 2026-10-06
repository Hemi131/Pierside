# Remote engines over SSH

Pierside can manage Docker on another machine through SSH. Nothing is installed on the server.

## Add an engine

1. Open the engine switcher at the top of the sidebar and choose **Engines → Add SSH engine**.
2. Enter the host, the user, and a private key (paste it) or a password.
3. Pierside tests the connection and shows the server's host-key fingerprint. Confirm it, then save.

Switch engines from the same menu. Everything in Pierside (containers, images, volumes, logs, shell, files) then works on the selected engine.

## What the server needs

- An SSH server you can log in to.
- Docker, and a user that may use the Docker socket: a member of the `docker` group, or rootless Docker.
- For Compose actions: the `docker compose` plugin on the server.

Pierside reaches the Docker socket by SSH socket forwarding. If the server disallows forwarding, it falls back to `docker system dial-stdio` automatically.

## Colours

Give an engine a colour (when adding it, or **Engines → Colour**). While that engine is active, Pierside is framed in the colour and shows a banner with the engine's name. A red frame for production makes it hard to delete the wrong thing.

## What differs on a remote engine

| | Local engine | SSH engine |
|---|---|---|
| Compose Up/Down | Runs `docker compose` on your machine through Rancher Desktop | Runs `docker compose` on the server, where the files are |
| Terminal (footer) | Docker console: `docker …` commands only | A full shell on the server |
| Port forwarding | Container port → your `localhost` | Remote container port → your `localhost`, through the SSH connection |

## Where credentials are stored

Keys and passwords are stored in Pierside's data volume (`pierside-data`) on your machine and are only used to open the SSH connection. Removing an engine deletes its stored key. Anyone who can use Docker on your machine can read that volume, as they can read any volume.
