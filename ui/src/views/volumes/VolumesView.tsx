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
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import FilterListIcon from "@mui/icons-material/FilterList";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { useColumnLayout } from "../../components/table/useColumnLayout";
import { usePersistentState } from "../../hooks/usePersistentState";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, PageHeader, SearchField } from "../../components/common";
import { RANCHER_WARNING, useFeedback } from "../../components/Feedback";
import { copyText, formatBytes, relativeTime } from "../../utils/format";
import type { Volume } from "./types";

type Filter = "all" | "used" | "unused";

// Rancher's own extension plumbing (like Docker Desktop, extension resources are hidden).
const isExtensionVolume = (v: Volume) => (v.project ?? "").startsWith("rd-extension-");
type SortKey = "name" | "created" | "size";

export function useVolumeActions(reload: () => void) {
  const { toast, confirm } = useFeedback();
  const remove = async (names: string[]) => {
    if (!names.length) return false;
    const ok = await confirm({
      title: names.length === 1 ? "Delete volume?" : `Delete ${names.length} volumes?`,
      message: names.length === 1 ? `"${names[0]}" and all data stored in it will be permanently deleted.` : "The selected volumes and all their data will be permanently deleted.",
      // Compose prefixes a volume's name with its project, so the name identifies extension volumes.
      warning: names.some((n) => n.startsWith("rd-extension-")) ? RANCHER_WARNING.extension : undefined,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!ok) return false;
    const results = await Promise.allSettled(names.map((n) => api.del(`/volumes/${encodeURIComponent(n)}`)));
    const failed = results.map((r, i) => (r.status === "rejected" ? `${names[i]}: ${(r.reason as Error).message}` : null)).filter(Boolean);
    const done = names.length - failed.length;
    if (done) toast("success", done === 1 ? `Volume ${names.length === 1 ? names[0] : ""} deleted`.replace("  ", " ") : `${done} volumes deleted`);
    if (failed.length) toast("error", failed.join("; "));
    reload();
    return done > 0;
  };
  return { remove };
}

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { toast } = useFeedback();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name === "" || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
  const submit = async () => {
    setBusy(true);
    try {
      const v = await api.post<{ Name: string }>("/volumes", { name });
      toast("success", `Volume ${v.Name.slice(0, 32)} created`);
      setName("");
      onCreated();
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New volume</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Volume name"
          placeholder="Leave empty for a random name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && void submit()}
          error={!valid}
          helperText={valid ? " " : "Use letters, digits, '_', '.', '-' (must start with a letter or digit)"}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!valid || busy}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RowMenu({ v, onDelete }: { v: Volume; onDelete: () => void }) {
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
      <IconButton aria-label={`More actions for ${v.name}`} onClick={(e) => (e.stopPropagation(), setAnchor(e.currentTarget))}>
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
        {item("View stored data", <FolderOpenOutlinedIcon fontSize="small" />, () => navigate("volumes", v.name, "data"))}
        {item("View details", <InfoOutlinedIcon fontSize="small" />, () => navigate("volumes", v.name, "containers"))}
        {item("Copy name", <ContentCopyIcon fontSize="small" />, () => void copyText(v.name).then(() => toast("success", "Name copied")))}
        {item("Delete", <DeleteOutlineIcon fontSize="small" />, onDelete, { disabled: v.inUse, danger: true })}
      </Menu>
    </>
  );
}

export function VolumesView() {
  const { data, error, reload } = useResource<Volume[]>("/volumes", ["volume", "container"]);
  const sizes = useResource<Record<string, number>>("/volumes/sizes", ["volume"], 1500);
  const { toast, confirm } = useFeedback();
  const { remove } = useVolumeActions(() => {
    void reload();
    void sizes.reload();
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = usePersistentState<Filter>("volumes.filter", "all");
  const [showExtension, setShowExtension] = usePersistentState("volumes.showExtension", false);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: "asc" | "desc" }>("volumes.sort", { key: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const layout = useColumnLayout("volumes", [
    { pos: 2, label: "Name" },
    { pos: 3, label: "In use", autoHide: 3 },
    { pos: 4, label: "Created", autoHide: 1 },
    { pos: 5, label: "Size", autoHide: 2 },
    { pos: 6, label: "Actions", resizable: false },
  ]);


  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (data ?? []).filter(
      (v) =>
        (showExtension || !isExtensionVolume(v)) &&
        (filter === "all" || (filter === "used") === v.inUse) &&
        (!q || v.name.toLowerCase().includes(q) || (v.project ?? "").toLowerCase().includes(q)),
    );
    const sign = sort.dir === "asc" ? 1 : -1;
    const size = (v: Volume) => sizes.data?.[v.name] ?? -1;
    out.sort(
      (a, b) =>
        sign *
        (sort.key === "name" ? a.name.localeCompare(b.name) : sort.key === "created" ? (a.createdAt ?? "").localeCompare(b.createdAt ?? "") : size(a) - size(b)),
    );
    return out;
  }, [data, search, filter, sort, sizes.data, showExtension]);

  useEffect(() => {
    const names = new Set(list.map((v) => v.name));
    setSelected((s) => {
      const n = new Set([...s].filter((x) => names.has(x)));
      return n.size === s.size ? s : n;
    });
  }, [list]);

  // Extension volumes (an extension's saved data) are only pruned when they are shown.
  const unused = (data ?? []).filter((v) => !v.inUse && (showExtension || !isExtensionVolume(v)));
  const hiddenExtension = (data ?? []).filter(isExtensionVolume).length;
  const prune = async () => {
    const ok = await confirm({
      title: "Prune unused volumes?",
      message: `${unused.length} volume${unused.length === 1 ? "" : "s"} not used by any container (named and anonymous) will be permanently deleted with all their data.`,
      warning: unused.some(isExtensionVolume) ? RANCHER_WARNING.extension.replace("This belongs", "Extension volumes are shown, so this includes volumes that belong") : undefined,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<{ deleted: string[]; spaceReclaimed: number }>(`/volumes/prune?all=true&extension=${showExtension}`);
      toast("success", `${r.deleted.length} volume${r.deleted.length === 1 ? "" : "s"} deleted, ${formatBytes(r.spaceReclaimed)} reclaimed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
    void sizes.reload();
  };

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const allSelected = list.length > 0 && list.every((v) => selected.has(v.name));
  const selectedInUse = [...selected].filter((n) => data?.find((v) => v.name === n)?.inUse);

  return (
    <>
      <PageHeader
        title="Volumes"
        subtitle="Persistent storage for your containers. Browse stored data, see which containers use a volume, and clean up."
        actions={
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" startIcon={<DeleteSweepOutlinedIcon />} onClick={() => void prune()} disabled={unused.length === 0}>
              Prune
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              Create
            </Button>
          </Stack>
        }
      />
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1.5, minHeight: 40 }}>
        <SearchField value={search} onChange={setSearch} />
        <Select size="small" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} sx={{ minWidth: 130 }}>
          <MenuItem value="all">All volumes</MenuItem>
          <MenuItem value="used">In use</MenuItem>
          <MenuItem value="unused">Unused</MenuItem>
        </Select>
        <Tooltip title="Filters">
          <IconButton onClick={(e) => setFilterAnchor(e.currentTarget)} color={showExtension ? "primary" : "default"}>
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
          <MenuItem onClick={() => setShowExtension(!showExtension)}>
            <Checkbox size="small" checked={showExtension} sx={{ p: 0, mr: 1 }} />
            Show extension volumes
          </MenuItem>
        </Menu>
        {layout.columnsButton}
        <Box sx={{ flex: 1 }} />
        {selected.size > 0 && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography color="text.secondary">{selected.size} selected</Typography>
            <Tooltip title={selectedInUse.length ? "Volumes in use by a container can't be deleted" : ""}>
              <span>
                <Button
                  variant="contained"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  disabled={selectedInUse.length > 0}
                  onClick={() => void remove([...selected]).then(() => setSelected(new Set()))}
                >
                  Delete
                </Button>
              </span>
            </Tooltip>
          </Stack>
        )}
      </Stack>

      {error && !data ? (
        <EmptyState title="Couldn't load volumes">
          <Typography>{error}</Typography>
        </EmptyState>
      ) : data === null ? (
        <Stack alignItems="center" sx={{ py: 8 }}>
          <CircularProgress size={26} />
        </Stack>
      ) : data.length === 0 ? (
        <EmptyState icon={<StorageOutlinedIcon sx={{ fontSize: 48 }} />} title="No volumes yet">
          <Typography>Volumes appear here when containers create them, or create one with the Create button.</Typography>
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
                    onChange={(e) => setSelected(e.target.checked ? new Set(list.map((v) => v.name)) : new Set())}
                    inputProps={{ "aria-label": "Select all" }}
                  />
                </TableCell>
                <TableCell>
                  <TableSortLabel active={sort.key === "name"} direction={sort.dir} onClick={() => toggleSort("name")}>
                    Name
                  </TableSortLabel>
                  {layout.resizeHandle(2)}
                </TableCell>
                <TableCell sx={{ width: 140 }}>
                  In use
                  {layout.resizeHandle(3)}
                </TableCell>
                <TableCell sx={{ width: 150 }}>
                  <TableSortLabel active={sort.key === "created"} direction={sort.dir} onClick={() => toggleSort("created")}>
                    Created
                  </TableSortLabel>
                  {layout.resizeHandle(4)}
                </TableCell>
                <TableCell align="right" sx={{ width: 110 }}>
                  <TableSortLabel active={sort.key === "size"} direction={sort.dir} onClick={() => toggleSort("size")}>
                    Size
                  </TableSortLabel>
                  {layout.resizeHandle(5)}
                </TableCell>
                <TableCell align="right" sx={{ width: 100 }}>
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
                    No volumes match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {list.map((v) => {
                const size = sizes.data?.[v.name];
                return (
                  <TableRow key={v.name} hover selected={selected.has(v.name)} onClick={() => navigate("volumes", v.name)} sx={{ cursor: "pointer" }}>
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="small"
                        checked={selected.has(v.name)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(v.name);
                            else n.delete(v.name);
                            return n;
                          })
                        }
                        inputProps={{ "aria-label": `Select ${v.name}` }}
                      />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 420 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <StorageOutlinedIcon fontSize="small" sx={{ color: v.inUse ? "success.main" : "text.disabled" }} />
                        <Box sx={{ minWidth: 0 }}>
                          <Link href={href("volumes", v.name)} underline="hover" onClick={(e) => e.stopPropagation()} noWrap sx={{ display: "block", fontWeight: 500 }}>
                            {v.anonymous ? v.name.slice(0, 16) + "…" : v.name}
                          </Link>
                          {(v.project || v.anonymous) && (
                            <Typography variant="body2" color="text.secondary" noWrap>
                              {v.project ? `Compose project ${v.project}` : "Anonymous volume"}
                            </Typography>
                          )}
                        </Box>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {v.inUse ? (
                        <Tooltip title={v.containers.map((c) => c.name).join(", ")}>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "success.main" }} />
                            <span>
                              In use{v.containers.length > 1 ? ` (${v.containers.length})` : ""}
                            </span>
                          </Stack>
                        </Tooltip>
                      ) : (
                        <Typography variant="body1" color="text.secondary">
                          Unused
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip title={v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}>
                        <span>{relativeTime(v.createdAt)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right">
                      {size === undefined ? sizes.error ? "—" : <CircularProgress size={14} /> : size < 0 ? "N/A" : formatBytes(size)}
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()} sx={{ py: 0, whiteSpace: "nowrap" }}>
                      <RowMenu v={v} onDelete={() => void remove([v.name])} />
                      <Tooltip title={v.inUse ? "In use by a container" : "Delete"}>
                        <span>
                          <IconButton disabled={v.inUse} onClick={() => void remove([v.name])} aria-label={`Delete ${v.name}`}>
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {!showExtension && hiddenExtension > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {hiddenExtension} extension volume{hiddenExtension === 1 ? "" : "s"} hidden · change in Filters
        </Typography>
      )}
      <CreateDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />
    </>
  );
}
