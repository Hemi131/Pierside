# Remote engines over SSH

Pierside can manage Docker on another machine through SSH. Nothing is installed on the server.

## Add an engine

1. Open the engine switcher at the top of the sidebar and choose **Engines → Add SSH engine**.
2. Enter the host, the user, and a private key (paste it) or a password.
3. **Check host key** shows the server's host-key fingerprint before anything is sent to the server. Compare it with the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) and confirm it.
4. **Test connection** then logs in, only to a server with that key, and checks Docker. Save when it works.

Switch engines from the same menu. Everything in Pierside (containers, images, volumes, logs, shell, files) then works on the selected engine.

## What the server needs

- An SSH server you can log in to.
- Docker, and a user that may use the Docker socket: a member of the `docker` group, or rootless Docker.
- For Compose actions: the `docker compose` plugin on the server.

Pierside reaches the Docker socket by SSH socket forwarding. If the server disallows forwarding, it falls back to `docker system dial-stdio` automatically.

## Colours

Give an engine a colour (when adding it, or **Engines → Colour**). While that engine is active, Pierside is framed in the colour and shows a banner with the engine's name. A red frame for production makes it hard to delete the wrong thing.

## Engines at a glance

**Engines at a glance**, the second line of the engine switcher at the top of the sidebar, has a card for every engine, without switching to it:

- whether it can be reached, and how many containers run;
- the CPU and memory its running containers use (100% is one core);
- which containers need attention: restarting, unhealthy, dead, or exited with an error in the last hours. Hover a problem to see the containers' names; click it to switch to that engine and open the (first) container's logs.

The page keeps itself up to date while it is open: every 30 seconds by default, or every 10 seconds, minute or 5 minutes, or only when you press **Refresh** (the menu at the top right). **Switch** makes an engine the active one.

### Watching an engine in the background

Switch on **Watch in the background** on an engine's card to keep an eye on it while you work on another engine:

- its card stays up to date even while the page is closed;
- its [alerts](alerts.md) (restart loops, out of memory, unhealthy, failing Swarm services) are shown like the active engine's, with the engine's name;
- you are told when it can't be reached, and again when it is back.

Pierside keeps a connection to each watched engine open for this. The alerts of every engine are listed under **Recent alerts** on the page, also those that came while no Pierside window was open (until Rancher Desktop is restarted).

## What differs on a remote engine

Most of Pierside works the same on a remote engine. In short:

- **Compose** runs on the server, where the project's files are, instead of on your computer.
- **Terminal** in the bottom bar is a full shell on the server instead of a Docker console.
- **Server files** in the bottom bar browses and edits the server's own files, and **Server disk** next to it shows what takes the server's disk space; both exist only for SSH engines.
- **Port links** open the server's address, and **Forward a port** brings a remote container's port to your `localhost` through the SSH connection.

The full list, with the reason for each difference, is in [What works where](what-works-where.md#local-engine-or-ssh-engine).

## Where credentials are stored

Keys and passwords are stored in Pierside's data volume (`pierside-data`) on your machine and are only used to open the SSH connection. Removing an engine deletes its stored key. Anyone who can use Docker on your machine can read that volume, as they can read any volume.
