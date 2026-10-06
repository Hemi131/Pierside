import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
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
import LanOutlinedIcon from "@mui/icons-material/LanOutlined";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { useColumnLayout } from "../../components/table/useColumnLayout";
import { usePersistentState } from "../../hooks/usePersistentState";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, PageHeader, SearchField } from "../../components/common";
import { RANCHER_WARNING, useFeedback } from "../../components/Feedback";
import { MONO } from "../../theme";
import { relativeTime } from "../../utils/format";
import type { Network } from "./types";

type Filter = "all" | "used" | "unused";
type SortKey = "name" | "driver" | "created";

// Rancher's own extension plumbing, hidden like elsewhere.
const isExtensionNetwork = (n: Network) => (n.project ?? "").startsWith("rd-extension-") || n.name.startsWith("rd-extension-");
/** Why Docker won't delete this network, or null if it can be deleted. */
export function whyNotDeletable(n: Network): string | null {
  if (n.builtin) return "Built-in network: Docker creates it and it can't be deleted";
  if (n.containers.length) {
    const names = n.containers.map((c) => c.name);
    return `Has ${names.length} container${names.length === 1 ? "" : "s"} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}): disconnect ${names.length === 1 ? "it" : "them"} first`;
  }
  return null;
}
const deletable = (n: Network) => whyNotDeletable(n) === null;

export function useNetworkActions(reload: () => void) {
  const { toast, confirm } = useFeedback();
  const remove = async (nets: Network[]) => {
    if (!nets.length) return false;
    const ok = await confirm({
      title: nets.length === 1 ? "Delete network?" : `Delete ${nets.length} networks?`,
      message: nets.length === 1 ? `Network "${nets[0].name}" will be removed.` : "The selected networks will be removed.",
      warning: nets.some(isExtensionNetwork) ? RANCHER_WARNING.extension : undefined,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return false;
    const results = await Promise.allSettled(nets.map((n) => api.del(`/networks/${n.id}`)));
    const failed = results.map((r, i) => (r.status === "rejected" ? `${nets[i].name}: ${(r.reason as Error).message}` : null)).filter(Boolean);
    const done = nets.length - failed.length;
    if (done) toast("success", done === 1 && nets.length === 1 ? `Network ${nets[0].name} deleted` : `${done} networks deleted`);
    if (failed.length) toast("error", failed.join("; "));
    reload();
    return done > 0;
  };
  return { remove };
}

const EMPTY = { name: "", driver: "bridge", subnet: "", gateway: "", internal: false, attachable: false, ipv6: false };

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { toast } = useFeedback();
  const [f, setF] = useState(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.name);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/networks", f);
      toast("success", `Network ${f.name} created`);
      setF(EMPTY);
      onCreated();
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const flag = (k: "internal" | "attachable" | "ipv6", label: string) => (
    <FormControlLabel control={<Checkbox size="small" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />} label={label} />
  );
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New network</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label="Name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && validName && void submit()}
            error={f.name !== "" && !validName}
            helperText={f.name !== "" && !validName ? "Use letters, digits, '_', '.', '-'" : " "}
          />
          <TextField select label="Driver" value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })}>
            <MenuItem value="bridge">bridge</MenuItem>
            <MenuItem value="overlay">overlay (swarm)</MenuItem>
            <MenuItem value="macvlan">macvlan</MenuItem>
            <MenuItem value="ipvlan">ipvlan</MenuItem>
          </TextField>
          <Box>
            <Button size="small" onClick={() => setAdvanced((a) => !a)}>
              {advanced ? "Hide" : "Show"} advanced settings
            </Button>
            <Collapse in={advanced}>
              <Stack spacing={2} sx={{ mt: 1.5 }}>
                <TextField label="Subnet" placeholder="172.30.0.0/16 (automatic if empty)" value={f.subnet} onChange={(e) => setF({ ...f, subnet: e.target.value })} />
                <TextField label="Gateway" placeholder="172.30.0.1" value={f.gateway} disabled={!f.subnet} onChange={(e) => setF({ ...f, gateway: e.target.value })} />
                <Stack>
                  {flag("internal", "Internal (no outside access)")}
                  {flag("attachable", "Attachable (standalone containers can join an overlay)")}
                  {flag("ipv6", "Enable IPv6")}
                </Stack>
              </Stack>
            </Collapse>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!validName || busy}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function NetworksView() {
  const { data, error, reload } = useResource<Network[]>("/networks", ["network", "container"]);
  const { toast, confirm } = useFeedback();
  const { remove } = useNetworkActions(() => void reload());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = usePersistentState<Filter>("networks.filter", "all");
  const [showExtension, setShowExtension] = usePersistentState("networks.showExtension", false);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: "asc" | "desc" }>("networks.sort", { key: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const layout = useColumnLayout("networks", [
    { pos: 2, label: "Name" },
    { pos: 3, label: "Driver", autoHide: 2 },
    { pos: 4, label: "Subnet", autoHide: 3 },
    { pos: 5, label: "Containers", autoHide: 4 },
    { pos: 6, label: "Created", autoHide: 1 },
    { pos: 7, label: "Actions", resizable: false },
  ]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (data ?? []).filter(
      (n) =>
        (showExtension || !isExtensionNetwork(n)) &&
        (filter === "all" || (filter === "used") === n.containers.length > 0) &&
        (!q || n.name.toLowerCase().includes(q) || n.driver.includes(q) || n.subnets.some((s) => s.includes(q)) || n.containers.some((c) => c.name.toLowerCase().includes(q))),
    );
    const sign = sort.dir === "asc" ? 1 : -1;
    out.sort((a, b) => sign * (sort.key === "name" ? a.name.localeCompare(b.name) : sort.key === "driver" ? a.driver.localeCompare(b.driver) : a.created.localeCompare(b.created)));
    return out;
  }, [data, search, filter, sort, showExtension]);

  useEffect(() => {
    const ids = new Set(list.map((n) => n.id));
    setSelected((s) => {
      const n = new Set([...s].filter((x) => ids.has(x)));
      return n.size === s.size ? s : n;
    });
  }, [list]);

  const unused = (data ?? []).filter((n) => deletable(n) && !isExtensionNetwork(n));
  const hiddenExtension = (data ?? []).filter(isExtensionNetwork).length;
  const prune = async () => {
    const ok = await confirm({
      title: "Prune unused networks?",
      message: `${unused.length} network${unused.length === 1 ? "" : "s"} without containers will be removed. Built-in networks are kept.`,
      warning: (data ?? []).some((n) => deletable(n) && isExtensionNetwork(n)) ? "This also removes unused networks of Rancher Desktop extensions that aren't running." : undefined,
      confirmLabel: "Prune",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<{ deleted: string[] }>("/networks/prune");
      toast("success", `${r.deleted.length} network${r.deleted.length === 1 ? "" : "s"} removed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "created" ? "desc" : "asc" }));
  const selectable = list.filter(deletable);
  const allSelected = selectable.length > 0 && selectable.every((n) => selected.has(n.id));

  return (
    <>
      <PageHeader
        title="Networks"
        subtitle="How your containers talk to each other. See which containers are on each network, and connect or disconnect them."
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
        <Select size="small" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} sx={{ minWidth: 150 }}>
          <MenuItem value="all">All networks</MenuItem>
          <MenuItem value="used">With containers</MenuItem>
          <MenuItem value="unused">Without containers</MenuItem>
        </Select>
        <Tooltip title="Filters">
          <IconButton onClick={(e) => setFilterAnchor(e.currentTarget)} color={showExtension ? "primary" : "default"}>
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
          <MenuItem onClick={() => setShowExtension(!showExtension)}>
            <Checkbox size="small" checked={showExtension} sx={{ p: 0, mr: 1 }} />
            Show extension networks
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
              onClick={() => void remove((data ?? []).filter((n) => selected.has(n.id))).then(() => setSelected(new Set()))}
            >
              Delete
            </Button>
          </Stack>
        )}
      </Stack>

      {error && !data ? (
        <EmptyState title="Couldn't load networks">
          <Typography>{error}</Typography>
        </EmptyState>
      ) : data === null ? (
        <Stack alignItems="center" sx={{ py: 8 }}>
          <CircularProgress size={26} />
        </Stack>
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
                    disabled={selectable.length === 0}
                    onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((n) => n.id)) : new Set())}
                    inputProps={{ "aria-label": "Select all" }}
                  />
                </TableCell>
                <TableCell sx={{ width: 300 }}>
                  <TableSortLabel active={sort.key === "name"} direction={sort.dir} onClick={() => toggleSort("name")}>
                    Name
                  </TableSortLabel>
                  {layout.resizeHandle(2)}
                </TableCell>
                <TableCell sx={{ width: 110 }}>
                  <TableSortLabel active={sort.key === "driver"} direction={sort.dir} onClick={() => toggleSort("driver")}>
                    Driver
                  </TableSortLabel>
                  {layout.resizeHandle(3)}
                </TableCell>
                <TableCell sx={{ width: 170 }}>
                  Subnet
                  {layout.resizeHandle(4)}
                </TableCell>
                {/* The flexible column: the member list is the long part, the name is not. */}
                <TableCell sx={{ minWidth: 180 }}>
                  Containers
                  {layout.resizeHandle(5)}
                </TableCell>
                <TableCell sx={{ width: 130 }}>
                  <TableSortLabel active={sort.key === "created"} direction={sort.dir} onClick={() => toggleSort("created")}>
                    Created
                  </TableSortLabel>
                  {layout.resizeHandle(6)}
                </TableCell>
                <TableCell align="right" sx={{ width: 70 }}>
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
                    No networks match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {list.map((n) => (
                <TableRow key={n.id} hover selected={selected.has(n.id)} onClick={() => navigate("networks", n.id)} sx={{ cursor: "pointer" }}>
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    <Tooltip title={whyNotDeletable(n) ?? ""} placement="right">
                      <span>
                        <Checkbox
                          size="small"
                          disabled={!deletable(n)}
                          checked={selected.has(n.id)}
                          onChange={(e) =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(n.id);
                              else next.delete(n.id);
                              return next;
                            })
                          }
                          inputProps={{ "aria-label": `Select ${n.name}` }}
                        />
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <LanOutlinedIcon fontSize="small" sx={{ color: n.containers.some((c) => c.state === "running") ? "success.main" : "text.disabled" }} />
                      <Box sx={{ minWidth: 0 }}>
                        <Link href={href("networks", n.id)} underline="hover" onClick={(e) => e.stopPropagation()} noWrap sx={{ display: "block", fontWeight: 500 }}>
                          {n.name}
                        </Link>
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {n.builtin ? "Built-in" : n.project ? `Compose project ${n.project}` : n.id.slice(0, 12)}
                          {n.internal ? " · internal" : ""}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell>{n.driver}</TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{n.subnets.join(", ") || "—"}</TableCell>
                  <TableCell sx={{ maxWidth: 0 }}>
                    {n.containers.length === 0 ? (
                      <Typography variant="body1" color="text.secondary">
                        None
                      </Typography>
                    ) : (
                      <Tooltip title={n.containers.map((c) => c.name).join(", ")}>
                        <Typography variant="body1" noWrap>
                          {n.containers.length} · {n.containers.map((c) => c.name).join(", ")}
                        </Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={new Date(n.created).toLocaleString()}>
                      <span>{relativeTime(n.created)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" onClick={(e) => e.stopPropagation()} sx={{ py: 0, whiteSpace: "nowrap" }}>
                    <Tooltip title={whyNotDeletable(n) ?? "Delete"}>
                      <span>
                        <IconButton disabled={!deletable(n)} onClick={() => void remove([n])} aria-label={`Delete ${n.name}`}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {!showExtension && hiddenExtension > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {hiddenExtension} extension network{hiddenExtension === 1 ? "" : "s"} hidden · change in Filters
        </Typography>
      )}
      <CreateDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />
    </>
  );
}
