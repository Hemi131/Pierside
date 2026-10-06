import { FormControlLabel, Link, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from "@mui/material";
import { useState } from "react";
import { StatusDot } from "../../components/common";
import { href } from "../../hooks/useRoute";
import { relativeTime } from "../../utils/format";
import { MONO } from "../../theme";
import type { SwarmTask } from "./types";

type Dot = "running" | "partial" | "exited" | "dead" | "created";

function dotState(t: SwarmTask): Dot {
  if (t.state === "running") return "running";
  if (t.state === "failed" || t.state === "rejected" || t.state === "orphaned") return "dead";
  if (t.state === "complete" || t.state === "shutdown") return "exited";
  return "partial"; // new/pending/assigned/preparing/starting …
}

/** Tasks like `docker service ps`: current tasks first, history (desired shutdown) optional. */
export function TasksTable({ tasks, serviceNames }: { tasks: SwarmTask[]; serviceNames?: Record<string, string> }) {
  const [showHistory, setShowHistory] = useState(false);
  const current = tasks.filter((t) => t.desiredState !== "shutdown");
  const shown = (showHistory ? tasks : current).slice().sort((a, b) => {
    const sa = (serviceNames?.[a.serviceId] ?? "") + String(a.slot ?? 0).padStart(4, "0");
    const sb = (serviceNames?.[b.serviceId] ?? "") + String(b.slot ?? 0).padStart(4, "0");
    return sa.localeCompare(sb) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
  const historyCount = tasks.length - current.length;
  return (
    <>
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="body1" color="text.secondary" sx={{ flex: 1 }}>
          {current.length} current task{current.length === 1 ? "" : "s"}
        </Typography>
        <FormControlLabel
          control={<Switch size="small" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />}
          label={<Typography variant="body1">Show history ({historyCount})</Typography>}
        />
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ flex: "0 1 auto", minHeight: 0 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Task</TableCell>
              <TableCell sx={{ width: 160 }}>State</TableCell>
              <TableCell sx={{ width: 110 }}>Desired</TableCell>
              <TableCell sx={{ width: 120 }}>Node</TableCell>
              <TableCell>Error / message</TableCell>
              <TableCell sx={{ width: 120 }}>Since</TableCell>
              <TableCell sx={{ width: 120 }}>Container</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} sx={{ py: 5, textAlign: "center", color: "text.secondary" }}>
                  No tasks.
                </TableCell>
              </TableRow>
            )}
            {shown.map((t) => (
              <TableRow key={t.id} hover sx={{ opacity: t.desiredState === "shutdown" ? 0.65 : 1 }}>
                <TableCell>
                  <Typography variant="body1" component="span" sx={{ fontWeight: 500 }}>
                    {serviceNames?.[t.serviceId] ? `${serviceNames[t.serviceId]}.` : "#"}
                    {t.slot ?? t.nodeId.slice(0, 6)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div" sx={{ fontFamily: MONO, fontSize: 11 }}>
                    {t.id.slice(0, 12)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <StatusDot state={dotState(t)} size={8} />
                    <span style={{ textTransform: "capitalize" }}>{t.state}</span>
                    {t.exitCode != null && t.state !== "running" && (
                      <Typography variant="body2" color="text.secondary">
                        ({t.exitCode})
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell sx={{ textTransform: "capitalize" }}>{t.desiredState}</TableCell>
                <TableCell>{t.node}</TableCell>
                <TableCell sx={{ color: t.error ? "error.main" : "text.secondary", wordBreak: "break-word" }}>{t.error || t.message}</TableCell>
                <TableCell>
                  <Tooltip title={new Date(t.timestamp).toLocaleString()}>
                    <span>{relativeTime(t.timestamp)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  {t.containerId && t.state === "running" ? (
                    <Link href={href("containers", t.containerId)} underline="hover" sx={{ fontFamily: MONO, fontSize: 12 }}>
                      {t.containerId.slice(0, 12)}
                    </Link>
                  ) : (
                    <Typography variant="body2" color="text.disabled" sx={{ fontFamily: MONO, fontSize: 12 }}>
                      {t.containerId?.slice(0, 12) ?? "—"}
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}
