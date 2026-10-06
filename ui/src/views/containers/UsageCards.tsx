import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, Typography, useTheme } from "@mui/material";
import { useEngine } from "../../hooks/useEngine";
import { formatBytes } from "../../utils/format";

const HISTORY = 60; // samples (~2 min at 2 s)

function Sparkline({ values, max, color }: { values: number[]; max: number; color: string }) {
  const w = 160;
  const h = 36;
  if (values.length < 2) return <Box sx={{ width: w, height: h }} />;
  const top = Math.max(max, ...values, 1e-9);
  const step = w / (HISTORY - 1);
  const offset = (HISTORY - values.length) * step;
  const pts = values.map((v, i) => `${(offset + i * step).toFixed(1)},${(h - 2 - (v / top) * (h - 4)).toFixed(1)}`);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={`${pts[0].split(",")[0]},${h} ${pts.join(" ")} ${w},${h}`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** "Container CPU usage" / "Container memory usage" cards like Docker Desktop's containers view. */
export function UsageCards() {
  const { totals, engine } = useEngine();
  const theme = useTheme();
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const [, force] = useState(0);

  useEffect(() => {
    if (!totals) return;
    cpuHist.current = [...cpuHist.current, totals.cpu].slice(-HISTORY);
    memHist.current = [...memHist.current, totals.mem].slice(-HISTORY);
    force((n) => n + 1);
  }, [totals]);

  const ncpu = totals?.ncpu ?? engine?.info?.ncpu ?? 0;
  const memTotal = totals?.memTotal ?? engine?.info?.memTotal ?? 0;

  const card = (title: string, value: string, sub: string, values: number[], color: string) => (
    <Paper variant="outlined" sx={{ px: 2, py: 1.5, flex: 1, minWidth: 260, display: "flex", alignItems: "center", gap: 2 }}>
      <Box sx={{ flex: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {title}
        </Typography>
        <Typography variant="h3" sx={{ mt: 0.5 }}>
          {value}
          <Typography component="span" variant="body1" color="text.secondary" sx={{ ml: 1 }}>
            {sub}
          </Typography>
        </Typography>
      </Box>
      <Sparkline values={values} max={0} color={color} />
    </Paper>
  );

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }} useFlexGap flexWrap="wrap">
      {card(
        "Container CPU usage",
        totals ? `${totals.cpu.toFixed(2)}%` : "—",
        ncpu ? `/ ${ncpu * 100}% (${ncpu} CPUs available)` : "",
        cpuHist.current,
        theme.palette.primary.main,
      )}
      {card("Container memory usage", totals ? formatBytes(totals.mem) : "—", memTotal ? `/ ${formatBytes(memTotal)}` : "", memHist.current, theme.palette.success.main)}
    </Stack>
  );
}
