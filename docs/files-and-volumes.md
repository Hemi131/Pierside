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

## Find a file by name

Every file browser (container files, volume contents, Server files) has a **Find by name** box in its path bar.

- Typing narrows the folder you are in at once.
- **Enter** also looks through its subfolders and lists the matches with where they are. Click a file to open it, or a folder to go there. The cross in the box brings the folder back.

Upper and lower case don't matter, and the text is taken literally (`*` is just a star). A search returns at most 500 matches and is stopped after 20 seconds on a very large tree; it then says so, and searching from a subfolder gets the rest. It never looks into `/proc`, `/sys` or `/dev`, and doesn't follow symbolic links. On Server files it runs with your own rights and says when folders you can't read were skipped; with Docker allowed for that server it searches those too.

## Files on the server (SSH engines)

With an SSH engine active, **Server files** in the bottom bar, next to **Terminal**, browses and edits the files of that server itself, with the same browser and editor. It starts in your home folder; the pin button next to the path takes you to any folder by typing its path.

Everything runs as your SSH user, with that user's rights. A folder you can read lists all its entries, including files you can't open, with their owner and permissions.

**Where you have no permission.** If your SSH user may use Docker on the server (it is in the `docker` group, for example), Pierside can do the same through a short-lived helper container that mounts the folder, as root. The first time you hit such a file or folder, Pierside asks whether to do that on this server and remembers the answer; the switch **Use Docker where I have no permission** at the top of the page changes it later. While a file is handled this way, the path bar shows **Through Docker (root)**; otherwise it shows **As** and your user name.

- Reading and browsing use a read-only mount; only saving, uploading, creating, deleting and changing permissions use a separate writable one. The helpers are removed after a minute without use.
- A file you save keeps its owner and permissions. A new file or folder gets the owner of the folder it is created in.
- Not mounted: the root folder itself (files directly in `/` are only reachable with your own rights) and `/proc`, `/sys`, `/dev`.
- Docker can't help when it runs rootless or with user-namespace remapping on the server, as its containers then have no more rights than you; the switch says so.
- On servers with SELinux enforcing, a mount may still be refused. Pierside doesn't relabel files to get around that.

Being allowed to use Docker on a server is as good as being root there, and this makes it one click away. Check that working this way is fine where you work.

## Disk space on the server (SSH engines)

**Server disk** in the bottom bar shows where the space on the server went. It only reads; nothing can be deleted from it.

- At the top are the server's filesystems with how full they are. This is immediate.
- Click one to open it. Pierside lists the folder and then measures each subfolder, so the rows fill in one after another, largest first, each with a bar and its share. Click a folder to go deeper; the folder button at the right opens the same place in Server files.
- Nothing is measured that you didn't open, and sizes you have seen are kept while the page is open, so going back up is instant. **Refresh** measures the current folder again.

Measuring a folder with a great many files takes time on any system. It runs at the lowest CPU and disk priority, so the server's own work comes first, at most two folders at a time, and a single folder is given two minutes; one that takes longer is marked, and opening it measures its parts one by one. The stop button ends what is running. Sizes count each folder's own filesystem only, so a disk mounted inside it is not added.

Folders your SSH user can't read fully are marked **Partly unreadable**, because their real size is larger. If your account may use Docker on the server, Pierside offers to measure those through a read-only helper container, as root; this is the same choice as for Server files, is remembered per server, and can be changed with the switch **Use Docker where I have no permission** at the top of either page. Such rows show **Through Docker**. The root folder itself and `/proc`, `/sys`, `/dev` are never mounted.

Docker's own data (images, volumes, build cache) is broken down on the **Disk usage** page.

## The editor

Files open in a code editor, first as a read-only preview:

- syntax highlighting chosen from the file name (YAML, JSON, Dockerfile, nginx, shell, INI, TOML, Python, JavaScript/TypeScript, SQL, HTML/CSS/XML, Markdown, Go, Rust and more). The language button next to the file name picks another.
- line numbers, folding, search and replace (**Ctrl+F**), multiple cursors, undo.
- **Edit** unlocks the view; **Ctrl+S** saves.
- **Review changes** (the button next to Save) shows your edit as a diff against the file as it was loaded: removed lines in red above the new ones in green, long unchanged stretches folded. Save from there, or click the button again to go back to editing. A change of line endings is mentioned above the diff.
- **LF/CRLF** sets the line endings written to disk. Files that mix both are flagged.
- **Error checking** for JSON and YAML: syntax errors are underlined in red with a marker in the gutter; hover for the message. Compose files (`compose.yaml`, `docker-compose.yml`, `compose.override.yaml`, `docker-compose.prod.yml` and so on) are also checked against the official Compose schema, which is built into Pierside (nothing is downloaded); schema problems are underlined in yellow on the key or value concerned. YAML files over 200 KB aren't checked, and Compose files over 100 KB get the syntax check only. Picking JSON or YAML with the language button checks the file as that language.
- Keyboard shortcuts as in VS Code: **Ctrl+D** select the next occurrence, **Alt+Up/Down** move lines, **Shift+Alt+Up/Down** copy lines, **Ctrl+/** toggle comment, **Ctrl+Shift+K** delete line, **Ctrl+L** select line (again for the next one), **Ctrl+Enter** / **Ctrl+Shift+Enter** insert a line below / above, **Tab** / **Shift+Tab** indent / unindent the selection.
- Matching brackets are coloured by nesting depth, and indentation guides show the structure of nested blocks.
- **Wrap lines** toggles wrapping; **Maximize** expands the editor over the whole window (**Esc** restores); drag the divider to resize.

## Logs as Markdown

Select lines in any log view and choose **Copy as Markdown** to get a ready-to-paste block with the source, the time range and full timestamps.

## Copy an image to another engine

From an image's ⋮ menu or detail page you can copy the image to another engine, for example from your laptop to an SSH server. It is streamed directly; no registry is involved.
