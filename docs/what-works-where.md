# What works where

Most of Pierside works the same everywhere. A few features depend on two things: whether you use Pierside inside Rancher Desktop or in its separate window, and whether the active engine is the local one or a server over SSH. This page lists those differences and the reason for each.

## Inside Rancher Desktop or in the separate window

Pierside normally runs as a tab inside Rancher Desktop. **Open in separate window**, at the bottom of the sidebar, opens the same Pierside in your web browser, which is handy on a second monitor.

The difference comes from one rule: only Rancher Desktop may start programs on your computer. A page in a web browser can't, and Pierside doesn't try to get around that. Everything that only talks to Docker works in both.

| Feature | Inside Rancher Desktop | Separate window | Why |
|---|---|---|---|
| Containers, images, volumes, networks, ports, disk usage, Swarm, logs, shells in containers, files | Yes | Yes | Pierside's backend does this through the Docker engine. |
| Compose Up, Down, Pull, View configuration on the **local engine** | Yes | No | Pierside runs the real `docker compose` on your computer, which only Rancher Desktop can start. |
| The same Compose commands on an **SSH engine** | Yes | Yes | They run on the server, over Pierside's SSH connection. |
| **Open compose file** on the local engine | Yes | No | It uses Rancher Desktop's file dialog and then runs Compose on your computer. |
| Terminal: Docker console (local engine) | Yes | No | It runs `docker` commands on your computer through Rancher Desktop. |
| Terminal: shell on the server (SSH engine) | Yes | Yes | It goes over the SSH connection. |
| AI access: **Add to Claude Code / Devin CLI** and the folder chooser | Yes | No | The button runs the assistant's own command on your computer. In the separate window, copy the command and run it yourself. |
| AI access: everything else (connections, approvals, activity) | Yes | Yes | |
| Server files and Server disk (SSH engine) | Yes | Yes | |
| Alerts and desktop notifications | Yes | Yes | In Rancher Desktop the notification is Rancher's own (fixed title, no click action); in the separate window it is the browser's, which asks for permission once. |

Other things to know about the separate window:

- **It is opened from Rancher Desktop.** The link works once and only on your computer. After Pierside restarts (an update, or Rancher Desktop restarting), the window says its session has expired; open it again from the sidebar.
- **View settings are kept separately.** Column widths, filters, the collapsed sidebar and similar settings are remembered per view, so changing them in the window doesn't change them in Rancher Desktop. Engines, AI access connections and everything else Pierside stores are shared.
- **Approval questions appear in both.** A question from an AI assistant shows up wherever Pierside is open; answering it in one place closes it in the other.

## Local engine or SSH engine

The local engine is the Docker inside Rancher Desktop on your computer. An SSH engine is Docker on another machine, which Pierside reaches through an SSH connection (see [Remote engines over SSH](remote-engines.md)). Lists, logs, shells, stats, files in containers and volumes, images, networks and Swarm work the same on both. These differ:

| Feature | Local engine | SSH engine | Why |
|---|---|---|---|
| Compose Up, Down, Pull, View configuration | Runs `docker compose` on your computer, through Rancher Desktop (not in the separate window) | Runs `docker compose` on the server | Compose needs the project's files, so it runs where they are. The server needs the `docker compose` plugin. |
| Open compose file | A file dialog on your computer | You type the file's path on the server | Same reason: the file is on the server. |
| Terminal in the bottom bar | Docker console: `docker …` commands only | A full shell on the server, as your SSH user | Locally there is no server to log in to; Rancher Desktop runs the Docker commands. |
| **Server files** | Not available | Browse and edit the server's own files, with Docker as a fallback where your user has no permission | Locally the "server" would be Rancher Desktop's internal Linux VM, and your own files are already on your computer. |
| **Server disk** | Not available | See how full the server's filesystems are and which folders take the space | Same reason. Docker's own data is on the Disk usage page for both kinds of engine. |
| Port links in the lists | Open `localhost:<port>` | Open the server's address (or the **Host for port links** set for the engine) | A published port is published on the machine the engine runs on. |
| Forward a port | Makes a container port reachable on `localhost` without recreating the container | The same, for a container on the server, through the SSH connection; nothing is opened on the server | Forwards always end on your computer. |
| Host folders when running an image | A Windows path such as `C:\data` is translated for you | Paths are paths on the server | A mounted folder is always a folder of the machine the engine runs on. |
| Containers of Rancher Desktop itself (Kubernetes, extensions) | Hidden unless you show them; protected from Prune | Usually none | They belong to Rancher Desktop on your computer. |
| AI access: Compose tools (up, down, read files, configuration) | Not available; the assistant gets the files' location instead | Available | An AI connection has no access to Rancher Desktop's window, which is where local Compose runs. On a server Pierside runs Compose itself. |

Not a difference, though it is easy to assume one: the AI access permissions (apart from the Compose tools), the protection of Pierside's own containers and copying images between engines behave the same on both kinds of engine.
