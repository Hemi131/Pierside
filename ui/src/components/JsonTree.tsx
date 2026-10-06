import { memo, useState } from "react";
import { Box, Button, Stack, ToggleButton, ToggleButtonGroup, Paper } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import UnfoldLessIcon from "@mui/icons-material/UnfoldLess";
import { MONO } from "../theme";
import { copyText } from "../utils/format";
import { useFeedback } from "./Feedback";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const Node = memo(function Node({ name, value, depth, openDepth, last }: { name?: string; value: Json; depth: number; openDepth: number; last: boolean }) {
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < openDepth);
  const comma = last ? "" : ",";
  const key =
    name !== undefined ? (
      <Box component="span" sx={{ color: "primary.main" }}>
        "{name}"<Box component="span" sx={{ color: "text.secondary" }}>: </Box>
      </Box>
    ) : null;

  if (!isObj) {
    const color = typeof value === "string" ? "success.main" : typeof value === "number" ? "warning.main" : "secondary.main";
    return (
      <Box sx={{ pl: 2.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {key}
        <Box component="span" sx={{ color }}>
          {JSON.stringify(value)}
        </Box>
        {comma}
      </Box>
    );
  }

  const entries: [string | undefined, Json][] = Array.isArray(value) ? value.map((v) => [undefined, v]) : Object.entries(value);
  const [ob, cb] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <Box sx={{ pl: 2.5 }}>
        {key}
        {ob}
        {cb}
        {comma}
      </Box>
    );
  }
  return (
    <Box>
      <Box
        onClick={() => setOpen((o) => !o)}
        sx={{ cursor: "pointer", display: "flex", "&:hover": { bgcolor: "action.hover" }, borderRadius: 0.5 }}
      >
        <Box component="span" sx={{ width: 20, flexShrink: 0, color: "text.secondary", textAlign: "center", userSelect: "none" }}>
          {open ? "▾" : "▸"}
        </Box>
        <span>
          {key}
          {ob}
          {!open && (
            <Box component="span" sx={{ color: "text.secondary" }}>
              {" "}
              {Array.isArray(value) ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} key${entries.length === 1 ? "" : "s"}`} {cb}
              {comma}
            </Box>
          )}
        </span>
      </Box>
      {open && (
        <>
          <Box sx={{ pl: 2, borderLeft: 1, borderColor: "divider", ml: "9px" }}>
            {entries.map(([k, v], i) => (
              <Node key={k ?? i} name={k} value={v} depth={depth + 1} openDepth={openDepth} last={i === entries.length - 1} />
            ))}
          </Box>
          <Box sx={{ pl: 2.5 }}>
            {cb}
            {comma}
          </Box>
        </>
      )}
    </Box>
  );
});

export function JsonTree({ data, defaultDepth = 2 }: { data: unknown; defaultDepth?: number }) {
  const { toast } = useFeedback();
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  // Changing `gen` remounts the tree with a new default depth (expand/collapse all).
  const [depth, setDepth] = useState({ d: defaultDepth, gen: 0 });
  const text = JSON.stringify(data, null, 2);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)}>
          <ToggleButton value="tree" sx={{ px: 1.5, py: 0.25, textTransform: "none" }}>
            Tree
          </ToggleButton>
          <ToggleButton value="raw" sx={{ px: 1.5, py: 0.25, textTransform: "none" }}>
            Raw
          </ToggleButton>
        </ToggleButtonGroup>
        {mode === "tree" && (
          <>
            <Button startIcon={<UnfoldMoreIcon />} onClick={() => setDepth((s) => ({ d: 99, gen: s.gen + 1 }))}>
              Expand all
            </Button>
            <Button startIcon={<UnfoldLessIcon />} onClick={() => setDepth((s) => ({ d: 1, gen: s.gen + 1 }))}>
              Collapse all
            </Button>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          startIcon={<ContentCopyIcon />}
          onClick={() => void copyText(text).then(() => toast("success", "JSON copied to clipboard"))}
        >
          Copy
        </Button>
      </Stack>
      <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5, fontFamily: MONO, fontSize: 12, lineHeight: 1.6 }}>
        {mode === "raw" ? (
          <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {text}
          </Box>
        ) : (
          <Node key={depth.gen} value={data as Json} depth={0} openDepth={depth.d} last />
        )}
      </Paper>
    </Box>
  );
}
