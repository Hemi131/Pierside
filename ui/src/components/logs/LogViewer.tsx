/**
 * Log viewer built on xterm.js (ANSI colours, wrapping, fast canvas rendering, search highlights).
 * Keeps its own capped line buffer so display options (timestamps, filters, per-service toggles)
 * can re-render without refetching.
 */
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Divider, FormControlLabel, IconButton, InputAdornment, MenuItem, Select, Stack, Switch, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import BlockIcon from "@mui/icons-material/Block";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import IntegrationInstructionsOutlinedIcon from "@mui/icons-material/IntegrationInstructionsOutlined";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "../../api/ddclient";
import { usePersistentState } from "../../hooks/usePersistentState";
import { useFeedback } from "../Feedback";
import { copyText } from "../../utils/format";
import { MONO } from "../../theme";
import { fg, stripAnsi } from "./ansi";
import { LogLine, MAX_LINES, useLogStream } from "./useLogStream";
import { xtermTheme } from "./xtermTheme";
import { attachClipboardKeys } from "./clipboardKeys";
import { markdownSnippet, selectedEntries } from "./snippet";

export interface LogViewerProps {
  path: string;
  params?: Record<string, string>;
  /** ANSI-formatted prefix per line (e.g. coloured service name). */
  prefix?: (l: LogLine) => string;
  /** Plain-text prefix for copy/download. */
  plainPrefix?: (l: LogLine) => string;
  /** External filter (e.g. per-service visibility); change `filterKey` to re-render. */
  lineFilter?: (l: LogLine) => boolean;
  filterKey?: string;
  toolbarExtra?: ReactNode;
  downloadName: string;
  /** Whether the containing tab is visible (fit + focus handling). */
  active?: boolean;
  stoppedLabel?: string;
}

type StreamSel = "all" | "stdout" | "stderr";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function fmtTs(l: LogLine): string {
  if (!l.k) return "".padEnd(23);
  const d = new Date(Math.floor(l.k / 1e6));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function LogViewer({ path, params, prefix, plainPrefix, lineFilter, filterKey, toolbarExtra, downloadName, active = true, stoppedLabel }: LogViewerProps) {
  const theme = useTheme();
  const { toast } = useFeedback();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const buf = useRef<LogLine[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);

  const [showTs, setShowTs] = usePersistentState("logs.timestamps", false);
  const [streamSel, setStreamSel] = useState<StreamSel>("all");
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [truncated, setTruncated] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);

  // Settings read from inside WS callbacks.
  const settings = useRef({ showTs, streamSel, query, filterMode, lineFilter, prefix, atBottom });
  settings.current = { showTs, streamSel, query, filterMode, lineFilter, prefix, atBottom };

  const passes = useCallback((l: LogLine) => {
    const s = settings.current;
    if (s.streamSel !== "all" && l.s !== s.streamSel) return false;
    if (s.lineFilter && !s.lineFilter(l)) return false;
    if (s.filterMode && s.query) {
      const q = s.query.toLowerCase();
      if (!stripAnsi(l.m).toLowerCase().includes(q) && !(l.svc ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  }, []);

  const tsColor = theme.palette.mode === "dark" ? "#7d8590" : "#8c959f";
  const errColor = theme.palette.error.main;
  const format = useCallback(
    (l: LogLine) => {
      const s = settings.current;
      const ts = s.showTs ? fg(l.s === "stderr" ? errColor : tsColor, fmtTs(l)) + " " : "";
      return ts + (s.prefix ? s.prefix(l) : "") + l.m;
    },
    [tsColor, errColor],
  );

  const searchOpts = useMemo(
    () => ({
      caseSensitive: false,
      decorations: {
        matchBackground: theme.palette.mode === "dark" ? "#6e5a00" : "#fff1a8",
        matchOverviewRuler: "#d4a72c",
        activeMatchBackground: theme.palette.mode === "dark" ? "#b36b00" : "#ffb340",
        activeMatchColorOverviewRuler: "#ff8c00",
      },
    }),
    [theme.palette.mode],
  );

  const checkBottom = useCallback(() => {
    const t = term.current;
    if (!t) return;
    const b = t.buffer.active;
    const bottom = b.viewportY >= b.baseY;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  }, []);

  /** Re-render the whole buffer (after a display option change). */
  const rerender = useCallback(() => {
    const t = term.current;
    if (!t) return;
    t.reset();
    const visible = buf.current.filter(passes);
    const CHUNK = 2000;
    for (let i = 0; i < visible.length; i += CHUNK) {
      t.write(visible.slice(i, i + CHUNK).map(format).join("\r\n") + "\r\n");
    }
    t.write("", () => {
      if (term.current !== t) return; // disposed meanwhile (unmount / StrictMode remount)
      t.scrollToBottom();
      setAtBottom(true);
      setUnseen(0);
      if (settings.current.query) search.current?.findPrevious(settings.current.query, searchOpts);
    });
  }, [passes, format, searchOpts]);

  // Create terminal once.
  useEffect(() => {
    const t = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: MAX_LINES,
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.25,
      allowProposedApi: true, // search decorations
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      theme: xtermTheme(theme),
    });
    const f = new FitAddon();
    const s = new SearchAddon({ highlightLimit: 2000 });
    t.loadAddon(f);
    t.loadAddon(s);
    t.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
    t.open(host.current!);
    attachClipboardKeys(t, {
      interactive: false,
      onCopy: (text) => {
        const n = text.replace(/\n+$/, "").split("\n").length;
        toast("success", `Copied ${n.toLocaleString()} line${n === 1 ? "" : "s"}`);
      },
    });
    // Hide the cursor entirely: this is a read-only view.
    t.write("\x1b[?25l");
    term.current = t;
    fit.current = f;
    search.current = s;
    const sub1 = s.onDidChangeResults((r) => setResults(r.resultCount ? { index: r.resultIndex, count: r.resultCount } : { index: -1, count: 0 }));
    const sub2 = t.onScroll(checkBottom);
    const sub3 = t.onWriteParsed(checkBottom);
    const sub4 = t.onSelectionChange(() => setHasSelection(t.hasSelection()));
    const el = host.current!;
    const onWheel = () => requestAnimationFrame(checkBottom);
    el.addEventListener("wheel", onWheel, { passive: true });
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) {
        try {
          f.fit();
        } catch {
          /* not visible */
        }
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      sub1.dispose();
      sub2.dispose();
      sub3.dispose();
      sub4.dispose();
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme changes.
  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme);
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.palette.mode]);

  // Display option changes -> re-render.
  useEffect(() => {
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTs, streamSel, filterMode, filterKey, filterMode ? query : ""]);

  // Search highlighting.
  useEffect(() => {
    const s = search.current;
    if (!s) return;
    const id = window.setTimeout(() => {
      if (query) s.findPrevious(query, searchOpts);
      else {
        s.clearDecorations();
        setResults(null);
      }
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, searchOpts]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [active]);

  // Incoming lines. Search highlights follow by themselves: the search addon looks again after each
  // write without scrolling or moving the current match (calling findNext here jumped to the next one).
  const onLines = useCallback(
    (lines: LogLine[]) => {
      const b = buf.current;
      b.push(...lines);
      if (b.length > MAX_LINES) {
        const over = b.length - MAX_LINES;
        b.splice(0, over);
        setTruncated((n) => n + over);
      }
      setLineCount(b.length);
      const visible = lines.filter(passes);
      if (visible.length && term.current) {
        term.current.write(visible.map(format).join("\r\n") + "\r\n");
        if (!settings.current.atBottom) setUnseen((n) => n + visible.length);
      }
    },
    [passes, format],
  );

  const onReset = useCallback(() => {
    buf.current = [];
    setLineCount(0);
    setTruncated(0);
    term.current?.reset();
  }, []);

  const { state, error, dropped } = useLogStream(path, params ?? {}, { onLines, onReset });

  // Ctrl/Cmd+F focuses log search while this viewer is visible.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const plain = (l: LogLine) => `${settings.current.showTs ? fmtTs(l) + " " : ""}${plainPrefix ? plainPrefix(l) : ""}${stripAnsi(l.m)}`;

  const copyAll = async () => {
    const sel = term.current?.getSelection();
    if (sel) {
      await copyText(sel);
      toast("success", "Selection copied");
      return;
    }
    const lines = buf.current.filter(passes);
    await copyText(lines.map(plain).join("\n"));
    toast("success", `${lines.length.toLocaleString()} lines copied`);
  };

  /** Selected lines as a Markdown snippet: source, time range, and each line with its timestamp. */
  const copyMarkdown = async () => {
    const t = term.current;
    if (!t) return;
    const entries = selectedEntries(t, buf.current.filter(passes));
    if (!entries?.length) {
      toast("info", "Select some log lines first");
      return;
    }
    const lines = entries.map((l) => `${fmtTs(l)} ${plainPrefix ? plainPrefix(l) : ""}${stripAnsi(l.m)}`);
    const withTs = entries.filter((l) => l.k);
    const md = markdownSnippet(downloadName, lines, withTs.length ? fmtTs(withTs[0]) : undefined, withTs.length ? fmtTs(withTs[withTs.length - 1]) : undefined);
    await copyText(md);
    toast("success", `${entries.length.toLocaleString()} line${entries.length === 1 ? "" : "s"} copied as Markdown`);
  };

  const download = () => {
    const lines = buf.current.filter(passes);
    const blob = new Blob([lines.map(plain).join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `${downloadName}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const clear = () => {
    buf.current = [];
    setLineCount(0);
    setTruncated(0);
    term.current?.reset();
    term.current?.write("\x1b[?25l");
    setUnseen(0);
  };

  const jumpToBottom = () => {
    term.current?.scrollToBottom();
    setAtBottom(true);
    setUnseen(0);
  };

  const nav = (dir: 1 | -1) => {
    if (!query) return;
    if (dir === 1) search.current?.findNext(query, searchOpts);
    else search.current?.findPrevious(query, searchOpts);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: "wrap", rowGap: 1 }}>
        <TextField
          inputRef={searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              nav(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search logs"
          sx={{ width: 300 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: query ? (
              <InputAdornment position="end">
                <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5, whiteSpace: "nowrap" }}>
                  {results ? (results.count ? `${results.index >= 0 ? results.index + 1 : "?"}/${results.count}` : "0/0") : ""}
                </Typography>
                <IconButton size="small" onClick={() => nav(-1)} aria-label="Previous match">
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
                <IconButton size="small" onClick={() => nav(1)} aria-label="Next match" edge="end">
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined,
          }}
        />
        <Tooltip title={filterMode ? "Showing only matching lines" : "Only show matching lines"}>
          <IconButton onClick={() => setFilterMode((f) => !f)} color={filterMode ? "primary" : "default"} aria-pressed={filterMode}>
            {filterMode ? <FilterAltIcon fontSize="small" /> : <FilterAltOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Select size="small" value={streamSel} onChange={(e) => setStreamSel(e.target.value as StreamSel)} sx={{ minWidth: 120 }}>
          <MenuItem value="all">All streams</MenuItem>
          <MenuItem value="stdout">stdout</MenuItem>
          <MenuItem value="stderr">stderr</MenuItem>
        </Select>
        {toolbarExtra}
        <Box sx={{ flex: 1 }} />
        <FormControlLabel
          control={<Switch size="small" checked={showTs} onChange={(e) => setShowTs(e.target.checked)} />}
          label={<Typography variant="body1">Timestamps</Typography>}
          sx={{ mr: 0.5 }}
        />
        <Divider orientation="vertical" flexItem />
        <Tooltip title="Clear view">
          <IconButton onClick={clear} aria-label="Clear view">
            <BlockIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Copy (selection or all visible lines)">
          <IconButton onClick={() => void copyAll()} aria-label="Copy logs">
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={hasSelection ? "Copy selected lines as Markdown (for an issue or chat)" : "Copy as Markdown: select some lines first"}>
          <span>
            <IconButton onClick={() => void copyMarkdown()} disabled={!hasSelection} aria-label="Copy selection as Markdown">
              <IntegrationInstructionsOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Download visible lines">
          <IconButton onClick={download} aria-label="Download logs">
            <FileDownloadOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {(state === "stopped" || state === "removed" || state === "error" || truncated > 0 || dropped > 0) && (
        <Stack spacing={0.5} sx={{ mb: 1 }}>
          {state === "stopped" && (
            <Alert severity="info" sx={{ py: 0 }}>
              {stoppedLabel ?? "Container is not running. New logs will appear here when it starts."}
            </Alert>
          )}
          {state === "removed" && (
            <Alert severity="warning" sx={{ py: 0 }}>
              The container was removed.
            </Alert>
          )}
          {state === "error" && (
            <Alert severity="error" sx={{ py: 0 }}>
              {error ?? "Log stream failed"}
            </Alert>
          )}
          {truncated > 0 && (
            <Alert severity="info" sx={{ py: 0 }}>
              Showing the latest {MAX_LINES.toLocaleString()} lines; {truncated.toLocaleString()} older lines were discarded.
            </Alert>
          )}
          {dropped > 0 && (
            <Alert severity="warning" sx={{ py: 0 }}>
              Output is arriving faster than it can be displayed: {dropped.toLocaleString()} lines were skipped.
            </Alert>
          )}
        </Stack>
      )}

      <Box
        sx={{
          position: "relative",
          flex: 1,
          minHeight: 200,
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "background.paper",
          overflow: "hidden",
          "& .xterm": { height: "100%", p: 1 },
          "& .xterm-viewport": { bgcolor: "transparent !important" },
        }}
      >
        <Box ref={host} sx={{ position: "absolute", inset: 0 }} />
        {lineCount === 0 && state !== "connecting" && (
          <Typography color="text.secondary" sx={{ position: "absolute", top: 16, left: 16, pointerEvents: "none" }}>
            No logs yet.
          </Typography>
        )}
        {!atBottom && (
          <Button
            variant="contained"
            size="small"
            startIcon={<ArrowDownwardIcon />}
            onClick={jumpToBottom}
            sx={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", borderRadius: 4, boxShadow: 3 }}
          >
            {unseen > 0 ? `${unseen.toLocaleString()} new line${unseen === 1 ? "" : "s"}` : "Jump to bottom"}
          </Button>
        )}
      </Box>
    </Box>
  );
}
