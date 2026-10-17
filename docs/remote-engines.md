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

## Server performance

**Server performance** in the bottom bar is like `htop` for the server, with each process's container next to it. Nothing has to be installed on the server: Pierside reads the figures over the SSH connection every 2 seconds while the page is open, and stops when you leave it.

- **At the top:** CPU (with the time spent waiting for the disk, and "steal" on a virtual machine whose host is overloaded), memory (with the cache the system gives back when needed, and swap), disks and network, with charts of the last 10 minutes.
- **A note** when something stands out: memory almost full, the server swapping, the CPU waiting for the disk, high load.
- **Processes:** CPU, memory, disk reads and writes, how long they have been running, and the command. Click a column to sort, search by command, user, container or process number, or **Group by container** to see at once how much each container uses, and how much the server's own processes do. 100 % CPU is one full core, as in `htop`. While the pointer is on the list, its rows stay in place (the figures keep updating), so a row and its ⋮ don't move away under the pointer; new processes are added at the bottom and ended ones are greyed out. **Hold order under the pointer** (on by default) switches this off.
- **What you can do** with a process (the ⋮ menu): open its container, copy its command line, **Lower priority**, **End** (asks it to stop) or **Force end** (stops it at once). Each asks first and shows exactly which process (its name and user as the system knows them, and its command line), with a warning for processes the server depends on, such as `sshd` or `dockerd`. A container's main process ignores **End**; use **Force end**, or stop the container.

As your SSH user, Pierside sees every process's CPU and memory, but disk reads and writes only for your own processes, and you can only end your own. With **Use Docker where I have no permission** switched on (at the top of the page; the same setting as in Server files and Server disk), everything is read and done as root, through a short-lived helper container on the server that is removed when you leave the page. It shares the server's processes (not its files or network) and may read every process's I/O figures and change its priority.

**Alert me about this server** (at the top of the page) checks the server every 30 seconds, also while you work on another engine: you get an [alert](alerts.md#server-alerts) when its memory is almost full, it keeps swapping, its load stays high, or a disk is 90 % full.

## What differs on a remote engine

Most of Pierside works the same on a remote engine. In short:

- **Compose** runs on the server, where the project's files are, instead of on your computer.
- **Terminal** in the bottom bar is a full shell on the server instead of a Docker console.
- **Server files**, **Server performance** and **Server disk** in the bottom bar show the server itself: its files, what uses its CPU, memory, disks and network, and what takes its disk space. They exist only for SSH engines.
- **Port links** open the server's address, and **Forward a port** brings a remote container's port to your `localhost` through the SSH connection.

The full list, with the reason for each difference, is in [What works where](what-works-where.md#local-engine-or-ssh-engine).

## Where credentials are stored

Keys and passwords are stored in Pierside's data volume (`pierside-data`) on your machine and are only used to open the SSH connection. Removing an engine deletes its stored key. Anyone who can use Docker on your machine can read that volume, as they can read any volume.

They are stored as they are needed to connect: a password in plain text, a key together with its passphrase. A passphrase therefore doesn't protect the key while it is stored there; nothing inside Rancher Desktop's VM could keep it better. Give Pierside a key of its own (for example `ssh-keygen -t ed25519 -f ~/.ssh/pierside`, added to the server's `authorized_keys`) rather than your personal one, so you can revoke it on its own.
