#!/bin/sh
# macOS and Linux: run the build of pierside-mcp-setup for this machine's CPU (Rancher Desktop
# picks host binaries by operating system only). See main.go.
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  *) arch=amd64 ;;
esac
exec "$(dirname "$0")/pierside-mcp-setup-$arch" "$@"
