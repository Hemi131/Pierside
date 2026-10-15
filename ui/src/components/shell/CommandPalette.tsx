/**
 * Command palette for the Exec tab: the user's labelled commands (api/commands.ts), searched by
 * label or text. The ones whose scope matches this container come first; while searching, the
 * others are listed below them. Using one hands it to the shell (onUse), which types it, and
 * presses Enter too when the command is set to run.
 */
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListSubheader,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import KeyboardReturnIcon from "@mui/icons-material/KeyboardReturn";
import { commandApplies, loadCommands, newCommand, PaletteCommand, saveCommands, scopeText, ShellTarget } from "../../api/commands";
import { MONO } from "../../theme";
import { useFeedback } from "../Feedback";

export function CommandPalette({
  open,
  onClose,
  target,
  onUse,
  onClosed,
}: {
  open: boolean;
  onClose: () => void;
  /** After the closing transition, when focus can move elsewhere (the dialog's focus trap is gone). */
  onClosed?: () => void;
  target: ShellTarget;
  /** run: press Enter after typing it. */
  onUse: (command: string, run: boolean) => void;
}) {
  const { toast, confirm } = useFeedback();
  const [list, setList] = useState<PaletteCommand[] | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<PaletteCommand | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Read the list on every open: the other view (Rancher / separate window) may have changed it.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    loadCommands()
      .then(setList)
      .catch((e) => {
        setList((l) => l ?? []);
        toast("error", `Can't load your commands: ${(e as Error).message}`);
      });
  }, [open, toast]);

  const q = query.trim().toLowerCase();
  const { here, other } = useMemo(() => {
    const found = (list ?? []).filter((c) => !q || c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q));
    return { here: found.filter((c) => commandApplies(c, target)), other: q ? found.filter((c) => !commandApplies(c, target)) : [] };
  }, [list, q, target]);
  const flat = [...here, ...other];
  const current = flat[Math.min(sel, flat.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const use = (c: PaletteCommand, run: boolean) => {
    onClose();
    onUse(c.command, run);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      // Alt+Enter: only type it, even if it's set to run.
      use(current, current.run && !e.altKey);
    }
  };

  const save = async (next: PaletteCommand[]) => {
    try {
      setList(await saveCommands(next));
      return true;
    } catch (e) {
      toast("error", `Can't save your commands: ${(e as Error).message}`);
      return false;
    }
  };

  const row = (c: PaletteCommand, i: number) => (
    <ListItemButton key={c.id} data-index={i} selected={i === sel} onMouseMove={() => setSel(i)} onClick={() => use(c, c.run)} sx={{ py: 0.5, pr: 1, alignItems: "center" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography sx={{ fontWeight: 500 }} noWrap>
            {c.label}
          </Typography>
          {c.scope.kind !== "all" && <Chip size="small" variant="outlined" label={scopeText(c)} sx={{ height: 18, fontSize: 11 }} />}
        </Stack>
        <Typography variant="body2" color="text.secondary" noWrap sx={{ fontFamily: MONO }}>
          {c.command}
        </Typography>
      </Box>
      <Stack direction="row" sx={{ visibility: i === sel ? "visible" : "hidden" }} onClick={(e) => e.stopPropagation()}>
        <Tooltip title="Type it without running">
          <IconButton size="small" onClick={() => use(c, false)}>
            <KeyboardReturnIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Run it">
          <IconButton size="small" onClick={() => use(c, true)}>
            <PlayArrowIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Edit">
          <IconButton size="small" onClick={() => setEditing(c)}>
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </ListItemButton>
  );

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" disableRestoreFocus TransitionProps={{ onExited: onClosed }} PaperProps={{ sx: { alignSelf: "flex-start", mt: 10 } }}>
        <Box sx={{ p: 1.5, pb: 1 }}>
          <TextField
            autoFocus
            fullWidth
            placeholder="Search your commands"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        </Box>
        <List ref={listRef} dense sx={{ maxHeight: 360, overflow: "auto", py: 0 }}>
          {here.map((c, i) => row(c, i))}
          {other.length > 0 && <ListSubheader sx={{ lineHeight: "28px", fontSize: 12 }}>For other containers</ListSubheader>}
          {other.map((c, i) => row(c, here.length + i))}
        </List>
        {list && flat.length === 0 && (
          <Typography color="text.secondary" sx={{ px: 2, py: 2 }}>
            {list.length === 0
              ? "No commands yet. Add the ones you type often, give them a name, and run them from here in any container."
              : q
                ? "No command matches."
                : "None of your commands is meant for this container. Search to see the others."}
          </Typography>
        )}
        <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: "divider" }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            ↑↓ choose · Enter use · Alt+Enter type without running
          </Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setEditing(newCommand(flat.length === 0 ? query.trim() : ""))}>
            Add command
          </Button>
        </Stack>
      </Dialog>
      {editing && (
        <CommandEditor
          initial={editing}
          target={target}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const all = list ?? [];
            const ok = await save(c.id ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]);
            if (ok) setEditing(null);
          }}
          onDelete={
            editing.id
              ? async () => {
                  if (!(await confirm({ title: "Delete command?", message: `"${editing.label}" is removed from your commands.`, confirmLabel: "Delete", destructive: true }))) return;
                  if (await save((list ?? []).filter((x) => x.id !== editing.id))) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function CommandEditor({
  initial,
  target,
  onClose,
  onSave,
  onDelete,
}: {
  initial: PaletteCommand;
  target: ShellTarget;
  onClose: () => void;
  onSave: (c: PaletteCommand) => void;
  onDelete?: () => void;
}) {
  const [c, setC] = useState(initial);
  const scope = (patch: Partial<PaletteCommand["scope"]>) => setC({ ...c, scope: { ...c.scope, ...patch } });
  // This container's image without registry and tag, e.g. "postgres" or "bitnami/redis".
  const imageName = target.image.replace(/^docker\.io\/(library\/)?/, "").replace(/(@sha256)?:[^/]*$/, "");
  const valid = c.label.trim() !== "" && c.command.trim() !== "";

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{initial.id ? "Edit command" : "Add command"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField autoFocus={!initial.command} label="Label" value={c.label} onChange={(e) => setC({ ...c, label: e.target.value })} placeholder="e.g. Database console" />
          <TextField
            autoFocus={!!initial.command}
            label="Command"
            value={c.command}
            onChange={(e) => setC({ ...c, command: e.target.value })}
            multiline
            minRows={2}
            placeholder="e.g. psql -U postgres"
            InputProps={{ sx: { fontFamily: MONO, fontSize: 13 } }}
          />
          <FormControlLabel
            control={<Switch checked={c.run} onChange={(e) => setC({ ...c, run: e.target.checked })} />}
            label={c.run ? "Run it right away (type it and press Enter)" : "Only type it, so I can change it before pressing Enter"}
          />
          <TextField select label="Offer it for" value={c.scope.kind} onChange={(e) => scope({ kind: e.target.value as PaletteCommand["scope"]["kind"] })}>
            <MenuItem value="all">Every container</MenuItem>
            <MenuItem value="image">Containers of an image</MenuItem>
            <MenuItem value="compose">Containers of a Compose project</MenuItem>
          </TextField>
          {c.scope.kind === "image" && (
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                fullWidth
                label="Image"
                value={c.scope.image}
                onChange={(e) => scope({ image: e.target.value })}
                placeholder="e.g. postgres or postgres:16 or mycorp/*"
                helperText="* matches anything. Without a tag, every tag matches."
              />
              <Button sx={{ flexShrink: 0, mb: 2.5 }} onClick={() => scope({ image: imageName })}>
                This image
              </Button>
            </Stack>
          )}
          {c.scope.kind === "compose" && (
            <>
              <Stack direction="row" spacing={1}>
                <TextField fullWidth label="Project" value={c.scope.project} onChange={(e) => scope({ project: e.target.value })} placeholder="any project" />
                <TextField fullWidth label="Service" value={c.scope.service} onChange={(e) => scope({ service: e.target.value })} placeholder="any service" />
              </Stack>
              {target.project && (
                <Stack direction="row" spacing={1}>
                  <Button size="small" onClick={() => scope({ project: target.project ?? "", service: "" })}>
                    This project
                  </Button>
                  <Button size="small" onClick={() => scope({ project: target.project ?? "", service: target.service ?? "" })}>
                    This service
                  </Button>
                </Stack>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {onDelete && (
          <Button color="error" onClick={onDelete} sx={{ mr: "auto" }}>
            Delete
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave({ ...c, label: c.label.trim() })}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
