# AI access (MCP server)

Pierside can let an AI assistant such as Claude Code work with your Docker engines, with limits you set: from reading the logs of one project up to nearly everything Pierside's own window can do. It does this through a built-in [MCP](https://modelcontextprotocol.io/) server: the assistant gets a fixed set of tools, never Docker itself, and Pierside checks every call against the permissions of the connection it came from.

Nothing is shared until you create a connection.

## Create a connection

1. Open **AI access** at the bottom of the sidebar and choose **New connection**.
2. Give it a name and choose **which engines** it may use: the local one, SSH engines, or all of them. The first one ticked is the default; the assistant can list the engines and name another one in each call.
3. Choose **which containers** it covers: all of them, or tick them in the list. Ticking a Compose project covers its containers, including ones it gets later. Below the list you can add name patterns for containers or projects that don't exist yet: `*` matches any text, so `shop-*` covers `shop-web` and `shop-db`.
4. Tick **what the assistant may do** (see below).
5. Choose **how the assistant gets in** (see the next section) and create it.
6. In the dialog that opens, choose **Add to Claude Code** or **Add to Devin CLI**. The dialog shows the command the button runs; where there is no button (see below), run that command in a terminal yourself.

The **Add to …** button runs the command shown in the dialog for you (`claude mcp add …` or `devin mcp add …`) and replaces an older entry of the same name. With **Available in all my projects** switched off, choose the project folder first: the command then runs in that folder and the assistant has the access only there. The entry stays in your own assistant settings; nothing is written into the folder. It appears when Pierside runs inside Rancher Desktop and finds the assistant installed for your user; a running Claude Code session picks the new server up with `/mcp` or at its next start. Removing a connection in Pierside also removes it from the assistants that have it under that name.

For Claude Code the command looks like this:

```sh
claude mcp add --scope user pierside-webshop -- docker exec -i <pierside container> python -m app.mcp_stdio --profile 1a2b3c4d5e6f
```

With `--scope user` Claude Code has the access in all your projects. Without **Available in all my projects** the command has no such flag and registers the access only for the project folder it is run in. In Claude Code, `/mcp` shows whether it is connected.

The dialog's **Devin CLI** tab has the same command for Devin's command-line tool:

```sh
devin mcp add -s user pierside-webshop -- docker exec -i <pierside container> python -m app.mcp_stdio --profile 1a2b3c4d5e6f
```

`-s user` plays the role of `--scope user`; without it Devin registers the access only for the project folder you run it in. `devin mcp list` shows the servers it knows.

The last tab has the same thing as JSON for other MCP clients.

## How the assistant gets in

### You allow it in Pierside (the default)

The command contains no secret. The first time the assistant uses a tool, Pierside shows a question with a four-letter code. That first tool call comes back after a few seconds so that the assistant can tell you the same code in its reply; compare the two, then answer:

- **Allow this session**: until that assistant session ends. The next session asks again.
- **Allow longer**: for 24 hours, 7 days, 30 days, or always. During that time no question is asked.
- **Deny**.

After you allow it, the assistant calls the tool again. The question stays open in Pierside for ten minutes, so a late answer still counts.

You can also set the trust period in the connection's settings, and withdraw it at any time with **stop trusting** on the AI access page. Sessions that are running are then asked again.

If the connection may change things, Pierside can also ask before **each** such action and shows exactly what the assistant is about to do. **Ask before each action** in the connection's settings has three choices:

- **Every action that changes something** (the default),
- **Only deleting, overwriting and running commands** (starting a container with a folder of the host mounted counts as this too, since it can change files on your machine),
- **Never**.

"Always trust" together with "Never" means the assistant is not held up by any question.

Keep in mind what trust means: while a connection is trusted, any program on your computer that can run Docker can use it without asking. That program could already do more with Docker directly, so this is a convenience trade-off, not a new hole.

### Access token

For assistants that run unattended and can't wait for a click. The command then carries a token (`-e PIERSIDE_MCP_TOKEN=pmcp_…`), shown only once; Pierside stores only a hash of it. It works without asking you, until you make a new token with the key button or remove the connection. Don't commit a configuration file that contains it.

## Permissions

The assistant is only offered the tools you allowed. It can always list the engines of the connection, the shared containers and their Compose projects, and it can ask what the connection allows (its permissions, file paths and limits), so it doesn't have to find out by trial and error.

### Shared containers

These apply to the containers chosen under **Which containers**.

| Permission | What the assistant can do |
|---|---|
| **Read logs** | Recent log lines of a container or a whole Compose project, filtered by text, by the last N minutes, or by a time window in the past. See the limits below. |
| **See configuration and state** | Image, command, ports, networks, mounts, labels, restart policy; live CPU and memory use, running processes, health check results, files changed since start, the equivalent `docker run` command. Environment variables show only their names unless you tick the option to show values. |
| **Start, stop, restart** | Also pause, resume and kill; single containers and whole Compose projects |
| **Create, rename, delete** | Run a new container from an image (name, ports, environment, volumes, restart policy, network); recreate a container with the same settings, for example to pick up a newer image; rename and delete containers |
| **Compose up and down** | Read a project's Compose files and its resolved configuration, bring the project up (also after a change, or when it is down) and take it down. **SSH engines only**, see below. |
| **Run commands** | Any shell command inside the containers, optionally as a given user and in a given folder, with a time limit of up to two minutes. A command that runs past its limit, or prints far more than can be read (over 800,000 bytes), is stopped together with the processes it started, also those it sent into the background (for example `(tail -f log &)`). Only a program that detached itself completely with `setsid` keeps running. A command that ends normally leaves its background programs running, as `docker exec` does. |

**Log limits.** A request returns the newest 200 lines unless the assistant asks for more, and never more than the connection's **Most log lines per request** (500 unless you change it, at most 5000). A text filter searches only that many newest lines of the requested time window, not the whole log. "Allow everything" connections use the maximum, 5000. When the assistant asks for more lines than the connection allows, the answer says so. Every answer is kept to about 60,000 characters, so that an assistant such as Claude Code shows it directly (see below for how longer results continue).

A new or renamed container must have a name the connection covers. New containers can't mount the Docker socket, system folders of the host such as `/etc`, `/usr` or `/var/lib/docker` (or a folder that contains one, such as `/var`), or the volumes of Pierside and other extensions. A host path with a symbolic link in it is refused too, and so is a path inside a folder that a container the assistant can reach mounts writable: otherwise the assistant could make a link there that leads to a system folder. Mounting a volume that already exists also needs **See volumes**. They can't use the host's network or share another container's (`container:…`). They can join any network the connection may see, including a macvlan or ipvlan network if the engine has one: that puts the container on your local network (not into the host's own).

**Allow mounting host system folders** lifts the mount rule. It appears only under **Allow everything** and is off unless you switch it on. With it, the assistant can start a container with the Docker socket or `/var/lib/docker` mounted, which is full control of the engine's machine: it reaches everything that is otherwise kept back, including Pierside's own data with your saved SSH keys and passwords. Use it only on an engine where that is acceptable.

### Files

| Permission | What the assistant can do |
|---|---|
| **Read files** | List folders, read text files up to 1 MB, and search file contents, only under the paths you list |
| **Change files** | Write or replace text files up to 1 MB, create folders, delete, change permissions, under the same paths |

List one path pattern per line. `*` matches within one folder, `**` also across folders:

- `/etc/nginx/**` allows everything under `/etc/nginx`
- `/app/config/*.yaml` allows the YAML files directly in `/app/config`

Nothing is reachable until you add a path. A path that goes through a symbolic link is refused, so a link inside an allowed folder can't be used to reach something outside it. In a running container this holds also when a process in it replaces a folder with a link just as the assistant reads, lists or searches it, as long as the container has `sh` and `cat` (without them Pierside reads through Docker, which doesn't notice such a swap). Swapping the file itself, rather than a folder, is caught only where the container also has `/proc` and `readlink`, and not during a search. Reading and listing run as root in the container (a search runs as the container's own user); in a container that takes away root's access to other users' files (for example `--cap-drop ALL`), they run again as the container's own user, so its own files can still be read and listed. A search looks only into files the patterns allow, also below the folder it starts in; it stops after 30 seconds and never reads `/proc`, `/sys` or `/dev`.

Changing files in a running container is protected the same way: writing, creating a folder, deleting and changing permissions act only in the folder that was checked, also when a process in the container replaces it (or a folder inside it, while a whole folder is deleted or changed) with a link at that moment. What changed that way is left as it is and named in the answer. This needs `sh`, and for writing also `head`, in the container.

- An existing file is written in place, so it keeps its owner, permissions and hard links. New files and folders belong to the container's own user. Writing runs as that user first and as root where the user isn't allowed to.
- Deleting and changing permissions run as the container's own user, as before. A recursive permission change leaves symbolic links and special files (FIFOs, sockets, devices) as they are, and a file it can't open is left as it is too.
- A stopped container is written through Docker. Nothing in it can swap a folder then.
- A running container without `sh` (a distroless image, for example) can't be written to unless you tick **Also write to running containers that have no shell** under **Change files**. Pierside then writes through Docker, which doesn't notice a swapped folder. This switch is off by default, also with **Allow everything**.

### The whole engine

These are not limited to the shared containers.

| Permission | What the assistant can do |
|---|---|
| **See images** | List images, their details and layers |
| **Pull images** | Download an image to the engine |
| **See volumes** | List volumes and their details. Reading files in a volume also needs **Read files**, and its paths apply inside the volume. |
| **See networks** | List networks and what is attached |
| **Connect networks** | Connect a shared container to a network, or disconnect it |
| **See ports** | Published and exposed ports of the shared containers, and Pierside's port forwards |
| **Forward ports** | Make a shared container's port reachable at `localhost` on your computer, and remove such forwards. A forward follows a renamed container and ends when its container is deleted (on an SSH engine within a minute); until then the assistant sees it marked and can remove it |
| **Engine info** | Docker version, CPUs and memory, disk usage, and recent engine events such as crashes and out-of-memory kills |
| **See Swarm** | Nodes, stacks, services and their tasks, service logs, and the names (never the contents) of secrets and configs |
| **Change Swarm services** | Create, scale, restart, change the image, roll back and remove services; remove a stack. Deploying a stack from a Compose file is not available. |
| **Create volumes and networks** | New named volumes and networks |
| **Delete and clean up** | Delete images, volumes and networks, and prune what is unused: stopped shared containers, images, volumes, networks, build cache. A preview shows what a prune would delete without deleting anything. |

### Allow everything

One switch at the top of the dialog: every container, every permission above, all file paths, and environment values visible, on the engines you choose under **Which engines**. Pick a single engine there to give full access to that one only, or **All engines**. The connection is marked in red on the AI access page. How the assistant gets in, and whether it asks before each action, are still your choice.

### Compose on the local engine

Compose up, down and reading Compose files work on SSH engines, where Pierside runs `docker compose` on the server. On the local engine Compose runs through Rancher Desktop's window, which a connection can't use. There the assistant can start, stop and restart a project's existing containers and recreate single containers, and it is told where the Compose files are on your computer so it can read them from disk itself.

### Asking for more

When the assistant needs something its connection doesn't allow, it can ask you instead of stopping. Pierside shows what it asks for (a permission, a container or Compose project, a file path, an engine, or the values of environment variables) with the assistant's reason, and you answer:

- **Allow this session**: that assistant session has it until it ends, or until you edit the connection (Pierside then tells you how many sessions lost such access, and the assistant can ask again); the connection itself doesn't change.
- **Add to connection**: it becomes part of the connection, as if you had ticked it in the dialog.
- **Deny**: refused; the assistant may ask for something else.
- **Deny, pause 2 min**: refused, and that assistant session can't ask for more access for two minutes.

Decide by the list of what would be allowed. The reason is written by the assistant, and text in a log or a file can talk an assistant into asking. The request waits in Pierside for ten minutes. A new request's allow buttons react only after a moment, so a click meant for the previous question doesn't answer it, and after you answer, a message says what you decided. Pierside's own, extension and Kubernetes containers never match a request, even an allowed one.

The assistant can't ask for **Allow everything**, for mounting host system folders, or to change how it is trusted or when it is asked; those you set yourself. Asking is available for connections you allow in Pierside, not for access tokens, and you can switch it off per connection with **The assistant may ask for more access**.

### What the assistant can't do

- Add or remove engines.
- Run commands on a server itself, outside containers. (Compose on an SSH engine is the one exception, and only for the projects the connection covers.)
- Read the contents of Swarm secrets.

## What is never shared

Not even with "Allow everything":

- Containers, volumes and networks that belong to Pierside itself, to other Rancher Desktop extensions, or to Kubernetes. Pierside's container holds the Docker socket and your saved SSH credentials.
- Containers a connection doesn't cover. To the assistant they look the same as containers that don't exist.

## Things to keep in mind

- **Logs and files can contain secrets.** Passwords printed at start-up, tokens in config files and the values of environment variables go to the assistant, and so to the AI provider, if you allow them. Share narrowly.
- **Image details can contain secrets too.** With environment values hidden, the build history still shows `RUN` lines as they were written; a secret typed directly into a Dockerfile command is visible there.
- **Run commands removes the other limits** for the containers it covers: a command can read any file, including those outside the allowed paths, read the values of environment variables even when they are hidden, and change anything inside them. Pierside asks about it with that warning. Leave it off unless you need it.
- **The engine-wide permissions show more than the shared containers.** **See images** and **See networks** list everything of that kind on the engine. **See volumes** lists the volumes that are unused or used only by shared containers (all volumes when the connection shares all containers): a volume holds the data of the containers using it. Lists of a network's or volume's containers name only shared ones. **Engine info** gives totals for the whole engine, but names only what the connection can see anyway: its own containers in engine events and in the largest items of disk usage, and images, volumes and networks only with the permission for them.
- **Container output is untrusted text.** A container can print something that reads like instructions. Read-only connections limit what such text could cause.
- A connection that uses an access token keeps that token in the assistant's configuration in plain text. Prefer the approval mode unless the assistant must run unattended.

## Manage connections

On the **AI access** page each connection has:

- a switch to turn it off and on without removing it,
- a button that shows the connection command again (or, for token connections, a key button that creates a new token and makes the old one stop working at once),
- how it is trusted right now, with **stop trusting** where that applies,
- edit and remove.

Changes apply to the next call; the assistant doesn't need to reconnect, except after a new token. When a change adds or removes tools, Pierside tells the assistant that its tool list changed (within half a minute); Claude Code then reloads it by itself.

**Recent activity** lists the latest calls: which connection, which tool, which container or file, and whether it was allowed. Refused calls, including ones you denied or didn't answer, are marked. The list is kept in memory and starts empty when Pierside restarts.

## Requirements and limits

- The assistant reaches Pierside through `docker exec`, so it needs the `docker` command on your computer, and Rancher Desktop and Pierside must be running.
- The connection keeps working when Pierside is updated. It stops if you install Pierside from a different image name (for example a build of your own), because the container name in the command changes; copy the command again with the key button.
- Connections are stored in Pierside's data volume and survive updates.
- Each answer is kept to a size an assistant can read. When a result is longer (many log lines, a big folder, long command output), Pierside leaves out whole lines or entries and says what it left out and how to get the rest: for example the next page of a folder listing, or the next lines of a file. A single line that is longer than a whole answer (a minified file, for example) is shortened, and the result says so. Some outputs are kept to their end by design: the latest output of each health check (800 characters) and Compose's output after up or down (about 6,000 characters).

## Structured results

Every tool also returns its result as structured data (MCP `structuredContent`, described by each tool's output schema), for clients and programs that work with data rather than text. Add `--structured` at the end of the connection command to get it. It is off by default, because some clients, Claude Code among them, then show the assistant the data instead of the text, which is longer and reads worse.
