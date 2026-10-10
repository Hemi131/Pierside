# Third-party notices

Pierside's own code is licensed under Apache-2.0 (see `LICENSE`). It uses the third-party components listed below, **unmodified**. Each keeps its own license. Full license texts come with each package, in `node_modules/<package>/LICENSE` or the installed Python package's metadata.

## UI (bundled into the extension's web UI)

| Component | License |
|---|---|
| React, React DOM | MIT |
| MUI (`@mui/material`, `@mui/icons-material`), Emotion | MIT |
| xterm.js (`@xterm/xterm` and addons: fit, search, web-links) | MIT |
| CodeMirror 6 (`codemirror`, `@codemirror/*`: state, view, language, commands, search, autocomplete, lint, merge, theme-one-dark, legacy-modes, and the language packages), `@replit/codemirror-indentation-markers`, the Lezer parsers (`@lezer/*`), `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break` | MIT |
| `@docker/extension-api-client` (+ types) | Apache-2.0 |
| `@cfworker/json-schema` | MIT |
| Compose specification JSON schema (`compose-spec.json` from https://github.com/compose-spec/compose-spec, bundled for checking Compose files) | Apache-2.0 |
| `hoist-non-react-statics`, `react-transition-group`, `source-map` | BSD-3-Clause |
| `picocolors`, `yaml` | ISC |
| Other transitive dependencies (≈75 packages) | MIT |

Build-only tools (Vite, TypeScript, …) are not shipped. They are MIT, Apache-2.0, ISC, BSD or, for the `caniuse-lite` browser data, CC-BY-4.0.

## Backend (installed in the extension image)

| Component | License |
|---|---|
| FastAPI, Pydantic, AnyIO, uvloop, watchfiles, h11, httptools, attrs, PyYAML | MIT |
| Starlette, Uvicorn, websockets, click, idna, pycparser, python-dotenv | BSD-3-Clause |
| aiodocker, aiohttp, yarl, multidict, frozenlist, aiosignal, propcache | Apache-2.0 (aiohttp: Apache-2.0 AND MIT) |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| cffi | MIT-0 |
| typing_extensions, aiohappyeyeballs | PSF-2.0 |
| **AsyncSSH** | **EPL-2.0 OR GPL-2.0-or-later**: used unmodified as a library. Source: https://github.com/ronf/asyncssh |

## Helper program on your computer

`pierside-mcp-setup` (copied to your computer by Rancher Desktop with the extension; it registers the AI access connection with Claude Code or Devin CLI) is Pierside's own code, built with Go. It contains the Go standard library and runtime: BSD-3-Clause.

## Container images

- The extension image is built on the official `python:3.12-slim` image (Debian). It contains Debian packages under various licenses, some of them GPL. Their sources are available from Debian (https://sources.debian.org).
- At runtime Pierside may pull `alpine:3.20` for temporary helper containers (volume browsing, and exec cleanup on remote engines).
- The files in `dev/` are test fixtures and are not part of the extension. They reference `alpine`, `nginx`, `redis` and `docker:dind` images, each under its own license.

## Trademarks

Pierside is not affiliated with, endorsed by, or sponsored by Docker, Inc. or SUSE (Rancher). "Docker", "Docker Desktop", "Rancher" and "Rancher Desktop" are trademarks of their respective owners and are used only to describe compatibility.
