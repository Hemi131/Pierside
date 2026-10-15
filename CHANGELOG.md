# Changelog

Each release of Pierside, newest first. Install a specific one with `rdctl extension install ghcr.io/hemi131/pierside:<version>`.

## Unreleased

## 1.2.0 - 2026-10-15

- **Engines at a glance** is its own page now, opened from the second line of the engine switcher at the top of the sidebar. It keeps itself up to date (every 30 seconds by default; 10 seconds to 5 minutes, or only on Refresh), shows the CPU and memory each engine's containers use, and a click on a problem opens the container on its engine.
- **Watch an engine in the background:** a switch on each engine's card. A watched engine's alerts (restart loops, out of memory, unhealthy, failing Swarm services) arrive while another engine is active, named with the engine, and you are told when it can't be reached and when it is back. Recent alerts from all engines are listed on the page.
- **Command palette** in the Exec tab: save the commands you type often under your own labels and run them in any container's shell with **Commands** or Ctrl+Shift+P. Each command either runs right away or is only typed so you can change it first, and can be offered everywhere, for an image (`postgres`, `mycorp/*`) or for a Compose project / service. One list for all engines, in Rancher and in the separate window.
- Fixed: with a search in the logs, every batch of new lines moved to the next match and scrolled there. The current match and the view now stay where they are; new matches are still highlighted.
- Fixed: containers started again and again by something other than Docker, such as a GitLab Runner's job containers, were reported as "keeps restarting" / "keeps crashing". Only containers that Docker itself restarts (restart policy `always`, `unless-stopped`, or `on-failure` after a failure) are reported now.
- Fixed: on smaller screens, a tooltip near the right edge (such as Refresh on the Server disk page) could make the whole page jump a little to the left.

## 1.1.1 - 2026-10-11

- Fixed: desktop notifications never appeared inside Rancher Desktop on Windows. They are now shown through Rancher Desktop's own notification call there; the separate window keeps using the browser's.

## 1.1.0 - 2026-10-11

- **Alerts:** restart loops are found more reliably. A container whose command keeps finishing cleanly and being restarted is now reported too (with different advice than a crashing one), stopping and starting a container by hand is no longer mistaken for a crash, and slow loops (Docker waits up to a minute between attempts) are no longer missed. New: a **Swarm service whose task keeps failing** is reported, on any node. See [docs/alerts.md](docs/alerts.md).
- **Desktop notifications** for these alerts when Pierside is open but not in front; switch them on in the dialog behind the version number.
- **Engines: At a glance.** The Engines page shows for every engine whether it can be reached, how many containers run and which need attention, without switching to it.
- **Server disk: the usual places.** A list of where space usually goes on a server (Docker's data, container logs, the journal, package caches, temporary files, home folders), measured with one click.
- File editor: typing in large files is faster.
- Fixed: switching to the SSH engine that is already active (for example from a second window) broke its connection until you switched away and back.
- **AI access, security:**
  - New containers can no longer reach host system folders through a symbolic link: a host path with a link in it is refused, and so is a path inside a folder that a container the assistant can reach mounts writable. The list of refused system folders now also has `/etc`, `/root`, `/usr`, `/boot`, `/bin`, `/sbin`, `/lib` and, on Windows, Rancher Desktop's WSL socket folder.
  - Answering an assistant's request for more access applies only to the request you saw: if the assistant changed its request meanwhile, nothing is granted and the new request is shown.
  - Engine events no longer show Swarm service, secret and config names to a connection without the Swarm permission.
  - `prune` of all unused images keeps the images of Rancher Desktop extensions and Kubernetes, as it promised.
  - Asking for a wider file path or name pattern than a connection has (e.g. `/app/**` when it has `/app/*`) now reaches you instead of being answered "already allowed".
- **Adding an SSH engine** shows the server's host-key fingerprint first; your password or key is sent only after you confirm it.
- **Downloads** from volumes, containers and server files fail visibly if they are cut short, instead of saving a shorter file; long downloads and uploads through Pierside's helper containers are no longer interrupted after a minute.
- **Logs:** lines are no longer dropped when a container writes to stdout and stderr at the same moment.
- **Live views** (logs, shell, stats, pull progress, terminal) reconnect by themselves after Pierside's backend restarts, instead of staying disconnected until Pierside is reopened.
- **Port forwards to SSH engines** follow a container that was recreated (new address or port), and go away when it is removed, instead of reaching whatever now has its old address.
- **Server files:** uploading into, or downloading from, a place your SSH user can't access asks whether Docker may be used, instead of showing "[object Object]".
- **Containers:** "Remove service" on a Swarm service asks first and reports the result.
- Cancelling `docker compose` on an SSH engine stops it on the server; stopping Server disk stops its measurements there too.

## 1.0.0 - 2026-10-10

Pierside 1.0: next to Docker itself, it now also works with the server behind an SSH engine.

- **Server files:** with an SSH engine active, **Server files** in the bottom bar browses and edits the files of that server with the same file browser and editor, as your SSH user. Where that user has no permission but may use Docker, Pierside can work through a short-lived helper container instead (asked once per server, marked with a badge, read-only unless you change something).
- **Server disk:** next to it, **Server disk** shows how full the server's filesystems are and which folders take the space. Folders are measured one by one as you open them, at low priority, with a time limit and a stop button; folders you can't read can be measured through Docker. It only reads.
- **Find by name** in every file browser (containers, volumes, server files): typing narrows the current folder, Enter searches its subfolders.
- **File editor:**
  - **Review changes** shows your edit as a diff before saving.
  - Syntax errors in JSON and YAML are underlined, and Compose files are checked against the official Compose schema (bundled, nothing is downloaded).
  - VS Code keyboard shortcuts (Ctrl+D, Alt+Up/Down, Ctrl+/, Ctrl+L and more).
  - Bracket pair colours and indentation guides.
- **AI access:**
  - **Add to Claude Code** / **Add to Devin CLI** registers a connection with one click, for all your projects or for one project folder you choose, through a small helper program Rancher Desktop installs with the extension. The dialog shows the command the button runs. Removing a connection also removes it from the assistant.
  - The connection dialog is simpler, and says when a connection is trusted instead of promising a question that won't come.
- **Containers:** a Compose project that is partly running has a start button for its stopped containers next to Stop all, in the list and on the project page.
- **Files in containers:** a folder the container's user can't read now says "Permission denied" instead of looking empty.
- **Docs:** [What works where](docs/what-works-where.md) lists what differs between the Pierside tab in Rancher Desktop and the separate window, and between the local engine and SSH engines, with the reason for each.

## 0.4.1 - 2026-10-07

- AI access: the connection dialog also shows the command for Devin CLI (`devin mcp add`).

## 0.4.0 - 2026-10-07

- **AI access:** a built-in MCP server for assistants such as Claude Code, with 66 tools covering containers, files, Compose projects, images, volumes, networks, ports, engine information, clean-up and Swarm, on the local engine and on SSH engines. Each connection has its own limits: which engines and containers, which of 20 permissions, and which file paths; or "Allow everything". By default no secret is stored with the assistant: you allow each session in Pierside, or trust a connection for a period or for good, actions that change something can ask every time, and the assistant can ask you for more access when it needs it; an access token is available for unattended use. Calls are listed under Recent activity. See [docs/ai-access.md](docs/ai-access.md).
- Troubleshooting: what to do when installing reports `invalid extension metadata`.

## 0.3.0 - 2026-10-06

First release under the name Pierside.

- **Containers:** live list grouped by Compose project; start, stop, restart and delete for single containers, projects and selections; port links; port-conflict hints; health checks; alerts for containers that crash, restart in a loop or run out of memory.
- **Container details:** logs (search, timestamps, download, copy as Markdown), inspect, bind mounts, interactive shell, debug shell for containers without one, file browser, live stats.
- **Compose:** merged colour-coded logs; Up, Down, Pull and recreate and View configuration with the common flags; projects stay listed after `down`.
- **Files:** upload, edit in a code editor with syntax highlighting, delete and change permissions, in containers and volumes.
- **Images:** pull, run with options, layers, prune, copy to another engine.
- **Volumes and networks:** create, inspect and prune; connect and disconnect containers. Items that belong to Rancher Desktop extensions are hidden unless you show them, are skipped by Prune, and deleting one asks with a warning first.
- **Disk usage:** what takes space, with one-click cleanup.
- **Ports:** forward container ports to `localhost`, also from remote servers.
- **Remote engines over SSH**, each with its own name and colour.
- **Swarm:** stacks, services, tasks, nodes, secrets and configs.
- **Terminal:** Docker console locally, a full shell on SSH engines.
- **Updates:** the footer shows the version and tells you when a newer release exists; old Pierside images are removed automatically.
