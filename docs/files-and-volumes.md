# Files, volumes and the editor

## Container files

A running container's **Files** tab is a file browser for its filesystem:

- navigate, preview and download files;
- upload with the button or by dropping files on the list;
- create files and folders, delete them;
- edit text files up to 1 MB;
- change permissions by clicking a value in the **Mode** column (a read/write/execute grid or an octal number; for folders optionally everything inside).

Edits keep the file's owner and permissions. New files belong to the container's user.

These actions use tools inside the container (`ls`, `rm`, `chmod`), so they need a container that has them. For minimal images without a shell, use the **debug shell** in the Exec tab.

## Volume contents

A volume's **Stored data** tab is the same browser for the volume. Pierside reads the volume through a short-lived helper container that mounts it **read-only**. Only when you change something does it start a second helper that mounts the volume writable. Both are removed afterwards. New files get the owner of the folder they are created in.

## The editor

Files open in a code editor, first as a read-only preview:

- syntax highlighting chosen from the file name (YAML, JSON, Dockerfile, nginx, shell, INI, TOML, Python, JavaScript/TypeScript, SQL, HTML/CSS/XML, Markdown, Go, Rust and more). The language button next to the file name picks another.
- line numbers, folding, search and replace (**Ctrl+F**), multiple cursors, undo.
- **Edit** unlocks the view; **Ctrl+S** saves.
- **LF/CRLF** sets the line endings written to disk. Files that mix both are flagged.
- **Wrap lines** toggles wrapping; **Maximize** expands the editor over the whole window (**Esc** restores); drag the divider to resize.

## Logs as Markdown

Select lines in any log view and choose **Copy as Markdown** to get a ready-to-paste block with the source, the time range and full timestamps.

## Copy an image to another engine

From an image's ⋮ menu or detail page you can copy the image to another engine, for example from your laptop to an SSH server. It is streamed directly; no registry is involved.
