import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SyncIcon from "@mui/icons-material/Sync";
import FilterListIcon from "@mui/icons-material/FilterList";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { useColumnLayout } from "../../components/table/useColumnLayout";
import { usePersistentState } from "../../hooks/usePersistentState";
import { href, navigate } from "../../hooks/useRoute";
import { CopyableId, EmptyState, PageHeader, SearchField } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { copyText, formatBytes, relativeTime } from "../../utils/format";
import { PullDialog } from "./PullDialog";
import { RunDialog } from "./RunDialog";
import { CopyToEngineDialog } from "./CopyToEngineDialog";
import MoveUpOutlinedIcon from "@mui/icons-material/MoveUpOutlined";
import type { ImageRow } from "./types";

type Filter = "all" | "used" | "unused";
type SortKey = "name" | "created" | "size";

export function useImageActions(reload: () => void) {
  const { toast, confirm } = useFeedback();
  const remove = async (rows: ImageRow[]) => {
    if (!rows.length) return false;
    const label = (r: ImageRow) => (r.dangling ? r.id.slice(7, 19) : r.ref);
    const ok = await confirm({
      title: rows.length === 1 ? "Delete image?" : `Delete ${rows.length} images?`,
      message:
        rows.length === 1
          ? `"${label(rows[0])}" will be removed. If the image has other tags, only this tag is removed.`
          : "The selected images (or tags) will be removed.",
      warning: rows.some((r) => r.isSystem) ? "This image belongs to Rancher Desktop or to one of its extensions. Deleting it can break Rancher Desktop, its Kubernetes cluster or that extension." : undefined,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return false;
    // Sequential: untagging several tags of the same image in parallel races.
    let done = 0;
    const failed: string[] = [];
    for (const r of rows) {
      try {
        await api.del(`/images/${encodeURIComponent(r.ref)}`);
        done++;
      } catch (e) {
        failed.push(`${label(r)}: ${(e as Error).message}`);
      }
    }
    if (done) toast("success", done === 1 && rows.length === 1 ? `Deleted ${label(rows[0])}` : `${done} images deleted`);
    if (failed.length) toast("error", failed.join("; "));
    reload();
    return done > 0;
  };
  return { remove };
}

function PruneDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [mode, setMode] = useState<"dangling" | "unused">("dangling");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ deleted: string[]; spaceReclaimed: number; failed?: string[]; kept?: string[] }>(`/images/prune?mode=${mode}`);
      // "unused" goes image by image (keeping Rancher's, Kubernetes' and extensions' images); "dangling" is the engine's prune.
      const what = mode === "unused" ? "image" : "image layer";
      const kept = r.kept?.length ? ` (${r.kept.length} of Rancher Desktop, Kubernetes or extensions kept)` : "";
      toast("success", `${r.deleted.length} ${what}${r.deleted.length === 1 ? "" : "s"} removed, ${mode === "unused" ? "at most " : ""}${formatBytes(r.spaceReclaimed)} reclaimed${kept}`);
      if (r.failed?.length) toast("warning", `Not deleted: ${r.failed.slice(0, 3).join("; ")}${r.failed.length > 3 ? ` and ${r.failed.length - 3} more` : ""}`);
      onDone();
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Clean up images</DialogTitle>
      <DialogContent>
        <RadioGroup value={mode} onChange={(e) => setMode(e.target.value as "dangling" | "unused")}>
          <FormControlLabel value="dangling" control={<Radio size="small" />} label="Dangling images only (untagged)" />
          <FormControlLabel value="unused" control={<Radio size="small" />} label="All images not used by any container" />
        </RadioGroup>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" color="error" onClick={() => void run()} disabled={busy}>
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RowMenu({ r, onDelete, onPull, onCopy }: { r: ImageRow; onDelete: () => void; onPull: () => void; onCopy: () => void }) {
  const { toast } = useFeedback();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const item = (label: string, icon: JSX.Element, fn: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <MenuItem
      disabled={opts.disabled}
      onClick={() => {
        setAnchor(null);
        fn();
      }}
      sx={opts.danger ? { color: "error.main" } : undefined}
    >
      <ListItemIcon sx={opts.danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  );
  return (
    <>
      <IconButton aria-label={`More actions for ${r.ref}`} onClick={(e) => (e.stopPropagation(), setAnchor(e.currentTarget))}>
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
        {item("View details", <InfoOutlinedIcon fontSize="small" />, () => navigate("images", r.ref))}
        {item("Pull latest", <SyncIcon fontSize="small" />, onPull, { disabled: r.dangling })}
        {item("Copy name", <ContentCopyIcon fontSize="small" />, () => void copyText(r.ref).then(() => toast("success", "Copied")), { disabled: r.dangling })}
        {item("Copy image ID", <ContentCopyIcon fontSize="small" />, () => void copyText(r.id).then(() => toast("success", "Copied")))}
        {item("Copy to another engine…", <MoveUpOutlinedIcon fontSize="small" />, onCopy)}
        {item("Delete", <DeleteOutlineIcon fontSize="small" />, onDelete, { danger: true })}
      </Menu>
    </>
  );
}

export function ImagesView() {
  const { data, error, reload } = useResource<ImageRow[]>("/images", ["image", "container"]);
  const { remove } = useImageActions(() => void reload());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = usePersistentState<Filter>("images.filter", "all");
  const [showSystem, setShowSystem] = usePersistentState("images.showSystem", false);
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: "asc" | "desc" }>("images.sort", { key: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pull, setPull] = useState<{ open: boolean; ref: string }>({ open: false, ref: "" });
  const [runImage, setRunImage] = useState<string | null>(null);
  const [copyImage, setCopyImage] = useState<string | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const layout = useColumnLayout("images", [
    { pos: 2, label: "Name" },
    { pos: 3, label: "Tag", autoHide: 5 },
    { pos: 4, label: "Image ID", autoHide: 2 },
    { pos: 5, label: "Created", autoHide: 1 },
    { pos: 6, label: "Size", autoHide: 3 },
    { pos: 7, label: "Status", autoHide: 4 },
    { pos: 8, label: "Actions", resizable: false },
  ]);


  const visibleAll = useMemo(() => (data ?? []).filter((r) => showSystem || !r.isSystem), [data, showSystem]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = visibleAll.filter(
      (r) => (filter === "all" || (filter === "used") === r.inUse) && (!q || r.ref.toLowerCase().includes(q) || r.id.slice(7).startsWith(q)),
    );
    const sign = sort.dir === "asc" ? 1 : -1;
    out.sort((a, b) => sign * (sort.key === "name" ? a.ref.localeCompare(b.ref) : sort.key === "created" ? a.created - b.created : a.size - b.size));
    return out;
  }, [visibleAll, search, filter, sort]);

  useEffect(() => {
    const refs = new Set(list.map((r) => r.ref));
    setSelected((s) => {
      const n = new Set([...s].filter((x) => refs.has(x)));
      return n.size === s.size ? s : n;
    });
  }, [list]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const allSelected = list.length > 0 && list.every((r) => selected.has(r.ref));
  // Unique images (a multi-tagged image counts once).
  const unique = new Map(visibleAll.map((r) => [r.id, r]));
  const totalSize = [...unique.values()].reduce((s, r) => s + r.size, 0);
  const usedSize = [...unique.values()].filter((r) => r.inUse).reduce((s, r) => s + r.size, 0);
  const hiddenSystem = (data ?? []).filter((r) => r.isSystem).length;

  return (
    <>
      <PageHeader
        title="Images"
        subtitle={
          data
            ? `${unique.size} image${unique.size === 1 ? "" : "s"} · ${formatBytes(totalSize)} total · ${formatBytes(usedSize)} in use`
            : "Local images on this engine."
        }
        actions={
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" startIcon={<DeleteSweepOutlinedIcon />} onClick={() => setPruneOpen(true)}>
              Clean up
            </Button>
            <Button variant="contained" startIcon={<CloudDownloadOutlinedIcon />} onClick={() => setPull({ open: true, ref: "" })}>
              Pull
            </Button>
          </Stack>
        }
      />
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1.5, minHeight: 40 }}>
        <SearchField value={search} onChange={setSearch} />
        <Select size="small" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} sx={{ minWidth: 130 }}>
          <MenuItem value="all">All images</MenuItem>
          <MenuItem value="used">In use</MenuItem>
          <MenuItem value="unused">Unused</MenuItem>
        </Select>
        <Tooltip title="Filters">
          <IconButton onClick={(e) => setFilterAnchor(e.currentTarget)} color={showSystem ? "primary" : "default"}>
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
          <MenuItem onClick={() => setShowSystem(!showSystem)}>
            <Checkbox size="small" checked={showSystem} sx={{ p: 0, mr: 1 }} />
            Show system images (Rancher, Kubernetes, extensions)
          </MenuItem>
        </Menu>
        {layout.columnsButton}
        <Box sx={{ flex: 1 }} />
        {selected.size > 0 && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography color="text.secondary">{selected.size} selected</Typography>
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => void remove(list.filter((r) => selected.has(r.ref))).then(() => setSelected(new Set()))}
            >
              Delete
            </Button>
          </Stack>
        )}
      </Stack>

      {error && !data ? (
        <EmptyState title="Couldn't load images">
          <Typography>{error}</Typography>
        </EmptyState>
      ) : data === null ? (
        <Stack alignItems="center" sx={{ py: 8 }}>
          <CircularProgress size={26} />
        </Stack>
      ) : visibleAll.length === 0 ? (
        <EmptyState icon={<LayersOutlinedIcon sx={{ fontSize: 48 }} />} title="No images yet">
          <Typography>Pull an image to get started.</Typography>
        </EmptyState>
      ) : (
        <TableContainer ref={layout.containerRef} component={Paper} variant="outlined" sx={{ flex: "0 1 auto", minHeight: 0 }}>
          <Table ref={layout.tableRef} size="small" stickyHeader sx={layout.tableSx}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allSelected}
                    indeterminate={selected.size > 0 && !allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(list.map((r) => r.ref)) : new Set())}
                    inputProps={{ "aria-label": "Select all" }}
                  />
                </TableCell>
                <TableCell>
                  <TableSortLabel active={sort.key === "name"} direction={sort.dir} onClick={() => toggleSort("name")}>
                    Name
                  </TableSortLabel>
                  {layout.resizeHandle(2)}
                </TableCell>
                <TableCell sx={{ width: 150 }}>
                  Tag
                  {layout.resizeHandle(3)}
                </TableCell>
                <TableCell sx={{ width: 130 }}>
                  Image ID
                  {layout.resizeHandle(4)}
                </TableCell>
                <TableCell sx={{ width: 130 }}>
                  <TableSortLabel active={sort.key === "created"} direction={sort.dir} onClick={() => toggleSort("created")}>
                    Created
                  </TableSortLabel>
                  {layout.resizeHandle(5)}
                </TableCell>
                <TableCell align="right" sx={{ width: 100 }}>
                  <TableSortLabel active={sort.key === "size"} direction={sort.dir} onClick={() => toggleSort("size")}>
                    Size
                  </TableSortLabel>
                  {layout.resizeHandle(6)}
                </TableCell>
                <TableCell sx={{ width: 110 }}>
                  Status
                  {layout.resizeHandle(7)}
                </TableCell>
                <TableCell align="right" sx={{ width: 130 }}>
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
                    No images match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {list.map((r) => (
                <TableRow key={r.ref} hover selected={selected.has(r.ref)} onClick={() => navigate("images", r.ref)} sx={{ cursor: "pointer" }}>
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      size="small"
                      checked={selected.has(r.ref)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.ref);
                          else n.delete(r.ref);
                          return n;
                        })
                      }
                      inputProps={{ "aria-label": `Select ${r.ref}` }}
                    />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 380 }}>
                    <Link href={href("images", r.ref)} underline="hover" onClick={(e) => e.stopPropagation()} noWrap sx={{ display: "block", fontWeight: 500 }}>
                      {r.repo}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 150 }}>
                    <Typography noWrap variant="body1" color={r.dangling ? "text.secondary" : "text.primary"}>
                      {r.tag}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <CopyableId id={r.id} />
                  </TableCell>
                  <TableCell>
                    <Tooltip title={new Date(r.created * 1000).toLocaleString()}>
                      <span>{relativeTime(r.created)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right">{formatBytes(r.size)}</TableCell>
                  <TableCell>
                    {r.inUse ? (
                      <Tooltip title={`Used by ${r.containers} container${r.containers === 1 ? "" : "s"}`}>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "success.main" }} />
                          <span>In use</span>
                        </Stack>
                      </Tooltip>
                    ) : (
                      <Typography color="text.secondary">Unused</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right" onClick={(e) => e.stopPropagation()} sx={{ py: 0, whiteSpace: "nowrap" }}>
                    <Tooltip title="Run">
                      <IconButton onClick={() => setRunImage(r.dangling ? r.id : r.ref)} aria-label={`Run ${r.ref}`}>
                        <PlayArrowIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <RowMenu r={r} onDelete={() => void remove([r])} onPull={() => setPull({ open: true, ref: r.ref })} onCopy={() => setCopyImage(r.dangling ? r.id : r.ref)} />
                    <Tooltip title="Delete">
                      <IconButton onClick={() => void remove([r])} aria-label={`Delete ${r.ref}`}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {!showSystem && hiddenSystem > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {hiddenSystem} system image{hiddenSystem === 1 ? "" : "s"} hidden · change in Filters
        </Typography>
      )}
      <PullDialog open={pull.open} initialRef={pull.ref} onClose={() => setPull({ open: false, ref: "" })} />
      <RunDialog image={runImage} open={!!runImage} onClose={() => setRunImage(null)} />
      <CopyToEngineDialog image={copyImage} open={!!copyImage} onClose={() => setCopyImage(null)} />
      <PruneDialog open={pruneOpen} onClose={() => setPruneOpen(false)} onDone={() => void reload()} />
    </>
  );
}
