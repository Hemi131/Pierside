/**
 * Ports: everything reachable from this computer, in one place.
 *   - Forwarded by Pierside: forwards (see backend services/forwards.py), with status and Stop.
 *   - Published ports of the active engine's containers (the engine or Rancher publishes these).
 *   - Exposed but not published: ports a container declares but nobody can reach; forward them.
 */
import { useMemo } from "react";
import { Alert, Box, Button, Chip, IconButton, Link, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import CallMadeIcon from "@mui/icons-material/CallMade";
import { api, openExternal } from "../../api/ddclient";
import type { Container } from "../../api/types";
import { useEngine, usePortHost } from "../../hooks/useEngine";
import { useResource } from "../../hooks/useResource";
import { href } from "../../hooks/useRoute";
import { EmptyState, PageHeader } from "../../components/common";
import { Forward, openForward } from "../../components/ForwardDialog";
import { useFeedback } from "../../components/Feedback";
import { MONO } from "../../theme";

interface PortRow {
  c: Container;
  private: number;
  public?: number;
  type: string;
  ip?: string;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h3" sx={{ mb: 0.25 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {hint}
        </Typography>
      )}
      <Paper variant="outlined">{children}</Paper>
    </Box>
  );
}

function ContainerLink({ c }: { c: { id: string; name: string } }) {
  return (
    <Link href={href("containers", c.id)} underline="hover" sx={{ fontWeight: 500 }}>
      {c.name}
    </Link>
  );
}

export function PortsView() {
  const { containers, engine } = useEngine();
  const portHost = usePortHost();
  const remote = engine?.engine?.type === "ssh";
  const { toast, confirm } = useFeedback();
  // Status (e.g. "target stopped") changes without engine events: poll while the page is open.
  const { data, reload } = useResource<{ forwards: Forward[] }>("/forwards", ["container"], 300, 5000);

  const rows = useMemo(() => {
    const out: PortRow[] = [];
    for (const c of containers ?? []) {
      if (c.isSystem || c.isExtension) continue;
      for (const p of c.ports) out.push({ c, ...p });
    }
    return out.sort((a, b) => (a.public ?? 0) - (b.public ?? 0) || a.c.name.localeCompare(b.c.name) || a.private - b.private);
  }, [containers]);
  const published = rows.filter((r) => r.public);
  const exposed = rows.filter((r) => !r.public && r.type === "tcp" && r.c.state === "running");

  const stop = async (f: Forward) => {
    const ok = await confirm({ title: "Stop forwarding?", message: `localhost:${f.hostPort} will stop reaching ${f.target.name}:${f.targetPort}.`, confirmLabel: "Stop" });
    if (!ok) return;
    try {
      await api.del(`/forwards/${f.id}`);
      toast("success", `localhost:${f.hostPort} stopped`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
    void reload();
  };

  const forwards = data?.forwards ?? [];
  const forwardButton = (c: Container, port: number, label = "Forward") => (
    <Button size="small" startIcon={<CallMadeIcon />} onClick={() => openForward({ container: c, port })}>
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Ports"
        subtitle={
          remote
            ? `Ports of containers on ${engine?.engine?.name}, and forwards that bring them to this computer.`
            : "Ports your containers publish, and forwards Pierside adds without recreating a container."
        }
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => openForward()}>
            Forward a port
          </Button>
        }
      />

      <Section title="Forwarded by Pierside" hint="Reachable at localhost on this computer while Pierside runs; restored after a restart. Stopping a container keeps its forward; removing it removes the forward.">
        {forwards.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            No forwards. Use Forward a port, or Forward next to a port below.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>On this computer</TableCell>
                <TableCell>Goes to</TableCell>
                <TableCell>Engine</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" sx={{ width: 90 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {forwards.map((f) => (
                <TableRow key={f.id} hover>
                  <TableCell>
                    <Link component="button" underline="hover" onClick={() => openExternal(`http://localhost:${f.hostPort}`)} sx={{ fontFamily: MONO, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                      localhost:{f.hostPort}
                      <OpenInNewIcon sx={{ fontSize: 13 }} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ContainerLink c={f.target} />
                    <Typography component="span" sx={{ fontFamily: MONO, fontSize: 13 }}>
                      :{f.targetPort}
                    </Typography>
                  </TableCell>
                  <TableCell>{f.kind === "remote" ? <Chip size="small" variant="outlined" label={f.remote?.engineName} /> : <Chip size="small" variant="outlined" label="Local" />}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>
                    {f.problem ? (
                      <Typography variant="body2" color="warning.main">
                        {f.problem}
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "success.main" }} />
                        <span>Active</span>
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }}>
                    <Tooltip title="Stop forwarding">
                      <IconButton onClick={() => void stop(f)} aria-label={`Stop forwarding localhost:${f.hostPort}`}>
                        <StopCircleOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Published ports"
        hint={remote ? `Published on ${engine?.engine?.name}. If one isn't reachable from here (firewall, or bound to the server's localhost), forward it.` : "Rancher Desktop makes these reachable on this computer automatically."}
      >
        {published.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            No container publishes a port.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Address</TableCell>
                <TableCell>Container</TableCell>
                <TableCell>Container port</TableCell>
                <TableCell align="right" sx={{ width: 150 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {published.map((r) => {
                const hostIp = r.ip && !["0.0.0.0", "::", ""].includes(r.ip) ? r.ip : portHost;
                return (
                  <TableRow key={`${r.c.id}-${r.public}-${r.private}-${r.type}`} hover>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 13 }}>
                      {r.type === "tcp" ? (
                        <Link component="button" underline="hover" onClick={() => openExternal(`http://${hostIp}:${r.public}`)} sx={{ fontFamily: MONO, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                          {hostIp}:{r.public}
                          <OpenInNewIcon sx={{ fontSize: 13 }} />
                        </Link>
                      ) : (
                        `${hostIp}:${r.public}`
                      )}
                    </TableCell>
                    <TableCell>
                      <ContainerLink c={r.c} />
                      {r.c.project && (
                        <Typography variant="body2" color="text.secondary">
                          {r.c.project}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 13 }}>
                      {r.private}/{r.type}
                    </TableCell>
                    <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }}>
                      {remote && r.type === "tcp" && r.c.state === "running" && forwardButton(r.c, r.private)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      {exposed.length > 0 && (
        <Section title="Exposed, not published" hint="Ports these containers declare (EXPOSE) but nothing publishes, so they aren't reachable from this computer. Forward one to reach it.">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Container</TableCell>
                <TableCell>Container port</TableCell>
                <TableCell align="right" sx={{ width: 150 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {exposed.map((r) => (
                <TableRow key={`${r.c.id}-${r.private}`} hover>
                  <TableCell>
                    <ContainerLink c={r.c} />
                  </TableCell>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 13 }}>{r.private}/tcp</TableCell>
                  <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }}>
                    {forwardButton(r.c, r.private)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      {!containers && <EmptyState title="Loading…" />}
      {remote && (
        <Alert severity="info" sx={{ mt: -1 }}>
          Forwards to an SSH engine keep working when you switch engines; they use their own SSH connection.
        </Alert>
      )}
    </>
  );
}
