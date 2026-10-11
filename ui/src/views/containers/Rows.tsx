import { MouseEvent, useState } from "react";
import { Box, Checkbox, CircularProgress, IconButton, Link, ListItemIcon, ListItemText, Menu, MenuItem, Divider, Stack, TableCell, TableRow, Tooltip, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import TerminalIcon from "@mui/icons-material/Terminal";
import PauseIcon from "@mui/icons-material/Pause";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import LayersIcon from "@mui/icons-material/Layers";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import { useSwarmActions } from "../swarm/useSwarmActions";
import type { Container, ContainerStats } from "../../api/types";
import { CopyableId, PortLinks, StatusDot, stateColor } from "../../components/common";
import { href, navigate } from "../../hooks/useRoute";
import { projectKey, useActions } from "../../hooks/useActions";
import { formatPercent, relativeTime } from "../../utils/format";
import { displayImage, isActive, ProjectGroup, projectStatus, statusLabel } from "./model";
import type { ComposeProject } from "../../api/compose";
import { composeMenu, EngineType } from "./ComposeRows";
import { openForward } from "../../components/ForwardDialog";
import CallMadeIcon from "@mui/icons-material/CallMade";

export const COLS = 9;

export interface MenuEntry {
  label: string;
  icon: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

export function KebabMenu({ items, label }: { items: MenuEntry[]; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Tooltip title="Show container actions">
        <IconButton
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            setAnchor(e.currentTarget);
          }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {items.flatMap((it) => [
          it.divider ? <Divider key={`${it.label}-div`} /> : null,
          <MenuItem
            key={it.label}
            disabled={it.disabled}
            onClick={() => {
              setAnchor(null);
              it.onClick();
            }}
            sx={it.danger ? { color: "error.main" } : undefined}
          >
            <ListItemIcon sx={it.danger ? { color: "error.main" } : undefined}>{it.icon}</ListItemIcon>
            <ListItemText>{it.label}</ListItemText>
          </MenuItem>,
        ])}
      </Menu>
    </>
  );
}

function ActionCell({ busy, active, paused, onToggle, toggleLabel, menu, onDelete, name, toggleDisabledReason, startRest }: {
  toggleDisabledReason?: string;
  /** A project with some containers stopped: a start button for those, next to Stop all. */
  startRest?: { label: string; onClick: () => void };
  busy: boolean;
  active: boolean;
  paused?: boolean;
  onToggle: () => void;
  toggleLabel: string;
  menu: MenuEntry[];
  onDelete: () => void;
  name: string;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={0.25} onClick={stop}>
      {startRest && !busy && (
        <Tooltip title={startRest.label}>
          <IconButton aria-label={`${startRest.label} of ${name}`} onClick={startRest.onClick}>
            <PlayArrowIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Box sx={{ width: 30, display: "flex", justifyContent: "center" }}>
        {busy ? (
          <CircularProgress size={16} />
        ) : toggleDisabledReason ? (
          <Tooltip title={toggleDisabledReason}>
            <span>
              <IconButton disabled aria-label={toggleDisabledReason}>
                {active ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title={toggleLabel}>
            <IconButton aria-label={`${toggleLabel} ${name}`} onClick={onToggle}>
              {active && !paused ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <KebabMenu items={menu} label={`More actions for ${name}`} />
      <Tooltip title="Delete">
        <span>
          <IconButton aria-label={`Delete ${name}`} onClick={onDelete} disabled={busy}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

export function ContainerRow({ c, stats, nested, selected, onSelect, pending }: {
  c: Container;
  stats?: ContainerStats;
  nested?: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  pending?: string;
}) {
  const { containerAction, deleteContainers, copyRunCommand } = useActions();
  const active = isActive(c.state);
  const paused = c.state === "paused";
  const open = (tab?: string) => navigate("containers", c.id, ...(tab ? [tab] : []));

  const menu: MenuEntry[] = [
    { label: "View details", icon: <InfoOutlinedIcon fontSize="small" />, onClick: () => open() },
    { label: "View logs", icon: <ArticleOutlinedIcon fontSize="small" />, onClick: () => open("logs") },
    { label: "Open in terminal", icon: <TerminalIcon fontSize="small" />, onClick: () => open("exec"), disabled: c.state !== "running" },
    paused
      ? { label: "Resume", icon: <PlayArrowIcon fontSize="small" />, onClick: () => void containerAction(c, "unpause"), divider: true }
      : { label: "Pause", icon: <PauseIcon fontSize="small" />, onClick: () => void containerAction(c, "pause"), disabled: c.state !== "running", divider: true },
    { label: "Restart", icon: <RestartAltIcon fontSize="small" />, onClick: () => void containerAction(c, "restart") },
    { label: "Copy docker run", icon: <ContentCopyIcon fontSize="small" />, onClick: () => void copyRunCommand(c) },
    { label: "Forward port…", icon: <CallMadeIcon fontSize="small" />, onClick: () => openForward({ container: c }), disabled: c.state !== "running" },
    { label: "Delete", icon: <DeleteOutlineIcon fontSize="small" />, onClick: () => void deleteContainers([c]), danger: true, divider: true },
  ];

  return (
    <TableRow hover selected={selected} onClick={() => open()} sx={{ cursor: "pointer", "& > td": { py: 0.75 } }}>
      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
        <Checkbox size="small" checked={selected} onChange={(e) => onSelect(e.target.checked)} inputProps={{ "aria-label": `Select ${c.name}` }} />
      </TableCell>
      <TableCell sx={{ width: 36, pl: nested ? 4 : 1, pr: 0 }}>
        <Tooltip title={c.status}>
          <ViewInArOutlinedIcon sx={{ fontSize: 20, color: stateColor(c.state, c.health), display: "block" }} />
        </Tooltip>
      </TableCell>
      <TableCell sx={{ maxWidth: 280 }}>
        <Link href={href("containers", c.id)} underline="hover" onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 500, display: "block", maxWidth: 280 }} noWrap title={c.name}>
          {c.name}
        </Link>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <CopyableId id={c.id} />
          {c.swarmServiceId && (
            <Tooltip title={`Swarm task of ${c.swarmService}: Swarm replaces it if it stops`}>
              <Typography variant="body2" component="span" sx={{ fontSize: 10.5, px: 0.5, borderRadius: 0.5, border: 1, borderColor: "divider", color: "text.secondary" }}>
                swarm
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ maxWidth: 260 }}>
        <Link href={href("images", c.image)} underline="hover" color="inherit" onClick={(e) => e.stopPropagation()} noWrap sx={{ display: "block", maxWidth: 240 }} title={c.image}>
          {displayImage(c.image)}
        </Link>
      </TableCell>
      <TableCell>
        <Tooltip title={c.status}>
          <Stack direction="row" spacing={1} alignItems="center">
            <StatusDot state={c.state} health={c.health} size={8} />
            <Typography variant="body1" component="span" noWrap>
              {statusLabel(c)}
            </Typography>
          </Stack>
        </Tooltip>
      </TableCell>
      <TableCell>
        <PortLinks ports={c.ports} />
      </TableCell>
      <TableCell align="right">{c.state === "running" ? formatPercent(stats?.cpu ?? 0) : "N/A"}</TableCell>
      <TableCell>
        <Tooltip title={c.startedAt ? new Date(c.startedAt).toLocaleString() : ""}>
          <span>{relativeTime(c.startedAt)}</span>
        </Tooltip>
      </TableCell>
      <TableCell align="right" sx={{ pr: 1 }}>
        <ActionCell
          busy={!!pending}
          active={active}
          paused={paused}
          toggleLabel={paused ? "Resume" : active ? "Stop" : "Start"}
          onToggle={() => void containerAction(c, paused ? "unpause" : active ? "stop" : "start")}
          menu={menu}
          onDelete={() => void deleteContainers([c])}
          name={c.name}
        />
      </TableCell>
    </TableRow>
  );
}

export function ProjectRow({ g, expanded, onToggleExpand, checked, indeterminate, onSelect, cpu, pending, compose, engineType = "local" }: {
  g: ProjectGroup;
  /** The remembered compose project (file location, saved options), when known. */
  compose?: ComposeProject;
  engineType?: EngineType;
  expanded: boolean;
  onToggleExpand: () => void;
  checked: boolean;
  indeterminate: boolean;
  onSelect: (checked: boolean) => void;
  cpu: number | null;
  pending?: string;
}) {
  const { projectAction, deleteProject } = useActions();
  const swarmActions = useSwarmActions(() => undefined);
  const swarm = g.source === "swarm";
  const isStack = swarm && !!g.containers[0]?.stack;
  const swarmTarget: [string, string, string] = isStack ? ["swarm", "stacks", g.name] : ["swarm", "services", g.containers[0]?.swarmServiceId ?? g.name];
  const anyActive = g.containers.some((c) => isActive(c.state));
  // What the project's start action starts (see backend routers/projects.py).
  const stopped = g.containers.filter((c) => c.state === "created" || c.state === "exited" || c.state === "dead").length;
  const allPaused = g.containers.every((c) => c.state === "paused" || !isActive(c.state)) && g.containers.some((c) => c.state === "paused");
  const open = (tab?: string) => (swarm ? navigate(...swarmTarget, ...(tab ? [tab] : [])) : navigate("projects", g.name, ...(tab ? [tab] : [])));
  const removeSwarm = () => {
    if (isStack) void swarmActions.removeStack(g.name);
    else {
      const id = g.containers[0]?.swarmServiceId;
      if (id) void swarmActions.remove({ id, name: g.containers[0]?.swarmService ?? g.name });
    }
  };
  const lastStarted = g.containers.reduce<string | null>((m, c) => (c.startedAt && (!m || c.startedAt > m) ? c.startedAt : m), null);

  const menu: MenuEntry[] = swarm
    ? [
        { label: isStack ? "View stack" : "View service", icon: <InfoOutlinedIcon fontSize="small" />, onClick: () => open() },
        { label: "View logs", icon: <ArticleOutlinedIcon fontSize="small" />, onClick: () => open("logs") },
        { label: isStack ? "Remove stack" : "Remove service", icon: <DeleteOutlineIcon fontSize="small" />, onClick: removeSwarm, danger: true, divider: true },
      ]
    : [
    { label: "View details", icon: <InfoOutlinedIcon fontSize="small" />, onClick: () => open() },
    { label: "View logs", icon: <ArticleOutlinedIcon fontSize="small" />, onClick: () => open("logs") },
    allPaused
      ? { label: "Resume all", icon: <PlayArrowIcon fontSize="small" />, onClick: () => void projectAction(g.name, "unpause"), divider: true }
      : { label: "Pause all", icon: <PauseIcon fontSize="small" />, onClick: () => void projectAction(g.name, "pause"), disabled: g.running === 0, divider: true },
    { label: "Restart", icon: <RestartAltIcon fontSize="small" />, onClick: () => void projectAction(g.name, "restart") },
    ...composeMenu(compose, engineType, anyActive),
    { label: "Delete", icon: <DeleteOutlineIcon fontSize="small" />, onClick: () => void deleteProject(g.name, g.containers.length), danger: true, divider: true },
  ];

  return (
    <TableRow hover onClick={onToggleExpand} sx={{ cursor: "pointer", "& > td": { py: 0.75 } }}>
      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          size="small"
          checked={checked}
          indeterminate={indeterminate}
          onChange={(e) => onSelect(e.target.checked)}
          inputProps={{ "aria-label": `Select project ${g.name}` }}
        />
      </TableCell>
      <TableCell sx={{ width: 36, pl: 0, pr: 0 }}>
        <Stack direction="row" alignItems="center">
          <IconButton
            size="small"
            sx={{ p: 0.25 }}
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
          >
            {expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
          </IconButton>
          {swarm ? <HubOutlinedIcon sx={{ fontSize: 20, color: stateColor(g.state) }} /> : <LayersIcon sx={{ fontSize: 20, color: stateColor(g.state) }} />}
        </Stack>
      </TableCell>
      <TableCell>
        <Link href={swarm ? href(...swarmTarget) : href("projects", g.name)} underline="hover" onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 600 }}>
          {g.name}
        </Link>
        <Typography variant="body2" color="text.secondary">
          {swarm ? (isStack ? "Swarm stack · " : "Swarm service · ") : ""}
          {g.containers.length} container{g.containers.length === 1 ? "" : "s"}
        </Typography>
      </TableCell>
      <TableCell />
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <StatusDot state={g.state} size={8} />
          <Typography variant="body1" component="span" noWrap>
            {projectStatus(g)}
          </Typography>
        </Stack>
      </TableCell>
      <TableCell />
      <TableCell align="right">{cpu == null ? "N/A" : formatPercent(cpu)}</TableCell>
      <TableCell>{relativeTime(lastStarted)}</TableCell>
      <TableCell align="right" sx={{ pr: 1 }}>
        <ActionCell
          busy={!!pending}
          active={anyActive}
          toggleLabel={anyActive ? "Stop all" : "Start all"}
          toggleDisabledReason={swarm ? "Managed by Swarm: scale or remove it in the Swarm view" : undefined}
          onToggle={() => void projectAction(g.name, anyActive ? "stop" : "start")}
          startRest={!swarm && anyActive && stopped > 0 ? { label: `Start the ${stopped} stopped`, onClick: () => void projectAction(g.name, "start") } : undefined}
          menu={menu}
          onDelete={() => (swarm ? removeSwarm() : void deleteProject(g.name, g.containers.length))}
          name={g.name}
        />
      </TableCell>
    </TableRow>
  );
}

export { projectKey };
