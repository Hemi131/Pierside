/** Copy an image from the active engine to another engine: `docker save` streamed into `docker load`. */
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, MenuItem, Stack, TextField, Typography } from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import { api } from "../../api/ddclient";
import { useFeedback } from "../../components/Feedback";
import { navigate } from "../../hooks/useRoute";
import { formatBytes } from "../../utils/format";
import { MONO } from "../../theme";
import type { EngineList } from "../engines/engineApi";

interface CopyJob {
  id: string;
  image: string;
  targetName: string;
  imageArch: string;
  targetEngine?: { os: string; arch: string; version: string };
  state: "running" | "done" | "error" | "cancelled";
  phase: "connecting" | "transferring" | "loading";
  bytes: number;
  error: string | null;
  loaded: string[];
  elapsed?: number;
}

const POLL_MS = 600;
const PHASE: Record<CopyJob["phase"], string> = {
  connecting: "Connecting to the target engine…",
  transferring: "Streaming the image…",
  loading: "Loading it on the target…",
};

export function CopyToEngineDialog({ image, open, onClose }: { image: string | null; open: boolean; onClose: () => void }) {
  const { toast } = useFeedback();
  const [engines, setEngines] = useState<EngineList | null>(null);
  const [target, setTarget] = useState("");
  const [job, setJob] = useState<CopyJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (job?.state !== "running") setJob(null);
    api
      .get<EngineList>("/engines")
      .then((l) => {
        setEngines(l);
        const others = l.engines.filter((e) => !e.active);
        setTarget((t) => (others.some((e) => e.id === t) ? t : (others[0]?.id ?? "")));
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Poll the running job; keeps going after the dialog closes and reports the result as a toast then.
  const jobId = job?.state === "running" ? job.id : null;
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.get<CopyJob>(`/images/copy/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.state !== "running") {
          if (!openRef.current) {
            if (j.state === "done") toast("success", `${j.image} copied to ${j.targetName}`);
            else if (j.state === "error") toast("error", `Copying ${j.image} to ${j.targetName} failed: ${j.error}`);
          }
          return;
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
        return;
      }
      if (!stop) window.setTimeout(() => void tick(), POLL_MS);
    };
    const first = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearTimeout(first);
    };
  }, [jobId, toast]);

  const start = async () => {
    if (!image || !target) return;
    setError(null);
    try {
      setJob(await api.post<CopyJob>("/images/copy", { image, target }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await api.del(`/images/copy/${job.id}`);
    } catch {
      /* finished meanwhile */
    }
  };

  const others = engines?.engines.filter((e) => !e.active) ?? [];
  const running = job?.state === "running";
  const targetArch = job?.targetEngine ? `${job.targetEngine.os}/${job.targetEngine.arch}` : null;
  const archMismatch = !!(job && targetArch && job.imageArch.split("/")[1] !== job.targetEngine!.arch);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Copy image to another engine</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Box>
            <Typography variant="body2" color="text.secondary">
              Image
            </Typography>
            <Typography sx={{ fontFamily: MONO, wordBreak: "break-all" }}>{image}</Typography>
          </Box>
          {engines && others.length === 0 ? (
            <Alert
              severity="info"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    onClose();
                    navigate("engines");
                  }}
                >
                  Engines
                </Button>
              }
            >
              There's no other engine to copy to. Add a remote engine over SSH first.
            </Alert>
          ) : (
            <TextField select label="Copy to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={running || !engines}>
              {others.map((e) => (
                <MenuItem key={e.id} value={e.id}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {e.type === "ssh" ? <CloudOutlinedIcon fontSize="small" /> : <ComputerIcon fontSize="small" />}
                    <span>{e.name}</span>
                    {e.type === "ssh" && (
                      <Typography variant="body2" color="text.secondary">
                        {e.user}@{e.host}
                      </Typography>
                    )}
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
          )}
          <Typography variant="body2" color="text.secondary">
            The image is streamed from the engine you're on straight into the target (<code>docker save</code> → <code>docker load</code>), no registry needed. Tags come along.
          </Typography>
          {job && (
            <Box>
              {running && (
                <>
                  <Typography variant="body2" sx={{ mb: 0.75 }}>
                    {PHASE[job.phase]} {job.bytes > 0 && <b>{formatBytes(job.bytes)}</b>}
                    {job.bytes > 0 ? " sent" : ""}
                  </Typography>
                  <LinearProgress />
                </>
              )}
              {job.state === "done" && (
                <Alert severity="success">
                  Copied to {job.targetName}: {formatBytes(job.bytes)} in {job.elapsed}s.
                  {job.loaded.length > 0 && (
                    <Box component="span" sx={{ display: "block", fontFamily: MONO, fontSize: 12, mt: 0.5 }}>
                      {job.loaded.join(", ")}
                    </Box>
                  )}
                </Alert>
              )}
              {job.state === "error" && <Alert severity="error">{job.error}</Alert>}
              {job.state === "cancelled" && <Alert severity="info">Copy cancelled.</Alert>}
              {archMismatch && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  The image is built for {job.imageArch}, but {job.targetName} runs {targetArch}. It may not start there.
                </Alert>
              )}
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {running ? (
          <>
            <Button variant="outlined" color="error" onClick={() => void cancel()}>
              Cancel copy
            </Button>
            <Button variant="outlined" onClick={onClose}>
              Continue in background
            </Button>
          </>
        ) : (
          <>
            <Button variant="outlined" onClick={onClose}>
              {job?.state === "done" ? "Close" : "Cancel"}
            </Button>
            {job?.state !== "done" && (
              <Button variant="contained" onClick={() => void start()} disabled={!target || !image} startIcon={!engines ? <CircularProgress size={14} /> : undefined}>
                Copy
              </Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
