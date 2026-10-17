import { useState } from "react";
import { Box, Chip, IconButton, LinearProgress, Link, ListItemIcon, ListItemText, Menu, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import OpenInFullIcon from "@mui/icons-material/UnfoldMore";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UndoIcon from "@mui/icons-material/Undo";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { openExternal } from "../../api/ddclient";
import { useColumnLayout } from "../../components/table/useColumnLayout";
import { usePortHost } from "../../hooks/useEngine";
import { href, navigate } from "../../hooks/useRoute";
import { urlHost, relativeTime } from "../../utils/format";
import { ScaleDialog, useSwarmActions } from "./useSwarmActions";
import { shortServiceName, SwarmPort, SwarmService } from "./types";

export function ReplicaBar({ running, desired }: { running: number | null; desired: number | null }) {
  const r = running ?? 0;
  const d = desired ?? 0;
  const ok = d > 0 && r >= d;
  const color = d === 0 ? "inherit" : ok ? "success" : r === 0 ? "error" : "warning";
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 110 }}>
      <Box sx={{ flex: 1, maxWidth: 70 }}>
        <LinearProgress variant="determinate" value={d ? Math.min(100, (r / d) * 100) : 0} color={color} sx={{ height: 6, borderRadius: 3 }} />
      </Box>
      <Typography variant="body1" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {r}/{d}
      </Typography>
    </Stack>
  );
}

export function SwarmPorts({ ports }: { ports: SwarmPort[] }) {
  const portHost = usePortHost();
  const published = ports.filter((p) => p.published);
  if (!published.length) return null;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
      {published.map((p) => (
        <Stack key={`${p.published}-${p.target}-${p.protocol}`} direction="row" spacing={0.25} alignItems="center">
          <Link
            component="button"
            underline="hover"
            onClick={(e) => {
              e.stopPropagation();
              openExternal(`http://${urlHost(portHost)}:${p.published}`);
            }}
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, fontSize: 13 }}
          >
            {p.published}:{p.target}
            {p.protocol !== "tcp" && `/${p.protocol}`}
            <OpenInNewIcon sx={{ fontSize: 13 }} />
          </Link>
          {p.mode === "ingress" && (
            <Tooltip title="Published through the swarm routing mesh (ingress). On Rancher Desktop the routing mesh doesn't work, so this port is likely unreachable. Publish it with mode: host instead.">
              <WarningAmberIcon sx={{ fontSize: 15, color: "warning.main" }} />
            </Tooltip>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

export function updateLabel(s: SwarmService): { text: string; color: "default" | "warning" | "error" | "success" } | null {
  const st = s.update?.state;
  if (!st) return null;
  if (st === "updating" || st === "rollback_started") return { text: st === "updating" ? "Updating" : "Rolling back", color: "warning" };
  if (st === "paused" || st === "rollback_paused") return { text: "Update paused", color: "error" };
  if (st === "rollback_completed") return { text: "Rolled back", color: "default" };
  return null;
}

function RowMenu({ s, onRestart, onRollback, onRemove }: { s: SwarmService; onRestart: () => void; onRollback: () => void; onRemove: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const item = (label: string, icon: JSX.Element, fn: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <MenuItem
      disabled={opts.disabled}
      onClick={() => {
        setAnchor(null);
        fn();
      }}
      sx={opts.danger ? { color: "error.main" } : undefined}
    >
      <ListItemIcon sx={opts.danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  );
  return (
    <>
      <IconButton aria-label={`More actions for ${s.name}`} onClick={(e) => (e.stopPropagation(), setAnchor(e.currentTarget))}>
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
        {item("View logs", <ArticleOutlinedIcon fontSize="small" />, () => navigate("swarm", "services", s.id, "logs"))}
        {item("Restart (force update)", <RestartAltIcon fontSize="small" />, onRestart)}
        {item("Roll back", <UndoIcon fontSize="small" />, onRollback, { disabled: !s.hasPrevious })}
        {item("Remove", <DeleteOutlineIcon fontSize="small" />, onRemove, { danger: true })}
      </Menu>
    </>
  );
}

export function ServicesTable({ services, reload, showStack = true }: { services: SwarmService[]; reload: () => void; showStack?: boolean }) {
  const actions = useSwarmActions(reload);
  const [scaling, setScaling] = useState<SwarmService | null>(null);
  // Column positions shift by one when the Stack column isn't shown (stack detail view).
  const o = showStack ? 0 : -1;
  const layout = useColumnLayout(showStack ? "swarm-services" : "swarm-stack-services", [
    { pos: 1, label: "Name" },
    ...(showStack ? [{ pos: 2, label: "Stack", autoHide: 4 }] : []),
    { pos: 3 + o, label: "Image", autoHide: 3 },
    { pos: 4 + o, label: "Mode", autoHide: 2 },
    { pos: 5 + o, label: "Replicas" },
    { pos: 6 + o, label: "Ports", autoHide: 5 },
    { pos: 7 + o, label: "Updated", autoHide: 1 },
    { pos: 8 + o, label: "Actions", resizable: false },
  ]);
  return (
    <>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 0.5 }}>
        {layout.columnsButton}
      </Stack>
      <TableContainer ref={layout.containerRef} component={Paper} variant="outlined" sx={{ flex: "0 1 auto", minHeight: 0 }}>
        <Table ref={layout.tableRef} size="small" stickyHeader sx={layout.tableSx}>
          <TableHead>
            <TableRow>
              <TableCell>
                Name
                {layout.resizeHandle(1)}
              </TableCell>
              {showStack && (
                <TableCell sx={{ width: 140 }}>
                  Stack
                  {layout.resizeHandle(2)}
                </TableCell>
              )}
              <TableCell>
                Image
                {layout.resizeHandle(3 + o)}
              </TableCell>
              <TableCell sx={{ width: 100 }}>
                Mode
                {layout.resizeHandle(4 + o)}
              </TableCell>
              <TableCell sx={{ width: 150 }}>
                Replicas
                {layout.resizeHandle(5 + o)}
              </TableCell>
              <TableCell sx={{ width: 150 }}>
                Ports
                {layout.resizeHandle(6 + o)}
              </TableCell>
              <TableCell sx={{ width: 120 }}>
                Updated
                {layout.resizeHandle(7 + o)}
              </TableCell>
              <TableCell align="right" sx={{ width: 110 }}>
                Actions
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {services.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
                  No services.
                </TableCell>
              </TableRow>
            )}
            {services.map((s) => {
              const upd = updateLabel(s);
              return (
                <TableRow key={s.id} hover onClick={() => navigate("swarm", "services", s.id)} sx={{ cursor: "pointer" }}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Link href={href("swarm", "services", s.id)} underline="hover" onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 500 }}>
                        {showStack ? s.name : shortServiceName(s)}
                      </Link>
                      {upd && <Chip size="small" label={upd.text} color={upd.color} variant="outlined" title={s.update?.message ?? ""} />}
                    </Stack>
                  </TableCell>
                  {showStack && (
                    <TableCell>
                      {s.stack ? (
                        <Link href={href("swarm", "stacks", s.stack)} underline="hover" onClick={(e) => e.stopPropagation()}>
                          {s.stack}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  <TableCell sx={{ maxWidth: 240 }}>
                    <Typography noWrap variant="body1" title={s.image}>
                      {s.image}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ textTransform: "capitalize" }}>{s.mode.replace("-", " ")}</TableCell>
                  <TableCell>
                    <ReplicaBar running={s.running} desired={s.desired} />
                  </TableCell>
                  <TableCell>
                    <SwarmPorts ports={s.ports} />
                  </TableCell>
                  <TableCell>
                    <Tooltip title={new Date(s.updatedAt).toLocaleString()}>
                      <span>{relativeTime(s.updatedAt)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ py: 0, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title={s.mode === "replicated" ? "Scale" : "Only replicated services can be scaled"}>
                      <span>
                        <IconButton disabled={s.mode !== "replicated"} onClick={() => setScaling(s)} aria-label={`Scale ${s.name}`}>
                          <OpenInFullIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <RowMenu s={s} onRestart={() => void actions.restart(s)} onRollback={() => void actions.rollback(s)} onRemove={() => void actions.remove(s)} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <ScaleDialog service={scaling} onClose={() => setScaling(null)} onScale={(s, n) => void actions.scale(s, n)} />
    </>
  );
}
