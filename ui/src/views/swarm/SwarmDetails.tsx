import { useMemo, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Link, Stack, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UndoIcon from "@mui/icons-material/Undo";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import { useResource } from "../../hooks/useResource";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState } from "../../components/common";
import { KeepAliveTabs } from "../../components/KeepAliveTabs";
import { JsonTree } from "../../components/JsonTree";
import { LogViewer } from "../../components/logs/LogViewer";
import type { LogLine } from "../../components/logs/useLogStream";
import { fg } from "../../components/logs/ansi";
import { serviceColors } from "../../utils/serviceColor";
import { relativeTime } from "../../utils/format";
import { MONO } from "../../theme";
import { ReplicaBar, ServicesTable, SwarmPorts, updateLabel } from "./ServicesTable";
import { TasksTable } from "./TasksTable";
import { ScaleDialog, useSwarmActions } from "./useSwarmActions";
import { shortServiceName, SWARM_EVENTS, SwarmService, SwarmTask } from "./types";

const POLL = 3000;

function NotFound({ what, error }: { what: string; error: string }) {
  return (
    <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title={`${what} not found`}>
      <Typography sx={{ mb: 2 }}>{error}</Typography>
      <Button variant="contained" onClick={() => navigate("swarm")}>
        Back to swarm
      </Button>
    </EmptyState>
  );
}

const Loading = () => (
  <Stack alignItems="center" sx={{ py: 8 }}>
    <CircularProgress size={26} />
  </Stack>
);

function iconBtn(title: string, icon: JSX.Element, onClick: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) {
  return (
    <Tooltip title={title}>
      <span>
        <IconButton aria-label={title} onClick={onClick} disabled={opts.disabled} sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: opts.danger ? "error.main" : undefined }}>
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}

/** Merged swarm logs with per-service colour (label "service.slot") and per-service show/hide chips. */
function SwarmLogs({ path, serviceNames, downloadName }: { path: string; serviceNames: string[]; downloadName: string }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const colors = useMemo(() => serviceColors(serviceNames), [serviceNames]);
  const svcOf = (label: string) => label.replace(/\.[^.]+$/, "");
  const maxLen = Math.max(6, ...serviceNames.map((n) => n.length + 3));
  const prefix = useMemo(
    () => (l: LogLine) => fg(colors.get(svcOf(l.svc ?? "")) ?? "#8c959f", (l.svc ?? "?").padEnd(maxLen)) + fg("#8c959f", " | "),
    [colors, maxLen],
  );
  const plainPrefix = useMemo(() => (l: LogLine) => `${(l.svc ?? "?").padEnd(maxLen)} | `, [maxLen]);
  const lineFilter = useMemo(() => (l: LogLine) => !hidden.has(svcOf(l.svc ?? "")), [hidden]);
  const chips =
    serviceNames.length > 1 ? (
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {serviceNames.map((n) => {
          const on = !hidden.has(n);
          return (
            <Chip
              key={n}
              size="small"
              label={n}
              variant={on ? "filled" : "outlined"}
              onClick={() =>
                setHidden((h) => {
                  const x = new Set(h);
                  if (on) x.add(n);
                  else x.delete(n);
                  return x;
                })
              }
              sx={on ? { bgcolor: colors.get(n), color: "#fff", "&:hover": { bgcolor: colors.get(n), opacity: 0.85 } } : { color: "text.secondary" }}
            />
          );
        })}
      </Stack>
    ) : undefined;
  return (
    <LogViewer
      path={path}
      params={{ tail: "500" }}
      prefix={prefix}
      plainPrefix={plainPrefix}
      lineFilter={lineFilter}
      filterKey={[...hidden].sort().join(",") + ":" + serviceNames.join(",")}
      toolbarExtra={chips}
      downloadName={downloadName}
    />
  );
}

// ---- Service ---------------------------------------------------------------------------------

const SERVICE_TABS = [
  { key: "tasks", label: "Tasks" },
  { key: "logs", label: "Logs" },
  { key: "inspect", label: "Inspect" },
];

export function ServiceDetail({ id, tab }: { id: string; tab?: string }) {
  const { data, error, reload } = useResource<{ service: SwarmService; tasks: SwarmTask[]; inspect: unknown }>(`/swarm/services/${encodeURIComponent(id)}`, SWARM_EVENTS, 400, POLL);
  const actions = useSwarmActions(() => void reload());
  const [scaling, setScaling] = useState<SwarmService | null>(null);
  const active = SERVICE_TABS.some((t) => t.key === tab) ? tab! : "tasks";
  if (error && !data) return <NotFound what="Service" error={error} />;
  if (!data) return <Loading />;
  const s = data.service;
  const upd = updateLabel(s);
  const short = shortServiceName(s);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
        <IconButton onClick={() => (s.stack ? navigate("swarm", "stacks", s.stack) : navigate("swarm", "services"))} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <HubOutlinedIcon sx={{ fontSize: 32, mt: 0.25, color: (s.running ?? 0) >= (s.desired ?? 0) && s.desired ? "success.main" : "warning.main" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h2" noWrap>
              {s.name}
            </Typography>
            <ReplicaBar running={s.running} desired={s.desired} />
            {upd && <Chip size="small" label={upd.text} color={upd.color} variant="outlined" />}
          </Stack>
          <Stack direction="row" spacing={2} sx={{ mt: 0.5, flexWrap: "wrap" }} alignItems="center" useFlexGap>
            <Typography variant="body2" sx={{ fontFamily: MONO }}>
              {s.id.slice(0, 12)}
            </Typography>
            <Link href={href("images", s.image)} underline="hover" sx={{ fontSize: 13 }}>
              {s.image}
            </Link>
            {s.stack && (
              <Typography variant="body2" color="text.secondary">
                Stack{" "}
                <Link href={href("swarm", "stacks", s.stack)} underline="hover">
                  {s.stack}
                </Link>
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ textTransform: "capitalize" }}>
              {s.mode.replace("-", " ")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Updated {relativeTime(s.updatedAt)}
            </Typography>
            <SwarmPorts ports={s.ports} />
          </Stack>
          {s.update?.message && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {s.update.message}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          {iconBtn("Scale", <UnfoldMoreIcon fontSize="small" />, () => setScaling(s), { disabled: s.mode !== "replicated" })}
          {iconBtn("Restart (force update)", <RestartAltIcon fontSize="small" />, () => void actions.restart(s))}
          {iconBtn("Roll back", <UndoIcon fontSize="small" />, () => void actions.rollback(s), { disabled: !s.hasPrevious })}
          {iconBtn("Remove service", <DeleteOutlineIcon fontSize="small" />, () => void actions.remove(s).then((ok) => ok && navigate("swarm", "services")), { danger: true })}
        </Stack>
      </Stack>
      <Tabs value={active} onChange={(_, t) => navigate("swarm", "services", id, t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {SERVICE_TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          tasks: () => {
            const lastFailed = [...data.tasks].filter((t) => t.error).sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0];
            const degraded = (s.running ?? 0) < (s.desired ?? 0);
            return (
              <>
                {degraded && lastFailed && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    {s.running ?? 0} of {s.desired} replicas running. Latest task failure ({relativeTime(lastFailed.timestamp)}): <b>{lastFailed.error}</b>
                    {lastFailed.exitCode != null ? ` (exit code ${lastFailed.exitCode})` : ""}. Check the Logs tab; if the restart policy gave up, fix the image or command and restart
                    the service.
                  </Alert>
                )}
                <TasksTable tasks={data.tasks} />
              </>
            );
          },
          logs: () => <SwarmLogs path={`/ws/logs/service/${s.id}`} serviceNames={[short]} downloadName={s.name} />,
          inspect: () => <JsonTree data={data.inspect} />,
        }}
      />
      <ScaleDialog service={scaling} onClose={() => setScaling(null)} onScale={(svc, n) => void actions.scale(svc, n)} />
    </Box>
  );
}

// ---- Stack -----------------------------------------------------------------------------------

const STACK_TABS = [
  { key: "services", label: "Services" },
  { key: "tasks", label: "Tasks" },
  { key: "logs", label: "Logs" },
];

export function StackDetail({ name, tab }: { name: string; tab?: string }) {
  const { data, error, reload } = useResource<{ name: string; services: SwarmService[]; tasks: SwarmTask[] }>(
    `/swarm/stacks/${encodeURIComponent(name)}`,
    SWARM_EVENTS,
    400,
    POLL,
  );
  const { removeStack } = useSwarmActions(() => void reload());
  const active = STACK_TABS.some((t) => t.key === tab) ? tab! : "services";
  const shortNames = useMemo(() => (data?.services ?? []).map(shortServiceName).sort(), [data?.services]);
  const namesKey = shortNames.join(",");
  // Stable array identity for the log viewer (only changes when the service set does).
  const stableNames = useMemo(() => shortNames, [namesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !data) return <NotFound what="Stack" error={error} />;
  if (!data) return <Loading />;
  const running = data.services.reduce((a, s) => a + (s.running ?? 0), 0);
  const desired = data.services.reduce((a, s) => a + (s.desired ?? 0), 0);
  const svcNameById = Object.fromEntries(data.services.map((s) => [s.id, shortServiceName(s)]));

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
        <IconButton onClick={() => navigate("swarm", "stacks")} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <HubOutlinedIcon sx={{ fontSize: 32, mt: 0.25, color: running >= desired && desired ? "success.main" : "warning.main" }} />
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h2">{name}</Typography>
            <ReplicaBar running={running} desired={desired} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Swarm stack · {data.services.length} service{data.services.length === 1 ? "" : "s"}
          </Typography>
        </Box>
        {iconBtn("Remove stack", <DeleteOutlineIcon fontSize="small" />, () => void removeStack(name).then((ok) => ok && navigate("swarm", "stacks")), { danger: true })}
      </Stack>
      <Tabs value={active} onChange={(_, t) => navigate("swarm", "stacks", name, t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {STACK_TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          services: () => <ServicesTable services={data.services} reload={() => void reload()} showStack={false} />,
          tasks: () => <TasksTable tasks={data.tasks} serviceNames={svcNameById} />,
          logs: () => <SwarmLogs path={`/ws/logs/stack/${encodeURIComponent(name)}`} serviceNames={stableNames} downloadName={name} />,
        }}
      />
    </Box>
  );
}
