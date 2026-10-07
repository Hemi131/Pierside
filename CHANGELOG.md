# Changelog

Each release of Pierside, newest first. Install a specific one with `rdctl extension install ghcr.io/hemi131/pierside:<version>`.

## Unreleased

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
