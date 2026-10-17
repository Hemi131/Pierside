import { ReactNode, useState } from "react";
import { Box, Button, Divider, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SpaceDashboardOutlinedIcon from "@mui/icons-material/SpaceDashboardOutlined";
import { api, inExtension, openExternal } from "../api/ddclient";
import { usePersistentState } from "../hooks/usePersistentState";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import KeyboardDoubleArrowLeftIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRightIcon from "@mui/icons-material/KeyboardDoubleArrowRight";
import { activateEngine, EngineList, engineSubtitle } from "../views/engines/engineApi";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import { navigate } from "../hooks/useRoute";
import { useEngine } from "../hooks/useEngine";
import { formatBytes } from "../utils/format";
import { EngineFrame } from "./EngineColor";
import { EngineAlerts } from "./EngineAlerts";
import { ComposeDialogHost } from "./compose/ComposeDialog";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { ForwardDialogHost } from "./ForwardDialog";
import { AccessPrompt } from "../views/access/AccessPrompt";
import { VersionFooter } from "./AboutDialog";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import TerminalIcon from "@mui/icons-material/Terminal";
import LanOutlinedIcon from "@mui/icons-material/LanOutlined";
import PieChartOutlineIcon from "@mui/icons-material/PieChartOutline";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import DonutLargeOutlinedIcon from "@mui/icons-material/DonutLargeOutlined";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";

const SECTIONS = [
  { key: "containers", label: "Containers", icon: <ViewInArOutlinedIcon fontSize="small" /> },
  { key: "images", label: "Images", icon: <LayersOutlinedIcon fontSize="small" /> },
  { key: "volumes", label: "Volumes", icon: <StorageOutlinedIcon fontSize="small" /> },
  { key: "networks", label: "Networks", icon: <LanOutlinedIcon fontSize="small" /> },
  { key: "ports", label: "Ports", icon: <SettingsEthernetIcon fontSize="small" /> },
  { key: "disk", label: "Disk usage", icon: <PieChartOutlineIcon fontSize="small" /> },
  { key: "swarm", label: "Swarm", icon: <HubOutlinedIcon fontSize="small" /> },
];

// Project views live under the Containers section.
const sectionOf = (route: string[]) => (route[0] === "projects" ? "containers" : route[0] || "containers");

/** The active engine (opens the engine menu), and under it, as its second line, Engines at a glance. */
function EngineSwitcher({ collapsed, glance }: { collapsed: boolean; glance: boolean }) {
  const { engine } = useEngine();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<EngineList | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = engine?.engine;
  const open = (el: HTMLElement) => {
    setAnchor(el);
    api.get<EngineList>("/engines").then(setList).catch(() => setList(null));
  };
  return (
    <>
      <Box sx={{ flexShrink: 0, mx: 1, mb: 1, borderRadius: 1, border: 1, borderColor: "divider", overflow: "hidden" }}>
        <Tooltip title={collapsed ? `Engine: ${meta?.name ?? "Local"}` : ""} placement="right">
          <ListItemButton
            onClick={(e) => open(e.currentTarget)}
            sx={{ flexGrow: 0, py: 0.5, px: collapsed ? 1 : 2, justifyContent: collapsed ? "center" : undefined, position: "relative" }}
            aria-label="Switch engine"
          >
            <ListItemIcon sx={{ minWidth: collapsed ? 0 : 32 }}>
              {meta?.type === "ssh" ? <CloudOutlinedIcon fontSize="small" /> : <ComputerIcon fontSize="small" />}
            </ListItemIcon>
            {!collapsed && (
              <ListItemText
                primary={meta?.name ?? "Local"}
                secondary={meta?.type === "ssh" ? engineSubtitle(meta.name, meta.target) : "Rancher Desktop"}
                primaryTypographyProps={{ noWrap: true, fontSize: 12.5, fontWeight: 600 }}
                secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
              />
            )}
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                bgcolor: engine?.ok ? "success.main" : engine ? "error.main" : "warning.main",
                ...(collapsed ? { position: "absolute", top: 4, right: 4 } : { ml: 0.5 }),
              }}
            />
          </ListItemButton>
        </Tooltip>
        <Divider />
        <Tooltip title={collapsed ? "Engines at a glance" : ""} placement="right">
          <ListItemButton
            selected={glance}
            onClick={() => navigate("glance")}
            sx={{ flexGrow: 0, py: 0.25, px: collapsed ? 1 : 2, justifyContent: collapsed ? "center" : undefined }}
            aria-label="Engines at a glance"
          >
            <ListItemIcon sx={{ minWidth: collapsed ? 0 : 32 }}>
              <SpaceDashboardOutlinedIcon fontSize="small" />
            </ListItemIcon>
            {!collapsed && <ListItemText primary="Engines at a glance" primaryTypographyProps={{ noWrap: true, fontSize: 12 }} />}
          </ListItemButton>
        </Tooltip>
      </Box>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {!list && <MenuItem disabled>Loading…</MenuItem>}
        {list?.engines.map((e) => (
          <MenuItem
            key={e.id}
            selected={e.active}
            disabled={busy}
            onClick={() => {
              if (e.active) return setAnchor(null);
              setBusy(true);
              activateEngine(e.id).catch((err) => {
                setBusy(false);
                window.alert((err as Error).message);
              });
            }}
          >
            <ListItemIcon>{e.type === "ssh" ? <CloudOutlinedIcon fontSize="small" /> : <ComputerIcon fontSize="small" />}</ListItemIcon>
            <ListItemText primary={e.name} secondary={e.type === "ssh" ? engineSubtitle(e.name, `${e.user}@${e.host}`) : "Rancher Desktop"} />
            {e.color && <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: e.color, ml: 2, flexShrink: 0 }} />}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            navigate("engines");
          }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Manage engines…</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

async function openSeparateWindow() {
  try {
    const { url } = await api.post<{ url: string }>("/standalone/ticket");
    openExternal(url);
  } catch (e) {
    window.alert(`Couldn't open a separate window: ${(e as Error).message}`);
  }
}

function Sidebar({ route }: { route: string[] }) {
  const active = sectionOf(route);
  const [collapsed, setCollapsed] = usePersistentState("sidebar.collapsed", false);
  const { containers } = useEngine();
  // Containers needing attention: unhealthy, or stuck restarting.
  const troubled = (containers ?? []).filter((c) => !c.isSystem && !c.isExtension && (c.health === "unhealthy" || c.state === "restarting"));
  const badges: Record<string, string> = troubled.length
    ? { containers: `${troubled.length} container${troubled.length > 1 ? "s" : ""} unhealthy or restarting: ${troubled.map((c) => c.name).join(", ")}` }
    : {};
  const item = (key: string, label: string, icon: ReactNode, onClick: () => void, selected = false) => (
    <Tooltip key={key} title={collapsed ? (badges[key] ? `${label}: ${badges[key]}` : label) : ""} placement="right">
      <ListItemButton
        selected={selected}
        onClick={onClick}
        aria-label={label}
        sx={{
          mx: 1,
          my: 0.25,
          borderRadius: 1,
          px: collapsed ? 1 : 2,
          justifyContent: collapsed ? "center" : undefined,
          "&.Mui-selected": { bgcolor: "action.selected", color: "primary.main", "& .MuiListItemIcon-root": { color: "primary.main" } },
        }}
      >
        <ListItemIcon sx={{ minWidth: collapsed ? 0 : 32, position: "relative" }}>
          {icon}
          {badges[key] && collapsed && <Box sx={{ position: "absolute", top: -2, right: -4, width: 8, height: 8, borderRadius: "50%", bgcolor: "error.main" }} />}
        </ListItemIcon>
        {!collapsed && <ListItemText primary={label} primaryTypographyProps={{ fontWeight: selected ? 600 : 500, fontSize: 13, noWrap: true }} />}
        {!collapsed && badges[key] && (
          <Tooltip title={badges[key]}>
            <Box sx={{ minWidth: 18, height: 18, px: 0.5, borderRadius: 9, bgcolor: "error.main", color: "error.contrastText", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {troubled.length}
            </Box>
          </Tooltip>
        )}
      </ListItemButton>
    </Tooltip>
  );
  return (
    <Box
      component="nav"
      sx={{
        width: collapsed ? 56 : 200,
        transition: "width 120ms ease",
        flexShrink: 0,
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        pt: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <EngineSwitcher collapsed={collapsed} glance={active === "glance"} />
      <List dense disablePadding>
        {SECTIONS.map((s) => item(s.key, s.label, s.icon, () => navigate(s.key), s.key === active))}
      </List>
      <Box sx={{ flex: 1 }} />
      <List dense disablePadding sx={{ pb: 1 }}>
        {item("access", "AI access", <SmartToyOutlinedIcon fontSize="small" />, () => navigate("access"), active === "access")}
        {inExtension && item("window", "Open in separate window", <OpenInNewIcon fontSize="small" />, () => void openSeparateWindow())}
        {item(
          "collapse",
          collapsed ? "Expand sidebar" : "Collapse sidebar",
          collapsed ? <KeyboardDoubleArrowRightIcon fontSize="small" /> : <KeyboardDoubleArrowLeftIcon fontSize="small" />,
          () => setCollapsed(!collapsed),
        )}
      </List>
    </Box>
  );
}

function Footer({ route, terminalOpen, onToggleTerminal }: { route: string[]; terminalOpen: boolean; onToggleTerminal: () => void }) {
  const { engine, totals, socket } = useEngine();
  const ok = engine?.ok;
  const ncpu = totals?.ncpu ?? engine?.info?.ncpu;
  const memTotal = totals?.memTotal ?? engine?.info?.memTotal;
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={3}
      sx={{ height: 32, px: 2, borderTop: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0, fontSize: 12, color: "text.secondary" }}
    >
      <Tooltip title={ok ? `Engine ${engine?.version ?? ""} · ${engine?.info?.os ?? ""}` : (engine?.error ?? "Connecting…")}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: ok ? "success.main" : engine ? "error.main" : "warning.main" }} />
          <Typography variant="body2">{ok ? "Engine running" : engine ? "Engine unavailable" : "Connecting…"}</Typography>
        </Stack>
      </Tooltip>
      {ok && totals && (
        <>
          <Typography variant="body2">
            CPU {totals.cpu.toFixed(2)}%{ncpu ? ` / ${ncpu * 100}%` : ""}
          </Typography>
          <Typography variant="body2">
            RAM {formatBytes(totals.mem)}
            {memTotal ? ` / ${formatBytes(memTotal)}` : ""}
          </Typography>
        </>
      )}
      <Box sx={{ flex: 1 }} />
      {socket === "polling" && (
        <Tooltip title="Live updates unavailable; refreshing every 3 s">
          <Typography variant="body2" color="warning.main">
            Polling
          </Typography>
        </Tooltip>
      )}
      {/* Only while an SSH engine is active: the files of that server (views/serverfiles). */}
      {engine?.engine?.type === "ssh" && (
        <Tooltip describeChild title="Browse and edit the files of this server">
          <Button
            size="small"
            color={route[0] === "server-files" ? "primary" : "inherit"}
            startIcon={<FolderOpenOutlinedIcon fontSize="small" />}
            onClick={() => navigate("server-files")}
            sx={{ minHeight: 0, py: 0.25 }}
          >
            Server files
          </Button>
        </Tooltip>
      )}
      {engine?.engine?.type === "ssh" && (
        <Tooltip describeChild title="See what uses the CPU, memory, disks and network of this server, by process and container">
          <Button
            size="small"
            color={route[0] === "server-perf" ? "primary" : "inherit"}
            startIcon={<SpeedOutlinedIcon fontSize="small" />}
            onClick={() => navigate("server-perf")}
            sx={{ minHeight: 0, py: 0.25 }}
          >
            Server performance
          </Button>
        </Tooltip>
      )}
      {engine?.engine?.type === "ssh" && (
        <Tooltip describeChild title="See what takes the disk space on this server">
          <Button
            size="small"
            color={route[0] === "server-disk" ? "primary" : "inherit"}
            startIcon={<DonutLargeOutlinedIcon fontSize="small" />}
            onClick={() => navigate("server-disk")}
            sx={{ minHeight: 0, py: 0.25 }}
          >
            Server disk
          </Button>
        </Tooltip>
      )}
      <Tooltip describeChild title={terminalOpen ? "Hide the terminal" : "Docker console (local engine) or a shell on the server (SSH engine)"}>
        <Button size="small" color={terminalOpen ? "primary" : "inherit"} startIcon={<TerminalIcon fontSize="small" />} onClick={onToggleTerminal} sx={{ minHeight: 0, py: 0.25 }}>
          Terminal
        </Button>
      </Tooltip>
      <VersionFooter />
    </Stack>
  );
}

export function Layout({ route, children }: { route: string[]; children: ReactNode }) {
  const [terminalOpen, setTerminalOpen] = usePersistentState("terminal.open", false);
  return (
    <EngineFrame>
      <EngineAlerts />
      <ComposeDialogHost />
      <ForwardDialogHost />
      <AccessPrompt />
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", bgcolor: "background.default" }}>
        <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Sidebar route={route} />
          <Box component="main" sx={{ flex: 1, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
            {children}
          </Box>
        </Box>
        {terminalOpen && <TerminalPanel onClose={() => setTerminalOpen(false)} />}
        <Footer route={route} terminalOpen={terminalOpen} onToggleTerminal={() => setTerminalOpen(!terminalOpen)} />
      </Box>
    </EngineFrame>
  );
}
