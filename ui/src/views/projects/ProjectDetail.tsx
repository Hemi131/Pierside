import { useMemo, useState } from "react";
import { Box, Button, Checkbox, CircularProgress, IconButton, Link, Paper, Stack, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import StopIcon from "@mui/icons-material/Stop";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LayersIcon from "@mui/icons-material/Layers";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import TerminalIcon from "@mui/icons-material/Terminal";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import type { Container } from "../../api/types";
import { useEngine } from "../../hooks/useEngine";
import { projectKey, useActions, usePending } from "../../hooks/useActions";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, PortLinks, StatusDot, stateColor } from "../../components/common";
import { LogViewer } from "../../components/logs/LogViewer";
import type { LogLine } from "../../components/logs/useLogStream";
import { fg } from "../../components/logs/ansi";
import { serviceColors } from "../../utils/serviceColor";
import { copyText, formatPercent } from "../../utils/format";
import { useFeedback } from "../../components/Feedback";
import { isActive, statusLabel } from "../containers/model";
import { useResource } from "../../hooks/useResource";
import type { ComposeProjects } from "../../api/compose";
import { composeMenu } from "../containers/ComposeRows";
import { KebabMenu } from "../containers/Rows";

/** Same labelling as the backend: service, or service-N when a service has replicas. */
function serviceLabels(cs: Container[]): Map<string, string> {
  const bySvc = new Map<string, Container[]>();
  cs.forEach((c) => {
    const s = c.service ?? c.name;
    bySvc.set(s, [...(bySvc.get(s) ?? []), c]);
  });
  const out = new Map<string, string>();
  bySvc.forEach((list, svc) => list.forEach((c) => out.set(c.id, list.length > 1 && c.containerNumber ? `${svc}-${c.containerNumber}` : svc)));
  return out;
}

function aggregate(cs: Container[]) {
  const running = cs.filter((c) => c.state === "running").length;
  const state = running === cs.length ? "running" : running > 0 ? "partial" : cs.some((c) => c.state === "paused") ? "paused" : "exited";
  return { running, state: state as "running" | "partial" | "paused" | "exited" };
}

function ServiceRow({ c, label, color, visible, onVisible, cpu }: { c: Container; label: string; color: string; visible: boolean; onVisible: (v: boolean) => void; cpu?: number }) {
  const { containerAction } = useActions();
  const pending = usePending().get(c.id);
  const active = isActive(c.state);
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1, py: 0.75, borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}>
      <Tooltip title={visible ? "Hide this service's logs" : "Show this service's logs"}>
        <Checkbox
          size="small"
          checked={visible}
          onChange={(e) => onVisible(e.target.checked)}
          sx={{ p: 0.5, color, "&.Mui-checked": { color } }}
          inputProps={{ "aria-label": `Show logs for ${label}` }}
        />
      </Tooltip>
      <StatusDot state={c.state} health={c.health} size={8} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Link href={href("containers", c.id)} underline="hover" sx={{ fontWeight: 500, display: "block" }} noWrap>
          {label}
        </Link>
        <Typography variant="body2" color="text.secondary" noWrap>
          {statusLabel(c)}
          {c.state === "running" && cpu != null ? ` · ${formatPercent(cpu)}` : ""}
        </Typography>
        <PortLinks ports={c.ports} max={2} />
      </Box>
      {pending ? (
        <CircularProgress size={16} sx={{ mx: 1 }} />
      ) : (
        <Tooltip title={active ? "Stop" : "Start"}>
          <IconButton onClick={() => void containerAction(c, active ? "stop" : "start")} aria-label={`${active ? "Stop" : "Start"} ${label}`}>
            {active ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Open in terminal">
        <span>
          <IconButton disabled={c.state !== "running"} onClick={() => navigate("containers", c.id, "exec")} aria-label={`Open terminal in ${label}`}>
            <TerminalIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

export function ProjectDetail({ name }: { name: string }) {
  const { containers, stats } = useEngine();
  const { projectAction, deleteProject } = useActions();
  const { toast } = useFeedback();
  const pending = usePending().get(projectKey(name));
  const cs = useMemo(() => (containers ?? []).filter((c) => c.project === name).sort((a, b) => a.name.localeCompare(b.name)), [containers, name]);
  const labels = useMemo(() => serviceLabels(cs), [cs]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const compose = useResource<ComposeProjects>("/compose/projects", ["container"], 800);
  const composeProject = compose.data?.projects.find((p) => p.name === name);

  const colors = useMemo(() => serviceColors(labels.values()), [labels]);
  const maxLen = useMemo(() => Math.max(4, ...[...labels.values()].map((l) => l.length)), [labels]);
  const prefix = useMemo(
    () => (l: LogLine) => fg(colors.get(l.svc ?? "") ?? "#8c959f", (l.svc ?? "?").padEnd(maxLen)) + fg("#8c959f", " | "),
    [maxLen, colors],
  );
  const plainPrefix = useMemo(() => (l: LogLine) => `${(l.svc ?? "?").padEnd(maxLen)} | `, [maxLen]);
  const lineFilter = useMemo(() => (l: LogLine) => !hidden.has(l.svc ?? ""), [hidden]);

  if (cs.length === 0) {
    return (
      <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title={`Project "${name}" not found`}>
        <Typography variant="body1" sx={{ mb: 2 }}>
          It has no containers (any more).
        </Typography>
        <Button variant="contained" onClick={() => navigate("containers")}>
          Back to containers
        </Button>
      </EmptyState>
    );
  }

  const { running, state } = aggregate(cs);
  const anyActive = cs.some((c) => isActive(c.state));
  const workingDir = cs[0].projectWorkingDir;
  const setVisible = (label: string, v: boolean) =>
    setHidden((h) => {
      const n = new Set(h);
      if (v) n.delete(label);
      else n.add(label);
      return n;
    });
  const allLabels = [...new Set(labels.values())];

  const btn = (title: string, icon: JSX.Element, onClick: () => void, danger = false) => (
    <Tooltip title={title}>
      <span>
        <IconButton aria-label={title} onClick={onClick} disabled={!!pending} sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: danger ? "error.main" : undefined }}>
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 2 }}>
        <IconButton onClick={() => navigate("containers")} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <LayersIcon sx={{ fontSize: 32, color: stateColor(state), mt: 0.25 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <Typography variant="h2" noWrap>
              {name}
            </Typography>
            <Stack direction="row" alignItems="center" spacing={0.75}>
              <StatusDot state={state} size={8} />
              <Typography variant="body1" color="text.secondary">
                {running === 0 ? "Exited" : `Running (${running}/${cs.length})`}
              </Typography>
            </Stack>
            {pending && <CircularProgress size={16} />}
          </Stack>
          {workingDir && (
            <Tooltip title="Copy path">
              <Typography
                variant="body2"
                color="text.secondary"
                onClick={() => void copyText(workingDir).then(() => toast("success", "Path copied"))}
                sx={{ fontFamily: "monospace", cursor: "pointer", mt: 0.5, display: "inline-flex", alignItems: "center", gap: 0.5, "&:hover": { color: "text.primary" } }}
              >
                {workingDir}
                <ContentCopyIcon sx={{ fontSize: 12 }} />
              </Typography>
            </Tooltip>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          {anyActive
            ? btn("Stop all", <StopIcon fontSize="small" />, () => void projectAction(name, "stop"))
            : btn("Start all", <PlayArrowIcon fontSize="small" />, () => void projectAction(name, "start"))}
          {btn("Restart", <RestartAltIcon fontSize="small" />, () => void projectAction(name, "restart"))}
          {composeProject && (
            <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, display: "flex" }}>
              <KebabMenu items={composeMenu(composeProject, compose.data!.engine.type, anyActive).map((m, i) => (i ? m : { ...m, divider: false }))} label="Compose actions" />
            </Box>
          )}
          {btn("Delete", <DeleteOutlineIcon fontSize="small" />, () => void deleteProject(name, cs.length).then((ok) => ok && navigate("containers")), true)}
        </Stack>
      </Stack>

      <Box sx={{ display: "flex", gap: 2, flex: 1, minHeight: 0 }}>
        <Paper variant="outlined" sx={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Stack direction="row" alignItems="center" sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
            <Typography variant="h5" sx={{ flex: 1 }}>
              Services ({cs.length})
            </Typography>
            <Button size="small" onClick={() => setHidden(hidden.size ? new Set() : new Set(allLabels))}>
              {hidden.size ? "Show all" : "Hide all"}
            </Button>
          </Stack>
          <Box sx={{ overflow: "auto", flex: 1 }}>
            {cs.map((c) => {
              const label = labels.get(c.id) ?? c.name;
              return <ServiceRow key={c.id} c={c} label={label} color={colors.get(label) ?? "#8c959f"} visible={!hidden.has(label)} onVisible={(v) => setVisible(label, v)} cpu={stats[c.id]?.cpu} />;
            })}
          </Box>
        </Paper>
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <LogViewer
            path={`/ws/logs/project/${encodeURIComponent(name)}`}
            params={{ tail: "2000" }}
            prefix={prefix}
            plainPrefix={plainPrefix}
            lineFilter={lineFilter}
            filterKey={[...hidden].sort().join(",") + `:${[...colors.keys()].join(",")}`}
            downloadName={name}
            stoppedLabel="All services are stopped. New logs will appear here when they start."
          />
        </Box>
      </Box>
    </Box>
  );
}
