/** File browser for volume stored data (read-only) and container files (upload, edit, new file/folder). */
import { DragEvent, lazy, MouseEvent as ReactMouseEvent, ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import NoteAddOutlinedIcon from "@mui/icons-material/NoteAddOutlined";
import CreateNewFolderOutlinedIcon from "@mui/icons-material/CreateNewFolderOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderIcon from "@mui/icons-material/Folder";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LinkIcon from "@mui/icons-material/Link";
import RefreshIcon from "@mui/icons-material/Refresh";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { api } from "../api/ddclient";
import { downloadFromBackend, uploadToBackend } from "../api/download";
import { copyText, formatBytes, relativeTime } from "../utils/format";
import { MONO } from "../theme";
import { useFeedback } from "./Feedback";
import { usePersistentState } from "../hooks/usePersistentState";
import { detectLanguage, LanguageId, languageLabel, LANGUAGES } from "./codeLanguages";
import { PermissionsDialog, PermissionsTarget } from "./PermissionsDialog";
import WrapTextIcon from "@mui/icons-material/WrapText";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import EditLocationAltOutlinedIcon from "@mui/icons-material/EditLocationAltOutlined";
import SearchIcon from "@mui/icons-material/Search";
import DifferenceOutlinedIcon from "@mui/icons-material/DifferenceOutlined";

export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file" | "link" | "other";
  size: number | null;
  mtime: number | null;
  mode: string;
  owner: string;
  linkToDir: boolean;
}

/** What a search below a folder found. Entries carry their full path. */
interface SearchResult {
  path: string;
  query: string;
  entries: FsEntry[];
  truncated: boolean;
  timedOut: boolean;
  skipped: boolean;
}

interface Preview {
  path: string;
  size: number | null;
  truncated: boolean;
  binary: boolean;
  content: string | null;
}

export interface FileBrowserApi {
  list: (path: string) => string; // vm.service URL
  preview: (path: string) => string; // vm.service URL
  download: (path: string) => string; // backend path (TCP)
  /** Names below a folder that contain the text; vm.service URL. */
  search?: (path: string, text: string) => string;
  /** Writable filesystems only (containers; volumes are browsed read-only). */
  write?: {
    upload: (dir: string, name: string) => string; // backend path (TCP), raw body
    save: string; // vm.service URL, PUT {path, content}
    mkdir: string; // vm.service URL, POST {path}
    remove: string; // vm.service URL, POST {path}: a file, or a folder with its contents
    chmod: string; // vm.service URL, POST {path, mode, recursive}
  };
  /** Sees every answer (server files: to show whether it went over SSH or through Docker). */
  onResult?: (result: unknown) => void;
  /** A failed request: resolve true to send it once more (e.g. after the user allowed something). */
  onDenied?: (error: unknown) => Promise<boolean>;
}

// Loaded when the first file is opened: the editor and its languages are a large part of the bundle.
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

const q = (p: string) => encodeURIComponent(p);
export const volumeFsApi = (name: string): FileBrowserApi => ({
  list: (p) => `/volumes/${q(name)}/files?path=${q(p)}`,
  preview: (p) => `/volumes/${q(name)}/file?path=${q(p)}`,
  download: (p) => `/volumes/${q(name)}/download?path=${q(p)}`,
  search: (p, text) => `/volumes/${q(name)}/search?path=${q(p)}&q=${q(text)}`,
  // Changes go through a separate writable helper; browsing stays read-only (see backend helper.py).
  write: {
    upload: (dir, file) => `/volumes/${q(name)}/upload?path=${q(dir)}&filename=${q(file)}`,
    save: `/volumes/${q(name)}/file`,
    mkdir: `/volumes/${q(name)}/mkdir`,
    remove: `/volumes/${q(name)}/delete`,
    chmod: `/volumes/${q(name)}/chmod`,
  },
});

export const containerFsApi = (id: string): FileBrowserApi => ({
  list: (p) => `/containers/${id}/files?path=${q(p)}`,
  preview: (p) => `/containers/${id}/file?path=${q(p)}`,
  download: (p) => `/containers/${id}/download?path=${q(p)}`,
  search: (p, text) => `/containers/${id}/search?path=${q(p)}&q=${q(text)}`,
  write: {
    upload: (dir, name) => `/containers/${id}/upload?path=${q(dir)}&name=${q(name)}`,
    save: `/containers/${id}/file`,
    mkdir: `/containers/${id}/mkdir`,
    remove: `/containers/${id}/delete`,
    chmod: `/containers/${id}/chmod`,
  },
});

type Eol = "\n" | "\r\n";
/** Line endings of a text: the majority style, and whether both occur. New files default to LF. */
function detectEol(text: string): { eol: Eol; mixed: boolean } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { eol: crlf > lf ? "\r\n" : "\n", mixed: crlf > 0 && lf > 0 };
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");

function EntryIcon({ e }: { e: FsEntry }) {
  if (e.type === "dir") return <FolderIcon fontSize="small" sx={{ color: "primary.main" }} />;
  if (e.type === "link") return <LinkIcon fontSize="small" sx={{ color: e.linkToDir ? "primary.main" : "text.secondary" }} />;
  return <InsertDriveFileOutlinedIcon fontSize="small" sx={{ color: "text.secondary" }} />;
}

/** Asks for a file or folder name (window.prompt doesn't work inside Rancher Desktop). */
function NameDialog({ title, dir, onClose }: { title: string | null; dir: string; onClose: (name: string | null) => void }) {
  const [name, setName] = useState("");
  const valid = !!name.trim() && !name.includes("/") && name !== "." && name !== "..";
  useEffect(() => setName(""), [title]);
  return (
    <Dialog open={!!title} onClose={() => onClose(null)} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && onClose(name.trim())}
          helperText={`In ${dir}`}
          sx={{ mt: 1 }}
          InputProps={{ sx: { fontFamily: MONO } }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={() => onClose(null)}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid} onClick={() => onClose(name.trim())}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function FileBrowser({ fs, emptyHint, start = "/", toolbar, goTo = false }: {
  fs: FileBrowserApi;
  emptyHint?: string;
  /** The folder shown first. */
  start?: string;
  /** Extra controls at the end of the path bar. */
  toolbar?: ReactNode;
  /** A button to type a folder to go to. */
  goTo?: boolean;
}) {
  const { toast, confirm } = useFeedback();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; pct: number; index: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [naming, setNaming] = useState<"file" | "folder" | null>(null);
  const [permissions, setPermissions] = useState<PermissionsTarget | null>(null);
  // Editor: draft text for `selected`; `isNew` when the file doesn't exist yet.
  const [draft, setDraft] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  // Line endings: the editor always holds \n; `eol` is what gets written back.
  const [eol, setEol] = useState<Eol>("\n");
  // Review: the editor shows the edit as a diff against the file as loaded (read-only meanwhile).
  const [reviewing, setReviewing] = useState(false);
  // The preview/editor panel: maximized over the whole window, or beside the list at a width the
  // user can drag (kept between sessions).
  const [maximized, setMaximized] = useState(false);
  // Syntax highlighting: detected from the file name, unless the user picks another for this file.
  const [languageChoice, setLanguageChoice] = useState<{ path: string; id: LanguageId } | null>(null);
  const [languageMenu, setLanguageMenu] = useState<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = usePersistentState<number | null>("files.previewWidth", null);
  const container = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  // One setting for preview and editor, so long lines look the same in both.
  const [wrap, setWrap] = usePersistentState("files.wrapLines", true);
  const [path, setPath] = useState(start);
  const [typedPath, setTypedPath] = useState<string | null>(null);
  // Find by name: typing narrows the folder shown; Enter looks through its subfolders too.
  const [find, setFind] = useState("");
  const [found, setFound] = useState<SearchResult | null>(null);
  const [finding, setFinding] = useState(false);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Every request goes through here, so the caller can watch answers and retry a refused one.
  const call = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      try {
        const r = await run();
        fs.onResult?.(r);
        return r;
      } catch (e) {
        if (!fs.onDenied || !(await fs.onDenied(e))) throw e;
        const r = await run();
        fs.onResult?.(r);
        return r;
      }
    },
    [fs],
  );

  const load = useCallback(
    (p: string) => {
      setLoading(true);
      setError(null);
      setFind("");
      setFound(null);
      call(() => api.get<{ path: string; entries: FsEntry[] }>(fs.list(p)))
        .then((r) => {
          setEntries(r.entries);
          setPath(r.path);
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    },
    [fs, call],
  );

  useEffect(() => load(start), [load, start]);

  const loadPreview = (p: string) => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    call(() => api.get<Preview>(fs.preview(p)))
      .then(setPreview)
      .catch((err) => setPreviewError((err as Error).message))
      .finally(() => setPreviewLoading(false));
  };

  const detected = selected ? detectLanguage(selected) : "plain";
  const language = languageChoice && languageChoice.path === selected ? languageChoice.id : detected;
  const original = detectEol(preview?.content ?? "");
  const shown = (preview?.content ?? "").replace(/\r\n/g, "\n");
  const dirty =
    draft !== null && (isNew || draft !== (preview?.content ?? "").replace(/\r\n/g, "\n") || eol !== original.eol || original.mixed);

  // Leaving the editor (saved, cancelled, another file) ends a review too.
  useEffect(() => {
    if (draft === null) setReviewing(false);
  }, [draft]);

  const startEditing = () => {
    if (!preview) return;
    setEol(original.eol);
    setDraft(shown);
  };

  // Esc leaves the maximized view, unless the editor used the key (e.g. to close its search bar).
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  // Drag the divider between the list and the preview/editor.
  const startPanelResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const box = container.current;
    if (!box) return;
    const right = box.getBoundingClientRect().right;
    const max = box.clientWidth - 260;
    const onMove = (ev: MouseEvent) => setPanelWidth(Math.round(Math.max(320, Math.min(max, right - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Leaving the editor with unsaved changes asks first. */
  const leaveEditor = async () => {
    if (!dirty) return true;
    return confirm({ title: "Discard changes?", message: "Your edits to this file haven't been saved.", confirmLabel: "Discard", destructive: true });
  };

  const searchBelow = () => {
    const text = find.trim();
    if (!fs.search || text.length < 2) return;
    const search = fs.search;
    setFinding(true);
    setError(null);
    call(() => api.get<SearchResult>(search(path, text)))
      .then(setFound)
      .catch((e) => setError((e as Error).message))
      .finally(() => setFinding(false));
  };

  // The rows shown: what a search found (with full paths), or the folder, narrowed while typing.
  const needle = find.trim().toLowerCase();
  const rows = found ? found.entries : needle ? (entries ?? []).filter((e) => e.name.toLowerCase().includes(needle)) : entries;
  const rowPath = (e: FsEntry) => (found ? e.path : join(path, e.name));

  const open = async (e: FsEntry) => {
    if (!(await leaveEditor())) return;
    setDraft(null);
    setIsNew(false);
    const p = rowPath(e);
    if (e.type === "dir" || e.linkToDir) {
      setSelected(null);
      setPreview(null);
      load(p);
    } else if (e.type === "file" || e.type === "link") {
      setSelected(p);
      loadPreview(p);
    }
  };

  const closePreview = async () => {
    if (!(await leaveEditor())) return;
    setDraft(null);
    setIsNew(false);
    setSelected(null);
    setMaximized(false);
  };

  const uploadFiles = async (files: File[]) => {
    const w = fs.write;
    if (!w || !files.length) return;
    const existing = new Set((entries ?? []).map((e) => e.name));
    const clashes = files.filter((f) => existing.has(f.name));
    if (clashes.length) {
      const ok = await confirm({
        title: clashes.length === 1 ? `Replace ${clashes[0].name}?` : `Replace ${clashes.length} files?`,
        message: `${clashes.map((f) => f.name).join(", ")} already exist${clashes.length === 1 ? "s" : ""} in ${path}.`,
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!ok) return;
    }
    const dir = path;
    let done = 0;
    for (const [i, f] of files.entries()) {
      setUploading({ name: f.name, pct: 0, index: i + 1, total: files.length });
      try {
        await call(() => uploadToBackend(w.upload(dir, f.name), f, (sent, total) => setUploading({ name: f.name, pct: total ? (sent / total) * 100 : 0, index: i + 1, total: files.length })));
        done++;
      } catch (e) {
        toast("error", `${f.name}: ${(e as Error).message}`);
      }
    }
    setUploading(null);
    if (done) toast("success", done === 1 ? `Uploaded ${files.length === 1 ? files[0].name : "1 file"} to ${dir}` : `Uploaded ${done} files to ${dir}`);
    load(dir);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!fs.write) return;
    void uploadFiles([...e.dataTransfer.files].filter((f) => f.size > 0 || f.type !== ""));
  };

  const remove = async (e: FsEntry) => {
    if (!fs.write) return;
    const p = join(path, e.name);
    const isDir = e.type === "dir";
    const ok = await confirm({
      title: `Delete ${e.name}${isDir ? "/" : ""}?`,
      message: isDir ? `The folder ${p} and everything in it will be permanently deleted.` : `${p} will be permanently deleted.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const remove = fs.write.remove;
      await call(() => api.post(remove, { path: p }));
      toast("success", `${e.name} deleted`);
      if (selected === p || selected?.startsWith(p + "/")) {
        setDraft(null);
        setIsNew(false);
        setSelected(null);
      }
    } catch (err) {
      toast("error", (err as Error).message);
    }
    load(path);
  };

  const applyPermissions = async (change: { mode: string; recursive: boolean } | null) => {
    const target = permissions;
    setPermissions(null);
    if (!change || !target || !fs.write) return;
    try {
      const chmod = fs.write.chmod;
      await call(() => api.post(chmod, { path: target.path, ...change }));
      toast("success", `Permissions of ${target.path.split("/").pop()} set to ${change.mode}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    load(path);
  };

  const create = async (name: string | null) => {
    const kind = naming;
    setNaming(null);
    if (!name || !fs.write) return;
    const p = join(path, name);
    if (kind === "folder") {
      try {
        const mkdir = fs.write.mkdir;
        await call(() => api.post(mkdir, { path: p }));
        toast("success", `Folder ${name} created`);
        load(p);
      } catch (e) {
        toast("error", (e as Error).message);
      }
      return;
    }
    if ((entries ?? []).some((e) => e.name === name)) {
      toast("error", `${name} already exists`);
      return;
    }
    if (!(await leaveEditor())) return;
    setSelected(p);
    setPreview({ path: p, size: 0, truncated: false, binary: false, content: "" });
    setPreviewError(null);
    setIsNew(true);
    setEol("\n");
    setDraft("");
  };

  const save = async () => {
    if (!fs.write || !selected || draft === null) return;
    setSaving(true);
    try {
      const content = eol === "\r\n" ? draft.replace(/\r?\n/g, "\r\n") : draft.replace(/\r\n/g, "\n");
      const saveUrl = fs.write.save;
      await call(() => api.put(saveUrl, { path: selected, content }));
      toast("success", `${selected.split("/").pop()} ${isNew ? "created" : "saved"}`);
      setPreview({ path: selected, size: new Blob([content]).size, truncated: false, binary: false, content });
      setDraft(null);
      setIsNew(false);
      load(path);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const download = (p: string) => {
    const name = p.split("/").pop() || "download";
    call(() => downloadFromBackend(fs.download(p), name))
      .then(() => toast("success", `Downloading ${name}`))
      .catch((e) => toast("error", (e as Error).message));
  };

  const crumbs = path.split("/").filter(Boolean);

  return (
    <Box ref={container} sx={{ display: "flex", gap: 2, flex: 1, minHeight: 0 }}>
      <Paper variant="outlined" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
          <Tooltip title="Up one level">
            <span>
              <IconButton disabled={path === "/"} onClick={() => load(parent(path))} aria-label="Up one level">
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {typedPath !== null ? (
            <TextField
              size="small"
              autoFocus
              value={typedPath}
              onChange={(e) => setTypedPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && typedPath.trim().startsWith("/")) {
                  load(typedPath.trim());
                  setTypedPath(null);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setTypedPath(null);
                }
              }}
              onBlur={() => setTypedPath(null)}
              placeholder="/path/to/folder"
              inputProps={{ "aria-label": "Folder to go to", style: { fontFamily: MONO, fontSize: 13 } }}
              sx={{ flex: 1 }}
            />
          ) : (
            <Breadcrumbs sx={{ flex: 1, fontFamily: MONO, fontSize: 13 }} maxItems={8}>
              <Link component="button" underline="hover" onClick={() => load("/")} aria-label="Root folder" sx={{ display: "flex", alignItems: "center" }}>
                <FolderIcon sx={{ fontSize: 16 }} />
              </Link>
              {crumbs.map((c, i) => (
                <Link
                  key={i}
                  component="button"
                  underline="hover"
                  color={i === crumbs.length - 1 ? "text.primary" : "primary"}
                  onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
                  sx={{ fontFamily: MONO, fontSize: 13 }}
                >
                  {c}
                </Link>
              ))}
            </Breadcrumbs>
          )}
          {goTo && typedPath === null && (
            <Tooltip title="Go to a folder by its path">
              <IconButton onClick={() => setTypedPath(path)} aria-label="Go to a folder">
                <EditLocationAltOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {(loading || finding) && <CircularProgress size={16} />}
          {fs.search && (
            <TextField
              size="small"
              value={find}
              onChange={(e) => {
                setFind(e.target.value);
                setFound(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") searchBelow();
                else if (e.key === "Escape" && find) {
                  e.stopPropagation();
                  setFind("");
                  setFound(null);
                }
              }}
              placeholder="Find by name"
              InputProps={{
                startAdornment: <SearchIcon sx={{ fontSize: 16, mr: 0.5, color: "text.secondary" }} />,
                endAdornment: find ? (
                  <IconButton
                    size="small"
                    edge="end"
                    aria-label="Clear the search"
                    onClick={() => {
                      setFind("");
                      setFound(null);
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                ) : undefined,
              }}
              inputProps={{ "aria-label": "Find files by name", style: { fontSize: 13, paddingTop: 5, paddingBottom: 5 } }}
              sx={{ width: 190 }}
            />
          )}
          {toolbar}
          {fs.write && (
            <>
              <Tooltip title="Upload files here (or drop them on the list)">
                <IconButton onClick={() => fileInput.current?.click()} disabled={!!uploading} aria-label="Upload files">
                  <UploadFileOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void uploadFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <Tooltip title="New file">
                <IconButton onClick={() => setNaming("file")} aria-label="New file">
                  <NoteAddOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="New folder">
                <IconButton onClick={() => setNaming("folder")} aria-label="New folder">
                  <CreateNewFolderOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
          <Tooltip title="Copy path">
            <IconButton onClick={() => void copyText(path).then(() => toast("success", "Path copied"))} aria-label="Copy path">
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton onClick={() => load(path)} aria-label="Refresh">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        {uploading && (
          <Box sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
            <Typography variant="body2" color="text.secondary" noWrap>
              Uploading {uploading.name}
              {uploading.total > 1 ? ` (${uploading.index}/${uploading.total})` : ""}… {Math.round(uploading.pct)}%
            </Typography>
            <LinearProgress variant="determinate" value={uploading.pct} sx={{ mt: 0.5 }} />
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ m: 1 }}>
            {error}
          </Alert>
        )}
        <Box
          sx={{ overflow: "auto", flex: 1, position: "relative" }}
          onDragOver={(e) => {
            if (!fs.write || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
          }}
          onDrop={onDrop}
        >
          {dragOver && (
            <Stack
              alignItems="center"
              justifyContent="center"
              sx={{ position: "absolute", inset: 4, zIndex: 3, border: 2, borderStyle: "dashed", borderColor: "primary.main", borderRadius: 1, bgcolor: "action.selected", pointerEvents: "none" }}
            >
              <UploadFileOutlinedIcon color="primary" sx={{ fontSize: 36 }} />
              <Typography color="primary" sx={{ fontWeight: 600 }}>
                Drop to upload to {path}
              </Typography>
            </Stack>
          )}
          {entries === null && !error ? (
            <Stack alignItems="center" sx={{ py: 6 }} spacing={1}>
              <CircularProgress size={24} />
              <Typography color="text.secondary">Reading files…</Typography>
            </Stack>
          ) : entries && entries.length === 0 && !found ? (
            <Typography color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
              {path === "/" && emptyHint ? emptyHint : "This folder is empty."}
            </Typography>
          ) : rows && rows.length === 0 ? (
            <Stack alignItems="center" spacing={1} sx={{ p: 3 }}>
              <Typography color="text.secondary">
                {found ? `Nothing below ${found.path} has "${found.query}" in its name.` : `Nothing in this folder has "${find.trim()}" in its name.`}
                {found?.timedOut ? " The search was stopped after 20 seconds, so it didn't get everywhere: try a subfolder." : ""}
                {found?.skipped ? " Folders you can't read were skipped." : ""}
              </Typography>
              {!found && fs.search && find.trim().length >= 2 && (
                <Button size="small" onClick={searchBelow} disabled={finding}>
                  Search the subfolders too
                </Button>
              )}
            </Stack>
          ) : (
            <>
            {(found || needle) && (
              <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "action.hover" }}>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {found ? (
                    <>
                      {found.entries.length}
                      {found.truncated ? "+" : ""} below {found.path} with "{found.query}" in the name
                      {found.truncated && !found.timedOut ? ` (the first ${found.entries.length})` : ""}
                      {found.timedOut ? ". Stopped after 20 seconds: try a subfolder for the rest" : ""}
                      {found.skipped ? ". Folders you can't read were skipped" : ""}
                    </>
                  ) : (
                    <>
                      {rows?.length} of {entries?.length} in this folder
                    </>
                  )}
                </Typography>
                {!found && fs.search && find.trim().length >= 2 && (
                  <Button size="small" onClick={searchBelow} disabled={finding} sx={{ minHeight: 0, py: 0 }}>
                    Search the subfolders too (Enter)
                  </Button>
                )}
              </Stack>
            )}
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 32, pr: 0 }} />
                  <TableCell>Name</TableCell>
                  <TableCell align="right" sx={{ width: 100 }}>
                    Size
                  </TableCell>
                  <TableCell sx={{ width: 140 }}>Modified</TableCell>
                  <TableCell sx={{ width: 110 }}>Mode</TableCell>
                  <TableCell sx={{ width: fs.write ? 84 : 48 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows?.map((e) => {
                  const p = rowPath(e);
                  // A search result is shown with where it is, below the folder searched.
                  const label = found ? (found.path === "/" ? p.slice(1) : p.slice(found.path.length + 1)) : e.name;
                  return (
                    <TableRow key={p} hover selected={selected === p} onClick={() => void open(e)} sx={{ cursor: e.type === "other" ? "default" : "pointer" }}>
                      <TableCell sx={{ pr: 0 }}>
                        <EntryIcon e={e} />
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, wordBreak: "break-all" }}>
                        {label}
                        {e.type === "dir" || e.linkToDir ? "/" : ""}
                      </TableCell>
                      <TableCell align="right">{e.type === "file" ? formatBytes(e.size) : ""}</TableCell>
                      <TableCell>
                        <Tooltip title={e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ""}>
                          <span>{e.mtime ? relativeTime(e.mtime * 1000) : "—"}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: 12 }} onClick={fs.write && (e.type === "file" || e.type === "dir") ? (ev) => ev.stopPropagation() : undefined}>
                        {fs.write && (e.type === "file" || e.type === "dir") ? (
                          <Tooltip disableInteractive title={`${e.owner} · click to change permissions`}>
                            <Link
                              component="button"
                              underline="hover"
                              color="inherit"
                              onClick={() => setPermissions({ path: p, mode: e.mode, owner: e.owner, isDir: e.type === "dir" })}
                              aria-label={`Permissions of ${e.name}`}
                              sx={{ fontFamily: MONO, fontSize: 12 }}
                            >
                              {e.mode}
                            </Link>
                          </Tooltip>
                        ) : (
                          <Tooltip title={e.owner}>
                            <span>{e.mode}</span>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell sx={{ py: 0, whiteSpace: "nowrap" }} onClick={(ev) => ev.stopPropagation()}>
                        {e.type === "file" && (
                          <Tooltip title="Download">
                            <IconButton onClick={() => download(p)} aria-label={`Download ${e.name}`}>
                              <FileDownloadOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        {fs.write && !found && (
                          <Tooltip title={e.type === "dir" ? "Delete folder" : "Delete"}>
                            <IconButton onClick={() => void remove(e)} aria-label={`Delete ${e.name}`}>
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </>
          )}
        </Box>
      </Paper>

      {selected && maximized && <Box onClick={() => setMaximized(false)} sx={{ position: "fixed", inset: 0, zIndex: 1249, bgcolor: "rgba(0,0,0,0.5)" }} />}
      {selected && (
        <Paper
          variant="outlined"
          sx={
            maximized
              ? { position: "fixed", inset: 16, zIndex: 1250, display: "flex", flexDirection: "column", minHeight: 0, boxShadow: 24 }
              : { width: panelWidth ?? "45%", maxWidth: "75%", minWidth: 320, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }
          }
        >
          {!maximized && (
            <Box
              onMouseDown={startPanelResize}
              onDoubleClick={() => setPanelWidth(null)}
              title="Drag to resize · double-click to reset"
              sx={{ position: "absolute", left: -12, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 1, "&:hover": { bgcolor: "action.hover" }, borderRadius: 1 }}
            />
          )}
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
            {/* Buttons keep their places when switching to edit mode (Edit -> Save, Download -> Cancel), so
                nothing new appears under the cursor: a tooltip opened that way stuck on screen. */}
            <Stack direction="row" alignItems="center" spacing={1} sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontFamily: MONO, fontSize: 13, minWidth: 0 }} noWrap title={selected}>
                {selected.split("/").pop()}
                {dirty ? " •" : ""}
              </Typography>
              {preview && !preview.binary && (
                <Tooltip disableInteractive title="Syntax highlighting. Click to choose a language">
                  <Button
                    size="small"
                    color="inherit"
                    onClick={(e) => setLanguageMenu(e.currentTarget)}
                    sx={{ minWidth: 0, px: 0.75, flexShrink: 0, fontSize: 12, color: "text.secondary", whiteSpace: "nowrap" }}
                    aria-label="Language"
                  >
                    {languageLabel(language)}
                  </Button>
                </Tooltip>
              )}
              {draft !== null ? (
                <Tooltip
                  disableInteractive
                  title={
                    original.mixed && !isNew
                      ? `This file mixes Windows (CRLF) and Unix (LF) line endings; saving writes all lines as ${eol === "\r\n" ? "CRLF" : "LF"}. Click to switch.`
                      : `Line endings: ${eol === "\r\n" ? "Windows (CRLF)" : "Unix (LF)"}. Click to switch.`
                  }
                >
                  <Button
                    size="small"
                    color={original.mixed && !isNew ? "warning" : "inherit"}
                    onClick={() => setEol((e) => (e === "\n" ? "\r\n" : "\n"))}
                    sx={{ minWidth: 0, px: 0.75, flexShrink: 0, fontFamily: MONO, fontSize: 12, color: original.mixed && !isNew ? undefined : "text.secondary" }}
                    aria-label="Line endings"
                  >
                    {eol === "\r\n" ? "CRLF" : "LF"}
                    {original.mixed && !isNew ? " (mixed)" : ""}
                  </Button>
                </Tooltip>
              ) : (
                preview?.size != null && (
                  <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {formatBytes(preview.size)}
                  </Typography>
                )
              )}
            </Stack>
            {draft !== null ? (
              <>
                <Button
                  size="small"
                  sx={{ minWidth: isNew ? 104 : 62 }}
                  onClick={() =>
                    void leaveEditor().then((ok) => {
                      if (!ok) return;
                      setDraft(null);
                      if (isNew) {
                        setIsNew(false);
                        setSelected(null);
                      }
                    })
                  }
                >
                  Cancel
                </Button>
                {!isNew && (
                  // Cancel is narrower for it, so Cancel + this take Download's room and Save stays put.
                  <Tooltip disableInteractive title={reviewing ? "Back to editing" : "Review changes: compare with the file as loaded"}>
                    <span>
                      <IconButton
                        onClick={() => setReviewing(!reviewing)}
                        disabled={!reviewing && !dirty}
                        color={reviewing ? "primary" : "default"}
                        aria-label="Review changes"
                        aria-pressed={reviewing}
                      >
                        <DifferenceOutlinedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                <Button
                  size="small"
                  variant="contained"
                  sx={{ minWidth: 80 }}
                  startIcon={saving ? <CircularProgress size={14} /> : <SaveOutlinedIcon />}
                  disabled={saving || !dirty}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </>
            ) : (
              <>
                <Button size="small" sx={{ minWidth: 104 }} startIcon={<FileDownloadOutlinedIcon />} onClick={() => download(selected)}>
                  Download
                </Button>
                {fs.write && preview && !preview.binary && (
                  <Tooltip disableInteractive title={preview.truncated ? "Files over 1 MB can't be edited here" : ""}>
                    <span>
                      <Button size="small" sx={{ minWidth: 80 }} startIcon={<EditOutlinedIcon />} disabled={preview.truncated} onClick={startEditing}>
                        Edit
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </>
            )}
            <Tooltip disableInteractive title={maximized ? "Restore size (Esc)" : "Maximize"}>
              <IconButton onClick={() => setMaximized(!maximized)} aria-label={maximized ? "Restore size" : "Maximize"}>
                {maximized ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            {preview && !preview.binary && (
              <Tooltip disableInteractive title={wrap ? "Long lines wrap. Click to scroll sideways instead" : "Long lines scroll sideways. Click to wrap them"}>
                <IconButton onClick={() => setWrap(!wrap)} color={wrap ? "primary" : "default"} aria-label="Wrap lines" aria-pressed={wrap}>
                  <WrapTextIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <IconButton onClick={() => void closePreview()} aria-label="Close preview">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {previewLoading && (
              <Stack alignItems="center" sx={{ py: 4 }}>
                <CircularProgress size={22} />
              </Stack>
            )}
            {previewError && (
              <Alert severity="error" sx={{ m: 1 }}>
                {previewError}
              </Alert>
            )}
            {preview?.binary && (
              <Typography color="text.secondary" sx={{ p: 2 }}>
                Binary file: no preview. Use Download to save it.
              </Typography>
            )}
            {preview?.truncated && (
              <Alert severity="info" sx={{ m: 1, py: 0 }}>
                Showing the first 1 MB only.
              </Alert>
            )}
            {reviewing && draft !== null && (eol !== original.eol || original.mixed) && (
              <Alert severity="info" sx={{ m: 1, py: 0 }}>
                {original.mixed
                  ? `Line endings: all lines will be written as ${eol === "\r\n" ? "CRLF" : "LF"} (the file mixes both).`
                  : `Line endings change from ${original.eol === "\r\n" ? "CRLF" : "LF"} to ${eol === "\r\n" ? "CRLF" : "LF"}.`}
              </Alert>
            )}
            {preview && !preview.binary && (
              // One editor for viewing and editing: clicking Edit only unlocks it, so the view stays put.
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <Suspense fallback={<CircularProgress size={22} sx={{ m: 2 }} />}>
                  <CodeEditor
                    path={selected}
                    language={language}
                    value={draft ?? shown}
                    readOnly={draft === null}
                    original={reviewing && draft !== null && !isNew ? shown : null}
                    check={!preview.truncated}
                    wrap={wrap}
                    onChange={draft !== null ? setDraft : undefined}
                    onSave={() => {
                      if (dirty && !saving) void save();
                    }}
                  />
                </Suspense>
              </Box>
            )}
          </Box>
        </Paper>
      )}
      <Menu anchorEl={languageMenu} open={!!languageMenu} onClose={() => setLanguageMenu(null)} slotProps={{ paper: { sx: { maxHeight: 360 } } }}>
        {LANGUAGES.map((l) => (
          <MenuItem
            key={l.id}
            dense
            selected={l.id === language}
            onClick={() => {
              setLanguageMenu(null);
              if (selected) setLanguageChoice(l.id === detected ? null : { path: selected, id: l.id });
            }}
          >
            {l.label}
            {l.id === detected && (
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                (detected)
              </Typography>
            )}
          </MenuItem>
        ))}
      </Menu>
      <PermissionsDialog target={permissions} onClose={(c) => void applyPermissions(c)} />
      <NameDialog title={naming === "folder" ? "New folder" : naming === "file" ? "New file" : null} dir={path} onClose={(n) => void create(n)} />
    </Box>
  );
}
