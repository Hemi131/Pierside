# Building from source

You need Rancher Desktop (dockerd engine). The image build needs nothing else; Node.js 22 is only needed for the UI dev server.

## Build and install

```sh
docker build -t pierside/extension:dev .
rdctl extension install pierside/extension:dev
```

Or with the helper scripts (`make` on Linux/macOS, `make.ps1` in PowerShell):

```sh
./make.ps1 build       # docker build -t pierside/extension:dev .
./make.ps1 install     # build + install
./make.ps1 reinstall   # build + uninstall + install
./make.ps1 logs        # follow the backend's logs
./make.ps1 dev         # UI dev server on http://localhost:3000
```

Use `reinstall` after changes: installing a tag that is already installed does nothing in Rancher Desktop.

To bake in a version number: `docker build --build-arg VERSION=1.2.3 -t … .`

## How it is put together

- **UI** (`ui/`): React, TypeScript, Vite, MUI. Rancher Desktop loads it as the extension's tab.
- **Backend** (`backend/`): Python 3.12, FastAPI, aiodocker. It runs as the extension's container with the Docker socket mounted and serves the UI's requests, plus WebSockets for logs, stats, events and shells on a localhost port.
- **Packaging**: `Dockerfile` builds the UI, then assembles the image with the backend, `metadata.json` and `docker-compose.yaml`.

## UI dev server

1. Install the extension once; its backend keeps running.
2. `./make.ps1 dev` (or `make dev`) finds the backend's port and starts Vite.
3. Open http://localhost:3000/#/containers in a browser.

The UI then talks to the installed backend directly. Features that need Rancher Desktop itself (local Compose, the Docker console) are unavailable there.
