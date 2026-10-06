/**
 * Compose Up / Down / Pull and recreate / View configuration for a remembered project.
 * One dialog host (mounted in Layout) serves every caller through openCompose().
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
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
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import {
  commandLine,
  ComposeProject,
  composeOutput,
  DownOptions,
  downArgs,
  explainComposeError,
  OutputLine,
  projectArgs,
  CANCELLED,
  Run,
  runCompose,
  saveOptions,
  UpOptions,
  upArgs,
} from "../../api/compose";
import { copyText } from "../../utils/format";
import { MONO } from "../../theme";
import { useFeedback } from "../Feedback";

export type ComposeMode = "up" | "down" | "pull" | "config";
export interface ComposeRequest {
  project: ComposeProject;
  engine: "local" | "ssh";
  mode: ComposeMode;
  /** Run straight away with the saved options (one-click Up / Pull and recreate). */
  direct?: boolean;
  onDone?: () => void;
}

// ---- tiny store: one dialog for the whole app ----
let current: (ComposeRequest & { seq: number }) | null = null;
let seq = 0;
const subs = new Set<() => void>();
export function openCompose(req: ComposeRequest) {
  current = { ...req, seq: ++seq };
  subs.forEach((s) => s());
}
function closeCompose() {
  current = null;
  subs.forEach((s) => s());
}
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

export function ComposeDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);
  return req ? <ComposeDialog key={req.seq} req={req} /> : null;
}

/**
 * Just the message of a Compose warning: without a terminal it's a log record
 * (`time="…" level=warning msg="…"`, backslashes escaped), with one `WARN[0000] …`.
 */
function warningText(line: string): string {
  const m = /\bmsg="((?:[^"\\]|\\.)*)"/.exec(line);
  if (m) return m[1].replace(/\\(["\\])/g, "$1");
  return line.replace(/^WARN\[\d+\]\s*/, "");
}

const TITLES: Record<ComposeMode, string> = { up: "Compose up", down: "Compose down", pull: "Pull and recreate", config: "Compose configuration" };
const MAX_OUTPUT = 3000;

function ComposeDialog({ req }: { req: ComposeRequest }) {
  const { project: p, engine, mode } = req;
  const { toast } = useFeedback();
  const [up, setUp] = useState<UpOptions>({ ...(p.options.up ?? {}), ...(mode === "pull" ? { pull: true } : {}) });
  const [down, setDown] = useState<DownOptions>(p.options.down ?? {});
  const [advanced, setAdvanced] = useState(!!(up.envFile || up.extra || up.profiles?.length || down.extra));
  const [services, setServices] = useState<string[] | null>(null);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"options" | "running" | "done">("options");
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const run = useRef<Run | null>(null);
  const started = useRef(false);
  const outBox = useRef<HTMLDivElement>(null);

  const args = mode === "down" ? downArgs(p, down, up) : mode === "config" ? [...projectArgs(p, up), "config"] : upArgs(p, up);
  const cwd = p.workingDir;

  // Services and profiles for the option pickers (also a quick check that the files are still there).
  useEffect(() => {
    if (mode !== "up" || req.direct) return;
    let alive = true;
    composeOutput(engine, [...projectArgs(p, up), "config", "--services"], cwd)
      .then((s) => alive && setServices(s.filter(Boolean)))
      .catch((e) => alive && setProbeError((e as Error).message));
    composeOutput(engine, [...projectArgs(p), "config", "--profiles"], cwd)
      .then((s) => alive && setProfiles(s.filter(Boolean)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => {
    setPhase("running");
    setOutput([]);
    setExitCode(null);
    if (mode !== "config") {
      // Remember the flags for next time (one-click Up uses them), but not a one-off service selection.
      const { services: _s, noDeps: _n, ...keep } = up;
      const savedUp = mode === "pull" ? { ...keep, pull: p.options.up?.pull } : keep;
      void saveOptions(p.name, { up: savedUp, down }).catch(() => undefined);
    }
    const r = runCompose(engine, args, cwd, (l) => setOutput((o) => (o.length >= MAX_OUTPUT ? [...o.slice(o.length - MAX_OUTPUT + 1), l] : [...o, l])));
    run.current = r;
    r.done
      .then((code) => {
        setExitCode(code);
        setPhase("done");
        if (code === 0 && req.direct) {
          toast("success", `${TITLES[mode]}: ${p.name} done`);
          closeCompose();
        }
        req.onDone?.();
      })
      .catch((e) => {
        setOutput((o) => [...o, { s: "stderr", m: (e as Error).message }]);
        setExitCode(-1);
        setPhase("done");
      });
  };

  // Direct actions and "View configuration" start immediately, exactly once (effects run twice in
  // React's development mode). No cancel on unmount: the dialog can't be closed while a command runs.
  useEffect(() => {
    if (started.current || !(req.direct || mode === "config")) return;
    started.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = outBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const check = (label: string, value: boolean | undefined, set: (v: boolean) => void, hint?: string) => (
    <FormControlLabel
      control={<Checkbox size="small" checked={!!value} onChange={(e) => set(e.target.checked)} />}
      label={
        <span>
          {label}
          {hint && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.75, fontFamily: MONO, fontSize: 11.5 }}>
              {hint}
            </Typography>
          )}
        </span>
      }
    />
  );

  const running = phase === "running";
  const ok = phase === "done" && exitCode === 0;
  const where = engine === "ssh" ? "the server" : "this computer";
  const hint = phase === "done" && !ok && exitCode !== CANCELLED ? explainComposeError(output.map((l) => l.m), p, where) : null;
  const probeHint = probeError ? explainComposeError([probeError], p, where) : null;
  // The configuration view shows the file itself (stdout); Compose's warnings on stderr, like
  // "the attribute `version` is obsolete", go in a note above it. If it failed, show everything.
  const configView = mode === "config" && ok;
  const shown = configView ? output.filter((l) => l.s === "stdout") : output;
  const warnings = configView ? output.filter((l) => l.s === "stderr" && l.m.trim()).map((l) => warningText(l.m)) : [];

  return (
    <Dialog open onClose={running ? undefined : closeCompose} maxWidth="md" fullWidth>
      <DialogTitle>
        {TITLES[mode]}: {p.name}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all", mb: 1.5 }}>
          {p.configFiles.join(", ") || "No compose file recorded"}
          {engine === "ssh" ? " (on the server)" : ""}
        </Typography>

        {phase === "options" && mode === "up" && (
          <Stack spacing={0.5}>
            {probeError && (
              <Alert severity="error" sx={{ mb: 1 }}>
                {probeHint ?? "Couldn't read the compose file."}
                <Box component="span" sx={{ display: "block", fontFamily: MONO, fontSize: 12, mt: 0.5, whiteSpace: "pre-wrap" }}>
                  {probeError}
                </Box>
              </Alert>
            )}
            {check("Build images before starting", up.build, (v) => setUp({ ...up, build: v }), "--build")}
            {check("Pull newer images", up.pull, (v) => setUp({ ...up, pull: v }), "--pull always")}
            {check("Recreate containers even if unchanged", up.forceRecreate, (v) => setUp({ ...up, forceRecreate: v }), "--force-recreate")}
            {check("Remove containers of services no longer in the file", up.removeOrphans, (v) => setUp({ ...up, removeOrphans: v }), "--remove-orphans")}
            <Autocomplete
              multiple
              size="small"
              options={services ?? []}
              loading={services === null && !probeError}
              value={up.services ?? []}
              onChange={(_, v) => setUp({ ...up, services: v })}
              renderTags={(v, getProps) => v.map((s, i) => <Chip size="small" label={s} {...getProps({ index: i })} key={s} />)}
              renderInput={(params) => <TextField {...params} label="Only these services" placeholder={up.services?.length ? "" : "All services"} />}
              sx={{ mt: 1 }}
            />
            {!!up.services?.length && check("Don't start their dependencies", up.noDeps, (v) => setUp({ ...up, noDeps: v }), "--no-deps")}
            <Box>
              <Button size="small" onClick={() => setAdvanced((a) => !a)} sx={{ mt: 0.5 }}>
                {advanced ? "Hide" : "Show"} more options
              </Button>
              <Collapse in={advanced}>
                <Stack spacing={2} sx={{ mt: 1.5 }}>
                  {profiles.length > 0 && (
                    <Autocomplete
                      multiple
                      size="small"
                      options={profiles}
                      value={up.profiles ?? []}
                      onChange={(_, v) => setUp({ ...up, profiles: v })}
                      renderInput={(params) => <TextField {...params} label="Profiles" helperText="--profile" />}
                    />
                  )}
                  <TextField size="small" label="Env file" placeholder=".env (default)" value={up.envFile ?? ""} onChange={(e) => setUp({ ...up, envFile: e.target.value })} helperText="--env-file, relative to the project folder" />
                  <TextField size="small" label="Extra arguments for up" placeholder="--wait --timeout 30" value={up.extra ?? ""} onChange={(e) => setUp({ ...up, extra: e.target.value })} InputProps={{ sx: { fontFamily: MONO } }} />
                </Stack>
              </Collapse>
            </Box>
          </Stack>
        )}

        {phase === "options" && mode === "down" && (
          <Stack spacing={0.5}>
            <Typography sx={{ mb: 1 }}>Stops and removes the project's containers and networks. Pierside remembers the project, so you can bring it up again.</Typography>
            {check("Also delete the project's volumes (their data is lost)", down.volumes, (v) => setDown({ ...down, volumes: v }), "--volumes")}
            {down.volumes && (
              <Alert severity="warning" sx={{ my: 0.5 }}>
                Named and anonymous volumes declared by this project will be deleted with all their data.
              </Alert>
            )}
            {check("Also delete images built by the project", down.rmi, (v) => setDown({ ...down, rmi: v }), "--rmi local")}
            {check("Remove containers of services no longer in the file", down.removeOrphans, (v) => setDown({ ...down, removeOrphans: v }), "--remove-orphans")}
            <TextField size="small" label="Extra arguments for down" value={down.extra ?? ""} onChange={(e) => setDown({ ...down, extra: e.target.value })} InputProps={{ sx: { fontFamily: MONO } }} sx={{ mt: 1 }} />
          </Stack>
        )}

        {mode !== "config" && (
          <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mt: 2, p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
            <Typography sx={{ fontFamily: MONO, fontSize: 12, flex: 1, wordBreak: "break-all" }}>{commandLine(args)}</Typography>
            <Tooltip title="Copy command">
              <IconButton size="small" onClick={() => void copyText(commandLine(args)).then(() => toast("success", "Command copied"))} aria-label="Copy command">
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        )}

        {hint && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {hint}
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Compose warned:
            {warnings.map((w, i) => (
              <Box key={i} component="span" sx={{ display: "block", fontFamily: MONO, fontSize: 12, mt: 0.5 }}>
                {w}
              </Box>
            ))}
          </Alert>
        )}
        {phase !== "options" && (
          <Box sx={{ mt: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              {running && <CircularProgress size={16} />}
              {ok && <CheckCircleOutlineIcon color="success" fontSize="small" />}
              {phase === "done" && !ok && <ErrorOutlineIcon color="error" fontSize="small" />}
              <Typography variant="body2" color={phase === "done" && !ok ? "error" : "text.secondary"}>
                {running ? "Running…" : ok ? "Done" : exitCode === CANCELLED ? "Stopped" : `Failed${exitCode != null && exitCode >= 0 ? ` (exit code ${exitCode})` : ""}`}
              </Typography>
            </Stack>
            <Box
              ref={outBox}
              sx={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5, p: 1.25, borderRadius: 1, border: 1, borderColor: "divider", bgcolor: "background.default", height: mode === "config" ? 420 : 260, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {output.length === 0 && running && <Typography color="text.secondary">Waiting for output…</Typography>}
              {shown.map((l, i) => (
                <Box key={i} sx={{ color: mode !== "config" && /\b(error|failed)\b/i.test(l.m) ? "error.main" : undefined }}>
                  {l.m || " "}
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {running ? (
          <Button variant="outlined" color="error" onClick={() => run.current?.cancel()}>
            Stop
          </Button>
        ) : (
          <Button variant="outlined" onClick={closeCompose}>
            {phase === "options" ? "Cancel" : "Close"}
          </Button>
        )}
        {phase === "options" && (
          <Button variant="contained" color={mode === "down" ? "error" : "primary"} onClick={start}>
            {mode === "down" ? "Down" : mode === "pull" ? "Pull and recreate" : "Up"}
          </Button>
        )}
        {phase === "done" && !ok && mode !== "config" && (
          <Button variant="contained" onClick={() => setPhase("options")}>
            Change options
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
