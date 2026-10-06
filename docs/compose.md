# Compose projects

Containers started by Docker Compose are grouped into a project row on the Containers page. The row shows how many services are running and has project-wide Start, Stop, Restart and Delete.

## Project view

Click a project to open it:

- **Logs** of all services merged into one stream, ordered by time, each line prefixed with the service name in its own colour. Hide or show services, search, toggle timestamps, download.
- **Services** with their status and actions; click one for the container's details.

## Up, Down and friends

Pierside remembers where each project's Compose files are, separately for each engine, so a project stays listed after `docker compose down` and can be brought up again. The ⋮ menu of a project has:

- **Up** and **Down**: a dialog with the common options (`--build`, `--pull always`, `--force-recreate`, `--remove-orphans`, selected services with `--no-deps`, profiles, env file, extra arguments). It shows the exact command and streams its output. Up always runs detached (`up -d`).
- **Pull and recreate**: pulls newer images and recreates the containers that use them.
- **View configuration**: the resolved Compose file (`docker compose config`).

The options you used last are remembered per project. The ▶ button on a stopped project runs Up with them.

**Open compose file** on the Containers page adds a project that has never been started.

## Where the command runs

- **Local engine:** Pierside runs the real `docker compose` on your machine through Rancher Desktop, so builds, relative paths and `.env` files behave as in a terminal. This works in the Pierside tab inside Rancher Desktop. It is not available in the separate browser window, because only Rancher Desktop may run commands on your machine.
- **SSH engine:** the command runs on the server, where the files are. The server needs the `docker compose` plugin.

## If something fails

The dialog shows Compose's own output and explains the usual causes: the Compose file was moved or deleted, the Compose plugin is missing, or a port is already in use.
