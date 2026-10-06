import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { wsUrl } from "../../api/ws";
import { useFeedback } from "../../components/Feedback";
import { formatBytes } from "../../utils/format";
import { MONO } from "../../theme";

interface Layer {
  status: string;
  current: number;
  total: number;
}

/** Pull an image by reference with per-layer progress (WS /ws/images/pull). */
export function PullDialog({ open, onClose, initialRef = "" }: { open: boolean; onClose: () => void; initialRef?: string }) {
  const { toast } = useFeedback();
  const [ref, setRef] = useState(initialRef);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [layers, setLayers] = useState<Record<string, Layer>>({});
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (open) {
      setRef(initialRef);
      setStatus("");
      setLayers({});
      setError(null);
    }
  }, [open, initialRef]);

  useEffect(() => () => ws.current?.close(), []);

  const start = async () => {
    const r = ref.trim();
    if (!r) return;
    setRunning(true);
    setError(null);
    setLayers({});
    setStatus("Starting…");
    try {
      const sock = new WebSocket(await wsUrl("/ws/images/pull", { ref: r }));
      ws.current = sock;
      let finished = false;
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "progress") {
          setStatus(m.status);
          setLayers(m.layers);
        } else if (m.type === "done") {
          finished = true;
          setRunning(false);
          toast("success", `Pulled ${r}`);
          onClose();
        } else if (m.type === "error") {
          finished = true;
          setRunning(false);
          setError(m.message);
        }
      };
      sock.onclose = () => {
        if (!finished) {
          setRunning(false);
          setError((e) => e ?? "Connection closed before the pull finished");
        }
      };
    } catch (e) {
      setRunning(false);
      setError((e as Error).message);
    }
  };

  const entries = Object.entries(layers);
  const total = entries.reduce((s, [, l]) => s + (l.total || 0), 0);
  const current = entries.reduce((s, [, l]) => s + Math.min(l.current || 0, l.total || 0), 0);
  const done = entries.filter(([, l]) => l.status === "Pull complete" || l.status === "Already exists").length;

  return (
    <Dialog open={open} onClose={running ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Pull an image</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Image"
          placeholder="e.g. nginx:latest, ghcr.io/org/app:1.2"
          value={ref}
          disabled={running}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !running && void start()}
          sx={{ mt: 1 }}
          InputProps={{ sx: { fontFamily: MONO } }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        {(running || entries.length > 0) && !error && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {status}
              {entries.length > 0 && ` · ${done}/${entries.length} layers`}
              {total > 0 && ` · ${formatBytes(current)} / ${formatBytes(total)}`}
            </Typography>
            <LinearProgress variant={total > 0 ? "determinate" : "indeterminate"} value={total > 0 ? (current / total) * 100 : undefined} />
            <Stack spacing={0.5} sx={{ mt: 1.5, maxHeight: 220, overflow: "auto" }}>
              {entries.map(([id, l]) => (
                <Stack key={id} direction="row" spacing={1.5} alignItems="center">
                  <Typography sx={{ fontFamily: MONO, fontSize: 12, width: 100 }}>{id}</Typography>
                  <Box sx={{ flex: 1 }}>
                    <LinearProgress
                      variant={l.total ? "determinate" : "indeterminate"}
                      value={l.total ? (Math.min(l.current, l.total) / l.total) * 100 : undefined}
                      color={l.status === "Pull complete" || l.status === "Already exists" ? "success" : "primary"}
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ width: 150 }} noWrap>
                    {l.status}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={() => (running ? ws.current?.close() : onClose())}>
          {running ? "Cancel" : "Close"}
        </Button>
        <Button variant="contained" onClick={() => void start()} disabled={running || !ref.trim()}>
          Pull
        </Button>
      </DialogActions>
    </Dialog>
  );
}
