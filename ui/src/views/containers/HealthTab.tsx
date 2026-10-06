import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Chip, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { api } from "../../api/ddclient";
import { MONO } from "../../theme";
import { relativeTime } from "../../utils/format";

interface Probe {
  Start: string;
  End: string;
  ExitCode: number;
  Output: string;
}
interface Inspect {
  State?: { Health?: { Status: string; FailingStreak: number; Log?: Probe[] } };
  Config?: { Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number } };
}

const POLL_MS = 5000;
const secs = (ns?: number) => (ns ? `${ns / 1e9}s` : "default");

/** Docker's Test is ["CMD", ...args] or ["CMD-SHELL", "cmd"]. */
function testCommand(test?: string[]): string {
  if (!test?.length) return "—";
  const [kind, ...rest] = test;
  return kind === "CMD-SHELL" ? rest.join(" ") : kind === "CMD" ? rest.join(" ") : test.join(" ");
}

const STATUS_COLOR: Record<string, "success" | "error" | "warning"> = { healthy: "success", unhealthy: "error", starting: "warning" };

export function HealthTab({ id, active }: { id: string; active: boolean }) {
  const [data, setData] = useState<Inspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<Inspect>(`/containers/${id}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  // Probe results don't produce engine events (only status changes do), so poll while visible.
  useEffect(() => {
    if (!active) return;
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [active, load]);

  if (error && !data) return <Alert severity="error">{error}</Alert>;
  if (!data) return <CircularProgress size={24} />;
  const health = data.State?.Health;
  const cfg = data.Config?.Healthcheck;
  if (!health) return <Alert severity="info">This container has no health check.</Alert>;
  const probes = [...(health.Log ?? [])].reverse();

  return (
    <Box sx={{ overflow: "auto" }}>
      <Stack direction="row" spacing={3} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Chip label={health.Status} color={STATUS_COLOR[health.Status]} sx={{ textTransform: "capitalize", fontWeight: 600 }} />
        <Typography variant="body2" color="text.secondary">
          {health.FailingStreak ? (
            <>
              <b>{health.FailingStreak}</b> failed check{health.FailingStreak === 1 ? "" : "s"} in a row
            </>
          ) : (
            "Last check passed"
          )}
          {cfg?.Retries ? ` (unhealthy after ${cfg.Retries})` : ""}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Every {secs(cfg?.Interval)}, timeout {secs(cfg?.Timeout)}
          {cfg?.StartPeriod ? `, start period ${secs(cfg.StartPeriod)}` : ""}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        Check command
      </Typography>
      <Box sx={{ fontFamily: MONO, fontSize: 12, p: 1, mb: 2, borderRadius: 1, bgcolor: "action.hover", wordBreak: "break-all" }}>{testCommand(cfg?.Test)}</Box>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 150 }}>When</TableCell>
              <TableCell sx={{ width: 90 }}>Result</TableCell>
              <TableCell sx={{ width: 90 }}>Duration</TableCell>
              <TableCell>Output</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {probes.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} sx={{ color: "text.secondary" }}>
                  No checks have run yet.
                </TableCell>
              </TableRow>
            )}
            {probes.map((p) => (
              <TableRow key={p.Start} sx={{ verticalAlign: "top" }}>
                <TableCell title={`${new Date(p.Start).toLocaleString()} (${relativeTime(p.Start)})`}>{new Date(p.Start).toLocaleTimeString()}</TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: p.ExitCode === 0 ? "success.main" : "error.main", fontWeight: 600 }}>
                    {p.ExitCode === 0 ? "Passed" : `Failed (${p.ExitCode})`}
                  </Typography>
                </TableCell>
                <TableCell>{Math.max(0, new Date(p.End).getTime() - new Date(p.Start).getTime())} ms</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.Output.trim() || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
