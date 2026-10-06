import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import LogoutIcon from "@mui/icons-material/Logout";
import KeyIcon from "@mui/icons-material/Key";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StarIcon from "@mui/icons-material/Star";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, PageHeader, SearchField } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { copyText, formatBytes, relativeTime } from "../../utils/format";
import { MONO } from "../../theme";
import { ReplicaBar, ServicesTable } from "./ServicesTable";
import { useSwarmActions } from "./useSwarmActions";
import { SWARM_EVENTS, SwarmNode, SwarmObject, SwarmService, SwarmStack, SwarmState } from "./types";

const TABS = [
  { key: "stacks", label: "Stacks" },
  { key: "services", label: "Services" },
  { key: "nodes", label: "Nodes" },
  { key: "objects", label: "Secrets & configs" },
];

const POLL = 3000;

function InitState({ state, onInit }: { state: SwarmState; onInit: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <EmptyState icon={<HubOutlinedIcon sx={{ fontSize: 48 }} />} title={state.state === "inactive" ? "Swarm mode is not active" : `Swarm is ${state.state}`}>
      <Typography sx={{ mb: 2 }}>
        Initialize a single-node swarm on this engine to deploy stacks (<code>docker stack deploy</code>) and services. Note: on Rancher Desktop the
        ingress routing mesh doesn't work; publish service ports with <code>mode: host</code>.
      </Typography>
      {state.error && (
        <Alert severity="error" sx={{ mb: 2, textAlign: "left" }}>
          {state.error}
        </Alert>
      )}
      <Button
        variant="contained"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onInit();
        }}
      >
        Initialize swarm
      </Button>
    </EmptyState>
  );
}

function JoinDialog({ state, open, onClose }: { state: SwarmState; open: boolean; onClose: () => void }) {
  const { toast } = useFeedback();
  const addr = `${state.nodeAddr ?? "<manager-ip>"}:2377`;
  const line = (role: "worker" | "manager") => `docker swarm join --token ${state.joinTokens?.[role]} ${addr}`;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Join tokens</DialogTitle>
      <DialogContent>
        {(["worker", "manager"] as const).map((role) => (
          <Box key={role} sx={{ mb: 2 }}>
            <Typography variant="h5" sx={{ textTransform: "capitalize", mb: 0.5 }}>
              {role}
            </Typography>
            <Paper variant="outlined" sx={{ p: 1, fontFamily: MONO, fontSize: 12, wordBreak: "break-all", cursor: "pointer" }} onClick={() => void copyText(line(role)).then(() => toast("success", "Copied"))}>
              {line(role)}
            </Paper>
          </Box>
        ))}
        <Alert severity="info">The manager address is inside Rancher's VM. Other machines usually can't reach it without extra networking.</Alert>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function StacksTab({ stacks, reload }: { stacks: SwarmStack[]; reload: () => void }) {
  const { removeStack } = useSwarmActions(reload);
  if (!stacks.length)
    return (
      <EmptyState title="No stacks deployed">
        <Typography>
          Deploy one with <code>docker stack deploy -c compose.yaml mystack</code>.
        </Typography>
      </EmptyState>
    );
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ flex: "0 1 auto", minHeight: 0 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell sx={{ width: 110 }}>Services</TableCell>
            <TableCell sx={{ width: 170 }}>Tasks</TableCell>
            <TableCell sx={{ width: 140 }}>Created</TableCell>
            <TableCell align="right" sx={{ width: 90 }}>
              Actions
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {stacks.map((s) => (
            <TableRow key={s.name} hover onClick={() => navigate("swarm", "stacks", s.name)} sx={{ cursor: "pointer" }}>
              <TableCell>
                <Link href={href("swarm", "stacks", s.name)} underline="hover" sx={{ fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>
                  {s.name}
                </Link>
                {s.updating && (
                  <Typography component="span" variant="body2" color="warning.main" sx={{ ml: 1 }}>
                    updating…
                  </Typography>
                )}
              </TableCell>
              <TableCell>{s.services}</TableCell>
              <TableCell>
                <ReplicaBar running={s.running} desired={s.desired} />
              </TableCell>
              <TableCell>{relativeTime(s.createdAt)}</TableCell>
              <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                <Tooltip title="Remove stack">
                  <IconButton onClick={() => void removeStack(s.name)} aria-label={`Remove stack ${s.name}`}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function NodesTab({ nodes, reload }: { nodes: SwarmNode[]; reload: () => void }) {
  const { toast } = useFeedback();
  const setAvail = async (n: SwarmNode, availability: string) => {
    try {
      await api.post(`/swarm/nodes/${n.id}/availability`, { availability });
      toast("success", `${n.hostname} set to ${availability}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    reload();
  };
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ flex: "0 1 auto" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Hostname</TableCell>
            <TableCell>Role</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Availability</TableCell>
            <TableCell>Address</TableCell>
            <TableCell>Engine</TableCell>
            <TableCell>Resources</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {nodes.map((n) => (
            <TableRow key={n.id} hover>
              <TableCell>
                <Typography sx={{ fontWeight: 500 }}>{n.hostname}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO, fontSize: 11 }}>
                  {n.id.slice(0, 12)}
                </Typography>
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span style={{ textTransform: "capitalize" }}>{n.role}</span>
                  {n.leader && (
                    <Tooltip title="Leader">
                      <StarIcon sx={{ fontSize: 15, color: "warning.main" }} />
                    </Tooltip>
                  )}
                </Stack>
              </TableCell>
              <TableCell sx={{ textTransform: "capitalize", color: n.state === "ready" ? "success.main" : "error.main" }}>{n.state}</TableCell>
              <TableCell>
                <Select size="small" value={n.availability} onChange={(e) => void setAvail(n, e.target.value)} sx={{ minWidth: 110 }}>
                  <MenuItem value="active">Active</MenuItem>
                  <MenuItem value="pause">Pause</MenuItem>
                  <MenuItem value="drain">Drain</MenuItem>
                </Select>
              </TableCell>
              <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{n.addr}</TableCell>
              <TableCell>
                {n.engine}
                <Typography variant="body2" color="text.secondary">
                  {n.os}
                </Typography>
              </TableCell>
              <TableCell>
                {n.cpus} CPUs · {formatBytes(n.memory)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ObjectsTab() {
  const secrets = useResource<SwarmObject[]>("/swarm/secrets", ["secret"]);
  const configs = useResource<SwarmObject[]>("/swarm/configs", ["config"]);
  const { toast, confirm } = useFeedback();
  const remove = async (kind: "secrets" | "configs", o: SwarmObject) => {
    const ok = await confirm({ title: `Remove ${kind === "secrets" ? "secret" : "config"}?`, message: `"${o.name}" will be removed. Services using it must be updated first.`, confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/swarm/${kind}/${o.id}`);
      toast("success", `${o.name} removed`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void (kind === "secrets" ? secrets.reload() : configs.reload());
  };
  const table = (title: string, kind: "secrets" | "configs", items: SwarmObject[] | null) => (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h4" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {items === null ? (
        <CircularProgress size={20} />
      ) : items.length === 0 ? (
        <Typography color="text.secondary">None.</Typography>
      ) : (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Stack</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((o) => (
                <TableRow key={o.id} hover>
                  <TableCell sx={{ fontWeight: 500 }}>{o.name}</TableCell>
                  <TableCell>{o.stack ?? "—"}</TableCell>
                  <TableCell>{relativeTime(o.createdAt)}</TableCell>
                  <TableCell>{relativeTime(o.updatedAt)}</TableCell>
                  <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }}>
                    <IconButton onClick={() => void remove(kind, o)} aria-label={`Remove ${o.name}`}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Box>
  );
  return (
    <Box sx={{ overflow: "auto" }}>
      {table("Secrets", "secrets", secrets.data)}
      {table("Configs", "configs", configs.data)}
    </Box>
  );
}

export function SwarmView({ tab }: { tab?: string }) {
  const { toast, confirm } = useFeedback();
  const swarm = useResource<SwarmState>("/swarm", ["node"]);
  const active = swarm.data?.active && swarm.data.isManager;
  const services = useResource<SwarmService[]>(active ? "/swarm/services" : null, SWARM_EVENTS, 400, POLL);
  const stacks = useResource<SwarmStack[]>(active ? "/swarm/stacks" : null, SWARM_EVENTS, 400, POLL);
  const nodes = useResource<SwarmNode[]>(active ? "/swarm/nodes" : null, ["node"], 400, 10000);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const current = TABS.some((t) => t.key === tab) ? tab! : "stacks";

  const reloadAll = () => {
    void services.reload();
    void stacks.reload();
    void nodes.reload();
  };

  const init = async () => {
    try {
      await api.post("/swarm/init", {});
      toast("success", "Swarm initialized");
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void swarm.reload();
  };

  const leave = async () => {
    const ok = await confirm({
      title: "Leave swarm?",
      message: "This node leaves the swarm. As the only manager, this destroys the swarm and removes ALL services, stacks, secrets and configs.",
      confirmLabel: "Leave swarm",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post("/swarm/leave?force=true");
      toast("success", "Left the swarm");
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void swarm.reload();
  };

  if (!swarm.data) {
    return swarm.error ? (
      <EmptyState title="Couldn't read swarm state">
        <Typography>{swarm.error}</Typography>
      </EmptyState>
    ) : (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size={26} />
      </Stack>
    );
  }
  const st = swarm.data;
  if (!st.active) {
    return (
      <>
        <PageHeader title="Swarm" />
        <InitState state={st} onInit={() => void init()} />
      </>
    );
  }
  if (!st.isManager) {
    return (
      <>
        <PageHeader title="Swarm" />
        <EmptyState title="This node is a swarm worker">
          <Typography>Services, stacks and nodes can only be managed from a manager node.</Typography>
        </EmptyState>
      </>
    );
  }

  const q = search.trim().toLowerCase();
  const filteredServices = (services.data ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.image.toLowerCase().includes(q));
  const filteredStacks = (stacks.data ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        title="Swarm"
        subtitle={`${st.nodes ?? 1} node${st.nodes === 1 ? "" : "s"} · ${st.managers ?? 1} manager${st.managers === 1 ? "" : "s"} · ${stacks.data?.length ?? "…"} stacks · ${services.data?.length ?? "…"} services`}
        actions={
          <>
            <IconButton onClick={(e) => setMenu(e.currentTarget)} aria-label="Swarm actions">
              <MoreVertIcon />
            </IconButton>
            <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  setJoinOpen(true);
                }}
              >
                <ListItemIcon>
                  <KeyIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Show join tokens</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void leave();
                }}
                sx={{ color: "error.main" }}
              >
                <ListItemIcon sx={{ color: "error.main" }}>
                  <LogoutIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Leave swarm…</ListItemText>
              </MenuItem>
            </Menu>
          </>
        }
      />
      <Tabs value={current} onChange={(_, t) => navigate("swarm", t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>
      {(current === "stacks" || current === "services") && (
        <Box sx={{ mb: 1.5 }}>
          <SearchField value={search} onChange={setSearch} />
        </Box>
      )}
      {current === "stacks" && (stacks.data ? <StacksTab stacks={filteredStacks} reload={reloadAll} /> : <CircularProgress size={22} />)}
      {current === "services" && (services.data ? <ServicesTable services={filteredServices} reload={reloadAll} /> : <CircularProgress size={22} />)}
      {current === "nodes" && (nodes.data ? <NodesTab nodes={nodes.data} reload={() => void nodes.reload()} /> : <CircularProgress size={22} />)}
      {current === "objects" && <ObjectsTab />}
      <JoinDialog state={st} open={joinOpen} onClose={() => setJoinOpen(false)} />
    </>
  );
}
