/**
 * AI access: connections that let an AI assistant (Claude Code or any MCP client) reach containers
 * through Pierside's MCP server, each with its own limits. The backend enforces the limits
 * (backend/app/services/mcp_access.py, mcp_tools.py); this page only edits them.
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
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
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import KeyOutlinedIcon from "@mui/icons-material/KeyOutlined";
import TerminalIcon from "@mui/icons-material/Terminal";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { EmptyState, PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { usePersistentState } from "../../hooks/usePersistentState";
import { MONO } from "../../theme";
import { copyText, relativeTime } from "../../utils/format";
import type { EngineList } from "../engines/engineApi";

type Action =
  | "logs"
  | "inspect"
  | "files"
  | "filewrite"
  | "control"
  | "manage"
  | "exec"
  | "images"
  | "imagepull"
  | "volumes"
  | "networks"
  | "netconnect"
  | "ports"
  | "forward"
  | "system"
  | "swarm"
  | "compose"
  | "create"
  | "cleanup"
  | "swarmctl";

export type Confirm = "all" | "destructive" | "none";

export type Trust = "none" | "day" | "week" | "month" | "always";

interface Profile {
  id: string;
  name: string;
  /** How the assistant proves it may use this: the user's approval in Pierside, or a stored token. */
  auth: "approval" | "token";
  tokenHint: string;
  trustAlways: boolean;
  trustedUntil: number | null;
  confirm: Confirm;
  enabled: boolean;
  /** Everything allowed, on the connection's engines. */
  god: boolean;
  hostMounts: boolean;
  mayAsk: boolean;
  allEngines: boolean;
  engines: string[];
  allContainers: boolean;
  projects: string[];
  containers: string[];
  actions: Action[];
  filePaths: string[];
  showEnv: boolean;
  maxLogLines: number;
  lastUsedAt: number | null;
}

const RESULT: Record<Activity["outcome"], { label: string; color: "default" | "warning" | "error" | "info"; variant?: "outlined" }> = {
  ok: { label: "OK", color: "default" },
  denied: { label: "Refused", color: "warning" },
  error: { label: "Failed", color: "error" },
  running: { label: "Running…", color: "info", variant: "outlined" },
  waiting: { label: "Waiting for you", color: "warning", variant: "outlined" },
};

interface Activity {
  at: number;
  profile: string;
  tool: string;
  target: string;
  /** running and waiting (for the user's answer) are calls still under way. */
  outcome: "ok" | "denied" | "error" | "running" | "waiting";
  detail: string;
}

export interface AccessRequest {
  id: string;
  /** session: may this assistant session use the connection; call: may this call run; access: may the session have more. */
  kind: "session" | "call" | "access";
  /** For "access": what is asked for, one line each. */
  items?: string[];
  profile: string;
  code: string;
  tool: string;
  target: string;
  detail: string;
  createdAt: number;
}

interface EngineContainers {
  engine: string;
  name: string;
  containers: { name: string; project: string | null; state: string }[];
  error: string | null;
}

interface AccessData {
  profiles: Profile[];
  maxLogLines: number;
  container: string;
  activity: Activity[];
}

interface ActionInfo {
  key: Action;
  label: string;
  help: string;
  /** Changes or deletes things. */
  risky?: boolean;
}

// Grouped as in the dialog. "Shared containers" below means the ones chosen under "Which containers";
// the engine-wide groups are not limited by that choice.
const ACTION_GROUPS: { title: string; note?: string; actions: ActionInfo[] }[] = [
  {
    title: "Shared containers",
    actions: [
      { key: "logs", label: "Read logs", help: "Recent log lines of containers and whole Compose projects." },
      { key: "inspect", label: "See configuration and state", help: "Image, command, ports, mounts, networks, labels, the names of environment variables; live stats, processes, health checks, changed files." },
      { key: "control", label: "Start, stop, restart", help: "Also pause, resume and kill; containers and whole Compose projects.", risky: true },
      { key: "manage", label: "Create, rename, delete", help: "Run new containers from images, recreate, rename and delete containers.", risky: true },
      { key: "compose", label: "Compose up and down", help: "Read a project's Compose files and resolved configuration, bring it up or down. SSH engines only.", risky: true },
      {
        key: "exec",
        label: "Run commands",
        help: "Any shell command inside the containers. This can read and change everything in them, so the file path limits no longer protect anything.",
        risky: true,
      },
    ],
  },
  {
    title: "Files",
    actions: [
      { key: "files", label: "Read files", help: "List, read and search text files, only under the paths listed below." },
      { key: "filewrite", label: "Change files", help: "Write, create, delete and change permissions, under the same paths.", risky: true },
    ],
  },
  {
    title: "The whole engine",
    note: "These are not limited to the shared containers.",
    actions: [
      { key: "images", label: "See images", help: "List images, their details and layers." },
      { key: "imagepull", label: "Pull images", help: "Download images to the engine.", risky: true },
      { key: "volumes", label: "See volumes", help: "List volumes and their details. Reading their files also needs Read files and its paths." },
      { key: "networks", label: "See networks", help: "List networks and what is attached." },
      { key: "netconnect", label: "Connect networks", help: "Connect shared containers to a network or disconnect them.", risky: true },
      { key: "ports", label: "See ports", help: "Published ports and Pierside's port forwards of the shared containers." },
      { key: "forward", label: "Forward ports", help: "Make a shared container's port reachable on this computer.", risky: true },
      { key: "system", label: "Engine info", help: "Docker version, resources, disk usage and recent engine events." },
      { key: "swarm", label: "See Swarm", help: "Nodes, stacks, services, tasks, service logs, and the names of secrets and configs." },
      { key: "swarmctl", label: "Change Swarm services", help: "Scale, restart, change the image, roll back and remove services; remove stacks.", risky: true },
      { key: "create", label: "Create volumes and networks", help: "New named volumes and networks.", risky: true },
      { key: "cleanup", label: "Delete and clean up", help: "Delete images, volumes and networks, and prune what is unused, including the build cache.", risky: true },
    ],
  },
];
const ACTIONS = ACTION_GROUPS.flatMap((g) => g.actions);

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "containers";

function scopeText(p: Profile): string {
  if (p.god || p.allContainers) return "All containers";
  const parts = [...p.projects.map((x) => `project ${x}`), ...p.containers];
  return parts.length ? parts.join(", ") : "None yet";
}

function trustText(p: Profile): string {
  if (p.auth === "token") return `Access token …${p.tokenHint}`;
  if (p.trustAlways) return "Always trusted";
  if (p.trustedUntil && p.trustedUntil * 1000 > Date.now()) return `Trusted until ${new Date(p.trustedUntil * 1000).toLocaleDateString()}`;
  return "Asks you each session";
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const { toast } = useFeedback();
  return (
    <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ p: 1.5, borderRadius: 1, bgcolor: "action.hover" }}>
      <Box component="pre" sx={{ m: 0, flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {text}
      </Box>
      <Tooltip title="Copy">
        <IconButton size="small" onClick={() => void copyText(text).then(() => toast("success", `${label} copied`))} aria-label={`Copy ${label}`}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/**
 * The command that connects an assistant. With a token it can be shown only once (the token isn't
 * stored); without one it holds no secret and can be shown any time.
 */
function ConnectDialog({ shown, container, onClose }: { shown: { profile: Profile; token: string | null } | null; container: string; onClose: () => void }) {
  const [tab, setTab] = useState(0);
  // Whether the Claude Code / Devin CLI command registers the server for all the user's projects or only one.
  const [everywhere, setEverywhere] = usePersistentState("access.allProjects", true);
  if (!shown) return null;
  const name = `pierside-${slug(shown.profile.name)}`;
  const backend = container || "<pierside backend container>";
  const args = shown.token
    ? ["exec", "-i", "-e", `PIERSIDE_MCP_TOKEN=${shown.token}`, backend, "python", "-m", "app.mcp_stdio"]
    : ["exec", "-i", backend, "python", "-m", "app.mcp_stdio", "--profile", shown.profile.id];
  const claude = `claude mcp add ${everywhere ? "--scope user " : ""}${name} -- docker ${args.join(" ")}`;
  const devin = `devin mcp add ${everywhere ? "-s user " : ""}${name} -- docker ${args.join(" ")}`;
  const cli = tab === 0 ? { app: "Claude Code", command: claude } : { app: "Devin CLI", command: devin };
  const json = JSON.stringify({ mcpServers: { [name]: { command: "docker", args } } }, null, 2);
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Connect "{shown.profile.name}"</DialogTitle>
      <DialogContent>
        {shown.token ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copy this now. The access token inside it is shown only once; if you lose it, create a new one with the key button.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ mb: 2 }}>
            This command contains no secret. When the assistant first uses the connection, Pierside asks you to allow it.
          </Alert>
        )}
        <Tabs value={tab} onChange={(_e, v: number) => setTab(v)} sx={{ mb: 2, minHeight: 36 }}>
          <Tab label="Claude Code" sx={{ minHeight: 36 }} />
          <Tab label="Devin CLI" sx={{ minHeight: 36 }} />
          <Tab label="Other MCP clients" sx={{ minHeight: 36 }} />
        </Tabs>
        {tab < 2 ? (
          <>
            <Typography sx={{ mb: 1 }}>
              {everywhere
                ? `Run this in a terminal on this computer. ${cli.app} then has the access in all your projects:`
                : `Run this in a terminal on this computer, inside the project folder where ${cli.app} should have the access:`}
            </Typography>
            <CopyBlock text={cli.command} label="Command" />
            <FormControlLabel
              sx={{ mt: 1 }}
              control={<Switch size="small" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />}
              label="Available in all my projects"
            />
            <Typography variant="body2" color="text.secondary">
              {tab === 0 ? (
                <>
                  Then start Claude Code and check <code>/mcp</code>.
                </>
              ) : (
                <>
                  Then check with <code>devin mcp list</code>.
                </>
              )}
            </Typography>
          </>
        ) : (
          <>
            <Typography sx={{ mb: 1 }}>Add this server to the client's MCP configuration (for example a project's <code>.mcp.json</code>):</Typography>
            <CopyBlock text={json} label="Configuration" />
          </>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          The assistant talks to Pierside through <code>docker exec</code>, so Rancher Desktop and Pierside must be running. The connection keeps working after
          Pierside is updated; it stops if you remove it here or reinstall Pierside from a different image.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface Form {
  name: string;
  god: boolean;
  hostMounts: boolean;
  mayAsk: boolean;
  allEngines: boolean;
  engines: string[];
  allContainers: boolean;
  /** Ticked in the list (exact names). */
  pickedProjects: string[];
  pickedContainers: string[];
  /** Typed patterns, one per line. */
  projects: string;
  containers: string;
  actions: Action[];
  filePaths: string;
  showEnv: boolean;
  maxLogLines: string;
  auth: "approval" | "token";
  trust: Trust;
  confirm: Confirm;
}

const emptyForm: Form = {
  name: "",
  god: false,
  hostMounts: false,
  mayAsk: true,
  allEngines: false,
  engines: ["local"],
  allContainers: false,
  pickedProjects: [],
  pickedContainers: [],
  projects: "",
  containers: "",
  actions: ["logs"],
  filePaths: "",
  showEnv: false,
  maxLogLines: "500",
  auth: "approval",
  trust: "none",
  confirm: "all",
};

const TRUST_LABELS: { value: Trust; label: string }[] = [
  { value: "none", label: "Ask me each time an assistant session starts" },
  { value: "week", label: "Trust for 7 days" },
  { value: "month", label: "Trust for 30 days" },
  { value: "always", label: "Always trust (never ask)" },
];

function EditDialog({
  open,
  editing,
  engines,
  maxLogLines,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Profile | null;
  engines: EngineList | null;
  maxLogLines: number;
  onClose: () => void;
  onSaved: (connect: { profile: Profile; token: string | null } | null) => void;
}) {
  const { toast } = useFeedback();
  const [f, setF] = useState<Form>(emptyForm);
  // Trust is only sent when the user changes it, so saving other edits doesn't restart a running period.
  const [trustTouched, setTrustTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF(
      editing
        ? {
            name: editing.name,
            god: editing.god,
            hostMounts: !!editing.hostMounts,
            mayAsk: editing.mayAsk !== false,
            allEngines: editing.allEngines,
            engines: editing.engines,
            allContainers: editing.allContainers,
            pickedProjects: [],
            pickedContainers: [],
            projects: editing.projects.join("\n"),
            containers: editing.containers.join("\n"),
            actions: editing.actions,
            filePaths: editing.filePaths.join("\n"),
            showEnv: editing.showEnv,
            maxLogLines: String(editing.maxLogLines),
            auth: editing.auth,
            trust: editing.trustAlways ? "always" : editing.trustedUntil && editing.trustedUntil * 1000 > Date.now() ? "month" : "none",
            confirm: editing.confirm,
          }
        : emptyForm,
    );
    setTrustTouched(false);
  }, [open, editing]);

  const has = (a: Action) => f.actions.includes(a);
  const toggle = (a: Action) => setF((cur) => ({ ...cur, actions: cur.actions.includes(a) ? cur.actions.filter((x) => x !== a) : [...cur.actions, a] }));
  const badPath = lines(f.filePaths).find((p) => !p.startsWith("/"));
  const noScope = !f.god && !f.allContainers && !lines(f.projects).length && !lines(f.containers).length && !f.pickedProjects.length && !f.pickedContainers.length;
  const noEngine = !f.allEngines && f.engines.length === 0;
  const valid = !!f.name.trim() && (f.god || !badPath) && !noEngine;
  const engineList = engines?.engines ?? [{ id: "local", name: "Local (Rancher Desktop)" }];
  const toggleEngine = (id: string) => setF((cur) => ({ ...cur, engines: cur.engines.includes(id) ? cur.engines.filter((x) => x !== id) : [...cur.engines, id] }));
  const anyRisky = f.god || ACTIONS.some((a) => a.risky && has(a.key));

  const engineIds = (f.allEngines ? engineList.map((e) => e.id) : f.engines).join(",");
  const [available, setAvailable] = useState<EngineContainers[] | null>(null);
  const sorted = useRef(false);
  useEffect(() => {
    if (!open || f.god || f.allContainers || !engineIds) return;
    let stale = false;
    setAvailable(null);
    api
      .get<EngineContainers[]>(`/mcp-access/containers?engines=${encodeURIComponent(engineIds)}`)
      .then((r) => !stale && setAvailable(r))
      .catch(() => !stale && setAvailable([]));
    return () => {
      stale = true;
    };
  }, [open, f.god, f.allContainers, engineIds]);
  useEffect(() => {
    if (open) sorted.current = false;
  }, [open, editing]);
  useEffect(() => {
    // Once per opening: names saved earlier that exist in the list become ticks; the rest stay as patterns.
    if (!available || sorted.current) return;
    sorted.current = true;
    const all = available.flatMap((e) => e.containers);
    const projects = new Set(all.map((c) => c.project).filter(Boolean) as string[]);
    const names = new Set(all.map((c) => c.name));
    setF((cur) => ({
      ...cur,
      pickedProjects: [...new Set([...cur.pickedProjects, ...lines(cur.projects).filter((x) => projects.has(x))])],
      pickedContainers: [...new Set([...cur.pickedContainers, ...lines(cur.containers).filter((x) => names.has(x))])],
      projects: lines(cur.projects).filter((x) => !projects.has(x)).join("\n"),
      containers: lines(cur.containers).filter((x) => !names.has(x)).join("\n"),
    }));
  }, [available]);
  const flip = (key: "pickedProjects" | "pickedContainers", name: string) =>
    setF((cur) => ({ ...cur, [key]: cur[key].includes(name) ? cur[key].filter((x) => x !== name) : [...cur[key], name] }));

  const save = async () => {
    setBusy(true);
    const body = {
      name: f.name.trim(),
      god: f.god,
      hostMounts: f.god && f.hostMounts,
      mayAsk: f.mayAsk,
      allEngines: f.allEngines,
      engines: f.engines,
      allContainers: f.allContainers,
      projects: [...new Set([...f.pickedProjects, ...lines(f.projects)])],
      containers: [...new Set([...f.pickedContainers, ...lines(f.containers)])],
      actions: f.actions,
      filePaths: lines(f.filePaths),
      showEnv: f.showEnv,
      maxLogLines: Number(f.maxLogLines) || 500,
      auth: f.auth,
      confirm: f.confirm,
      ...(f.auth === "approval" && (trustTouched || !editing) ? { trust: f.trust } : {}),
    };
    try {
      if (editing) {
        const r = await api.put<{ profile: Profile; token: string | null }>(`/mcp-access/${editing.id}`, body);
        toast("success", `${body.name} saved`);
        // Switching to a token creates one, and switching away needs a new command: show it.
        onSaved(r.token || editing.auth !== f.auth ? r : null);
      } else {
        onSaved(await api.post<{ profile: Profile; token: string | null }>("/mcp-access", body));
      }
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? "Edit connection" : "New connection"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" placeholder="e.g. webshop logs" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus fullWidth inputProps={{ maxLength: 60 }} />

          <Box sx={{ p: 1.5, border: 1, borderColor: f.god ? "error.main" : "divider", borderRadius: 1 }}>
            <FormControlLabel
              sx={{ alignItems: "flex-start", m: 0 }}
              control={<Switch size="small" color="error" checked={f.god} onChange={(e) => setF({ ...f, god: e.target.checked })} sx={{ mt: 0.25, mr: 1 }} />}
              label={
                <>
                  <Typography component="span" sx={{ fontWeight: 600 }}>
                    Allow everything
                  </Typography>
                  <Typography variant="body2" color={f.god ? "error.main" : "text.secondary"}>
                    On the engines chosen below: every container, every action, all files, environment values visible. Only the containers, volumes and
                    networks of Pierside, other extensions and Kubernetes stay off limits.
                  </Typography>
                </>
              }
            />
            {f.god && (
              <FormControlLabel
                sx={{ alignItems: "flex-start", m: 0, mt: 1.5 }}
                control={<Switch size="small" color="error" checked={f.hostMounts} onChange={(e) => setF({ ...f, hostMounts: e.target.checked })} sx={{ mt: 0.25, mr: 1 }} />}
                label={
                  <>
                    <Typography component="span" sx={{ fontWeight: 600 }}>
                      Allow mounting host system folders
                    </Typography>
                    <Typography variant="body2" color={f.hostMounts ? "error.main" : "text.secondary"}>
                      New containers may mount the Docker socket and folders such as /var/lib/docker or /etc of the engine's machine. This is full control of the
                      engine: it also reaches what is otherwise off limits, including Pierside's saved SSH keys and passwords.
                    </Typography>
                  </>
                }
              />
            )}
          </Box>

          <Box>
            <Typography sx={{ fontWeight: 600 }}>Which engines</Typography>
            <FormControlLabel
              control={<Switch size="small" checked={f.allEngines} onChange={(e) => setF({ ...f, allEngines: e.target.checked })} />}
              label="All engines, including ones added later"
            />
            {!f.allEngines && (
              <Stack sx={{ ml: 0.5 }}>
                {engineList.map((e) => (
                  <FormControlLabel
                    key={e.id}
                    control={<Checkbox size="small" checked={f.engines.includes(e.id)} onChange={() => toggleEngine(e.id)} sx={{ py: 0.25 }} />}
                    label={e.name + (f.engines[0] === e.id && f.engines.length > 1 ? " (default)" : "")}
                  />
                ))}
                {noEngine && (
                  <Typography variant="body2" color="error.main">
                    Choose at least one engine.
                  </Typography>
                )}
              </Stack>
            )}
          </Box>

          {!f.god && (
          <Box>
            <Typography sx={{ fontWeight: 600 }}>Which containers</Typography>
            <FormControlLabel
              control={<Switch size="small" checked={f.allContainers} onChange={(e) => setF({ ...f, allContainers: e.target.checked })} />}
              label="All containers on these engines"
            />
            {!f.allContainers && (
              <>
                <Box sx={{ mt: 1, border: 1, borderColor: "divider", borderRadius: 1, maxHeight: 240, overflow: "auto", px: 1.5, py: 0.5 }}>
                  {available === null ? (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                      Loading containers…
                    </Typography>
                  ) : (
                    available.map((eng) => {
                      const projects = [...new Set(eng.containers.map((c) => c.project).filter(Boolean) as string[])];
                      const loose = eng.containers.filter((c) => !c.project);
                      return (
                        <Box key={eng.engine} sx={{ py: 0.5 }}>
                          {available.length > 1 && (
                            <Typography variant="body2" sx={{ fontWeight: 600, color: "text.secondary" }}>
                              {eng.name}
                            </Typography>
                          )}
                          {eng.error && (
                            <Typography variant="body2" color="warning.main">
                              Can't reach this engine now: {eng.error}
                            </Typography>
                          )}
                          {!eng.error && eng.containers.length === 0 && (
                            <Typography variant="body2" color="text.secondary">
                              No containers here yet. Patterns below still apply to ones created later.
                            </Typography>
                          )}
                          {projects.map((project) => {
                            const whole = f.pickedProjects.includes(project);
                            return (
                              <Box key={project}>
                                <FormControlLabel
                                  sx={{ display: "flex" }}
                                  control={<Checkbox size="small" checked={whole} onChange={() => flip("pickedProjects", project)} sx={{ py: 0.25 }} />}
                                  label={
                                    <>
                                      <b>{project}</b>{" "}
                                      <Typography component="span" variant="body2" color="text.secondary">
                                        Compose project, also containers it gets later
                                      </Typography>
                                    </>
                                  }
                                />
                                {eng.containers
                                  .filter((c) => c.project === project)
                                  .map((c) => (
                                    <FormControlLabel
                                      key={c.name}
                                      sx={{ display: "flex", ml: 3 }}
                                      control={<Checkbox size="small" disabled={whole} checked={whole || f.pickedContainers.includes(c.name)} onChange={() => flip("pickedContainers", c.name)} sx={{ py: 0.25 }} />}
                                      label={<Typography sx={{ fontFamily: MONO, fontSize: 12.5 }}>{c.name}</Typography>}
                                    />
                                  ))}
                              </Box>
                            );
                          })}
                          {loose.map((c) => (
                            <FormControlLabel
                              key={c.name}
                              sx={{ display: "flex" }}
                              control={<Checkbox size="small" checked={f.pickedContainers.includes(c.name)} onChange={() => flip("pickedContainers", c.name)} sx={{ py: 0.25 }} />}
                              label={<Typography sx={{ fontFamily: MONO, fontSize: 12.5 }}>{c.name}</Typography>}
                            />
                          ))}
                        </Box>
                      );
                    })
                  )}
                </Box>
                <Stack direction="row" spacing={2} sx={{ mt: 1.5 }}>
                  <TextField
                    label="Also projects matching"
                    placeholder={"shop-*"}
                    value={f.projects}
                    onChange={(e) => setF({ ...f, projects: e.target.value })}
                    multiline
                    minRows={1}
                    sx={{ flex: 1 }}
                    helperText="Patterns, one per line. * matches any text."
                    InputProps={{ sx: { fontFamily: MONO, fontSize: 13 } }}
                  />
                  <TextField
                    label="Also containers matching"
                    placeholder={"api-*"}
                    value={f.containers}
                    onChange={(e) => setF({ ...f, containers: e.target.value })}
                    multiline
                    minRows={1}
                    sx={{ flex: 1 }}
                    helperText="Patterns, one per line. * matches any text."
                    InputProps={{ sx: { fontFamily: MONO, fontSize: 13 } }}
                  />
                </Stack>
              </>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Containers of Pierside, other Rancher Desktop extensions and Kubernetes are never shared.
            </Typography>
          </Box>
          )}

          {!f.god && (
          <Box>
            <Typography sx={{ fontWeight: 600 }}>What the assistant may do</Typography>
            <Typography variant="body2" color="text.secondary">
              It can always list the engines, the shared containers and their Compose projects.
            </Typography>
            {ACTION_GROUPS.map((g) => (
              <Box key={g.title} sx={{ mt: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "text.secondary" }}>
                  {g.title}
                </Typography>
                {g.note && (
                  <Typography variant="body2" color="text.secondary">
                    {g.note}
                  </Typography>
                )}
                {g.actions.map((a) => (
              <Box key={a.key}>
                <FormControlLabel
                  sx={{ alignItems: "flex-start", mt: 0.5 }}
                  control={<Checkbox size="small" checked={has(a.key)} onChange={() => toggle(a.key)} sx={{ pt: 0.5 }} />}
                  label={
                    <>
                      <Typography component="span">{a.label}</Typography>
                      <Typography variant="body2" color={a.risky && has(a.key) ? "warning.main" : "text.secondary"}>
                        {a.help}
                      </Typography>
                    </>
                  }
                />
                {a.key === "logs" && has("logs") && (
                  <TextField
                    label="Most log lines per request"
                    type="number"
                    size="small"
                    value={f.maxLogLines}
                    onChange={(e) => setF({ ...f, maxLogLines: e.target.value })}
                    inputProps={{ min: 10, max: maxLogLines }}
                    sx={{ ml: 4, mt: 1, width: 220 }}
                  />
                )}
                {a.key === "inspect" && has("inspect") && (
                  <FormControlLabel
                    sx={{ ml: 3, display: "flex" }}
                    control={<Checkbox size="small" checked={f.showEnv} onChange={(e) => setF({ ...f, showEnv: e.target.checked })} />}
                    label="Also show the values of environment variables (they often hold passwords)"
                  />
                )}
                {a.key === "files" && (has("files") || has("filewrite")) && (
                  <TextField
                    label="Allowed paths"
                    placeholder={"/etc/nginx/**\n/app/config/*.yaml"}
                    value={f.filePaths}
                    onChange={(e) => setF({ ...f, filePaths: e.target.value })}
                    multiline
                    minRows={2}
                    fullWidth
                    error={!!badPath}
                    helperText={badPath ? `Paths must start with /: ${badPath}` : "One per line. * matches within one folder, ** also across folders. Nothing is readable until you add a path."}
                    sx={{ ml: 4, mt: 1, width: "calc(100% - 32px)" }}
                    InputProps={{ sx: { fontFamily: MONO, fontSize: 13 } }}
                  />
                )}
              </Box>
                ))}
              </Box>
            ))}
          </Box>
          )}
          <Box>
            <Typography sx={{ fontWeight: 600 }}>How the assistant gets in</Typography>
            <RadioGroup value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value as Form["auth"] })}>
              <FormControlLabel
                value="approval"
                sx={{ alignItems: "flex-start", mt: 0.5 }}
                control={<Radio size="small" sx={{ pt: 0.5 }} />}
                label={
                  <>
                    <Typography component="span">You allow it in Pierside</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Nothing secret is stored with the assistant. Pierside asks you when it connects.
                    </Typography>
                  </>
                }
              />
              {f.auth === "approval" && (
                <Box sx={{ ml: 4, mt: 1 }}>
                  <TextField
                    select
                    size="small"
                    label="Trust"
                    value={f.trust}
                    onChange={(e) => {
                      setF({ ...f, trust: e.target.value as Trust });
                      setTrustTouched(true);
                    }}
                    sx={{ minWidth: 340 }}
                    helperText={
                      f.trust === "none"
                        ? "You can also choose a period when Pierside asks."
                        : "While trusted, any program on this computer that can run Docker can use this connection without asking."
                    }
                  >
                    {TRUST_LABELS.map((t) => (
                      <MenuItem key={t.value} value={t.value}>
                        {t.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  {anyRisky && (
                    <TextField
                      select
                      size="small"
                      label="Ask before each action"
                      value={f.confirm}
                      onChange={(e) => setF({ ...f, confirm: e.target.value as Confirm })}
                      sx={{ minWidth: 340, mt: 2, display: "flex" }}
                      helperText="The question shows exactly what the assistant is about to do."
                    >
                      <MenuItem value="all">Every action that changes something</MenuItem>
                      <MenuItem value="destructive">Only deleting, overwriting and running commands</MenuItem>
                      <MenuItem value="none">Never</MenuItem>
                    </TextField>
                  )}
                  <FormControlLabel
                    sx={{ alignItems: "flex-start", m: 0, mt: 1.5 }}
                    control={<Switch size="small" checked={f.mayAsk} onChange={(e) => setF({ ...f, mayAsk: e.target.checked })} sx={{ mt: 0.25, mr: 1 }} />}
                    label={
                      <>
                        <Typography component="span">The assistant may ask for more access</Typography>
                        <Typography variant="body2" color="text.secondary">
                          When it needs a permission, container, file path or engine this connection doesn't have, it can ask you here. You allow it for that session, add it
                          to the connection, or refuse.
                        </Typography>
                      </>
                    }
                  />
                </Box>
              )}
              <FormControlLabel
                value="token"
                sx={{ alignItems: "flex-start", mt: 0.5 }}
                control={<Radio size="small" sx={{ pt: 0.5 }} />}
                label={
                  <>
                    <Typography component="span">Access token</Typography>
                    <Typography variant="body2" color="text.secondary">
                      For assistants that run unattended. The token is stored in the assistant's configuration and works without asking you.
                    </Typography>
                  </>
                }
              />
            </RadioGroup>
          </Box>
          {noScope && <Alert severity="info">No containers are shared yet, so the assistant will see an empty list.</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid || busy} onClick={() => void save()}>
          {editing ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AccessView() {
  const { data, error, reload } = useResource<AccessData>("/mcp-access", ["mcp"], 300, 20000);
  const engines = useResource<EngineList>("/engines");
  const { toast, confirm } = useFeedback();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [connect, setConnect] = useState<{ profile: Profile; token: string | null } | null>(null);

  const engineName = (id: string) => engines.data?.engines.find((e) => e.id === id)?.name ?? id;

  const setEnabled = async (p: Profile, enabled: boolean) => {
    try {
      await api.put(`/mcp-access/${p.id}`, { enabled });
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const newToken = async (p: Profile) => {
    const ok = await confirm({
      title: "Create a new access token?",
      message: `The current token of "${p.name}" stops working at once. Any assistant using it must be connected again with the new command.`,
      confirmLabel: "New token",
      destructive: true,
    });
    if (!ok) return;
    try {
      setConnect(await api.post<{ profile: Profile; token: string }>(`/mcp-access/${p.id}/token`));
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const revokeTrust = async (p: Profile) => {
    try {
      await api.put(`/mcp-access/${p.id}`, { trust: "none" });
      toast("success", `${p.name} will ask you again`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const remove = async (p: Profile) => {
    const ok = await confirm({ title: "Remove connection?", message: `"${p.name}" is removed and its token stops working. Nothing changes in your containers.`, confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/mcp-access/${p.id}`);
      toast("success", `${p.name} removed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", mx: -3, px: 3, my: -3, py: 3 }}>
      <PageHeader
        title="AI access"
        subtitle="Let an AI assistant such as Claude Code look at your containers, with limits you set: which containers, which actions, which files."
        actions={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            New connection
          </Button>
        }
      />
      {error && !data && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {data && data.profiles.length === 0 ? (
        <EmptyState icon={<SmartToyOutlinedIcon sx={{ fontSize: 40 }} />} title="No connections yet">
          <Typography sx={{ maxWidth: 560 }}>
            A connection gives one assistant a fixed set of permissions through Pierside's MCP server. The assistant never gets Docker itself, only the
            tools you allow, and everything it does is listed here.
          </Typography>
        </EmptyState>
      ) : (
        data && (
          <Paper variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Connection</TableCell>
                  <TableCell>Engine</TableCell>
                  <TableCell>Containers</TableCell>
                  <TableCell>Allowed</TableCell>
                  <TableCell>Last used</TableCell>
                  <TableCell>On</TableCell>
                  <TableCell align="right" sx={{ width: 140 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {data.profiles.map((p) => (
                  <TableRow key={p.id} hover>
                    <TableCell>
                      <Typography sx={{ fontWeight: 500 }}>{p.name}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {trustText(p)}
                        {p.auth === "approval" && (p.trustAlways || (p.trustedUntil ?? 0) * 1000 > Date.now()) && (
                          <>
                            {" · "}
                            <Link component="button" onClick={() => void revokeTrust(p)} sx={{ verticalAlign: "baseline" }}>
                              stop trusting
                            </Link>
                          </>
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell>{p.allEngines ? "All engines" : p.engines.map(engineName).join(", ") || "None"}</TableCell>
                    <TableCell sx={{ maxWidth: 260, wordBreak: "break-word" }}>{scopeText(p)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {p.god ? (
                          <>
                            <Chip size="small" color="error" label="Everything" />
                            {p.hostMounts && <Chip size="small" color="error" variant="outlined" label="Host system mounts" />}
                          </>
                        ) : (
                          <>
                            <Chip size="small" label="List" />
                            {ACTIONS.filter((a) => p.actions.includes(a.key))
                              .slice(0, 4)
                              .map((a) => (
                                <Chip key={a.key} size="small" label={a.label} color={a.risky ? "warning" : "default"} />
                              ))}
                            {p.actions.length > 4 && (
                              <Tooltip title={ACTIONS.filter((a) => p.actions.includes(a.key)).slice(4).map((a) => a.label).join(", ")}>
                                <Chip size="small" variant="outlined" label={`+${p.actions.length - 4} more`} />
                              </Tooltip>
                            )}
                          </>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>{p.lastUsedAt ? relativeTime(p.lastUsedAt * 1000) : "Never"}</TableCell>
                    <TableCell>
                      <Switch size="small" checked={p.enabled} onChange={(e) => void setEnabled(p, e.target.checked)} inputProps={{ "aria-label": `Enable ${p.name}` }} />
                    </TableCell>
                    <TableCell align="right" sx={{ py: 0.5, whiteSpace: "nowrap" }}>
                      {p.auth === "token" ? (
                        <Tooltip title="New access token and connection command">
                          <IconButton onClick={() => void newToken(p)} aria-label={`New token for ${p.name}`}>
                            <KeyOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <Tooltip title="Show the connection command">
                          <IconButton onClick={() => setConnect({ profile: p, token: null })} aria-label={`Connection command for ${p.name}`}>
                            <TerminalIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title="Edit">
                        <IconButton
                          onClick={() => {
                            setEditing(p);
                            setFormOpen(true);
                          }}
                          aria-label={`Edit ${p.name}`}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Remove">
                        <IconButton onClick={() => void remove(p)} aria-label={`Remove ${p.name}`}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )
      )}

      {data && data.activity.length > 0 && (
        <>
          <Typography variant="h6" sx={{ mt: 3, mb: 1, fontSize: 15 }}>
            Recent activity
          </Typography>
          <Paper variant="outlined" sx={{ maxHeight: 420, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 130 }}>When</TableCell>
                  <TableCell>Connection</TableCell>
                  <TableCell>Tool</TableCell>
                  <TableCell>Target</TableCell>
                  <TableCell>Result</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.activity.slice(0, 50).map((a, i) => (
                  <TableRow key={`${a.at}-${i}`}>
                    <TableCell>
                      <Tooltip title={new Date(a.at * 1000).toLocaleString()}>
                        <span>{relativeTime(a.at * 1000)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>{a.profile}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{a.tool}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{a.target || "—"}</TableCell>
                    <TableCell>
                      <Tooltip title={a.detail}>
                        <Chip size="small" {...RESULT[a.outcome]} />
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            The last {Math.min(50, data.activity.length)} calls since Pierside started. A call is listed as soon as it arrives.
          </Typography>
        </>
      )}

      <EditDialog
        open={formOpen}
        editing={editing}
        engines={engines.data}
        maxLogLines={data?.maxLogLines ?? 5000}
        onClose={() => setFormOpen(false)}
        onSaved={(shown) => {
          if (shown) setConnect(shown);
          void reload();
        }}
      />
      <ConnectDialog shown={connect} container={data?.container ?? ""} onClose={() => setConnect(null)} />
    </Box>
  );
}
