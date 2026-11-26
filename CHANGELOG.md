# Changelog

Each release of Pierside, newest first. Install a specific one with `rdctl extension install ghcr.io/hemi131/pierside:<version>`.

## Unreleased

## 1.5.1 - 2026-11-26

- Server files and Server disk no longer freeze when Docker on the server stops answering while SSH still works. Folders your SSH user may not read, the usual places and the sizes measured through Docker now give up after 30 seconds (60 seconds for a step in a helper) and say that Docker isn't answering, and one stuck folder no longer holds up all the others. Folders you can read yourself keep working meanwhile, and the Server files and Server disk pages open within a few seconds. A slow Docker no longer greys out the switch for using Docker there; only a server where Docker can't help at all (rootless, user remapping) does. When the usual places on the Server disk page can't be listed, the page says so and offers **Try again** instead of leaving the list out.

## 1.5.0 - 2026-11-25

- **AI access: scripts.** With the new permission **Run scripts** (off by default), an assistant can send a short Python script that calls Pierside's tools, and only what the script prints comes back to it. A job such as "count the errors in the logs of every running container" then takes one step and far less of the assistant's context. Every call the script makes is checked like a direct one. The script runs in a sandbox on this computer with no network and no access to Docker or your files, and you can see each script before it runs. Changes a script makes can be shown to you as a list first, asked about at the first change of each kind, or one by one. See [AI access](docs/ai-access.md#scripts).
- Two Pierside installs on one engine (for example a local build next to the published one, or two computers using the same SSH server) no longer remove each other's helper containers when they start, stop or switch engines. Before, this could cut off the other install's open volume browser, Server files, debug shell or root terminal.
- Narrow windows (for example Pierside snapped to half the screen): the AI access connections and the Engines list no longer run off the right edge. Like the Containers list, they hide their less important columns to fit, keep the actions visible, and have a **Columns** button to choose. Page buttons such as **New connection** keep their label on one line and move below the title when there's no room, and the Containers list's **Only show running containers** switch moves below the search box. Smaller tables (details, Ports, Swarm) scroll sideways inside their frame instead of widening the page.
- AI access: a connection's **Last used** now shows when the assistant last used a tool. Before, it showed "just now" for as long as the assistant was open, because its background checks were counted too.
- AI access: the assistant's engine list now also names the engines its connection may not use, marked as without permission, so it can ask you for one in Pierside instead of not knowing it exists. It sees only their names, not their addresses, and Pierside doesn't connect to them for it. Naming such an engine in a call now says that permission is missing, not that the engine is unknown.
- AI access: the assistant now gets each Compose project's state (running, partly running, paused, exited or down) and, for a project that is down, when it was last seen. Asking for the logs of a project that is down, or starting it, now says that it's down and how to bring it up, instead of that there's no such project. In the Containers list, **Down** explains itself when you hover over it.

## 1.4.5 - 2026-11-24

- **AI access: structured results.** Every tool can also return its result as structured data with a schema, for clients that use MCP's `structuredContent`: add `--structured` to the connection command (see [AI access](docs/ai-access.md#structured-results)). Without it nothing changes for the assistant.
- **AI access:** long results are cut at whole lines or entries and say what was left out and how to continue: the newest log lines are kept (before, the newest could be the ones cut off), big folders and lists come in pages (`offset`), and a long file, Compose file or Compose configuration continues at the next line instead of being cut off or refused. Searching files works in folders with long paths up to the 20,000-file limit. With structured results, a file's content keeps its line endings and says whether it was read whole, so it can be edited and written back unchanged. A command whose exit code isn't known (its output was too long to read to the end, or the engine didn't report it in time) says so instead of reporting 0.
- **AI access:** a command the assistant runs in a container is now stopped, with the processes it started, when it passes its time limit or prints more than can be read. Before, it kept running in the container after the answer (for example `tail -f` or `ping`). Background programs left behind by a command that has itself already ended are not stopped (see [AI access](docs/ai-access.md)).
- **AI access:** reading, listing or searching files in a running container (or a volume) can no longer be led outside the allowed paths by a process in that container that replaces a folder with a symbolic link right after Pierside checked the path (in containers that have `sh` and `cat`; see [AI access](docs/ai-access.md) for the details). Folders are now listed as root, like files are read, so a listing no longer depends on the container's own user. A path starting with `//` is read like the same path with one `/`.
- **AI access:** writing, creating, deleting files and changing permissions in a running container can no longer be led outside the allowed paths by a process in that container that replaces a folder with a symbolic link right after Pierside checked the path. This holds also while a whole folder is deleted or its permissions are changed. An existing file is now written in place, so it keeps its hard links too. In a running container without `sh` the assistant can't write files unless you tick **Also write to running containers that have no shell** under **Change files** (off by default); stopped containers are written as before. See [AI access](docs/ai-access.md#files).
- **AI access:** a command stopped at its time or output limit now also takes along what it sent into the background by forking twice (`(cmd &)`), which used to keep running in the container. Only a program that detaches itself with `setsid` escapes, and the message says so.
- **AI access:** port forwards follow a renamed container and are removed when their container is deleted, also on SSH engines (within a minute; before, only at the next connection to the port). Until then the assistant sees such a forward marked as having lost its container and can remove it; before, it couldn't see it at all after a rename.
- **AI access:** answers are kept to about 60,000 characters (from 200,000), so that Claude Code shows them directly instead of saving them to a file; longer results continue as before (next page, next lines).
- **AI access:** smaller fixes. A log request above the connection's maximum says it was cut to it. A file line too long for one answer says where the file goes on. An image's long build commands are marked as shortened, and the assistant can get one whole (`layer`). A Compose project that is down but remembered shows its files in its details. Writing a file into a missing folder names that folder. Killing a container with a signal waits a moment before reporting its state. Swarm service logs name the task of each line. The `docker run` command of a container (also **Copy docker run command** in the containers list) includes its other networks and network aliases.
- **AI access requests:** the request for **Run commands** says that it can read every file and environment value in the containers. A new request's allow buttons react only after a moment, so a click meant for the previous question can't answer it, and a message says what you decided. Requests for containers that are never shared (extensions, Kubernetes) are refused, and the request says such containers never match. Editing a connection still ends what you allowed for single sessions, but now says how many sessions lost it, and the assistant is told it can ask again (also when it uses a tool it had a moment ago).
- **Files:** uploading, editing and creating a folder below a tmpfs or a mount the container made itself (the `/tmp` of a Docker-in-Docker image, for example) now changes what the container sees. Before, the change went into the folder hidden underneath: Pierside reported success, but the file never showed up.
- **Files, volume Stored data and Server files:** an upload that breaks off (window closed, connection lost) no longer replaces the existing file with the part that arrived. Uploads go to a temporary file next to the target and replace it only once complete; on a server reached over SSH, an existing file keeps its owner and permissions. A saved edit is likewise complete before the file is changed. In a container started with `--cap-drop ALL`, where root may not write into another user's folder, the change is made as the container's own user.
- **Files:** a paused container's file actions say to resume it, instead of failing with an engine error.
- **AI access:** reading and writing files no longer reaches the folder hidden under a tmpfs. A paused container's files are refused with a request to resume it (before, they could be read and written through Docker's file copy, which sees what lies under the container's mounts). In a running container without a shell, paths on a tmpfs are refused, also with **Also write to running containers that have no shell** on, and a file on a tmpfs is reported as such instead of "doesn't exist".
- **Files, volume Stored data and Server files:** a delete or permission change that fails is now reported as failed; before, it could look successful when the engine reported the result late. When it fails for many files at once, the message shows the first three and how many more. A container without `find` / `stat` (or without a shell) says that its files can't be browsed, instead of showing an empty folder, and a file preview no longer shows an empty file when the file couldn't be read.

## 1.4.4 - 2026-11-19

- **Website:** Pierside has its own site, [pierside.dev](https://pierside.dev), with an overview of what it does, the installation guide, the documentation (with search) and this changelog. Pierside's About dialog (click the version in the footer) links to it.

## 1.4.3 - 2026-11-18

- Terminals: **Ctrl+S** no longer freezes the shell. It used to stop all output until Ctrl+Q (the terminal's old flow control), which looked like a hung shell. Full-screen programs such as `nano` still get it.
- Terminals (the server terminal of an SSH engine and a container's shell): **right click** works as in Windows Terminal: it copies the selected text, or pastes when nothing is selected.
- The server terminal of an SSH engine edits the command line by word, as a container's shell already did: **Ctrl+Backspace** and **Ctrl+Delete** delete a word, **Ctrl+Left** / **Ctrl+Right** move by word, and text is selected with **Shift+arrows**, by word with **Ctrl+Shift+Left** / **Right**, or to the line's ends with **Shift+Home** / **End** (then **Ctrl+C** copies it). On the command line a selection works as in an editor: **Left** / **Right** go to its start / end, **Backspace** / **Delete** remove it, typing or pasting replaces it, and **Ctrl+X** cuts it (the command line is found after a prompt ending in `$`, `#`, `>` or `%`). Full-screen programs such as `vim` or `top` still get the keys unchanged.

## 1.4.2 - 2026-11-18

- **Alerts no longer spam.** A problem is reported once while it goes on, with a reminder every two hours, instead of again every few minutes for each kind of trouble: a restart loop that also makes the container unhealthy is one alert, and a Swarm service whose tasks all fail (for example an image that doesn't exist) is one alert, not one per replica. Alerts arriving together are one message, desktop notifications come at most every 30 seconds, and the message has **Mute 1 h** and **Pause all 15 min**. See [Alerts](docs/alerts.md#how-often).
- **Cancel switch on a slow server:** pressed after Pierside had already connected (an overloaded server answers slowly, so the switch can finish while you reach for the button), it used to do nothing, and you then waited for the slow server to load. Now it takes you back to the engine you came from. Leaving a slow server is also quicker: Pierside waits at most 10 seconds to clean up there.

## 1.4.1 - 2026-11-06

- Rancher Desktop 1.25: the extension lost its own look (very large headings, uppercase buttons, default colours) because Rancher now provides a minimal theme of its own. Pierside uses its own theme again.

## 1.4.0 - 2026-10-31

- **Root terminal** (SSH engines): a switch in the terminal's header opens that server's terminal as root, through a privileged helper container. Off by default, remembered per server, and it asks before turning on. See [Remote engines](docs/remote-engines.md#root-terminal).
- A file or process action on a server (upload, delete, change permissions, save, end a process) could finish on the other server if you switched engines while it ran. It now stops with a message instead, also when a second window still shows the previous server.
- **Cancel switch** stops the switch you see, not whichever one happens to be connecting, and only one switch runs at a time in a window.
- A server setting (Root terminal, or using Docker where you have no permission) is refused if the active engine changed while you were answering, instead of landing on another server.
- Containers: the icons of containers inside a Compose project are no longer cut off after a column has been resized.

## 1.3.2 - 2026-10-28

- Server performance no longer scrolls sideways in a narrow window: the process list leaves out the Running, User, Disk and Container columns as it gets narrower (the command's tooltip shows what they would), and the charts and the switches at the top fit the width.

## 1.3.1 - 2026-10-19

- Switching away from an SSH engine whose server had been turned off could take minutes, and other engines seemed impossible to switch to meanwhile. Requests waiting for the lost server now get its answer together instead of each trying to reconnect in turn, and the switch no longer waits for clean-up on a server it can't reach.
- A switch to an engine that doesn't answer can be cancelled: **Cancel switch** in the engine menu, or **Cancel** in place of **Switch** on Manage engines and Engines at a glance.
- Server performance: on a narrow window, the "Order held" note no longer moves the process list down when it appears, which ended the hold at once.

## 1.3.0 - 2026-10-17

- **Server performance** (SSH engines, in the bottom bar): like `htop` for the server, with the container of each process. CPU, memory, disks and network with 10-minute charts, a note when something stands out (low memory, swapping, waiting for the disk, high load), and the processes sorted by CPU, memory or disk I/O, or grouped by container. Processes can be ended, forced to end or given a lower priority. Nothing has to be installed on the server.
- **Server alerts:** switch on **Alert me about this server** to be told when an SSH server's memory is almost full, it keeps swapping, its load stays high, or a disk is almost full, checked every 30 seconds whichever engine is active.
- **Security:** a request to Pierside's local port that claimed to come from a development web page (`Origin: http://localhost:3000`) was let in without the session token, so any program on your computer, or a web page served on that port, could get full access to Docker through it. Every request now needs the token.
- **Security:** AI access accepted names such as `../containers/x` for images and networks, which reached other parts of the Docker API: an assistant could delete a container outside its scope or put a container on the host's network. Such names are refused now.
- Fixed: AI access could start a container on the host's network when given that network's ID instead of its name.
- Fixed: switching off **Watch in the background** (or removing a watched engine) left its connection open and could stop the page from updating.
- Fixed: an unreachable engine could make healthy watched engines look unreachable too.
- **AI access:** environment values with spaces were only partly hidden in `container_run_command`, and `compose_config` / `read_compose_files` showed secrets; with "Show environment values" off, variables are no longer filled in, values in environment, build arguments, driver options, inline contents and `x-` blocks are hidden, and `read_compose_files` shows the merged configuration instead of the raw files. A volume used by containers outside a connection's scope is no longer visible to it, and lists name only the containers it shares. Starting a container with a host folder mounted now counts as destructive for "ask before destructive actions".
- Fixed: Swarm "task keeps failing" alerts never came on servers whose clock isn't set to UTC.
- Fixed: Engines at a glance showed 0 CPU / memory for engines with many containers (now what could be measured, marked "≥"), counted Kubernetes' and Pierside's own containers on the active engine, and could call a container "restarting" hours after it stopped.
- Fixed: switching engines removed Pierside's helper containers on the new engine instead of the old one, and left shells of the old engine running.
- Fixed: pruning volumes stopped running file downloads, Server files and disk measurements and debug shells.
- Fixed: after a brief connection drop (e.g. an SSH hiccup), logs repeated up to 1000 lines; a single failed check could mark a container "removed". Merged Compose logs now also start in time order across slow and fast services.
- Fixed: **Images → Clean up → All unused** also deleted the images of Rancher Desktop, Kubernetes and extensions without a running container.
- Fixed: Swarm stack delete reported success when nothing could be deleted; Compose **Start all** also started `docker compose run` one-off containers; **Copy docker run command** wrote an invalid `-p 127.0.0.1:80` for ports with any host port and quoted a multi-word entrypoint as one word.
- Fixed: a settings file that couldn't be read (engines, port forwards) was overwritten empty on the next change; it is now kept as a copy.
- Fixed: a second confirmation (e.g. two port conflicts when starting several containers) replaced the first, and the action then never finished.
- Fixed: in a file browser, a file that loaded slowly could show up, and be saved, under the name of the file clicked after it.
- Fixed: pausing a container ended its Exec shell and dropped unsaved changes in its Files tab; both now carry on after Resume.
- Fixed: logs of a container with a terminal (TTY) could clear or switch the log view's screen; only colours and links are kept from such codes now.
- Fixed: removing an AI connection that was set up "for this project folder only" left it registered in the assistant (for connections set up from now on).
- Fixed: closing the bottom Docker console left commands such as `logs -f` running; Ctrl+F no longer takes the key from a shell (vim, less); Images: deleting from an image's page warns about Rancher Desktop's images and removes only the tag shown; IPv6 port links; Swarm secrets and configs show load errors instead of spinning; cancelling a Compose run right after starting it works; lists catch up after the live connection was briefly lost.

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
