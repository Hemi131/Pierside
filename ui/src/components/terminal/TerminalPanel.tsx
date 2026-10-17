/**
 * Bottom terminal panel (toggled from the footer).
 *   - SSH engine: an interactive shell on the server (WS /ws/host-shell), any command.
 *   - Local engine: a Docker console. An extension may only run the docker CLI on the host, so
 *     commands are `docker …`, run through Rancher's own CLI like in a terminal. Output streams, but
 *     there's no keyboard input: interactive commands (-it, login prompts) belong in the Exec tab.
 */
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import BlockIcon from "@mui/icons-material/Block";
import StopIcon from "@mui/icons-material/Stop";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { dd } from "../../api/ddclient";
import { wsUrl } from "../../api/ws";
import { splitArgs } from "../../api/compose";
import { useEngine } from "../../hooks/useEngine";
import { usePersistentState } from "../../hooks/usePersistentState";
import { MONO } from "../../theme";
import { xtermTheme } from "../logs/xtermTheme";
import { attachClipboardKeys } from "../logs/clipboardKeys";

/** An xterm filling its box, refitted on resize. */
function useXterm(interactive: boolean) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: MONO,
      fontSize: 12.5,
      convertEol: !interactive,
      cursorBlink: interactive,
      disableStdin: !interactive,
      scrollback: 5000,
      theme: xtermTheme(theme, theme.palette.mode === "dark" ? "#15191e" : "#ffffff"),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    attachClipboardKeys(t, { interactive });
    if (!interactive) t.write("\x1b[?25l"); // no cursor in the output area
    fit.current = f;
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current);
    setTerm(t);
    return () => {
      ro.disconnect();
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { host, term };
}

const box = { flex: 1, minHeight: 0, position: "relative", "& .xterm": { height: "100%", p: 1 }, "& .xterm-viewport": { bgcolor: "transparent !important" } } as const;

// ---- local engine: Docker console -----------------------------------------------------------

const INTERACTIVE_FLAG = /^-(-interactive|-tty|[a-zA-Z]*[it][a-zA-Z]*)$/;

/** Why a command can't run here (it needs keyboard input), or null. */
function needsInput(args: string[]): string | null {
  const [cmd, sub] = args;
  if (["run", "exec", "start", "attach", "create"].includes(cmd) || (cmd === "container" && ["run", "exec", "start", "attach"].includes(sub))) {
    const flags = args.filter((a) => a.startsWith("-") && !a.includes("="));
    if (cmd === "attach" || flags.some((f) => INTERACTIVE_FLAG.test(f) && !/^--(?!interactive|tty)/.test(f))) {
      return "This command needs keyboard input, which the console can't provide. Leave out -i/-t, or use the container's Exec tab for a shell.";
    }
  }
  if (cmd === "login" && !args.includes("--password-stdin") && !args.some((a) => a === "-p" || a.startsWith("--password"))) {
    return "docker login asks for a password interactively, which the console can't do. Run it in a terminal.";
  }
  return null;
}

/** Local engine outside Rancher (the separate window): no way to run host commands. */
function ConsoleUnavailable() {
  return (
    <Typography color="text.secondary" sx={{ p: 2 }}>
      The Docker console runs docker commands through Rancher, so it works inside Rancher Desktop only (not in the separate window). On an SSH engine, the terminal is a shell on the server and works everywhere.
    </Typography>
  );
}

function DockerConsole() {
  const { host, term } = useXterm(false);
  const [line, setLine] = useState("");
  const [history, setHistory] = usePersistentState<string[]>("terminal.history", []);
  const [pos, setPos] = useState<number | null>(null); // position while browsing history
  const [running, setRunning] = useState(false);
  const proc = useRef<{ close: () => void } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    term?.write("\x1b[2mDocker console: runs docker commands on the local engine through Rancher, like a terminal would.\r\n" + "Type a command without the leading `docker`, e.g. `ps -a` or `compose ls`.\x1b[0m\r\n");
  }, [term]);

  // Closing the panel stops what still runs (`logs -f`, `stats`), as closing a terminal would.
  useEffect(
    () => () => {
      proc.current?.close();
      proc.current = null;
    },
    [],
  );

  const run = () => {
    const text = line.trim().replace(/^docker\s+/, "");
    if (!text || running || !term) return;
    setHistory((h) => [...h.filter((x) => x !== text), text].slice(-50));
    setPos(null);
    setLine("");
    term.write(`\r\n\x1b[36m$ docker ${text}\x1b[0m\r\n`);
    const args = splitArgs(text);
    const why = needsInput(args);
    if (why) {
      term.write(`\x1b[33m${why}\x1b[0m\r\n`);
      return;
    }
    setRunning(true);
    const [cmd, ...rest] = args;
    proc.current = dd!.docker.cli.exec(cmd, rest, {
      stream: {
        // Whole lines (Rancher splits and strips the line breaks), written back with a break each.
        splitOutputLines: true,
        onOutput: (d: { stdout?: string; stderr?: string }) => {
          if (d.stdout !== undefined) term.write(d.stdout + "\n");
          if (d.stderr !== undefined) term.write(d.stderr + "\n");
        },
        onError: (e: unknown) => {
          term.write(`\x1b[31m${String((e as Error)?.message ?? e)}\x1b[0m\r\n`);
          setRunning(false);
        },
        onClose: (code: number) => {
          if (code) term.write(`\x1b[2m(exit code ${code})\x1b[0m\r\n`);
          setRunning(false);
          proc.current = null;
          requestAnimationFrame(() => input.current?.focus());
        },
      },
    } as never) as unknown as { close: () => void };
  };

  const stop = () => {
    proc.current?.close();
    term?.write("\x1b[2m(stopped)\x1b[0m\r\n");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") run();
    else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const p = pos === null ? history.length - 1 : Math.max(0, pos - 1);
      setPos(p);
      setLine(history[p]);
    } else if (e.key === "ArrowDown" && pos !== null) {
      e.preventDefault();
      const p = pos + 1;
      if (p >= history.length) {
        setPos(null);
        setLine("");
      } else {
        setPos(p);
        setLine(history[p]);
      }
    } else if (e.key === "c" && e.ctrlKey && running && !window.getSelection()?.toString()) {
      e.preventDefault();
      stop();
    }
  };

  return (
    <>
      <Box sx={box}>
        <Box ref={host} sx={{ position: "absolute", inset: 0 }} />
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, py: 0.75, borderTop: 1, borderColor: "divider" }}>
        <TextField
          inputRef={input}
          fullWidth
          size="small"
          autoFocus
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKey}
          placeholder={running ? "Running… (Ctrl+C stops it)" : "ps -a"}
          disabled={running}
          InputProps={{
            sx: { fontFamily: MONO, fontSize: 12.5 },
            startAdornment: (
              <InputAdornment position="start">
                <Typography sx={{ fontFamily: MONO, fontSize: 12.5, color: "text.secondary" }}>$ docker</Typography>
              </InputAdornment>
            ),
          }}
          inputProps={{ "aria-label": "Docker command", spellCheck: false }}
        />
        {running ? (
          <Button size="small" color="error" variant="outlined" startIcon={<StopIcon />} onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button size="small" variant="contained" onClick={run} disabled={!line.trim()}>
            Run
          </Button>
        )}
        <Tooltip title="Clear output">
          <IconButton onClick={() => term?.clear()} aria-label="Clear output">
            <BlockIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </>
  );
}

// ---- SSH engine: shell on the server ---------------------------------------------------------

function ServerShell() {
  const { host, term } = useXterm(true);
  const [state, setState] = useState<"connecting" | "open" | "ended" | "error">("connecting");
  const [session, setSession] = useState(0);

  useEffect(() => {
    if (!term) return;
    let sock: WebSocket | null = null;
    let disposed = false;
    term.reset();
    setState("connecting");
    const subs: { dispose: () => void }[] = [];
    (async () => {
      const url = await wsUrl("/ws/host-shell", { cols: String(term.cols), rows: String(term.rows) });
      if (disposed) return;
      sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string") return term.write(new Uint8Array(ev.data));
        const m = JSON.parse(ev.data) as { type: string; message?: string; code?: number };
        if (m.type === "ready") {
          setState("open");
          term.focus();
        } else if (m.type === "exit") {
          setState("ended");
          term.write(`\r\n\x1b[2m(shell ended${m.code ? `, exit code ${m.code}` : ""})\x1b[0m\r\n`);
        } else if (m.type === "error") {
          setState("error");
          term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
        }
      };
      sock.onclose = () => setState((s) => (s === "open" || s === "connecting" ? "ended" : s));
      const send = (msg: object) => sock?.readyState === WebSocket.OPEN && sock.send(JSON.stringify(msg));
      subs.push(term.onData((data) => send({ type: "input", data })));
      subs.push(term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows })));
    })().catch((e) => {
      setState("error");
      term.write(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
    });
    return () => {
      disposed = true;
      subs.forEach((s) => s.dispose());
      sock?.close();
    };
  }, [term, session]);

  return (
    <>
      <Box sx={box}>
        <Box ref={host} sx={{ position: "absolute", inset: 0 }} />
      </Box>
      {(state === "ended" || state === "error") && (
        <Stack direction="row" justifyContent="center" sx={{ py: 0.75, borderTop: 1, borderColor: "divider" }}>
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => setSession((n) => n + 1)}>
            New session
          </Button>
        </Stack>
      )}
    </>
  );
}

// ---- panel -------------------------------------------------------------------------------------

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const { engine } = useEngine();
  const meta = engine?.engine;
  const remote = meta?.type === "ssh";
  const [height, setHeight] = usePersistentState("terminal.height", 280);
  const drag = useRef<{ y: number; h: number } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!drag.current) return;
      setHeight(Math.max(140, Math.min(window.innerHeight - 200, drag.current.h + drag.current.y - e.clientY)));
    },
    [setHeight],
  );
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", up);
    };
  }, [onMove]);

  return (
    <Box sx={{ height, flexShrink: 0, display: "flex", flexDirection: "column", borderTop: 1, borderColor: "divider", bgcolor: "background.paper", position: "relative" }}>
      <Box
        onMouseDown={(e) => (drag.current = { y: e.clientY, h: height })}
        sx={{ position: "absolute", top: -3, left: 0, right: 0, height: 6, cursor: "ns-resize", zIndex: 2 }}
        aria-label="Resize terminal"
      />
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {remote ? "Shell" : "Docker console"}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {remote ? meta?.target : "Local engine (Rancher Desktop)"}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Close terminal">
          <IconButton onClick={onClose} aria-label="Close terminal">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {/* A different engine is a different session. */}
      {remote ? <ServerShell key={meta?.id} /> : dd ? <DockerConsole key={meta?.id ?? "local"} /> : <ConsoleUnavailable />}
    </Box>
  );
}
