/** "Forward a port": make a container port reachable at localhost:<port> on this computer. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Autocomplete, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { api } from "../api/ddclient";
import type { Container } from "../api/types";
import { useEngine } from "../hooks/useEngine";
import { useFeedback } from "./Feedback";

export interface Forward {
  id: string;
  kind: "container" | "remote";
  hostPort: number;
  targetPort: number;
  target: { id: string; name: string };
  remote?: { engineId: string; engineName: string; host: string; port: number };
  problem: string;
  createdAt: number;
}

// ---- one dialog for the app ----
let current: { container?: Container; port?: number; seq: number } | null = null;
let seq = 0;
const subs = new Set<() => void>();
export function openForward(opts: { container?: Container; port?: number } = {}) {
  current = { ...opts, seq: ++seq };
  subs.forEach((s) => s());
}
const close = () => {
  current = null;
  subs.forEach((s) => s());
};
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

export function ForwardDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);
  return req ? <ForwardDialog key={req.seq} initialContainer={req.container} initialPort={req.port} /> : null;
}

function ForwardDialog({ initialContainer, initialPort }: { initialContainer?: Container; initialPort?: number }) {
  const { containers, engine } = useEngine();
  const { toast } = useFeedback();
  const remote = engine?.engine?.type === "ssh";
  const options = useMemo(() => (containers ?? []).filter((c) => c.state === "running" && !c.isSystem && !c.isExtension).sort((a, b) => a.name.localeCompare(b.name)), [containers]);
  const [target, setTarget] = useState<Container | null>(initialContainer ?? null);
  const [port, setPort] = useState(initialPort ? String(initialPort) : "");
  const [hostPort, setHostPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ports = useMemo(() => [...new Set((target?.ports ?? []).filter((p) => p.type === "tcp").map((p) => String(p.private)))], [target]);
  useEffect(() => {
    if (!port && ports.length === 1) setPort(ports[0]);
  }, [ports, port]);
  // Suggest the same port number locally, or the next free one.
  useEffect(() => {
    const n = parseInt(port, 10);
    if (!n) return;
    let alive = true;
    api
      .get<{ port: number }>(`/forwards/free-port?start=${n}`)
      .then((r) => alive && setHostPort(String(r.port)))
      .catch(() => alive && setHostPort(String(n)));
    return () => {
      alive = false;
    };
  }, [port]);

  const valid = !!target && +port > 0 && +port < 65536 && +hostPort > 0 && +hostPort < 65536;
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/forwards", { containerId: target.id, targetPort: +port, hostPort: +hostPort });
      toast("success", `${target.name}:${port} is now at localhost:${hostPort}`);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>{remote ? "Forward a port to this computer" : "Forward a port"}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {remote
            ? `Makes a port of a container on ${engine?.engine?.name} reachable at localhost on this computer, through Pierside's SSH connection.`
            : "Makes a container port reachable at localhost on this computer without recreating the container (Docker can't add published ports to a running container)."}
        </Typography>
        <Stack spacing={2}>
          <Autocomplete
            options={options}
            value={target}
            onChange={(_, v) => {
              setTarget(v);
              setPort("");
            }}
            getOptionLabel={(c) => c.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            groupBy={(c) => c.project ?? "Standalone containers"}
            renderInput={(params) => <TextField {...params} label="Container" autoFocus={!initialContainer} />}
          />
          <Stack direction="row" spacing={2}>
            <Autocomplete
              freeSolo
              options={ports}
              value={port}
              inputValue={port}
              onInputChange={(_, v) => setPort(v.replace(/\D/g, ""))}
              renderInput={(params) => <TextField {...params} label="Container port" helperText={ports.length ? "Ports the container exposes" : "TCP"} />}
              sx={{ flex: 1 }}
            />
            <TextField label="Local port" value={hostPort} onChange={(e) => setHostPort(e.target.value.replace(/\D/g, ""))} helperText="localhost:<port> on this computer" sx={{ flex: 1 }} />
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={close}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!valid || busy}>
          Forward
        </Button>
      </DialogActions>
    </Dialog>
  );
}
