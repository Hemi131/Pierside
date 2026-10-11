/**
 * All engines at a glance (top of the Engines page): for each one whether it can be reached, how many
 * containers run, and which need attention, without switching to it. Each engine is asked separately
 * (backend /engines/{id}/overview), so a slow or unreachable server doesn't hold up the others.
 */
import { useCallback, useEffect, useState } from "react";
import { Box, Button, Chip, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import { api } from "../../api/ddclient";
import { formatBytes } from "../../utils/format";
import type { EngineEntry } from "./engineApi";

interface Overview {
  id: string;
  reachable: boolean;
  error: string | null;
  version?: string;
  os?: string;
  cpus?: number;
  memory?: number;
  images?: number;
  swarm?: boolean;
  running?: number;
  paused?: number;
  stopped?: number;
  total?: number;
  problems?: { name: string; what: string }[];
}

/** "2 restarting, 1 unhealthy" from the list of problems. */
function summarise(problems: { name: string; what: string }[]): { label: string; names: string }[] {
  const groups = new Map<string, string[]>();
  for (const p of problems) {
    const kind = p.what.startsWith("exited") ? "exited with an error" : p.what;
    groups.set(kind, [...(groups.get(kind) ?? []), p.what.startsWith("exited") ? `${p.name} (${p.what.replace("exited with ", "")})` : p.name]);
  }
  return [...groups].map(([kind, names]) => ({ label: `${names.length} ${kind}`, names: names.join(", ") }));
}

export function EnginesOverview({ engines, switching, onSwitch }: { engines: EngineEntry[]; switching: string | null; onSwitch: (id: string) => void }) {
  const [state, setState] = useState<Record<string, Overview | "loading">>({});
  const ids = engines.map((e) => e.id).join(",");

  const load = useCallback(() => {
    for (const id of ids.split(",").filter(Boolean)) {
      setState((s) => ({ ...s, [id]: "loading" }));
      api
        .get<Overview>(`/engines/${id}/overview`)
        .catch((e): Overview => ({ id, reachable: false, error: (e as Error).message }))
        .then((o) => setState((s) => ({ ...s, [id]: o })));
    }
  }, [ids]);

  useEffect(load, [load]);

  const anyLoading = Object.values(state).some((v) => v === "loading");
  return (
    <Box sx={{ mb: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="h3">At a glance</Typography>
        <Tooltip title="Ask every engine again">
          <span>
            <IconButton size="small" onClick={load} disabled={anyLoading} aria-label="Refresh the overview">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5}>
        {engines.map((e) => {
          const o = state[e.id];
          const problems = o && o !== "loading" && o.reachable ? summarise(o.problems ?? []) : [];
          return (
            <Paper key={e.id} variant="outlined" sx={{ p: 1.5, flex: "1 1 280px", maxWidth: 440, minWidth: 260, borderLeft: e.color ? `4px solid ${e.color}` : undefined }} aria-label={`Engine ${e.name}`}>
              <Stack direction="row" alignItems="center" spacing={1}>
                {e.type === "local" ? <ComputerIcon fontSize="small" color="action" /> : <CloudOutlinedIcon fontSize="small" color="action" />}
                <Typography sx={{ fontWeight: 600, flex: 1 }} noWrap>
                  {e.name}
                </Typography>
                {e.active ? (
                  <Chip size="small" color="success" label="Active" />
                ) : (
                  <Button size="small" disabled={!!switching} onClick={() => onSwitch(e.id)} sx={{ minHeight: 0, py: 0 }}>
                    Switch
                  </Button>
                )}
              </Stack>
              {!o || o === "loading" ? (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1.5 }}>
                  <CircularProgress size={14} />
                  <Typography variant="body2" color="text.secondary">
                    Asking the engine…
                  </Typography>
                </Stack>
              ) : !o.reachable ? (
                <Box sx={{ mt: 1 }}>
                  <Chip size="small" color="error" label="Can't be reached" />
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: "break-word" }}>
                    {o.error}
                  </Typography>
                </Box>
              ) : (
                <>
                  <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 1 }}>
                    <Typography sx={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>{o.running}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      running of {o.total} container{o.total === 1 ? "" : "s"}
                      {o.paused ? ` · ${o.paused} paused` : ""}
                    </Typography>
                  </Stack>
                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 1, minHeight: 24 }}>
                    {problems.length === 0 ? (
                      <Chip size="small" variant="outlined" color="success" label="No problems" />
                    ) : (
                      problems.map((p) => (
                        <Tooltip key={p.label} title={p.names}>
                          <Chip size="small" color={p.label.includes("exited") ? "warning" : "error"} label={p.label} />
                        </Tooltip>
                      ))
                    )}
                    {o.swarm && <Chip size="small" variant="outlined" label="Swarm" />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    Docker {o.version} · {o.cpus} CPUs · {formatBytes(o.memory)} · {o.images} images
                  </Typography>
                </>
              )}
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}
