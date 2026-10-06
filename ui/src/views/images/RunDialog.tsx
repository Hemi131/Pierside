/** "Run a new container" with Docker Desktop–style optional settings: name, ports, volumes, env. */
import { useEffect, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import AddIcon from "@mui/icons-material/Add";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import { api } from "../../api/ddclient";
import { useFeedback } from "../../components/Feedback";
import { navigate } from "../../hooks/useRoute";
import { MONO } from "../../theme";

interface Port {
  host: string;
  container: string;
  fixed?: boolean; // exposed by the image
}
interface Vol {
  source: string;
  target: string;
  readOnly: boolean;
}
interface Env {
  key: string;
  value: string;
}

function Section({ title, hint, children, onAdd }: { title: string; hint?: string; children: React.ReactNode; onAdd: () => void }) {
  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" alignItems="center">
        <Typography variant="h5" sx={{ flex: 1 }}>
          {title}
        </Typography>
        <Tooltip title={`Add ${title.toLowerCase()}`}>
          <IconButton onClick={onAdd} aria-label={`Add ${title}`}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {hint && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {hint}
        </Typography>
      )}
      <Stack spacing={1}>{children}</Stack>
    </Box>
  );
}

export function RunDialog({ image, open, onClose }: { image: string | null; open: boolean; onClose: () => void }) {
  const { toast } = useFeedback();
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<Port[]>([]);
  const [vols, setVols] = useState<Vol[]>([]);
  const [env, setEnv] = useState<Env[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !image) return;
    setName("");
    setVols([]);
    setEnv([]);
    setPorts([]);
    api
      .get<{ exposedPorts: string[]; volumes: string[] }>(`/images/${encodeURIComponent(image)}/run-defaults`)
      .then((d) => {
        setPorts(d.exposedPorts.map((p) => ({ host: "", container: p, fixed: true })));
        setVols(d.volumes.map((t) => ({ source: "", target: t, readOnly: false })));
      })
      .catch(() => undefined);
  }, [open, image]);

  const run = async () => {
    if (!image) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/images/run", {
        image,
        name,
        // Only publish ports with a host port or ones the user added explicitly.
        ports: ports.filter((p) => p.container && (p.host || !p.fixed)),
        volumes: vols.filter((v) => v.source && v.target),
        env: env.filter((e) => e.key),
      });
      toast("success", `Container ${name || r.id.slice(0, 12)} started`);
      onClose();
      navigate("containers", r.id, "logs");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upd = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, i: number, patch: Partial<T>) => set((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const del = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, i: number) => set((xs) => xs.filter((_, j) => j !== i));
  const remove = (label: string, fn: () => void) => (
    <IconButton onClick={fn} aria-label={`Remove ${label}`}>
      <RemoveCircleOutlineIcon fontSize="small" />
    </IconButton>
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        Run a new container
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO, mt: 0.5 }}>
          {image}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Accordion defaultExpanded disableGutters variant="outlined" sx={{ "&:before": { display: "none" } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="h5">Optional settings</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <TextField fullWidth label="Container name" placeholder="A random name is generated if left empty" value={name} onChange={(e) => setName(e.target.value)} />

            <Section title="Ports" hint="Leave the host port empty to not publish an exposed port; enter 0 for a random port." onAdd={() => setPorts((p) => [...p, { host: "", container: "" }])}>
              {ports.map((p, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <TextField label="Host port" value={p.host} onChange={(e) => upd(setPorts, i, { host: e.target.value.replace(/[^0-9]/g, "") })} sx={{ width: 140 }} />
                  <Typography color="text.secondary">:</Typography>
                  <TextField
                    label="Container port"
                    value={p.container}
                    disabled={p.fixed}
                    onChange={(e) => upd(setPorts, i, { container: e.target.value })}
                    placeholder="80 or 53/udp"
                    sx={{ flex: 1 }}
                  />
                  {!p.fixed ? remove("port", () => del(setPorts, i)) : <Box sx={{ width: 34 }} />}
                </Stack>
              ))}
            </Section>

            <Section title="Volumes" hint="Volume name, Linux path, or Windows path (C:\… is mapped automatically)." onAdd={() => setVols((v) => [...v, { source: "", target: "", readOnly: false }])}>
              {vols.map((v, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <TextField label="Host path / volume" value={v.source} onChange={(e) => upd(setVols, i, { source: e.target.value })} sx={{ flex: 1 }} />
                  <TextField label="Container path" value={v.target} onChange={(e) => upd(setVols, i, { target: e.target.value })} sx={{ flex: 1 }} />
                  <FormControlLabel control={<Checkbox size="small" checked={v.readOnly} onChange={(e) => upd(setVols, i, { readOnly: e.target.checked })} />} label="RO" />
                  {remove("volume", () => del(setVols, i))}
                </Stack>
              ))}
            </Section>

            <Section title="Environment variables" onAdd={() => setEnv((e) => [...e, { key: "", value: "" }])}>
              {env.map((e, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <TextField label="Variable" value={e.key} onChange={(ev) => upd(setEnv, i, { key: ev.target.value })} sx={{ flex: 1 }} />
                  <TextField label="Value" value={e.value} onChange={(ev) => upd(setEnv, i, { value: ev.target.value })} sx={{ flex: 1 }} />
                  {remove("variable", () => del(setEnv, i))}
                </Stack>
              ))}
            </Section>
          </AccordionDetails>
        </Accordion>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void run()} disabled={busy || !image}>
          Run
        </Button>
      </DialogActions>
    </Dialog>
  );
}
