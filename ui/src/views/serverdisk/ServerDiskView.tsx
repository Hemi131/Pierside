/**
 * Where the disk space on the active SSH engine's server went (backend services/hostdisk.py).
 * The filesystems come at once; below them one folder at a time is opened, and the size of each of
 * its subfolders is asked for separately, so the list fills in as the answers arrive and nothing is
 * measured that the user didn't open. Read-only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FolderIcon from "@mui/icons-material/Folder";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LinkIcon from "@mui/icons-material/Link";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import { api } from "../../api/ddclient";
import type { FsEntry } from "../../components/FileBrowser";
import { PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { useEngine } from "../../hooks/useEngine";
import { navigate } from "../../hooks/useRoute";
import { MONO } from "../../theme";
import { formatBytes } from "../../utils/format";

interface Filesystem {
  device: string;
  type: string;
  mount: string;
  size: number;
  used: number;
  free: number;
  percent: number;
}

interface Overview {
  engine: string;
  user: string;
  filesystems: Filesystem[];
  useDocker: boolean | null;
  dockerProblem: string | null;
}

interface Size {
  path: string;
  bytes: number | null;
  /** Not all of it could be read (or the time limit was reached), so the figure is too low. */
  partial: boolean;
  timedOut: boolean;
  via: "ssh" | "docker";
  needsConsent: boolean;
  seconds?: number;
}

/** A place where disk space usually goes on a server (backend hostdisk.usual_places). */
interface Place {
  path: string;
  label: string;
  hint: string;
}

/** A folder's size: measured, on its way ("pending"), or failed. */
type Measured = Size | "pending" | { error: string };

const PARALLEL = 2;
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");
const isSize = (m: Measured | undefined): m is Size => !!m && m !== "pending" && !("error" in m);
const fullness = (percent: number) => (percent >= 90 ? "error" : percent >= 75 ? "warning" : "primary");

export function ServerDiskView({ path }: { path?: string }) {
  const { engine } = useEngine();
  const { toast } = useFeedback();
  const meta = engine?.engine;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Sizes are kept while the page is open, so going back up doesn't measure again.
  const [sizes, setSizes] = useState<Record<string, Measured>>({});
  const known = useRef(sizes);
  known.current = sizes;
  // Each visit of a folder is a "run"; answers of an older run are still kept, but it starts nothing new.
  const run = useRef(0);
  const [busy, setBusy] = useState(false);
  const [places, setPlaces] = useState<Place[]>([]);

  const loadOverview = useCallback(() => {
    setError(null);
    api
      .get<Overview>("/hostdisk")
      .then(setOverview)
      .catch((e) => setError((e as Error).message));
    api
      .get<Place[]>("/hostdisk/places")
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, []);

  useEffect(() => {
    setOverview(null);
    setSizes({});
    if (meta?.type === "ssh") loadOverview();
  }, [meta?.id, meta?.type, loadOverview]);

  const measure = useCallback(async (paths: string[]) => {
    const mine = ++run.current;
    const todo = paths.filter((p) => !isSize(known.current[p]));
    if (!todo.length) return;
    setBusy(true);
    setSizes((s) => ({ ...s, ...Object.fromEntries(todo.map((p) => [p, "pending" as const])) }));
    let next = 0;
    const worker = async () => {
      while (next < todo.length && run.current === mine) {
        const p = todo[next++];
        const result: Measured = await api.get<Size>(`/hostdisk/size?path=${encodeURIComponent(p)}`).catch((e) => ({ error: (e as Error).message }));
        setSizes((s) => ({ ...s, [p]: result }));
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (run.current === mine) setBusy(false);
  }, []);

  const stop = useCallback(() => {
    run.current++;
    setBusy(false);
    setSizes((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== "pending")));
    void api.post("/hostdisk/cancel").catch(() => undefined);
  }, []);

  // Open a folder: list it (through the Server files routes), then measure its subfolders.
  useEffect(() => {
    setEntries(null);
    setListError(null);
    if (!path || meta?.type !== "ssh") return;
    let gone = false;
    api
      .get<{ entries: FsEntry[] }>(`/hostfs/files?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (gone) return;
        setEntries(r.entries);
        void measure(r.entries.filter((e) => e.type === "dir").map((e) => join(path, e.name)));
      })
      .catch((e) => !gone && setListError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [path, meta?.id, meta?.type, measure]);

  // Leaving the page stops what is still being measured.
  useEffect(() => () => void api.post("/hostdisk/cancel").catch(() => undefined), []);

  const go = (p: string | null) => {
    if (busy) stop();
    if (p) navigate("server-disk", p);
    else navigate("server-disk");
  };

  // The same answer as on the Server files page, kept per server.
  const setUseDocker = async (allow: boolean) => {
    try {
      await api.put("/hostfs/consent", { allow });
      setOverview((o) => (o ? { ...o, useDocker: allow } : o));
      // Measure again what the answer changes: what was only partly readable, or what came through Docker.
      const again = Object.entries(known.current).filter(([, v]) => isSize(v) && (allow ? v.partial && !v.timedOut : v.via === "docker")).map(([p]) => p);
      setSizes((s) => Object.fromEntries(Object.entries(s).filter(([p]) => !again.includes(p))));
      known.current = Object.fromEntries(Object.entries(known.current).filter(([p]) => !again.includes(p)));
      if (path) void measure((entries ?? []).filter((e) => e.type === "dir").map((e) => join(path, e.name)));
      else void measure(again);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const refresh = () => {
    loadOverview();
    if (!path) {
      // On the overview: measure the usual places again, if they were measured.
      const measured = places.map((x) => x.path).filter((x) => known.current[x]);
      known.current = Object.fromEntries(Object.entries(known.current).filter(([x]) => !measured.includes(x)));
      setSizes(known.current);
      if (measured.length) void measure(measured);
      return;
    }
    if (!entries) return;
    const here = entries.filter((e) => e.type === "dir").map((e) => join(path, e.name));
    known.current = Object.fromEntries(Object.entries(known.current).filter(([p]) => !here.includes(p)));
    setSizes(known.current);
    void measure(here);
  };

  if (meta?.type !== "ssh") {
    return (
      <>
        <PageHeader title="Server disk" />
        <Alert severity="info">Server disk is for SSH engines. Switch to one with the engine menu at the top left.</Alert>
      </>
    );
  }

  const rows = (entries ?? [])
    .map((e) => {
      const p = join(path ?? "/", e.name);
      const m = e.type === "dir" ? sizes[p] : undefined;
      const bytes = e.type === "dir" ? (isSize(m) ? m.bytes : null) : e.type === "file" ? e.size : null;
      return { e, p, m, bytes };
    })
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.e.name.localeCompare(b.e.name));
  const largest = Math.max(1, ...rows.map((r) => r.bytes ?? 0));
  const total = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const pending = rows.filter((r) => r.m === "pending").length;
  const here = rows.map((r) => r.m).filter(isSize);
  const placeRows = places
    .map((x, i) => ({ ...x, i, m: sizes[x.path] }))
    .sort((a, b) => (isSize(b.m) ? (b.m.bytes ?? -1) : -2) - (isSize(a.m) ? (a.m.bytes ?? -1) : -2) || a.i - b.i);
  const placesMeasured = placeRows.some((r) => r.m);
  const largestPlace = Math.max(1, ...placeRows.map((r) => (isSize(r.m) ? (r.m.bytes ?? 0) : 0)));
  const shownSizes = path ? here : placeRows.map((r) => r.m).filter(isSize);
  const needsConsent = overview?.useDocker == null && !overview?.dockerProblem && shownSizes.some((m) => m.needsConsent);
  const consentBanner = needsConsent && overview && (
    <Alert
      severity="info"
      sx={{ borderRadius: 0 }}
      action={
        <Button color="inherit" size="small" onClick={() => void setUseDocker(true)}>
          Use Docker on this server
        </Button>
      }
    >
      Your SSH user ({overview.user}) can't read everything here, so some sizes are too low. Because your account may use Docker on this server, Pierside can measure those folders through a
      read-only helper container, as root.
    </Alert>
  );
  const status = (m: Measured | undefined) => (
    <>
      {m && m !== "pending" && "error" in m && (
        <Tooltip title={m.error}>
          <Chip size="small" color="error" variant="outlined" label="Couldn't measure" />
        </Tooltip>
      )}
      {isSize(m) && m.timedOut && (
        <Tooltip title="Measuring was stopped after two minutes. Open the folder to measure its parts one by one.">
          <Chip size="small" color="warning" variant="outlined" label={m.bytes == null ? "Too big to measure at once" : "Stopped early"} />
        </Tooltip>
      )}
      {isSize(m) && m.partial && !m.timedOut && (
        <Tooltip title={`Your SSH user (${overview?.user}) can't read all of it, so the real size is larger.${overview?.dockerProblem ? " " + overview.dockerProblem + "." : ""}`}>
          <Chip size="small" color="warning" variant="outlined" label="Partly unreadable" />
        </Tooltip>
      )}
      {isSize(m) && m.via === "docker" && !m.partial && (
        <Tooltip title={`Measured through a read-only helper container, as root, because your SSH user (${overview?.user}) can't read all of it.`}>
          <Chip size="small" variant="outlined" icon={<ViewInArOutlinedIcon />} label="Through Docker" />
        </Tooltip>
      )}
    </>
  );
  const crumbs = (path ?? "").split("/").filter(Boolean);
  const mountHere = overview?.filesystems.find((f) => f.mount === path);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title="Server disk"
        subtitle={
          <>
            Where the space on <Box component="span" sx={{ fontFamily: MONO }}>{meta.target}</Box> went. Nothing is changed here.
          </>
        }
        actions={
          <Stack direction="row" alignItems="center" spacing={1}>
            {overview && (
              <Tooltip title={overview.dockerProblem ?? "Measure folders your SSH user can't read through a read-only helper container on the server (as root). Your account can do this because it may use Docker there. The same setting as on the Server files page."}>
                <span>
                  <FormControlLabel
                    control={<Switch size="small" checked={overview.useDocker === true} disabled={!!overview.dockerProblem} onChange={(e) => void setUseDocker(e.target.checked)} />}
                    label="Use Docker where I have no permission"
                  />
                </span>
              </Tooltip>
            )}
            <Tooltip title="Read the filesystems again, and measure this folder again">
              <Button variant="outlined" size="small" startIcon={<RefreshIcon fontSize="small" />} onClick={refresh}>
                Refresh
              </Button>
            </Tooltip>
          </Stack>
        }
      />
      {error && <Alert severity="error">{error}</Alert>}
      {!overview && !error && <CircularProgress size={24} />}

      {overview && (
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5} sx={{ mb: 2 }}>
          {overview.filesystems.map((f) => (
            <Paper
              key={f.device + f.mount}
              variant="outlined"
              onClick={() => go(f.mount)}
              role="button"
              aria-label={`Open ${f.mount}`}
              sx={{ p: 1.5, minWidth: 250, flex: "1 1 250px", maxWidth: 420, cursor: "pointer", borderColor: path === f.mount ? "primary.main" : undefined, "&:hover": { borderColor: "primary.main" } }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <StorageOutlinedIcon fontSize="small" color="action" />
                <Typography sx={{ fontFamily: MONO, fontWeight: 600, flex: 1, wordBreak: "break-all" }}>{f.mount}</Typography>
                <Typography variant="body2" color={`${fullness(f.percent)}.main`} sx={{ fontWeight: 600 }}>
                  {f.percent}%
                </Typography>
              </Stack>
              <LinearProgress variant="determinate" value={Math.min(100, f.percent)} color={fullness(f.percent)} sx={{ my: 1, height: 8, borderRadius: 4 }} />
              <Typography variant="body2" color="text.secondary">
                {formatBytes(f.free)} free of {formatBytes(f.size)} · <span style={{ fontFamily: MONO }}>{f.device}</span>
                {f.type ? ` (${f.type})` : ""}
              </Typography>
            </Paper>
          ))}
          {overview.filesystems.length === 0 && <Typography color="text.secondary">No filesystems were reported.</Typography>}
        </Stack>
      )}

      {overview && !path && (
        <>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Choose a filesystem above to go through its folders, or start with the places where space usually goes. Docker's own data (images, volumes, build cache) is broken down, with
            clean-up, on the{" "}
            <Link component="button" underline="hover" onClick={() => navigate("disk")} sx={{ verticalAlign: "baseline" }}>
              Disk usage
            </Link>{" "}
            page.
          </Typography>
          {placeRows.length > 0 && (
            <Paper variant="outlined" sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 160, overflow: "hidden" }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider" }}>
                <Typography sx={{ fontWeight: 600, flex: 1 }}>The usual places</Typography>
                {busy ? (
                  <Button size="small" startIcon={<StopIcon fontSize="small" />} onClick={stop}>
                    Stop
                  </Button>
                ) : (
                  <Tooltip describeChild title="Measures each of these folders, one after another, at low priority. Docker's data can take a while on a busy server.">
                    <Button size="small" variant={placesMeasured ? "text" : "contained"} onClick={() => void measure(places.map((x) => x.path))}>
                      {placesMeasured ? "Measure the rest" : "Measure these"}
                    </Button>
                  </Tooltip>
                )}
              </Stack>
              {busy && <LinearProgress sx={{ height: 2 }} />}
              {consentBanner}
              <Box sx={{ flex: 1, overflow: "auto" }}>
              <Table size="small">
                <TableBody>
                  {placeRows.map((r) => {
                    const bytes = isSize(r.m) ? r.m.bytes : null;
                    return (
                      <TableRow key={r.path} hover onClick={() => go(r.path)} sx={{ cursor: "pointer" }}>
                        <TableCell sx={{ width: "34%" }}>
                          <Typography sx={{ fontWeight: 500 }}>{r.label}</Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>
                            {r.path}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {bytes != null && bytes > 0 && (
                            <Box sx={{ height: 8, borderRadius: 4, bgcolor: "action.hover", overflow: "hidden", mb: r.hint ? 0.5 : 0 }}>
                              <Box sx={{ height: "100%", width: `${Math.max(1, (bytes / largestPlace) * 100)}%`, bgcolor: "primary.main", borderRadius: 4 }} />
                            </Box>
                          )}
                          {r.hint && (
                            <Typography variant="body2" color="text.secondary">
                              {r.hint}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ width: 110, whiteSpace: "nowrap" }}>
                          {r.m === "pending" ? <CircularProgress size={14} /> : bytes != null ? formatBytes(bytes) : r.m ? "—" : ""}
                        </TableCell>
                        <TableCell sx={{ width: 190, py: 0 }}>{status(r.m)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </Box>
            </Paper>
          )}
        </>
      )}

      {overview && path && (
        <Paper variant="outlined" sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 240, overflow: "hidden" }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
            <Tooltip title={path === "/" ? "Back to the overview" : "Up one level"}>
              <IconButton onClick={() => go(path === "/" ? null : parent(path))} aria-label={path === "/" ? "Back to the overview" : "Up one level"}>
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Breadcrumbs sx={{ flex: 1, fontFamily: MONO, fontSize: 13 }} maxItems={9}>
              <Link component="button" underline="hover" onClick={() => go(null)} sx={{ fontSize: 13 }}>
                Overview
              </Link>
              <Link component="button" underline="hover" onClick={() => go("/")} aria-label="Root folder" sx={{ display: "flex", alignItems: "center" }}>
                <FolderIcon sx={{ fontSize: 16 }} />
              </Link>
              {crumbs.map((c, i) => (
                <Link key={i} component="button" underline="hover" color={i === crumbs.length - 1 ? "text.primary" : "primary"} onClick={() => go("/" + crumbs.slice(0, i + 1).join("/"))} sx={{ fontFamily: MONO, fontSize: 13 }}>
                  {c}
                </Link>
              ))}
            </Breadcrumbs>
            {entries && (
              <Typography variant="body2" color="text.secondary">
                {pending ? `Measuring, ${pending} to go · ` : ""}
                {formatBytes(total)}
                {pending || here.some((m) => m.partial) ? " so far" : ""}
                {mountHere ? ` of ${formatBytes(mountHere.used)} used` : ""}
              </Typography>
            )}
            {busy && (
              <Tooltip title="Stop measuring">
                <IconButton onClick={stop} aria-label="Stop measuring">
                  <StopIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Open this folder in Server files">
              <IconButton onClick={() => navigate("server-files", path)} aria-label="Open in Server files">
                <FolderOpenOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          {busy && <LinearProgress sx={{ height: 2 }} />}
          {consentBanner}
          {listError && (
            <Alert severity="error" sx={{ borderRadius: 0 }}>
              {listError}
            </Alert>
          )}
          <Box sx={{ flex: 1, overflow: "auto" }}>
            {entries === null && !listError ? (
              <Stack alignItems="center" sx={{ py: 6 }} spacing={1}>
                <CircularProgress size={24} />
                <Typography color="text.secondary">Reading the folder…</Typography>
              </Stack>
            ) : entries && entries.length === 0 ? (
              <Typography color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
                This folder is empty.
              </Typography>
            ) : (
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 32, pr: 0 }} />
                    <TableCell sx={{ width: "32%" }}>Name</TableCell>
                    <TableCell />
                    <TableCell align="right" sx={{ width: 110 }}>
                      Size
                    </TableCell>
                    <TableCell align="right" sx={{ width: 70 }}>
                      Share
                    </TableCell>
                    <TableCell sx={{ width: 190 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map(({ e, p, m, bytes }) => {
                    const dir = e.type === "dir";
                    return (
                      <TableRow key={p} hover={dir} onClick={dir ? () => go(p) : undefined} sx={{ cursor: dir ? "pointer" : "default" }}>
                        <TableCell sx={{ pr: 0 }}>
                          {dir ? <FolderIcon sx={{ fontSize: 18, color: "primary.main" }} /> : e.type === "link" ? <LinkIcon sx={{ fontSize: 18 }} color="action" /> : <InsertDriveFileOutlinedIcon sx={{ fontSize: 18 }} color="action" />}
                        </TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, wordBreak: "break-all" }}>
                          {e.name}
                          {dir ? "/" : ""}
                        </TableCell>
                        <TableCell>
                          {bytes != null && bytes > 0 && (
                            <Box sx={{ height: 8, borderRadius: 4, bgcolor: "action.hover", overflow: "hidden" }}>
                              <Box sx={{ height: "100%", width: `${Math.max(1, (bytes / largest) * 100)}%`, bgcolor: dir ? "primary.main" : "text.disabled", borderRadius: 4 }} />
                            </Box>
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                          {m === "pending" ? <CircularProgress size={14} /> : bytes != null ? formatBytes(bytes) : e.type === "link" ? "link" : "—"}
                        </TableCell>
                        <TableCell align="right" sx={{ color: "text.secondary" }}>
                          {bytes != null && total > 0 ? `${((bytes / total) * 100).toFixed(bytes / total < 0.1 ? 1 : 0)}%` : ""}
                        </TableCell>
                        <TableCell sx={{ py: 0 }}>
                          {status(m)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Box>
        </Paper>
      )}
    </Box>
  );
}
