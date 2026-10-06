# Install and update

## Before you install

1. Install [Rancher Desktop](https://rancherdesktop.io/) 1.23 or newer.
2. In Rancher Desktop, open **Preferences → Container Engine** and choose **dockerd (moby)**. Pierside talks to the Docker socket; with containerd it shows a message asking you to switch.

`rdctl` and `docker` come with Rancher Desktop. If your terminal doesn't find them, open a new terminal after Rancher Desktop has started.

## Install

```sh
rdctl extension install ghcr.io/hemi131/pierside:latest
```

Open **Pierside** in Rancher Desktop's sidebar. Images are published for amd64 and arm64.

### Which tag?

| Tag | What you get |
|---|---|
| `latest` | The newest release. |
| `0.1.0`, `0.2.0`, … | Exactly that release. It never changes. |
| `edge` | The current development build. It can be broken; use it only to try something unreleased. |

## Update

When a newer release exists, Pierside's footer shows **Update available**. Click it for the commands that match your installation.

If you installed `latest`:

```sh
docker pull ghcr.io/hemi131/pierside:latest
rdctl extension uninstall ghcr.io/hemi131/pierside:latest
rdctl extension install ghcr.io/hemi131/pierside:latest
```

If you installed a version number, replace the old number with the new one:

```sh
rdctl extension uninstall ghcr.io/hemi131/pierside:0.1.0
rdctl extension install ghcr.io/hemi131/pierside:0.2.0
```

### Why `install` alone doesn't update

Rancher Desktop has two behaviours that surprise people:

- Installing a tag that is already installed does nothing, even though it prints `Created`.
- It never downloads a newer image for a tag you already have locally. After an uninstall, `install …:latest` reuses the old `latest` stored on your machine.

So `latest` needs a `docker pull` first, and any update needs an uninstall. Version numbers avoid the second problem, because a new number has never been on your machine.

### Which version am I running?

The footer shows it (for example `Pierside 0.2.0`). Click it for the About dialog.

## What survives an update

Engines, SSH keys, remembered Compose projects, port forwards and the update-check setting live in a Docker volume named `pierside-data`, which uninstalling does not remove. View settings such as column widths are stored by Rancher Desktop with the extension and normally survive as well.

## Old images

Rancher Desktop does not delete an extension's previous image. Each time Pierside starts, it removes old Pierside images that no container uses: untagged ones, and older version numbers of the copy you installed. It never touches other images.

## Update check

Once a day Pierside asks GitHub for the newest release number of this repository. Nothing about your installation is sent. To switch it off, click the version in the footer and turn off **Check for new versions**.

## Uninstall

```sh
rdctl extension uninstall ghcr.io/hemi131/pierside:latest
```

To also delete Pierside's saved data (engines, SSH keys, settings):

```sh
docker volume ls --filter name=pierside-data
docker volume rm <the volume name shown>
```
