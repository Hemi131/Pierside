import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, CircularProgress, IconButton, Link, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import StopIcon from "@mui/icons-material/Stop";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RefreshIcon from "@mui/icons-material/Refresh";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import ArrowRightAltIcon from "@mui/icons-material/ArrowRightAlt";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import type { Container } from "../../api/types";
import { api } from "../../api/ddclient";
import { useEngine } from "../../hooks/useEngine";
import { useActions, usePending } from "../../hooks/useActions";
import { href, navigate } from "../../hooks/useRoute";
import { CopyableId, EmptyState, PortLinks, StatusDot, stateColor } from "../../components/common";
import { KeepAliveTabs } from "../../components/KeepAliveTabs";
import { JsonTree } from "../../components/JsonTree";
import { LogViewer } from "../../components/logs/LogViewer";
import { ShellView } from "../../components/shell/ShellView";
import { FileBrowser, containerFsApi } from "../../components/FileBrowser";
import { StatsTab } from "./StatsTab";
import { HealthTab } from "./HealthTab";
import { relativeTime } from "../../utils/format";
import { isActive, statusLabel } from "./model";

export const CONTAINER_TABS = [
  { key: "logs", label: "Logs" },
  { key: "inspect", label: "Inspect" },
  { key: "mounts", label: "Bind mounts" },
  { key: "exec", label: "Exec" },
  { key: "files", label: "Files" },
  { key: "stats", label: "Stats" },
  { key: "health", label: "Health" }, // only shown for containers with a health check
] as const;

export function findContainer(list: Container[] | null, ref: string): Container | undefined {
  return list?.find((c) => c.id === ref) ?? list?.find((c) => c.name === ref) ?? list?.find((c) => c.id.startsWith(ref));
}

function Header({ c }: { c: Container }) {
  const { containerAction, deleteContainers, copyRunCommand } = useActions();
  const pending = usePending().get(c.id);
  const active = isActive(c.state);
  const paused = c.state === "paused";
  const back = c.project ? () => navigate("projects", c.project!) : () => navigate("containers");

  const btn = (title: string, icon: JSX.Element, onClick: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <Tooltip title={title}>
      <span>
        <IconButton
          aria-label={title}
          onClick={onClick}
          disabled={!!pending || opts.disabled}
          sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: opts.danger ? "error.main" : undefined }}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );

  return (
    <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
      <Tooltip title={c.project ? `Back to ${c.project}` : "Back to containers"}>
        <IconButton onClick={back} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
      </Tooltip>
      <ViewInArOutlinedIcon sx={{ fontSize: 32, color: stateColor(c.state, c.health), mt: 0.25 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="h2" noWrap>
            {c.name}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <StatusDot state={c.state} health={c.health} size={8} />
            <Typography variant="body1" color="text.secondary" noWrap>
              {statusLabel(c)}
              {c.state === "running" && c.startedAt ? ` (${relativeTime(c.startedAt)})` : ""}
            </Typography>
          </Stack>
          {pending && <CircularProgress size={16} />}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 0.5, flexWrap: "wrap" }} useFlexGap>
          <CopyableId id={c.id} />
          <Link href={href("images", c.image)} underline="hover" sx={{ fontSize: 13 }}>
            {c.image}
          </Link>
          {c.project && (
            <Typography variant="body2" color="text.secondary">
              Project{" "}
              <Link href={href("projects", c.project)} underline="hover">
                {c.project}
              </Link>
              {c.service ? ` · service ${c.service}` : ""}
            </Typography>
          )}
          <PortLinks ports={c.ports} max={6} />
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center">
        {paused
          ? btn("Resume", <PlayArrowIcon fontSize="small" />, () => void containerAction(c, "unpause"))
          : btn("Pause", <PauseIcon fontSize="small" />, () => void containerAction(c, "pause"), { disabled: c.state !== "running" })}
        {active
          ? btn("Stop", <StopIcon fontSize="small" />, () => void containerAction(c, "stop"))
          : btn("Start", <PlayArrowIcon fontSize="small" />, () => void containerAction(c, "start"))}
        {btn("Restart", <RestartAltIcon fontSize="small" />, () => void containerAction(c, "restart"))}
        {btn("Copy docker run command", <ContentCopyIcon fontSize="small" />, () => void copyRunCommand(c))}
        {btn("Delete", <DeleteOutlineIcon fontSize="small" />, () => void deleteContainers([c]).then((ok) => ok && back()), { danger: true })}
      </Stack>
    </Stack>
  );
}

function InspectTab({ id, stateKey }: { id: string; stateKey: string }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    api
      .get(`/containers/${id}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);
  // Refresh when the container's state changes (started, stopped, …).
  useEffect(load, [load, stateKey]);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <CircularProgress size={24} />;
  return (
    <Box sx={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Tooltip title="Refresh">
        <IconButton onClick={load} disabled={loading} sx={{ position: "absolute", right: 90, top: 0 }} aria-label="Refresh inspect data">
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <JsonTree data={data} />
    </Box>
  );
}

function MountsTab({ c }: { c: Container }) {
  if (c.mounts.length === 0) {
    return (
      <EmptyState title="No mounts">
        <Typography variant="body1">This container has no bind mounts or volumes.</Typography>
      </EmptyState>
    );
  }
  return (
    <Paper variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Type</TableCell>
            <TableCell>Source</TableCell>
            <TableCell />
            <TableCell>Destination</TableCell>
            <TableCell>Mode</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {c.mounts.map((m) => (
            <TableRow key={m.destination}>
              <TableCell sx={{ textTransform: "capitalize" }}>{m.type}</TableCell>
              <TableCell sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {m.type === "volume" && m.name ? (
                  <Link href={href("volumes", m.name)} underline="hover">
                    {m.name}
                  </Link>
                ) : (
                  m.source
                )}
              </TableCell>
              <TableCell sx={{ width: 32, px: 0, color: "text.secondary" }}>
                <ArrowRightAltIcon fontSize="small" />
              </TableCell>
              <TableCell sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>{m.destination}</TableCell>
              <TableCell>{m.rw ? "Read / write" : "Read only"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

export function ContainerDetail({ id, tab }: { id: string; tab?: string }) {
  const { containers } = useEngine();
  const { containerAction } = useActions();
  const c = findContainer(containers, id);
  const cid = c?.id;
  const fs = useMemo(() => (cid ? containerFsApi(cid) : null), [cid]);
  const tabs = CONTAINER_TABS.filter((t) => t.key !== "health" || c?.health);
  const active = tabs.some((t) => t.key === tab) ? tab! : "logs";

  if (!c) {
    return (
      <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title="Container not found">
        <Typography variant="body1" sx={{ mb: 2 }}>
          It may have been removed.
        </Typography>
        <Button variant="contained" onClick={() => navigate("containers")}>
          Back to containers
        </Button>
      </EmptyState>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Header c={c} />
      <Tabs value={active} onChange={(_, v) => navigate("containers", id, v)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {tabs.map((t) => (
          <Tab
            key={t.key}
            value={t.key}
            label={
              t.key === "health" ? (
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <StatusDot state={c.state} health={c.health} size={8} />
                  <span>Health</span>
                </Stack>
              ) : (
                t.label
              )
            }
          />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          logs: (visible) => <LogViewer path={`/ws/logs/container/${c.id}`} params={{ tail: "5000" }} downloadName={c.name} active={visible} />,
          inspect: () => <InspectTab id={c.id} stateKey={`${c.state}:${c.startedAt}`} />,
          mounts: () => <MountsTab c={c} />,
          exec: (visible) => <ShellView containerId={c.id} running={c.state === "running"} active={visible} onStart={() => void containerAction(c, "start")} />,
          files: () =>
            c.state === "running" ? (
              <FileBrowser key={c.startedAt ?? ""} fs={fs!} />
            ) : (
              <EmptyState title="The container isn't running">
                <Typography variant="body1">Start it to browse its filesystem.</Typography>
              </EmptyState>
            ),
          stats: () => <StatsTab containerId={c.id} running={c.state === "running"} />,
          health: (visible) => <HealthTab id={c.id} active={visible} />,
        }}
      />
    </Box>
  );
}
