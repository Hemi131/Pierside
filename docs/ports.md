# Ports and forwarding

The **Ports** page lists three things:

- ports Pierside is forwarding,
- ports that containers publish,
- ports that containers expose but nobody publishes.

## Forward a port

**Forward a port** (on the Ports page, or in a container's ⋮ menu) makes a container port reachable at `localhost:<port>` on your computer without recreating the container.

- **Local engine:** useful for a container that was started without `-p`.
- **SSH engine:** brings a remote container's port to your computer through Pierside's SSH connection, even when the port isn't published on the server. Nothing is opened on the server.

Each forward is a small helper container on your local engine. Forwards survive switching engines and restarting Pierside, disappear when their target container is removed, and are removed when Pierside is uninstalled.

## Port conflicts

Starting a container whose host port is already taken shows which container holds the port and offers to stop it.
