# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:22-alpine AS ui-build
WORKDIR /ui
COPY ui/package.json ui/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci || npm install
COPY ui/ ./
RUN npm run build

# pierside-mcp-setup: run on the user's computer by the AI access page to register the MCP server
# with Claude Code / Devin CLI (host/mcpsetup). Shipped as Rancher Desktop "host binaries".
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS host-build
WORKDIR /src
COPY host/mcpsetup/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -H windowsgui" -o /out/windows/pierside-mcp-setup.exe . \
 && for os in darwin linux; do for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags="-s -w" -o /out/$os/pierside-mcp-setup-$arch . ; \
    done; cp pierside-mcp-setup.sh /out/$os/pierside-mcp-setup; done \
 && chmod 755 /out/darwin/* /out/linux/*

FROM python:3.12-slim
# Release number (CI passes the git tag); shown in the UI and used by the update notice.
ARG VERSION=dev
LABEL org.opencontainers.image.title="Pierside" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/Hemi131/Pierside" \
      org.opencontainers.image.description="Docker Desktop–style container UI for Rancher Desktop." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Pierside" \
      com.docker.desktop.extension.api.version="0.3.4" \
      com.docker.desktop.extension.icon="icon.svg" \
      com.docker.extension.categories="utility-tools"

WORKDIR /backend
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN --mount=type=cache,target=/root/.cache/pip pip install .

COPY metadata.json icon.svg LICENSE NOTICE THIRD_PARTY_NOTICES.md /
# Rancher copies the compose file's whole directory out of the image, so keep it in its own dir.
COPY docker-compose.yaml /compose/docker-compose.yaml
COPY --from=ui-build /ui/build /ui
COPY --from=host-build /out /host

ENV PYTHONUNBUFFERED=1 \
    PIERSIDE_VERSION=${VERSION}
CMD ["python", "-m", "app.server"]
