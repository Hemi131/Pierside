/**
 * Small live time-series chart (SVG): one y-axis, 2px lines, recessive grid, crosshair + tooltip.
 * Series colours come from a validated categorical pair (dataviz reference palette, slots 1-2).
 */
import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, Typography, useTheme } from "@mui/material";

export interface Series {
  key: string;
  label: string;
  values: number[]; // aligned with `times`
}

export const SERIES_COLORS = {
  light: ["#2a78d6", "#eb6834"],
  dark: ["#3987e5", "#d95926"],
};

interface Props {
  title: string;
  times: number[]; // epoch seconds
  series: Series[];
  format: (v: number) => string;
  /** Fixed y max (e.g. memory limit); otherwise nice-rounded from data. */
  yMax?: number;
  headline?: string;
  windowS: number;
}

const H = 150;
const PAD = { l: 56, r: 12, t: 10, b: 22 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * exp;
}

export function TimeChart({ title, times, series, format, yMax, headline, windowS }: Props) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const colors = dark ? SERIES_COLORS.dark : SERIES_COLORS.light;
  const host = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const now = times.length ? times[times.length - 1] : Date.now() / 1000;
  const t0 = now - windowS;
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values));
  const top = yMax ?? niceMax(dataMax * 1.1);
  const iw = Math.max(w - PAD.l - PAD.r, 10);
  const ih = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - t0) / windowS) * iw;
  const y = (v: number) => PAD.t + ih - (Math.min(v, top) / top) * ih;
  const grid = [0, 0.5, 1].map((f) => f * top);
  const ink = theme.palette.text.secondary;
  const gridColor = theme.palette.divider;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!times.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - PAD.l) / iw) * windowS;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    setHover(best);
  };

  const hi = hover != null && hover < times.length ? hover : null;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
      <Stack direction="row" alignItems="baseline" spacing={1.5} sx={{ mb: 0.5 }}>
        <Typography variant="h5">{title}</Typography>
        {headline && (
          <Typography variant="body1" color="text.secondary">
            {headline}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {series.length > 1 &&
          series.map((s, i) => (
            <Stack key={s.key} direction="row" spacing={0.5} alignItems="center">
              <Box sx={{ width: 12, height: 2, bgcolor: colors[i], borderRadius: 1 }} />
              <Typography variant="body2" color="text.secondary">
                {s.label} {s.values.length ? format(s.values[s.values.length - 1]) : ""}
              </Typography>
            </Stack>
          ))}
      </Stack>
      <Box ref={host} sx={{ position: "relative" }}>
        <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${title} chart`}>
          {grid.map((g, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke={gridColor} strokeWidth={1} strokeDasharray={i === 0 ? undefined : "2 3"} />
              <text x={PAD.l - 6} y={y(g) + 4} textAnchor="end" fontSize={10} fill={ink}>
                {format(g)}
              </text>
            </g>
          ))}
          <text x={PAD.l} y={H - 6} fontSize={10} fill={ink}>
            −{Math.round(windowS / 60)} min
          </text>
          <text x={w - PAD.r} y={H - 6} fontSize={10} fill={ink} textAnchor="end">
            now
          </text>
          {series.map((s, si) => {
            const pts = s.values.map((v, i) => [x(times[i]), y(v)] as const).filter(([px]) => px >= PAD.l - 1);
            if (pts.length < 2) return null;
            const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
            return (
              <g key={s.key}>
                {series.length === 1 && <path d={`${d}L${pts[pts.length - 1][0]},${PAD.t + ih}L${pts[0][0]},${PAD.t + ih}Z`} fill={colors[si]} fillOpacity={0.1} />}
                <path d={d} fill="none" stroke={colors[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hi != null && (
            <g>
              <line x1={x(times[hi])} x2={x(times[hi])} y1={PAD.t} y2={PAD.t + ih} stroke={ink} strokeOpacity={0.5} strokeWidth={1} />
              {series.map((s, si) => (
                <circle key={s.key} cx={x(times[hi])} cy={y(s.values[hi] ?? 0)} r={4} fill={colors[si]} stroke={theme.palette.background.paper} strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hi != null && (
          <Paper
            elevation={4}
            sx={{
              position: "absolute",
              top: 4,
              left: Math.min(Math.max(x(times[hi]) + 10, 0), w - 170),
              px: 1,
              py: 0.5,
              pointerEvents: "none",
              minWidth: 150,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {new Date(times[hi] * 1000).toLocaleTimeString()}
            </Typography>
            {series.map((s, si) => (
              <Stack key={s.key} direction="row" spacing={0.75} alignItems="center">
                <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: colors[si] }} />
                <Typography variant="body2">
                  {series.length > 1 ? `${s.label}: ` : ""}
                  {format(s.values[hi] ?? 0)}
                </Typography>
              </Stack>
            ))}
          </Paper>
        )}
      </Box>
    </Paper>
  );
}
