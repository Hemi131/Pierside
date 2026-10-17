/**
 * Interactive shell (Exec tab): xterm.js <-> /ws/exec/{id}. The session lives as long as this
 * component is mounted (KeepAliveTabs keeps it across tab switches); unmount closes the socket and
 * the backend cleans up the exec process.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, MenuItem, Select, Stack, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import BugReportOutlinedIcon from "@mui/icons-material/BugReportOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import TerminalIcon from "@mui/icons-material/Terminal";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "../../api/ddclient";
import { wsUrl } from "../../api/ws";
import { usePersistentState } from "../../hooks/usePersistentState";
import { MONO } from "../../theme";
import { xtermTheme } from "../logs/xtermTheme";
import { clipboardKeyHandler } from "../logs/clipboardKeys";
import { terminalKeyHandler } from "./terminalKeys";
import { PromptTracker } from "./promptTracker";
import { useFeedback } from "../Feedback";
import { CommandPalette } from "./CommandPalette";
import type { ShellTarget } from "../../api/commands";

type SessionState = "idle" | "connecting" | "open" | "exited" | "error";

interface Opts {
  shell: string;
  user: string;
  workdir: string;
}

export function ShellView({
  containerId,
  target,
  running,
  paused,
  active,
  onStart,
}: {
  containerId: string;
  /** For the command palette: which of the user's commands are meant for this container. */
  target: ShellTarget;
  running: boolean;
  /** Paused: the session stays; it carries on when the container is resumed. */
  paused?: boolean;
  active: boolean;
  onStart?: () => void;
}) {
  const theme = useTheme();
  const { toast } = useFeedback();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = usePersistentState<Opts>("shell.opts", { shell: "auto", user: "", workdir: "" });
  const [draft, setDraft] = useState<Opts>(saved);
  const [session, setSession] = useState(0); // bump to start a new session
  // Debug shell (a helper with its own tools, for containers without a shell): per session, never
  // saved, since the saved shell choice applies to every container.
  const [debug, setDebug] = useState(false);
  const [draftDebug, setDraftDebug] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Types a palette command into the shell (set up with the terminal below).
  const typeCommand = useRef<(command: string, run: boolean) => void>(() => undefined);

  // Terminal instance (once).
  useEffect(() => {
    const t = new Terminal({
      fontFamily: MONO,
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: xtermTheme(theme, theme.palette.mode === "dark" ? "#15191e" : "#ffffff"),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
    t.open(host.current!);
    // One xterm key handler: editor-like keys first, then clipboard shortcuts.
    const sendInput = (data: string) => {
      const sock = ws.current;
      if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "input", data }));
    };
    const prompt = new PromptTracker(t);
    if (import.meta.env.DEV) (window as unknown as { __dsPrompt?: PromptTracker }).__dsPrompt = prompt;
    const editKeys = terminalKeyHandler(t, sendInput, prompt);
    const clipKeys = clipboardKeyHandler(t, {
      interactive: true,
      onPasteError: (m) => toast("error", m),
      beforePaste: () => {
        const keys = t.hasSelection() ? prompt.deleteSelectionKeys() : null;
        if (keys) {
          sendInput(keys);
          t.clearSelection();
        }
        prompt.resetExpected(); // the pasted text moves the cursor
      },
    });
    t.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyP") {
        if (e.type === "keydown") setPaletteOpen(true);
        return false;
      }
      return editKeys(e) && clipKeys(e);
    });
    // Like a paste: xterm turns line breaks into Enter and wraps the text in bracketed-paste
    // markers when the shell asked for them, so a multi-line command isn't run line by line.
    typeCommand.current = (command, run) => {
      const sock = ws.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) {
        toast("error", "The shell isn't connected.");
        return;
      }
      prompt.resetExpected();
      t.paste(command);
      if (run) sendInput("\r");
    };
    term.current = t;
    fit.current = f;
    // Dev-only hook for browser tests (stripped from production builds).
    if (import.meta.env.DEV) (window as unknown as { __dsShell?: Terminal }).__dsShell = t;

    const onData = t.onData((data) => {
      const s = ws.current;
      if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: "input", data }));
      else if (stateRef.current === "exited" && data === "\r") setSession((n) => n + 1);
    });
    const onResize = t.onResize(({ cols, rows }) => {
      const s = ws.current;
      if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const el = host.current!;
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) {
        try {
          f.fit();
        } catch {
          /* hidden */
        }
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme, theme.palette.mode === "dark" ? "#15191e" : "#ffffff");
  }, [theme]);

  // A session starts only once the container runs (Docker refuses exec into a paused one), and stays
  // through a pause: `armed` turns on when it runs, off when it stops, and a pause doesn't change it.
  const [armed, setArmed] = useState(running && !paused);
  useEffect(() => {
    if (!running) setArmed(false);
    else if (!paused) setArmed(true);
  }, [running, paused]);

  // Session lifecycle.
  useEffect(() => {
    if (!armed) {
      setState("idle");
      return;
    }
    const t = term.current;
    if (!t) return;
    let disposed = false;
    let sock: WebSocket | null = null;
    setState("connecting");
    setError(null);
    try {
      fit.current?.fit();
    } catch {
      /* hidden */
    }
    t.reset();

    (async () => {
      let url: string;
      try {
        url = await wsUrl(`/ws/exec/${containerId}`, {
          shell: debug ? "debug" : saved.shell,
          user: saved.user,
          workdir: saved.workdir,
          cols: String(t.cols),
          rows: String(t.rows),
        });
      } catch (e) {
        setError((e as Error).message);
        setState("error");
        return;
      }
      if (disposed) return;
      sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      ws.current = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          t.write(new Uint8Array(ev.data as ArrayBuffer));
          return;
        }
        const m = JSON.parse(ev.data);
        if (m.type === "ready") {
          setState("open");
          // Re-send the size once the process exists; the initial resize can race the start.
          sock?.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
          if (active) t.focus();
        } else if (m.type === "exit") {
          setState("exited");
          t.write(`\r\n\x1b[2m[Process exited${m.code != null ? ` with code ${m.code}` : ""}. Press Enter to start a new session.]\x1b[0m\r\n`);
        } else if (m.type === "error") {
          setError(m.message);
          setState("error");
        }
      };
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null;
        if (!disposed && stateRef.current !== "exited" && stateRef.current !== "error") {
          setState("exited");
          t.write("\r\n\x1b[2m[Connection closed. Press Enter to reconnect.]\x1b[0m\r\n");
        }
      };
    })();

    return () => {
      disposed = true;
      sock?.close();
      if (ws.current === sock) ws.current = null;
    };
  }, [containerId, armed, session, saved, debug]);

  // Fit + focus when the tab becomes visible.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* hidden */
      }
      term.current?.focus();
    });
  }, [active]);

  const apply = useCallback(() => {
    setSaved(draft);
    setDebug(draftDebug);
    setSession((n) => n + 1);
  }, [draft, draftDebug, setSaved]);

  const startDebug = () => {
    setDraftDebug(true);
    setDebug(true);
    setSession((n) => n + 1);
  };
  // The container has no shell (distroless / scratch images): offer the debug shell.
  const noShell = !debug && !!error && /executable file not found|no such file or directory|not found in \$PATH/i.test(error);

  const dirty = draftDebug !== debug || (!draftDebug && (draft.shell !== saved.shell || draft.user !== saved.user || draft.workdir !== saved.workdir));
  const chip = { idle: ["Not running", "default"], connecting: ["Connecting…", "default"], open: ["Connected", "success"], exited: ["Ended", "default"], error: ["Error", "error"] }[state] as [
    string,
    "default" | "success" | "error",
  ];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1, flexWrap: "wrap", rowGap: 1 }}>
        <Select
          size="small"
          value={draftDebug ? "debug" : draft.shell}
          onChange={(e) => {
            const v = e.target.value;
            setDraftDebug(v === "debug");
            if (v !== "debug") setDraft({ ...draft, shell: v });
          }}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="auto">Auto (bash → sh)</MenuItem>
          <MenuItem value="sh">/bin/sh</MenuItem>
          <MenuItem value="bash">/bin/bash</MenuItem>
          <MenuItem value="debug">Debug shell (no shell needed)</MenuItem>
        </Select>
        <TextField
          placeholder="User (default)"
          disabled={draftDebug}
          value={draft.user}
          onChange={(e) => setDraft({ ...draft, user: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          sx={{ width: 150 }}
        />
        <TextField
          placeholder="Working directory"
          disabled={draftDebug}
          value={draft.workdir}
          onChange={(e) => setDraft({ ...draft, workdir: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          sx={{ width: 220 }}
        />
        <Tooltip title={dirty ? "Start a new session with these settings" : "Start a new session"}>
          <span>
            <Button variant={dirty ? "contained" : "outlined"} startIcon={<RefreshIcon />} onClick={apply} disabled={!armed}>
              {dirty ? "Apply" : "New session"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Your commands (Ctrl+Shift+P)">
          <span>
            <Button variant="outlined" startIcon={<TerminalIcon />} onClick={() => setPaletteOpen(true)} disabled={state !== "open"}>
              Commands
            </Button>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" label={chip[0]} color={chip[1]} variant={chip[1] === "default" ? "outlined" : "filled"} />
      </Stack>
      {error && noShell && (
        <Alert severity="info" icon={<BugReportOutlinedIcon />} sx={{ mb: 1, alignItems: "flex-start" }}>
          <Typography sx={{ fontWeight: 600 }}>This container has no shell</Typography>
          <Typography variant="body2" sx={{ mt: 0.25 }}>
            Its image doesn't include /bin/sh (common for distroless and minimal images). A debug shell brings its own tools and runs next to the container, with its
            processes, network and files.
          </Typography>
          <Button variant="contained" size="small" startIcon={<BugReportOutlinedIcon />} onClick={startDebug} sx={{ mt: 1.25 }}>
            Start debug shell
          </Button>
        </Alert>
      )}
      {paused && armed && (
        <Alert severity="info" sx={{ mb: 1, py: 0 }}>
          The container is paused. This shell carries on when you resume it.
        </Alert>
      )}
      {error && !noShell && (
        <Alert severity="error" sx={{ mb: 1, py: 0 }}>
          {error}
        </Alert>
      )}
      <Box
        sx={{
          position: "relative",
          flex: 1,
          minHeight: 240,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          bgcolor: theme.palette.mode === "dark" ? "#15191e" : "#ffffff",
          overflow: "hidden",
          "& .xterm": { height: "100%", p: 1 },
          "& .xterm-viewport": { bgcolor: "transparent !important" },
        }}
      >
        <Box ref={host} sx={{ position: "absolute", inset: 0, visibility: armed ? "visible" : "hidden" }} />
        {!armed && running && (
          <Stack alignItems="center" justifyContent="center" sx={{ position: "absolute", inset: 0 }}>
            <Typography color="text.secondary">The container is paused. The shell starts when you resume it.</Typography>
          </Stack>
        )}
        {!running && (
          <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ position: "absolute", inset: 0 }}>
            <Typography color="text.secondary">The container isn't running, so there's no shell to attach to.</Typography>
            {onStart && (
              <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={onStart}>
                Start container
              </Button>
            )}
          </Stack>
        )}
      </Box>
      <CommandPalette
        open={paletteOpen}
        target={target}
        onClose={() => setPaletteOpen(false)}
        onClosed={() => term.current?.focus()}
        onUse={(command, run) => typeCommand.current(command, run)}
      />
    </Box>
  );
}
