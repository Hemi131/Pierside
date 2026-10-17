/**
 * Engines at a glance: every engine's state without switching to it (backend services/watch.py),
 * kept up to date at the chosen interval while this page is open. Engines watched in the background
 * are kept up to date always, and their alerts arrive while another engine is active.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { Glance, GlanceAlert, GlanceEngine, GlanceProblem, loadGlance, refreshGlance, saveGlanceSettings } from "../../api/glance";
import { activateEngine } from "../engines/engineApi";
import { PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { formatBytes, relativeTime } from "../../utils/format";
import { navigate } from "../../hooks/useRoute";

/** How often the page reads the backend's snapshots (cheap: no engine is asked by that). */
const READ_MS = 3000;
/** …and while an engine is still being asked, so its card fills in as soon as it answers. */
const READ_WAITING_MS = 400;
/** …at most this long after opening the page or Refresh (an engine that doesn't answer stays "updating"). */
const FAST_FOR_MS = 20_000;

const intervalLabel = (s: number) => (s === 0 ? "Only when I refresh" : s < 60 ? `Every ${s} seconds` : s === 60 ? "Every minute" : `Every ${s / 60} minutes`);

function ago(t: number | undefined, now: number): string {
  if (!t) return "";
  const s = Math.max(0, Math.round(now / 1000 - t));
  return s < 5 ? "just now" : s < 120 ? `${s} s ago` : relativeTime(t, now);
}

/** "2 restarting", "1 exited with an error" … with the containers behind each. */
function groups(problems: GlanceProblem[]): { label: string; items: GlanceProblem[] }[] {
  const by = new Map<string, GlanceProblem[]>();
  for (const p of problems) {
    const kind = p.what.startsWith("exited") ? "exited with an error" : p.what;
    by.set(kind, [...(by.get(kind) ?? []), p]);
  }
  return [...by].map(([kind, items]) => ({ label: `${items.length} ${kind}`, items }));
}

function Meter({ label, value, max, text, partial }: { label: string; value: number; max: number; text: string; partial?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Tooltip title={partial ? "Some containers didn't answer in time, so this is at least this much" : ""}>
          <Typography variant="body2" noWrap sx={{ ml: 1 }}>
            {partial ? "≥ " : ""}
            {text}
          </Typography>
        </Tooltip>
      </Stack>
      <LinearProgress variant="determinate" value={pct} color={pct > 90 ? "error" : pct > 70 ? "warning" : "primary"} sx={{ height: 6, borderRadius: 3, bgcolor: "action.hover" }} />
    </Box>
  );
}

function EngineCard({ e, now, busy, onWatch, onOpen }: { e: GlanceEngine; now: number; busy: boolean; onWatch: (on: boolean) => void; onOpen: (hash?: string) => void }) {
  const loaded = e.updatedAt != null;
  const up = loaded && e.reachable;
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: "1 1 320px", maxWidth: 480, minWidth: 280, display: "flex", flexDirection: "column", borderLeft: e.color ? `4px solid ${e.color}` : undefined }} aria-label={`Engine ${e.name}`}>
      <Stack direction="row" alignItems="center" spacing={1}>
        {e.type === "local" ? <ComputerIcon fontSize="small" color="action" /> : <CloudOutlinedIcon fontSize="small" color="action" />}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600 }} noWrap>
            {e.name}
          </Typography>
          {e.target && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {e.target}
            </Typography>
          )}
        </Box>
        {e.active ? (
          <Chip size="small" color="success" label="Active" />
        ) : (
          <Button size="small" disabled={busy} onClick={() => onOpen()}>
            Switch
          </Button>
        )}
      </Stack>

      {!loaded ? (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1.5, flex: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="body2" color="text.secondary">
            Asking the engine…
          </Typography>
        </Stack>
      ) : !up ? (
        <Box sx={{ mt: 1, flex: 1 }}>
          <Chip size="small" color="error" label="Can't be reached" />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: "break-word" }}>
            {e.error}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 1 }}>
            <Typography sx={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>{e.running}</Typography>
            <Typography variant="body2" color="text.secondary">
              running of {e.total} container{e.total === 1 ? "" : "s"}
              {e.paused ? ` · ${e.paused} paused` : ""}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={2} sx={{ mt: 1.25 }}>
            {/* null until the first measurement is in (the counts above come first) */}
            <Meter label="CPU" value={e.cpu ?? 0} max={(e.cpus ?? 0) * 100} partial={!!e.usagePartial} text={e.cpu == null ? "measuring…" : `${e.cpu.toFixed(1)}% / ${(e.cpus ?? 0) * 100}%`} />
            <Meter label="Memory" value={e.mem ?? 0} max={e.memory ?? 0} partial={!!e.usagePartial} text={e.mem == null ? "measuring…" : `${formatBytes(e.mem)} / ${formatBytes(e.memory)}`} />
          </Stack>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 1.25, minHeight: 24 }}>
            {(e.problems ?? []).length === 0 ? (
              <Chip size="small" variant="outlined" color="success" label="No problems" />
            ) : (
              groups(e.problems ?? []).map((g) => (
                <Tooltip
                  key={g.label}
                  title={
                    <>
                      {g.items.map((p) => (
                        <div key={p.id}>
                          {p.name}
                          {p.what.startsWith("exited") ? ` (${p.what.replace("exited with ", "")})` : ""}
                        </div>
                      ))}
                      <div style={{ opacity: 0.7, marginTop: 4 }}>{e.active ? "Click to open it" : "Click to switch to this engine and open it"}</div>
                    </>
                  }
                >
                  <Chip
                    size="small"
                    color={g.label.includes("exited") ? "warning" : "error"}
                    label={g.label}
                    onClick={busy ? undefined : () => onOpen(`#/containers/${encodeURIComponent(g.items[0].id)}/logs`)}
                  />
                </Tooltip>
              ))
            )}
            {e.swarm && <Chip size="small" variant="outlined" label="Swarm" />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Docker {e.version} · {e.cpus} CPUs · {formatBytes(e.memory)} · {e.images} images
          </Typography>
        </Box>
      )}

      <Stack direction="row" alignItems="center" sx={{ mt: 1, pt: 0.5, borderTop: 1, borderColor: "divider" }}>
        <Tooltip
          title="Keep this engine's state up to date and report its problems (restart loops, out of memory, unhealthy, Swarm services, the engine itself not answering) even while another engine is active. Keeps a connection to it open."
          placement="bottom-start"
        >
          <FormControlLabel
            control={<Switch size="small" checked={e.watched} onChange={(ev) => onWatch(ev.target.checked)} />}
            label={<Typography variant="body2">Watch in the background</Typography>}
            sx={{ mr: 0 }}
          />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {e.polling && loaded && <CircularProgress size={10} sx={{ mr: 0.75 }} aria-label="Updating" />}
        <Typography variant="body2" color="text.secondary" noWrap>
          {loaded ? `Updated ${ago(e.updatedAt, now)}` : ""}
        </Typography>
      </Stack>
    </Paper>
  );
}

function RecentAlerts({ alerts, now, engines }: { alerts: GlanceAlert[]; now: number; engines: GlanceEngine[] }) {
  if (alerts.length === 0) return null;
  const activeId = engines.find((e) => e.active)?.id;
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h3" sx={{ mb: 1 }}>
        Recent alerts
      </Typography>
      <Paper variant="outlined">
        {alerts.slice(0, 30).map((a, i) => (
          <Stack key={`${a.at}-${i}`} direction="row" spacing={1.5} alignItems="flex-start" sx={{ px: 1.5, py: 1, borderTop: i ? 1 : 0, borderColor: "divider" }}>
            {a.severity === "error" ? (
              <ErrorOutlineIcon fontSize="small" color="error" sx={{ mt: 0.25 }} />
            ) : a.severity === "info" ? (
              <CheckCircleOutlineIcon fontSize="small" color="success" sx={{ mt: 0.25 }} />
            ) : (
              <WarningAmberIcon fontSize="small" color="warning" sx={{ mt: 0.25 }} />
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body1">{a.message}</Typography>
              <Typography variant="body2" color="text.secondary">
                {a.engineName} · {ago(a.at, now)}
              </Typography>
            </Box>
            {a.containerId && a.engineId === activeId && (
              <Button size="small" onClick={() => navigate("containers", a.containerId, "logs")}>
                Logs
              </Button>
            )}
          </Stack>
        ))}
      </Paper>
    </Box>
  );
}

export function GlanceView() {
  const { toast } = useFeedback();
  const [data, setData] = useState<Glance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Each engine is asked separately; while any is still being asked, read often, so each card fills in
  // as soon as its own engine answers rather than all together at the next slow read.
  // One read loop (a read asked for while one is on its way follows it), fast only while a card has
  // no figures yet or shortly after opening / Refresh: an engine that never answers mustn't keep it fast.
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const again = useRef(false);
  const fastUntil = useRef(0);
  const read = useCallback(() => {
    if (!alive.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    window.clearTimeout(timer.current);
    inFlight.current = true;
    let waiting = false;
    loadGlance()
      .then((g) => {
        setData(g);
        setError(null);
        waiting = Date.now() < fastUntil.current && g.engines.some((e) => e.updatedAt == null || e.polling);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => {
        inFlight.current = false;
        if (!alive.current) return;
        setNow(Date.now());
        if (again.current) {
          again.current = false;
          read();
        } else timer.current = window.setTimeout(read, waiting ? READ_WAITING_MS : READ_MS);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    fastUntil.current = Date.now() + FAST_FOR_MS;
    read();
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, [read]);

  const save = async (s: { interval?: number; watch?: Record<string, boolean> }) => {
    try {
      setData(await saveGlanceSettings(s));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const refresh = async () => {
    try {
      await refreshGlance();
      fastUntil.current = Date.now() + FAST_FOR_MS;
      read();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const open = (id: string, hash?: string) => {
    const e = data?.engines.find((x) => x.id === id);
    if (e?.active) {
      if (hash) window.location.hash = hash;
      return;
    }
    setBusy(true);
    activateEngine(id, hash).catch((err) => {
      setBusy(false);
      toast("error", (err as Error).message);
    });
  };

  return (
    <Box>
      <PageHeader
        title="Engines at a glance"
        subtitle="How every engine is doing, without switching to it."
        actions={
          <Stack direction="row" alignItems="center" spacing={1}>
            <Select size="small" value={data?.interval ?? 30} onChange={(e) => void save({ interval: Number(e.target.value) })} aria-label="How often to update" disabled={!data}>
              {(data?.intervals ?? [0, 10, 30, 60, 300]).map((s) => (
                <MenuItem key={s} value={s}>
                  {intervalLabel(s)}
                </MenuItem>
              ))}
            </Select>
            <Tooltip title="Ask every engine now">
              <span>
                <Button variant="outlined" size="small" startIcon={<RefreshIcon fontSize="small" />} onClick={() => void refresh()} disabled={!data}>
                  Refresh
                </Button>
              </span>
            </Tooltip>
          </Stack>
        }
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!data && !error && <CircularProgress size={24} />}
      {data && (
        <>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5}>
            {data.engines.map((e) => (
              <EngineCard key={e.id} e={e} now={now} busy={busy} onWatch={(on) => void save({ watch: { [e.id]: on } })} onOpen={(hash) => open(e.id, hash)} />
            ))}
          </Stack>
          <RecentAlerts alerts={data.recent} now={now} engines={data.engines} />
        </>
      )}
    </Box>
  );
}
