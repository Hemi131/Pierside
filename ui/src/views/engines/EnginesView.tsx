import { useEffect, useRef, useState } from "react";
import {
  Alert,
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
  MenuItem,
  Paper,
  Popover,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ComputerIcon from "@mui/icons-material/Computer";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { MONO } from "../../theme";
import { EngineColorPicker } from "../../components/EngineColor";
import { activateEngine, EngineEntry, EngineList, updateEngine } from "./engineApi";
import { EnginesOverview } from "./EnginesOverview";

interface ProbeResult {
  hostKey: string;
  fingerprint: string;
  mode: "socket" | "stdio";
  docker: { version: string; apiVersion: string; os: string; arch: string };
}

const EMPTY = {
  name: "",
  host: "",
  port: "22",
  user: "",
  privateKey: "",
  passphrase: "",
  password: "",
  socketPath: "/var/run/docker.sock",
  mode: "auto",
  publicHost: "",
  color: "",
};

function AddEngineDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useFeedback();
  const [f, setF] = useState(EMPTY);
  const [auth, setAuth] = useState<"key" | "password">("key");
  // Step 1: the server's host key (fetched without logging in); step 2, once the user trusts it: the
  // connection test, which is the first time a password or key is sent, and only to that server.
  const [hostKey, setHostKey] = useState<{ hostKey: string; fingerprint: string } | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value });
    setProbe(null); // any change invalidates the previous test
    if (k === "host" || k === "port") {
      setHostKey(null); // another server: check its key again
      setTrusted(false);
    }
  };

  const params = () => ({
    name: f.name,
    host: f.host.trim(),
    port: parseInt(f.port, 10) || 22,
    user: f.user.trim(),
    privateKey: auth === "key" ? f.privateKey : "",
    passphrase: auth === "key" ? f.passphrase : "",
    password: auth === "password" ? f.password : "",
    socketPath: f.socketPath.trim(),
    mode: f.mode,
    publicHost: f.publicHost.trim(),
  });

  const checkKey = async () => {
    setBusy(true);
    setError(null);
    setTrusted(false);
    try {
      setHostKey(await api.post<{ hostKey: string; fingerprint: string }>("/engines/host-key", { host: f.host.trim(), port: parseInt(f.port, 10) || 22 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!hostKey || !trusted) return;
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await api.post<ProbeResult>("/engines/probe", { ...params(), hostKey: hostKey.hostKey }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (activate: boolean) => {
    if (!probe) return;
    setBusy(true);
    try {
      const added = await api.post<{ id: string; name: string }>("/engines", { ...params(), hostKey: probe.hostKey, resolvedMode: probe.mode, color: f.color });
      toast("success", `Engine ${added.name} added`);
      setF(EMPTY);
      setHostKey(null);
      setProbe(null);
      setTrusted(false);
      onAdded();
      onClose();
      if (activate) await activateEngine(added.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadKeyFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setF((cur) => ({ ...cur, privateKey: text }));
      setProbe(null);
    });
  };

  const canTest = f.host.trim() && f.user.trim() && (auth === "key" ? f.privateKey.trim() : f.password);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a remote engine over SSH</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1}>
            <TextField label="Host" placeholder="server.example.com or 10.0.0.5" value={f.host} onChange={set("host")} sx={{ flex: 1 }} autoFocus />
            <TextField label="Port" value={f.port} onChange={set("port")} sx={{ width: 90 }} />
            <TextField label="User" placeholder="deploy" value={f.user} onChange={set("user")} sx={{ width: 150 }} />
          </Stack>
          <TextField label="Display name (optional)" placeholder={f.user && f.host ? `${f.user}@${f.host}` : "e.g. Build server"} value={f.name} onChange={set("name")} />
          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Colour: while this engine is active, Pierside is framed in it (e.g. red for production)
            </Typography>
            <EngineColorPicker value={f.color} onChange={(color) => setF((cur) => ({ ...cur, color }))} />
          </Box>

          <Box>
            <Tabs value={auth} onChange={(_, v) => (setAuth(v), setProbe(null))} sx={{ minHeight: 32, mb: 1 }}>
              <Tab value="key" label="Private key" sx={{ minHeight: 32, py: 0 }} />
              <Tab value="password" label="Password" sx={{ minHeight: 32, py: 0 }} />
            </Tabs>
            {auth === "key" ? (
              <Stack spacing={1}>
                <TextField
                  multiline
                  minRows={3}
                  maxRows={6}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
                  value={f.privateKey}
                  onChange={set("privateKey")}
                  InputProps={{ sx: { fontFamily: MONO, fontSize: 11 } }}
                />
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button size="small" startIcon={<UploadFileIcon />} onClick={() => fileInput.current?.click()}>
                    Load key file…
                  </Button>
                  <input ref={fileInput} type="file" hidden onChange={(e) => loadKeyFile(e.target.files?.[0])} />
                  <TextField size="small" type="password" label="Key passphrase (if any)" value={f.passphrase} onChange={set("passphrase")} sx={{ flex: 1 }} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  The key is stored in the extension's own volume (file mode 0600) and is never sent back to the UI. A dedicated key for this purpose is recommended.
                </Typography>
              </Stack>
            ) : (
              <TextField fullWidth type="password" label="Password" value={f.password} onChange={set("password")} helperText="Stored in the extension's volume. Prefer key authentication." />
            )}
          </Box>

          <Box>
            <Button size="small" onClick={() => setAdvanced((a) => !a)}>
              {advanced ? "Hide" : "Show"} advanced settings
            </Button>
            <Collapse in={advanced}>
              <Stack spacing={2} sx={{ mt: 1.5 }}>
                <TextField label="Docker socket path on the host" value={f.socketPath} onChange={set("socketPath")} helperText="Rootless Docker: /run/user/<uid>/docker.sock" />
                <TextField select label="Connection method" value={f.mode} onChange={set("mode")}>
                  <MenuItem value="auto">Automatic (socket forwarding, then docker dial-stdio)</MenuItem>
                  <MenuItem value="socket">SSH socket forwarding</MenuItem>
                  <MenuItem value="stdio">docker system dial-stdio (needs docker CLI on the host)</MenuItem>
                </TextField>
                <TextField label="Host for port links" placeholder={f.host || "same as SSH host"} value={f.publicHost} onChange={set("publicHost")} helperText="Published container ports open as http://<this host>:<port>" />
              </Stack>
            </Collapse>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}
          {hostKey && (
            <Alert severity={probe ? "success" : "info"} icon={<VerifiedUserOutlinedIcon />}>
              {probe && (
                <Typography variant="body1" sx={{ fontWeight: 500, mb: 1 }}>
                  Connected: Docker {probe.docker.version} ({probe.docker.os}/{probe.docker.arch}) via {probe.mode === "socket" ? "socket forwarding" : "docker dial-stdio"}
                </Typography>
              )}
              <Typography variant="body2">Host key fingerprint{probe ? "" : " (nothing has been sent to the server yet)"}:</Typography>
              <Typography sx={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{hostKey.fingerprint}</Typography>
              <FormControlLabel
                sx={{ mt: 1 }}
                control={<Checkbox size="small" checked={trusted} disabled={!!probe} onChange={(e) => setTrusted(e.target.checked)} />}
                label="I've verified this fingerprint and trust this host"
              />
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />
        {busy && <CircularProgress size={18} />}
        {!hostKey ? (
          <Button variant="contained" onClick={() => void checkKey()} disabled={!canTest || busy}>
            Check host key
          </Button>
        ) : !probe ? (
          <Button variant="contained" onClick={() => void test()} disabled={!canTest || !trusted || busy}>
            Test connection
          </Button>
        ) : (
          <>
            <Button variant="outlined" onClick={() => void save(false)} disabled={!trusted || busy}>
              Save
            </Button>
            <Button variant="contained" onClick={() => void save(true)} disabled={!trusted || busy}>
              Save and switch
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

function RenameDialog({ engine, onClose }: { engine: EngineEntry | null; onClose: (changed: boolean) => void }) {
  const { toast } = useFeedback();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (engine) setName(engine.name);
  }, [engine]);
  const fallback = engine ? `${engine.user}@${engine.host}` : "";
  const save = async () => {
    if (!engine) return;
    setBusy(true);
    try {
      await updateEngine(engine.id, { name: name.trim() });
      toast("success", `Engine renamed to ${name.trim() || fallback}`);
      onClose(true);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!engine} onClose={() => onClose(false)} maxWidth="xs" fullWidth>
      <DialogTitle>Rename engine</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Name"
          value={name}
          placeholder={fallback}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void save()}
          helperText={`Leave empty to use ${fallback}`}
          inputProps={{ maxLength: 60 }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button variant="contained" disabled={busy || name.trim() === engine?.name} onClick={() => void save()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ColorCell({ engine, onChanged }: { engine: EngineEntry; onChanged: () => void }) {
  const { toast } = useFeedback();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const color = engine.color ?? "";
  const change = async (next: string) => {
    setAnchor(null);
    try {
      await updateEngine(engine.id, { color: next });
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <>
      <Tooltip title="Change colour">
        <Button
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ minWidth: 0, px: 1, color: "text.secondary" }}
          aria-label={`Colour of ${engine.name}`}
          startIcon={<Box sx={{ width: 14, height: 14, borderRadius: "50%", bgcolor: color || "transparent", border: color ? 0 : 1, borderColor: "divider" }} />}
        >
          {color ? "" : "None"}
        </Button>
      </Tooltip>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}>
        <Box sx={{ p: 2 }}>
          <EngineColorPicker value={color} onChange={(c) => void change(c)} />
        </Box>
      </Popover>
    </>
  );
}

export function EnginesView() {
  const { data, reload } = useResource<EngineList>("/engines");
  const { toast, confirm } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<EngineEntry | null>(null);

  const activate = async (id: string) => {
    setSwitching(id);
    try {
      await activateEngine(id);
    } catch (e) {
      toast("error", (e as Error).message);
      setSwitching(null);
    }
  };

  const remove = async (id: string, name: string) => {
    const ok = await confirm({ title: "Remove engine?", message: `"${name}" and its stored SSH credentials will be removed from Pierside. Nothing changes on the remote host.`, confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/engines/${id}`);
      toast("success", `${name} removed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  return (
    <>
      <PageHeader
        title="Engines"
        subtitle="Manage the local Rancher Desktop engine and remote Docker hosts over SSH. Every view shows the active engine."
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
            Add SSH engine
          </Button>
        }
      />
      {data?.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          The active engine is unreachable: {data.error}
        </Alert>
      )}
      {data && <EnginesOverview engines={data.engines} switching={switching} onSwitch={(id) => void activate(id)} />}
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Engine</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Connection</TableCell>
              <TableCell>Host key</TableCell>
              <TableCell>Colour</TableCell>
              <TableCell align="right" sx={{ width: 200 }}>
                Actions
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!data && (
              <TableRow>
                <TableCell colSpan={6}>
                  <CircularProgress size={20} />
                </TableCell>
              </TableRow>
            )}
            {data?.engines.map((e) => (
              <TableRow key={e.id} hover selected={e.active}>
                <TableCell>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {e.type === "local" ? <ComputerIcon fontSize="small" color="action" /> : <CloudOutlinedIcon fontSize="small" color="action" />}
                    <Typography sx={{ fontWeight: 500 }}>{e.name}</Typography>
                    {e.type === "ssh" && (
                      <Tooltip title="Rename">
                        <IconButton size="small" onClick={() => setRenaming(e)} aria-label={`Rename ${e.name}`}>
                          <EditOutlinedIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {e.active && <Chip size="small" color="success" label="Active" />}
                  </Stack>
                </TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>
                  {e.type === "local" ? "unix:///var/run/docker.sock" : `ssh://${e.user}@${e.host}:${e.port}${e.socketPath}`}
                </TableCell>
                <TableCell>{e.type === "local" ? "Direct" : e.mode === "socket" ? "Socket forwarding" : "docker dial-stdio"}</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 11, maxWidth: 220, wordBreak: "break-all", color: "text.secondary" }}>{e.fingerprint ?? "—"}</TableCell>
                <TableCell sx={{ py: 0.5 }}>
                  <ColorCell engine={e} onChanged={() => void reload()} />
                </TableCell>
                <TableCell align="right" sx={{ py: 0.5 }}>
                  {!e.active && (
                    <Button size="small" variant="outlined" disabled={!!switching} onClick={() => void activate(e.id)} startIcon={switching === e.id ? <CircularProgress size={14} /> : undefined}>
                      Switch
                    </Button>
                  )}
                  {e.type === "ssh" && (
                    <Tooltip title={e.active ? "Switch to another engine first" : "Remove"}>
                      <span>
                        <IconButton disabled={e.active} onClick={() => void remove(e.id, e.name)} aria-label={`Remove ${e.name}`}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        The SSH user needs access to the Docker socket on the host (member of the <code>docker</code> group, or rootless Docker). That access is equivalent to root on
        that host, so use a dedicated key.
      </Typography>
      <AddEngineDialog open={adding} onClose={() => setAdding(false)} onAdded={() => void reload()} />
      <RenameDialog
        engine={renaming}
        onClose={(changed) => {
          setRenaming(null);
          if (changed) void reload();
        }}
      />
    </>
  );
}
