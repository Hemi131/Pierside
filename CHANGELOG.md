# Changelog

Each release of Pierside, newest first. Install a specific one with `rdctl extension install ghcr.io/hemi131/pierside:<version>`.

## Unreleased

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
