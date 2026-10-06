/** Compose pieces of the Containers list: menu items for project rows, rows for projects that are down. */
import { useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TableCell,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import CloudSyncOutlinedIcon from "@mui/icons-material/CloudSyncOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import BookmarkRemoveOutlinedIcon from "@mui/icons-material/BookmarkRemoveOutlined";
import NoteOutlinedIcon from "@mui/icons-material/NoteOutlined";
import { api, dd } from "../../api/ddclient";
import { canRunLocal, ComposeProject, composeOutput, ComposeProjects, explainComposeError, localPathProblem } from "../../api/compose";
import { openCompose } from "../../components/compose/ComposeDialog";
import { useFeedback } from "../../components/Feedback";
import { MONO } from "../../theme";
import { relativeTime } from "../../utils/format";
import { KebabMenu, MenuEntry } from "./Rows";

export type EngineType = "local" | "ssh";

/** Why compose commands can't run here, or null. */
export function composeUnavailable(engine: EngineType, p?: ComposeProject): string | null {
  if (engine === "local" && !canRunLocal()) return "Compose commands run inside Rancher Desktop only (not in the separate window)";
  if (p && p.configFiles.length === 0) return "Pierside doesn't know where this project's compose file is";
  if (p && engine === "local") return localPathProblem(p);
  return null;
}

/** Compose actions for a project row's ⋮ menu (Up / Down / Pull and recreate / View configuration). */
export function composeMenu(p: ComposeProject | undefined, engine: EngineType, running: boolean, onDone?: () => void): MenuEntry[] {
  if (!p) return [];
  const disabled = !!composeUnavailable(engine, p);
  const open = (mode: "up" | "down" | "pull" | "config", direct = false) => openCompose({ project: p, engine, mode, direct, onDone });
  return [
    { label: "Compose up…", icon: <ArrowUpwardIcon fontSize="small" />, onClick: () => open("up"), disabled, divider: true },
    { label: "Pull and recreate", icon: <CloudSyncOutlinedIcon fontSize="small" />, onClick: () => open("pull", true), disabled },
    { label: "Compose down…", icon: <ArrowDownwardIcon fontSize="small" />, onClick: () => open("down"), disabled: disabled || !running && p.containers === 0 },
    { label: "View compose configuration", icon: <DescriptionOutlinedIcon fontSize="small" />, onClick: () => open("config"), disabled },
  ];
}

/** A remembered compose project with no containers (after `docker compose down`). */
export function DownProjectRow({ p, engine, onChanged }: { p: ComposeProject; engine: EngineType; onChanged: () => void }) {
  const { toast, confirm } = useFeedback();
  const why = composeUnavailable(engine, p);
  const forget = async () => {
    const ok = await confirm({
      title: "Forget this project?",
      message: `Pierside stops listing "${p.name}" and forgets its compose file location and saved options. Nothing is deleted.`,
      confirmLabel: "Forget",
    });
    if (!ok) return;
    try {
      await api.del(`/compose/projects/${encodeURIComponent(p.name)}`);
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const menu: MenuEntry[] = [
    ...composeMenu(p, engine, false, onChanged).filter((m) => !m.label.startsWith("Compose down")),
    { label: "Forget project", icon: <BookmarkRemoveOutlinedIcon fontSize="small" />, onClick: () => void forget(), divider: true },
  ];
  menu[0] = { ...menu[0], divider: false };
  return (
    <TableRow hover sx={{ "& > td": { py: 0.75 } }}>
      <TableCell padding="checkbox">
        <Checkbox size="small" disabled inputProps={{ "aria-label": `${p.name} is down` }} />
      </TableCell>
      <TableCell sx={{ width: 36, pl: 0, pr: 0 }}>
        <Stack direction="row" alignItems="center" sx={{ pl: 3.5 }}>
          <LayersOutlinedIcon sx={{ fontSize: 20, color: "text.disabled" }} />
        </Stack>
      </TableCell>
      <TableCell sx={{ maxWidth: 320 }}>
        <Typography sx={{ fontWeight: 600, color: "text.secondary" }}>{p.name}</Typography>
        <Tooltip title={p.configFiles.join(", ")}>
          <Typography variant="body2" color="text.secondary" noWrap sx={{ fontFamily: MONO, fontSize: 11.5 }}>
            {p.configFiles.map((f) => f.split(/[\\/]/).slice(-2).join("/")).join(", ") || "compose file unknown"}
          </Typography>
        </Tooltip>
      </TableCell>
      <TableCell />
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", border: 1.5, borderColor: "text.disabled" }} />
          <Typography variant="body1" component="span" color="text.secondary">
            Down
          </Typography>
        </Stack>
      </TableCell>
      <TableCell />
      <TableCell align="right">N/A</TableCell>
      <TableCell>
        <Tooltip title={p.lastSeen ? `Last seen running ${new Date(p.lastSeen * 1000).toLocaleString()}` : ""}>
          <span>{p.lastSeen ? relativeTime(p.lastSeen * 1000) : "—"}</span>
        </Tooltip>
      </TableCell>
      <TableCell align="right" sx={{ pr: 1 }}>
        <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={0.25}>
          <Box sx={{ width: 30, display: "flex", justifyContent: "center" }}>
            <Tooltip title={why ?? "Compose up (with the saved options)"}>
              <span>
                <IconButton disabled={!!why} aria-label={`Compose up ${p.name}`} onClick={() => openCompose({ project: p, engine, mode: "up", direct: true, onDone: onChanged })}>
                  <PlayArrowIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <KebabMenu items={menu} label={`More actions for ${p.name}`} />
          <Box sx={{ width: 30 }} />
        </Stack>
      </TableCell>
    </TableRow>
  );
}

/**
 * "Open compose file": pick a file (a native dialog on the local engine, a server path on an SSH
 * engine), read its project name with `docker compose config`, remember it, then offer Up.
 */
export function OpenComposeButton({ compose, onAdded }: { compose: ComposeProjects | null; onAdded: () => void }) {
  const { toast } = useFeedback();
  const [askPath, setAskPath] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const engine = compose?.engine.type ?? "local";
  const why = composeUnavailable(engine);

  const add = async (file: string) => {
    setBusy(true);
    try {
      const dir = file.replace(/[\\/][^\\/]*$/, "") || "/";
      const out = await composeOutput(engine, ["--ansi", "never", "-f", file, "config", "--format", "json"], dir);
      const name = (JSON.parse(out.join("\n")) as { name?: string }).name;
      if (!name) throw new Error("Couldn't find the project name in that file");
      const entry = await api.put<Omit<ComposeProject, "name" | "containers" | "running" | "services">>(`/compose/projects/${encodeURIComponent(name)}`, {
        configFiles: [file],
        workingDir: dir,
      });
      onAdded();
      setAskPath(false);
      openCompose({ project: { name, containers: 0, running: 0, services: [], ...entry }, engine, mode: "up", onDone: onAdded });
    } catch (e) {
      const msg = (e as Error).message;
      const hint = explainComposeError([msg], { name: "", configFiles: [file], workingDir: file.replace(/[\\/][^\\/]*$/, ""), options: {}, lastSeen: null, containers: 0, running: 0, services: [] }, engine === "ssh" ? "the server" : "this computer");
      toast("error", hint ?? `Couldn't open ${file}: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    if (engine === "ssh") {
      setAskPath(true);
      return;
    }
    const res = (await dd!.desktopUI.dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Compose files", extensions: ["yml", "yaml"] }],
    })) as { canceled: boolean; filePaths: string[] };
    if (!res.canceled && res.filePaths[0]) await add(res.filePaths[0]);
  };

  return (
    <>
      <Tooltip title={why ?? "Add a compose project from its file and bring it up"}>
        <span>
          <Button variant="outlined" startIcon={<NoteOutlinedIcon />} disabled={!!why || busy} onClick={() => void pick()}>
            Open compose file
          </Button>
        </span>
      </Tooltip>
      <Dialog open={askPath} onClose={() => setAskPath(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Open a compose file on the server</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Path on the server"
            placeholder="/home/deploy/app/docker-compose.yml"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && path.trim() && void add(path.trim())}
            sx={{ mt: 1 }}
            InputProps={{ sx: { fontFamily: MONO } }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="outlined" onClick={() => setAskPath(false)}>
            Cancel
          </Button>
          <Button variant="contained" disabled={!path.trim() || busy} onClick={() => void add(path.trim())}>
            Open
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
