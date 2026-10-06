import { useEffect, useRef, useState } from "react";
import { Alert, Box, Paper, Stack, Typography } from "@mui/material";
import { wsUrl } from "../../api/ws";
import { TimeChart } from "../../components/charts/TimeChart";
import { formatBytes } from "../../utils/format";

interface Sample {
  t: number;
  cpu: number;
  ncpu: number;
  mem: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  pids: number | null;
}

const WINDOW_S = 180;
const rate = (v: number) => `${formatBytes(v)}/s`;
const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

export function StatsTab({ containerId, running }: { containerId: string; running: boolean }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const buf = useRef<Sample[]>([]);

  useEffect(() => {
    if (!running) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    (async () => {
      try {
        ws = new WebSocket(await wsUrl(`/ws/stats/${containerId}`));
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (disposed) return ws.close();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "stats") {
          const cutoff = m.t - WINDOW_S - 5;
          buf.current = [...buf.current.filter((s) => s.t > cutoff), m as Sample];
          setSamples(buf.current);
          setError(null);
        } else if (m.type === "error") setError(m.message);
      };
    })();
    return () => {
      disposed = true;
      ws?.close();
    };
  }, [containerId, running]);

  if (!running) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <Typography color="text.secondary">The container isn't running, so there are no live stats.</Typography>
      </Stack>
    );
  }

  const last = samples[samples.length - 1];
  const times = samples.map((s) => s.t);
  const memLimit = last?.memLimit;

  return (
    <Box sx={{ overflow: "auto", flex: 1 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      <Stack direction="row" spacing={2} sx={{ mb: 2 }} useFlexGap flexWrap="wrap">
        {[
          ["CPU", last ? `${pct(last.cpu)} of ${last.ncpu * 100}%` : "—"],
          ["Memory", last ? `${formatBytes(last.mem)} / ${formatBytes(last.memLimit)}` : "—"],
          ["Network", last ? `↓ ${rate(last.netRx)}  ↑ ${rate(last.netTx)}` : "—"],
          ["Disk", last ? `R ${rate(last.blkRead)}  W ${rate(last.blkWrite)}` : "—"],
          ["Processes", last?.pids != null ? String(last.pids) : "—"],
        ].map(([label, value]) => (
          <Paper key={label} variant="outlined" sx={{ px: 2, py: 1, minWidth: 150 }}>
            <Typography variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography variant="h4">{value}</Typography>
          </Paper>
        ))}
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 2 }}>
        <TimeChart title="CPU usage" windowS={WINDOW_S} times={times} format={pct} series={[{ key: "cpu", label: "CPU", values: samples.map((s) => s.cpu) }]} />
        <TimeChart
          title="Memory usage"
          headline={memLimit ? `limit ${formatBytes(memLimit)}` : undefined}
          windowS={WINDOW_S}
          times={times}
          format={(v) => formatBytes(v)}
          series={[{ key: "mem", label: "Memory", values: samples.map((s) => s.mem) }]}
        />
        <TimeChart
          title="Network I/O"
          windowS={WINDOW_S}
          times={times}
          format={rate}
          series={[
            { key: "rx", label: "Received", values: samples.map((s) => s.netRx) },
            { key: "tx", label: "Sent", values: samples.map((s) => s.netTx) },
          ]}
        />
        <TimeChart
          title="Disk I/O"
          windowS={WINDOW_S}
          times={times}
          format={rate}
          series={[
            { key: "r", label: "Read", values: samples.map((s) => s.blkRead) },
            { key: "w", label: "Written", values: samples.map((s) => s.blkWrite) },
          ]}
        />
      </Box>
    </Box>
  );
}
