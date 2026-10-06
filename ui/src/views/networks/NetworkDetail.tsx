import { useState } from "react";
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Paper,
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
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LanOutlinedIcon from "@mui/icons-material/LanOutlined";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import { api } from "../../api/ddclient";
import type { Container, ContainerState } from "../../api/types";
import { useEngine } from "../../hooks/useEngine";
import { useResource } from "../../hooks/useResource";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, StatusDot } from "../../components/common";
import { KeepAliveTabs } from "../../components/KeepAliveTabs";
import { JsonTree } from "../../components/JsonTree";
import { useFeedback } from "../../components/Feedback";
import { MONO } from "../../theme";
import { relativeTime } from "../../utils/format";
import type { Network, NetworkMember } from "./types";
import { useNetworkActions, whyNotDeletable } from "./NetworksView";

const TABS = [
  { key: "containers", label: "Containers" },
  { key: "inspect", label: "Inspect" },
];

function ConnectDialog({ net, open, onClose, onDone }: { net: Network; open: boolean; onClose: () => void; onDone: () => void }) {
  const { containers } = useEngine();
  const { toast } = useFeedback();
  const [target, setTarget] = useState<Container | null>(null);
  const [aliases, setAliases] = useState("");
  const [ipv4, setIpv4] = useState("");
  const [busy, setBusy] = useState(false);
  const members = new Set(net.containers.map((c) => c.id));
  const options = (containers ?? []).filter((c) => !members.has(c.id) && !c.isSystem && !c.isExtension).sort((a, b) => a.name.localeCompare(b.name));
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/networks/${net.id}/connect`, { container: target.id, aliases: aliases.split(/[,\s]+/).filter(Boolean), ipv4 });
      toast("success", `${target.name} connected to ${net.name}`);
      setTarget(null);
      setAliases("");
      setIpv4("");
      onDone();
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Connect a container to {net.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={options}
            value={target}
            onChange={(_, v) => setTarget(v)}
            getOptionLabel={(c) => c.name}
            groupBy={(c) => c.project ?? "Standalone containers"}
            renderOption={(props, c) => (
              <li {...props} key={c.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <StatusDot state={c.state} health={c.health} size={8} />
                  <span>{c.name}</span>
                </Stack>
              </li>
            )}
            renderInput={(params) => <TextField {...params} label="Container" autoFocus />}
            noOptionsText="Every container is already on this network"
          />
          <TextField label="Aliases (optional)" placeholder="db, postgres" value={aliases} onChange={(e) => setAliases(e.target.value)} helperText="Extra DNS names for the container on this network" />
          <TextField label="IPv4 address (optional)" placeholder={net.subnets[0] ? `within ${net.subnets[0]}` : "automatic"} value={ipv4} onChange={(e) => setIpv4(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!target || busy}>
          Connect
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function NetworkDetail({ id, tab }: { id: string; tab?: string }) {
  const { data, error, reload } = useResource<{ network: Network; inspect: unknown }>(`/networks/${encodeURIComponent(id)}`, ["network", "container"]);
  const { remove } = useNetworkActions(() => void reload());
  const { toast, confirm } = useFeedback();
  const [connectOpen, setConnectOpen] = useState(false);
  const active = TABS.some((t) => t.key === tab) ? tab! : "containers";

  if (error && !data) {
    return (
      <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title="Network not found">
        <Typography sx={{ mb: 2 }}>{error}</Typography>
        <Button variant="contained" onClick={() => navigate("networks")}>
          Back to networks
        </Button>
      </EmptyState>
    );
  }
  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size={26} />
      </Stack>
    );
  }
  const n = data.network;
  const canDelete = whyNotDeletable(n) === null;
  // host/none can't take extra containers; swarm-scoped networks need "attachable".
  const canConnect = !["host", "none"].includes(n.name) && (n.scope !== "swarm" || n.attachable);

  const disconnect = async (c: NetworkMember) => {
    const ok = await confirm({
      title: "Disconnect container?",
      message: `"${c.name}" will be removed from network "${n.name}". Containers that reach it by name on this network will lose the connection.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post(`/networks/${n.id}/disconnect`, { container: c.id, force: c.state !== "running" });
      toast("success", `${c.name} disconnected from ${n.name}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const fact = (label: string, value: string) => (
    <Typography variant="body2" color="text.secondary">
      {label} <span style={{ fontFamily: MONO }}>{value}</span>
    </Typography>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
        <IconButton onClick={() => navigate("networks")} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <LanOutlinedIcon sx={{ fontSize: 32, mt: 0.25, color: n.containers.some((c) => c.state === "running") ? "success.main" : "text.disabled" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h2" noWrap title={n.name}>
            {n.name}
          </Typography>
          <Stack direction="row" spacing={2} sx={{ mt: 0.5 }} alignItems="center" flexWrap="wrap" useFlexGap>
            {fact("Driver", n.driver)}
            {fact("Scope", n.scope)}
            {n.subnets.length > 0 && fact("Subnet", n.subnets.join(", "))}
            {n.gateways.length > 0 && fact("Gateway", n.gateways.join(", "))}
            {n.internal && fact("", "internal")}
            <Typography variant="body2" color="text.secondary">
              Created {relativeTime(n.created)}
            </Typography>
          </Stack>
        </Box>
        {canConnect && (
          <Button variant="contained" startIcon={<LinkIcon />} onClick={() => setConnectOpen(true)}>
            Connect container
          </Button>
        )}
        <Tooltip title={whyNotDeletable(n) ?? "Delete network"}>
          <span>
            <IconButton
              disabled={!canDelete}
              onClick={() => void remove([n]).then((ok) => ok && navigate("networks"))}
              aria-label="Delete network"
              sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: "error.main" }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Tabs value={active} onChange={(_, t) => navigate("networks", id, t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.key === "containers" ? `Containers (${n.containers.length})` : t.label} />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          containers: () =>
            n.containers.length === 0 ? (
              <EmptyState title="No containers on this network">
                {canConnect && <Typography>Use Connect container to add one.</Typography>}
              </EmptyState>
            ) : (
              <Paper variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Container</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>IPv4 address</TableCell>
                      <TableCell>MAC address</TableCell>
                      <TableCell>Aliases</TableCell>
                      <TableCell align="right" sx={{ width: 70 }} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {n.containers.map((c) => (
                      <TableRow key={c.id} hover>
                        <TableCell>
                          <Link href={href("containers", c.id)} underline="hover" sx={{ fontWeight: 500 }}>
                            {c.name}
                          </Link>
                          {c.project && (
                            <Typography variant="body2" color="text.secondary">
                              Project {c.project}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <StatusDot state={c.state as ContainerState} size={8} />
                            <span style={{ textTransform: "capitalize" }}>{c.state}</span>
                          </Stack>
                        </TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{c.ipv4 ?? "—"}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{c.mac ?? "—"}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{c.aliases.join(", ") || "—"}</TableCell>
                        <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }}>
                          <Tooltip title="Disconnect from this network">
                            <IconButton onClick={() => void disconnect(c)} aria-label={`Disconnect ${c.name}`}>
                              <LinkOffIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            ),
          inspect: () => <JsonTree data={data.inspect} />,
        }}
      />
      <ConnectDialog net={n} open={connectOpen} onClose={() => setConnectOpen(false)} onDone={() => void reload()} />
    </Box>
  );
}
