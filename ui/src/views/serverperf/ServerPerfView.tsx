/**
 * Server performance: what uses the CPU, memory, disks and network of the active SSH engine's server,
 * like htop, with each process's container (backend services/hostperf.py). Read every 2 s while the
 * page is open; leaving it stops the sampling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import DangerousOutlinedIcon from "@mui/icons-material/DangerousOutlined";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { actOnProcess, HostPerf, leaveHostPerf, loadHostPerf, PerfProcess, setServerAlerts } from "../../api/hostperf";
import { api } from "../../api/ddclient";
import { EmptyState, PageHeader, SearchField } from "../../components/common";
import { TimeChart } from "../../components/charts/TimeChart";
import { useFeedback } from "../../components/Feedback";
import { useEngine } from "../../hooks/useEngine";
import { usePersistentState } from "../../hooks/usePersistentState";
import { navigate } from "../../hooks/useRoute";
import { MONO } from "../../theme";
import { copyText, formatBytes } from "../../utils/format";

const READ_MS = 2000;
const WINDOW_S = 600;
const MAX_ROWS = 200;

const rate = (v: number) => `${formatBytes(v)}/s`;
// Processes the server itself depends on: ending one gets a warning in the confirmation.
const VITAL = /^(sshd|sshd-session|dockerd|containerd|containerd-shim.*|systemd.*|init|journald|udevd|dbus.*|networkd|NetworkManager|kubelet|k3s.*)$/;
const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

type SortKey = "cpu" | "mem" | "io" | "pid" | "name";

function duration(s: number | null): string {
  if (s == null) return "";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function Bar({ value, max }: { value: number; max: number }) {
  const v = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <LinearProgress variant="determinate" value={v} color={v > 90 ? "error" : v > 70 ? "warning" : "primary"} sx={{ height: 6, borderRadius: 3, bgcolor: "action.hover" }} />;
}

function Card({ title, value, children }: { title: string; value: string; children?: React.ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: "1 1 220px", minWidth: 220 }}>
      <Typography variant="body2" color="text.secondary">
        {title}
      </Typography>
      <Typography variant="h4" sx={{ mb: 0.75 }}>
        {value}
      </Typography>
      {children}
    </Paper>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
      {children}
    </Typography>
  );
}

interface Group {
  key: string;
  label: string;
  container: PerfProcess["container"];
  count: number;
  cpu: number;
  mem: number;
  read: number | null;
  write: number | null;
}

export function ServerPerfView() {
  const { engine } = useEngine();
  const meta = engine?.engine;
  const { toast, confirm } = useFeedback();
  const [data, setData] = useState<HostPerf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("cpu");
  const [grouped, setGrouped] = useState(false);
  const [kernel, setKernel] = useState(false);
  // The menu opens where the ⋮ was clicked and stays there, even if the row moves meanwhile.
  const [menu, setMenu] = useState<{ top: number; left: number; p: PerfProcess } | null>(null);
  // While the pointer is on the list (or a row's menu is open), the rows keep their order: values
  // update in place, new rows come after them, and ended processes stay greyed out. Otherwise the list
  // re-sorts every 2 s and the row (and its ⋮) moves away from under the pointer.
  const [held, setHeld] = useState<string[] | null>(null);
  const [holdOnHover, setHoldOnHover] = usePersistentState("serverPerf.holdOrder", true);
  const pointerIn = useRef(false);
  const lastSeen = useRef(new Map<string, PerfProcess>());
  // One read loop: a read asked for while one is on its way (an action, a switch) waits for it and
  // follows it, instead of starting a second loop; a loop of an earlier engine / visit (older
  // generation) ends by itself, and nothing is read after the page was left.
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef<number | null>(null);
  const again = useRef(false);
  // Values the user just switched: kept over answers to reads that started before the switch.
  const overrides = useRef<{ alerts?: boolean; useDocker?: boolean }>({});

  const read = useCallback(() => {
    if (!alive.current) return;
    const my = generation.current;
    if (inFlight.current === my) {
      again.current = true;
      return;
    }
    window.clearTimeout(timer.current);
    inFlight.current = my;
    loadHostPerf()
      .then((d) => {
        if (my !== generation.current) return;
        const o = overrides.current;
        if (o.alerts !== undefined && d.alerts !== o.alerts) d = { ...d, alerts: o.alerts };
        else delete o.alerts;
        if (o.useDocker !== undefined && d.useDocker !== o.useDocker) d = { ...d, useDocker: o.useDocker };
        else delete o.useDocker;
        setData(d);
        setError(null);
      })
      .catch((e) => my === generation.current && setError((e as Error).message))
      .finally(() => {
        if (inFlight.current === my) inFlight.current = null;
        if (!alive.current || my !== generation.current) return;
        if (again.current) {
          again.current = false;
          read();
        } else timer.current = window.setTimeout(read, READ_MS);
      });
  }, []);

  useEffect(() => {
    if (meta?.type !== "ssh") return; // nothing to read on the local engine
    alive.current = true;
    generation.current++;
    again.current = false;
    overrides.current = {};
    // Another server: nothing of the previous one may stay on screen (or be acted on from it).
    setData(null);
    setError(null);
    setHeld(null);
    setMenu(null);
    read();
    return () => {
      alive.current = false;
      generation.current++;
      window.clearTimeout(timer.current);
      void leaveHostPerf().catch(() => undefined); // the root helper isn't needed any more
    };
  }, [read, meta?.id, meta?.type]);

  const shown = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.processes.filter(
      (p) =>
        (kernel || !p.kernel) &&
        (!q || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q || (p.container?.name ?? "").toLowerCase().includes(q) || (p.container?.service ?? "").toLowerCase().includes(q)),
    );
  }, [data, query, kernel]);

  const io = (p: { read: number | null; write: number | null }) => (p.read ?? 0) + (p.write ?? 0);
  const order = (a: { cpu: number; mem: number; read: number | null; write: number | null }, b: typeof a) =>
    sort === "mem" ? b.mem - a.mem : sort === "io" ? io(b) - io(a) : b.cpu - a.cpu || b.mem - a.mem;

  const rows = useMemo(() => {
    const list = [...shown];
    if (sort === "pid") list.sort((a, b) => a.pid - b.pid);
    else if (sort === "name") list.sort((a, b) => a.cmd.localeCompare(b.cmd));
    else list.sort(order);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, sort]);

  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    for (const p of shown) {
      const key = p.container?.id ?? "host";
      const g = by.get(key) ?? {
        key,
        label: p.container ? (p.container.project && p.container.service ? `${p.container.project} / ${p.container.service}` : p.container.name) : "The server itself (not in a container)",
        container: p.container,
        count: 0,
        cpu: 0,
        mem: 0,
        read: null,
        write: null,
      };
      g.count++;
      g.cpu += p.cpu;
      g.mem += p.mem;
      if (p.read != null) g.read = (g.read ?? 0) + p.read;
      if (p.write != null) g.write = (g.write ?? 0) + p.write;
      by.set(key, g);
    }
    return [...by.values()].sort(sort === "pid" || sort === "name" ? (a, b) => a.label.localeCompare(b.label) : order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, sort]);

  const setUseDocker = async (allow: boolean) => {
    overrides.current.useDocker = allow;
    setData((d) => d && { ...d, useDocker: allow }); // at once; put back if saving fails
    try {
      await api.put("/hostfs/consent", { allow });
      read(); // the next sample is read the new way
    } catch (e) {
      delete overrides.current.useDocker;
      setData((d) => d && { ...d, useDocker: !allow });
      toast("error", (e as Error).message);
    }
  };

  const keyOf = (p: PerfProcess) => `${p.pid}-${p.start}`;
  const alive_ = useMemo(() => new Set((data?.processes ?? []).map(keyOf)), [data]);
  useEffect(() => {
    for (const p of data?.processes ?? []) lastSeen.current.set(keyOf(p), p);
    if (!held) lastSeen.current = new Map((data?.processes ?? []).map((p) => [keyOf(p), p]));
  }, [data, held]);

  /** Rows in the held order (current values; ended processes from their last values), then new ones. */
  const shownRows: (PerfProcess & { ended?: boolean })[] = useMemo(() => {
    if (!held || grouped) return rows.slice(0, MAX_ROWS);
    const current = new Map(rows.map((p) => [keyOf(p), p]));
    const out: (PerfProcess & { ended?: boolean })[] = [];
    for (const k of held) {
      const p = current.get(k);
      if (p) out.push(p);
      else if (!alive_.has(k) && lastSeen.current.has(k)) out.push({ ...lastSeen.current.get(k)!, ended: true });
    }
    const kept = new Set(held);
    for (const p of rows) if (!kept.has(keyOf(p)) && out.length < MAX_ROWS) out.push(p);
    return out;
  }, [rows, held, grouped, alive_]);

  const shownGroups = useMemo(() => {
    if (!held || !grouped) return groups;
    const by = new Map(groups.map((g) => [g.key, g]));
    const kept = new Set(held);
    return [...held.map((k) => by.get(k)).filter((g): g is Group => !!g), ...groups.filter((g) => !kept.has(g.key))];
  }, [groups, held, grouped]);

  // Held while the pointer is on the rows (not the header: a click there sorts) or a row has keyboard focus.
  const body = useRef<HTMLTableSectionElement>(null);
  const hold = () => {
    pointerIn.current = true;
    if (holdOnHover && !held) setHeld(grouped ? groups.map((g) => g.key) : rows.slice(0, MAX_ROWS).map(keyOf));
  };
  const release = () => {
    pointerIn.current = false;
    if (!menu) setHeld(null);
  };
  const closeMenu = () => {
    setMenu(null);
    // The menu's backdrop took the pointer: look where it is now, once the menu is gone.
    requestAnimationFrame(() => {
      const el = body.current;
      pointerIn.current = !!el && (el.matches(":hover") || el.contains(document.activeElement));
      if (!pointerIn.current) setHeld(null);
    });
  };

  const act = async (p: PerfProcess, action: "end" | "kill" | "lower") => {
    closeMenu();
    const engine = data?.engine; // the server the process was seen on (the backend refuses another)
    if (!engine) return;
    const what = p.container ? ` in the container "${p.container.name}"` : "";
    const vital = action !== "lower" && !p.container && VITAL.test(p.name);
    const ok = await confirm({
      title: action === "end" ? "End this process?" : action === "kill" ? "Force this process to end?" : "Lower this process's priority?",
      message: (
        <>
          {/* Name and user come from the process's stat and status, which it can't fake; the command line
              is what it says about itself. */}
          <Box component="span" sx={{ display: "block", mb: 0.5 }}>
            <b>{p.name}</b> (process {p.pid}, user {p.user})
          </Box>
          <Box component="span" sx={{ fontFamily: MONO, fontSize: 12, display: "block", mb: 1, wordBreak: "break-all" }}>
            {p.cmd}
          </Box>
          {action === "end"
            ? `It is asked to stop (SIGTERM)${what}. Some processes ignore that, a container's main process among them; Force end then.`
            : action === "kill"
              ? `It is stopped at once (SIGKILL)${what}, without a chance to save anything.`
              : "It gets less CPU time when the CPU is busy (nice 10); nothing is stopped."}
        </>
      ),
      warning: vital ? `${p.name} is part of the server itself: ending it can cut your SSH connection (and Pierside's), stop Docker with all containers, or take the server down.` : undefined,
      confirmLabel: action === "end" ? "End" : action === "kill" ? "Force end" : "Lower priority",
      destructive: action !== "lower",
    });
    if (!ok) return;
    try {
      await actOnProcess(engine, p, action);
      toast("success", action === "lower" ? `${p.name} (${p.pid}) has a lower priority now` : `${p.name} (${p.pid}) ${action === "kill" ? "was forced to end" : "was asked to end"}`);
      read();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  if (meta?.type !== "ssh") {
    return (
      <>
        <PageHeader title="Server performance" />
        <Alert severity="info">Server performance is for SSH engines. Switch to one with the engine menu at the top left.</Alert>
      </>
    );
  }

  const s = data?.summary;
  const history = data?.history ?? [];
  const times = history.map((h) => h.t);
  const cpu = s?.cpu;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" }}>
      <PageHeader
        title="Server performance"
        subtitle={
          <>
            What uses the CPU, memory, disks and network of <Box component="span" sx={{ fontFamily: MONO }}>{meta.target}</Box>, live.
          </>
        }
        actions={
          data && (
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Tooltip
                title={
                  data.via === "docker"
                    ? "Processes are read as root, through a helper container on the server (you allowed Docker for this server in Server files): disk I/O and the actions work for every process."
                    : `Read as your SSH user (${data.user}): disk I/O shows for your own processes only, and the actions work on them only. Allowing Docker for this server (Server files) shows everything.`
                }
              >
                <Chip size="small" variant="outlined" label={data.via === "docker" ? "All processes (root)" : `As ${data.user}`} />
              </Tooltip>
              <Tooltip
                title={
                  data.dockerProblem ??
                  "Read every process's disk I/O, and end or re-prioritise any process, as root through a short-lived helper container on the server. Your account can do this because it may use Docker there. The same setting as on the Server files and Server disk pages."
                }
              >
                <span>
                  <FormControlLabel
                    control={<Switch size="small" checked={data.useDocker === true} disabled={!!data.dockerProblem} onChange={(e) => void setUseDocker(e.target.checked)} />}
                    label="Use Docker where I have no permission"
                    sx={{ mr: 0 }}
                  />
                </span>
              </Tooltip>
              <Tooltip title="Get an alert when this server's memory is almost full, it swaps, its load stays high or a disk is almost full: checked every 30 seconds, also while you are on another engine or another page.">
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={data.alerts}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setData((d) => d && { ...d, alerts: on }); // at once; put back if saving fails
                        overrides.current.alerts = on;
                        setServerAlerts(data.engine, on)
                          .then(() => toast("success", on ? "You'll be alerted about this server" : "No more alerts about this server"))
                          .catch((err) => {
                            delete overrides.current.alerts;
                            setData((d) => d && { ...d, alerts: !on });
                            toast("error", (err as Error).message);
                          });
                      }}
                    />
                  }
                  label="Alert me about this server"
                  sx={{ mr: 0 }}
                />
              </Tooltip>
            </Stack>
          )
        }
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!data && !error && (
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">Reading the server…</Typography>
        </Stack>
      )}
      {data && s && (
        <>
          {data.hints.map((h) => (
            <Alert key={h.text} severity={h.severity} sx={{ mb: 1 }}>
              {h.text}
            </Alert>
          ))}

          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5} sx={{ mb: 2 }}>
            <Card title={`CPU (${s.cpus} cores)`} value={cpu ? pct(cpu.busy) : "…"}>
              <Bar value={cpu?.busy ?? 0} max={100} />
              {cpu && (
                <Detail>
                  user {pct(cpu.user)} · system {pct(cpu.system)} · I/O wait {pct(cpu.iowait)}
                  {cpu.steal >= 0.5 ? ` · steal ${pct(cpu.steal)}` : ""}
                </Detail>
              )}
              <Detail>
                Load {s.load.map((l) => l.toFixed(2)).join(" · ")} (1 · 5 · 15 min)
              </Detail>
              {s.cores.some(Boolean) && (
                <Tooltip title={s.cores.map((c, i) => `CPU ${i}: ${c ? pct(c.busy) : "…"}`).join("\n")}>
                  <Stack direction="row" spacing={0.25} sx={{ mt: 0.75, height: 18, alignItems: "flex-end" }}>
                    {s.cores.map((c, i) => (
                      <Box key={i} sx={{ flex: 1, height: `${Math.max(6, c?.busy ?? 0)}%`, bgcolor: (c?.busy ?? 0) > 90 ? "error.main" : "primary.main", opacity: 0.75, borderRadius: 0.5 }} />
                    ))}
                  </Stack>
                </Tooltip>
              )}
            </Card>
            <Card title="Memory" value={`${formatBytes(s.mem.used)} / ${formatBytes(s.mem.total)}`}>
              <Bar value={s.mem.used} max={s.mem.total} />
              <Detail>
                {formatBytes(s.mem.available)} available · {formatBytes(s.mem.cached)} cache (given back when needed)
              </Detail>
              <Detail>
                {s.mem.swapTotal ? `Swap ${formatBytes(s.mem.swapUsed)} / ${formatBytes(s.mem.swapTotal)}${s.mem.swapRate > 0 ? `, swapping ${rate(s.mem.swapRate)}` : ""}` : "No swap"}
                {s.psi.memory ? ` · waiting for memory ${pct(s.psi.memory)}` : ""}
              </Detail>
            </Card>
            {/* Totals over the real disks only: LVM / RAID devices sit on them and would count twice. */}
            <Card
              title="Disks"
              value={
                data.warming
                  ? "…"
                  : `R ${rate(s.disks.filter((d) => !d.virtual).reduce((a, d) => a + d.read, 0))}  W ${rate(s.disks.filter((d) => !d.virtual).reduce((a, d) => a + d.write, 0))}`
              }
            >
              {s.disks.slice(0, 3).map((d) => (
                <Detail key={d.name}>
                  {d.name}
                  {d.virtual ? " (LVM / RAID)" : ""}: busy {pct(d.util)} · R {rate(d.read)} · W {rate(d.write)}
                </Detail>
              ))}
              {s.psi.io ? <Detail>waiting for the disk {pct(s.psi.io)}</Detail> : null}
            </Card>
            <Card title="Network" value={data.warming ? "…" : `↓ ${rate(s.net.reduce((a, n) => a + n.rx, 0))}  ↑ ${rate(s.net.reduce((a, n) => a + n.tx, 0))}`}>
              {s.net.slice(0, 3).map((n) => (
                <Detail key={n.name}>
                  {n.name}: ↓ {rate(n.rx)} · ↑ {rate(n.tx)}
                </Detail>
              ))}
              <Detail>
                {s.processes} processes · up {duration(Math.round(s.uptime))}
              </Detail>
            </Card>
          </Stack>

          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 2, mb: 2 }}>
            <TimeChart title="CPU" windowS={WINDOW_S} times={times} format={pct} yMax={100} series={[{ key: "cpu", label: "Busy", values: history.map((h) => h.cpu ?? 0) }]} />
            <TimeChart title="Memory used" windowS={WINDOW_S} times={times} format={(v) => formatBytes(v)} yMax={s.mem.total} series={[{ key: "mem", label: "Used", values: history.map((h) => h.mem) }]} />
            <TimeChart
              title="Disk I/O"
              windowS={WINDOW_S}
              times={times}
              format={rate}
              series={[
                { key: "read", label: "Read", values: history.map((h) => h.read) },
                { key: "write", label: "Write", values: history.map((h) => h.write) },
              ]}
            />
            <TimeChart
              title="Network"
              windowS={WINDOW_S}
              times={times}
              format={rate}
              series={[
                { key: "rx", label: "Received", values: history.map((h) => h.rx) },
                { key: "tx", label: "Sent", values: history.map((h) => h.tx) },
              ]}
            />
          </Box>

          <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1, flexWrap: "wrap", rowGap: 1 }}>
            <Typography variant="h3">Processes</Typography>
            <SearchField value={query} onChange={setQuery} placeholder="Search command, user, container, PID" />
            <FormControlLabel control={<Switch size="small" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />} label="Group by container" />
            <FormControlLabel control={<Switch size="small" checked={kernel} onChange={(e) => setKernel(e.target.checked)} />} label="Kernel threads" />
            <Tooltip title="While the pointer is on the list, its rows stay in place (the figures keep updating), so a row and its ⋮ don't move away under the pointer. Off: the list keeps re-sorting every 2 seconds.">
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={holdOnHover}
                    onChange={(e) => {
                      setHoldOnHover(e.target.checked);
                      if (!e.target.checked) setHeld(null);
                    }}
                  />
                }
                label="Hold order under the pointer"
              />
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            {held && (
              <Typography variant="body2" color="text.secondary">
                Order held while the pointer is on the list
              </Typography>
            )}
            {!data.ioAll && data.ioSeen && (
              <Typography variant="body2" color="text.secondary">
                Disk I/O only for {data.user}'s processes
              </Typography>
            )}
          </Stack>

          <Paper variant="outlined" sx={{ mb: 2 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {grouped ? (
                    <TableCell>
                      <TableSortLabel active={sort === "name"} direction="asc" onClick={() => setSort("name")}>
                        Container
                      </TableSortLabel>
                    </TableCell>
                  ) : (
                    <>
                      <TableCell sx={{ width: 80 }}>
                        <TableSortLabel active={sort === "pid"} direction="asc" onClick={() => setSort("pid")}>
                          PID
                        </TableSortLabel>
                      </TableCell>
                      <TableCell sx={{ width: 100 }}>User</TableCell>
                      <TableCell sx={{ width: 180 }}>Container</TableCell>
                    </>
                  )}
                  <TableCell align="right" sx={{ width: 90 }}>
                    <Tooltip title="Like htop: 100 % is one full core, so a process can show more than 100 % on several cores. The CPU card above is the whole server.">
                      <TableSortLabel active={sort === "cpu"} direction="desc" onClick={() => setSort("cpu")}>
                        CPU
                      </TableSortLabel>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ width: 110 }}>
                    <TableSortLabel active={sort === "mem"} direction="desc" onClick={() => setSort("mem")}>
                      Memory
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right" sx={{ width: 150 }}>
                    <TableSortLabel active={sort === "io"} direction="desc" onClick={() => setSort("io")}>
                      Disk R / W
                    </TableSortLabel>
                  </TableCell>
                  {grouped ? (
                    <TableCell align="right" sx={{ width: 110 }}>
                      Processes
                    </TableCell>
                  ) : (
                    <>
                      <TableCell sx={{ width: 70 }}>Running</TableCell>
                      <TableCell>
                        <TableSortLabel active={sort === "name"} direction="asc" onClick={() => setSort("name")}>
                          Command
                        </TableSortLabel>
                      </TableCell>
                      <TableCell sx={{ width: 48 }} />
                    </>
                  )}
                </TableRow>
              </TableHead>
              <TableBody
                ref={body}
                onMouseEnter={hold}
                onMouseLeave={release}
                onFocus={hold}
                onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !menu && !body.current?.matches(":hover") && release()}
              >
                {grouped
                  ? shownGroups.map((g) => (
                      <TableRow key={g.key} hover sx={{ cursor: "pointer" }} onClick={() => (setGrouped(false), setQuery(g.container?.name ?? ""))}>
                        <TableCell sx={{ fontWeight: 500 }}>
                          {g.container ? <ViewInArOutlinedIcon fontSize="inherit" sx={{ mr: 0.75, verticalAlign: "-2px" }} /> : null}
                          {g.label}
                        </TableCell>
                        <TableCell align="right">{pct(g.cpu)}</TableCell>
                        <TableCell align="right">{formatBytes(g.mem)}</TableCell>
                        <TableCell align="right">{g.read == null ? "—" : `${rate(g.read)} / ${rate(g.write ?? 0)}`}</TableCell>
                        <TableCell align="right">{g.count}</TableCell>
                      </TableRow>
                    ))
                  : shownRows.map((p) => (
                      <TableRow key={keyOf(p)} hover sx={p.ended ? { opacity: 0.45 } : undefined}>
                        <TableCell sx={{ fontFamily: MONO }}>{p.pid}</TableCell>
                        <TableCell>{p.user}</TableCell>
                        <TableCell>
                          {p.container ? (
                            <Link component="button" underline="hover" onClick={() => navigate("containers", p.container!.id)} sx={{ textAlign: "left" }}>
                              {p.container.service ?? p.container.name}
                            </Link>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              —
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: p.cpu >= 50 && !p.ended ? 600 : undefined }}>
                          {p.ended ? "ended" : pct(p.cpu)}
                        </TableCell>
                        <TableCell align="right">{formatBytes(p.mem)}</TableCell>
                        <TableCell align="right">{p.read == null ? "—" : `${rate(p.read)} / ${rate(p.write ?? 0)}`}</TableCell>
                        <TableCell>{duration(p.seconds)}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.cmd}>
                          {p.nice > 0 ? <Chip size="small" label={`nice ${p.nice}`} sx={{ height: 18, fontSize: 10, mr: 0.75 }} /> : null}
                          {p.cmd}
                        </TableCell>
                        <TableCell sx={{ py: 0 }}>
                          {!p.kernel && !p.ended && p.pid > 2 && (
                            <IconButton
                              size="small"
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setMenu({ top: r.bottom, left: r.left, p });
                              }}
                              aria-label={`Actions for process ${p.pid}`}
                            >
                              <MoreVertIcon fontSize="small" />
                            </IconButton>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
            {data.unreadable > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                {data.unreadable} {data.unreadable === 1 ? "process couldn't" : "processes couldn't"} be read unambiguously (a name with a line break, or one that looks like
                another process's) and {data.unreadable === 1 ? "isn't" : "aren't"} listed.
              </Typography>
            )}
            {data.processesShown < s.processes && (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                The server has {s.processes} processes; the {data.processesShown} busiest are shown.
              </Typography>
            )}
            {!grouped && rows.length > MAX_ROWS && (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                The first {MAX_ROWS} of {rows.length} processes; search to find others.
              </Typography>
            )}
            {(grouped ? groups.length : rows.length) === 0 && <EmptyState title="No process matches" />}
          </Paper>
        </>
      )}

      <Menu anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.top, left: menu.left } : undefined} open={!!menu} onClose={closeMenu}>
        {menu?.p.container && (
          <MenuItem onClick={() => (closeMenu(), navigate("containers", menu.p.container!.id))}>
            <ListItemIcon>
              <ViewInArOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open container {menu.p.container.name}</ListItemText>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            const cmd = menu?.p.cmd ?? "";
            closeMenu();
            void copyText(cmd).then(() => toast("success", "Command line copied"));
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy command line</ListItemText>
        </MenuItem>
        {menu && menu.p.nice < 10 && (
        <MenuItem onClick={() => menu && void act(menu.p, "lower")}>
          <ListItemIcon>
            <ArrowDownwardIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Lower priority</ListItemText>
        </MenuItem>
        )}
        <MenuItem onClick={() => menu && void act(menu.p, "end")}>
          <ListItemIcon>
            <StopCircleOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>End</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => menu && void act(menu.p, "kill")} sx={{ color: "error.main" }}>
          <ListItemIcon>
            <DangerousOutlinedIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText>Force end</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
