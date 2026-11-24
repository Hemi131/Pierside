/**
 * Asks the user to allow an AI assistant's request (see AccessView.tsx). Mounted once in the layout
 * so the question appears wherever the user is in Pierside; the backend holds the assistant's call
 * meanwhile (backend/app/services/mcp_access.py, Approvals).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { api, ApiError } from "../../api/ddclient";
import { useFeedback } from "../../components/Feedback";
import { useEngine } from "../../hooks/useEngine";
import { MONO } from "../../theme";
import type { AccessRequest, Trust } from "./AccessView";

// The backend announces new questions over the live channel; this slow check only covers a window
// whose live channel is down.
const POLL_MS = 20000;
/** How long a new question's allowing buttons stay disabled. */
const ARM_MS = 700;

/** What the user decided, for the toast after answering (so a wrong click is noticed at once). */
const DECIDED: Record<string, string> = {
  deny: "Denied",
  deny_pause: "Denied; further requests paused for 2 minutes",
  session: "Allowed for this session",
  permanent: "Added to the connection",
  once: "Assistant allowed for this session",
  day: "Assistant trusted for 24 hours",
  week: "Assistant trusted for 7 days",
  month: "Assistant trusted for 30 days",
  always: "Assistant trusted always",
};

/** One question. A session's questions share an id (there is one at a time), so the id alone would
 * also hide the next question from a session whose earlier one was answered here. */
const questionKey = (r: AccessRequest) => `${r.id}@${r.createdAt}`;

/** "delete_container" -> "delete container". */
const toolText = (tool: string) => tool.replace(/_/g, " ");

export function AccessPrompt() {
  const { toast } = useFeedback();
  const { onEvent } = useEngine();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [longer, setLonger] = useState<HTMLElement | null>(null);
  const answered = useRef(new Set<string>());

  const stopped = useRef(false);
  const load = useCallback(
    () =>
      api
        .get<AccessRequest[]>("/mcp-access/requests")
        .then((r) => !stopped.current && setRequests(r.filter((x) => !answered.current.has(questionKey(x)))))
        .catch(() => undefined), // backend not reachable right now: nothing to ask
    [],
  );

  useEffect(() => {
    stopped.current = false;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const off = onEvent((e) => {
      if (e.type === "mcp") void load();
    });
    return () => {
      stopped.current = true;
      window.clearInterval(timer);
      off();
    };
  }, [onEvent, load]);

  const req = requests[0];

  // A new question can open right where the last one was answered: its allowing buttons wait a moment,
  // so a click (or double click) meant for the previous question can't answer this one. Deny is never held.
  const key = req ? questionKey(req) : "";
  const [armed, setArmed] = useState("");
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => setArmed(key), ARM_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
  const held = armed !== key;

  if (!req) return null;

  const answer = async (decision: "deny" | "deny_pause" | "allow" | "once" | "session" | "permanent" | Exclude<Trust, "none">) => {
    setLonger(null);
    setBusy(true);
    let stale = false;
    try {
      // createdAt names the question shown here: if the assistant replaced it meanwhile, the backend
      // decides nothing (409) and the new question is shown instead.
      await api.post(`/mcp-access/requests/${encodeURIComponent(req.id)}`, { decision, createdAt: req.createdAt });
      // Not after each call's confirmation (those can come one after another); the grants are the ones
      // that last, so a wrong click there is told at once.
      if (req.kind !== "call") {
        const what = req.kind === "access" && req.items?.length ? `: ${req.items.join("; ")}` : ` (${req.profile})`;
        toast(decision.startsWith("deny") ? "info" : "success", `${DECIDED[decision] ?? decision}${what}`);
      }
    } catch (e) {
      stale = e instanceof ApiError && e.status === 409;
      toast(stale ? "warning" : "info", (e as Error).message);
    }
    answered.current.add(questionKey(req));
    setRequests((cur) => cur.filter((x) => questionKey(x) !== questionKey(req)));
    setBusy(false);
    if (stale) void load();
  };

  const call = req.kind === "call";
  const access = req.kind === "access";
  return (
    <Dialog open maxWidth={access ? "sm" : "xs"} fullWidth>
      <DialogTitle>{access ? "Give the assistant more access?" : call ? "Allow this action?" : "Allow an AI assistant?"}</DialogTitle>
      <DialogContent>
        {access ? (
          <>
            <Typography>
              An assistant using <b>{req.profile}</b> asks for more than that connection allows:
            </Typography>
            <Box component="ul" sx={{ mt: 1, mb: 0, pl: 2.5 }}>
              {(req.items ?? []).map((item) => (
                <Typography component="li" key={item} sx={{ fontWeight: 600, wordBreak: "break-word" }}>
                  {item}
                </Typography>
              ))}
            </Box>
            {(req.items ?? []).some((item) => item.startsWith("Container:") || item.startsWith("Compose project:")) && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Pierside&apos;s own, extension and Kubernetes containers never match, even when allowed.
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Its reason, in its own words:
            </Typography>
            <Box sx={{ mt: 0.5, p: 1.5, borderRadius: 1, bgcolor: "action.hover", fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 140, overflow: "auto" }}>{req.detail}</Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Decide by the list, not by the reason. If you didn't ask the assistant for something that needs this, deny.
            </Typography>
          </>
        ) : call ? (
          <>
            <Typography>
              An assistant using <b>{req.profile}</b> wants to <b>{toolText(req.tool)}</b>
              {req.target ? (
                <>
                  {" on "}
                  <b>{req.target}</b>
                </>
              ) : null}
              {req.detail ? ":" : "."}
            </Typography>
            {req.detail && (
              <Box component="pre" sx={{ mt: 1.5, mb: 0, p: 1.5, borderRadius: 1, bgcolor: "action.hover", fontFamily: MONO, fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200, overflow: "auto" }}>
                {req.detail}
              </Box>
            )}
          </>
        ) : (
          <>
            <Typography>
              An assistant wants to use the connection <b>{req.profile}</b>. It will be able to do what that connection allows, and nothing else.
            </Typography>
            <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 1.5 }}>
              <Typography color="text.secondary">Code</Typography>
              <Typography sx={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, letterSpacing: 2 }}>{req.code}</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              The assistant shows the same code. If you didn't just start an assistant, or the code differs, deny.
            </Typography>
          </>
        )}
        {requests.length > 1 && (
          <Alert severity="info" sx={{ mt: 2, py: 0 }}>
            {requests.length - 1} more waiting.
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" color="error" disabled={busy} onClick={() => void answer("deny")} autoFocus>
          Deny
        </Button>
        {access && (
          <Tooltip title="Deny, and this assistant session can't ask for more access for 2 minutes">
            <Button color="error" disabled={busy} onClick={() => void answer("deny_pause")}>
              Deny, pause 2 min
            </Button>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        {access ? (
          <>
            <Button variant="outlined" disabled={busy || held} onClick={() => void answer("permanent")}>
              Add to connection
            </Button>
            <Button variant="contained" disabled={busy || held} onClick={() => void answer("session")}>
              Allow this session
            </Button>
          </>
        ) : call ? (
          <Button variant="contained" disabled={busy || held} onClick={() => void answer("allow")}>
            Allow
          </Button>
        ) : (
          <>
            <Button variant="outlined" disabled={busy || held} endIcon={<ArrowDropDownIcon />} onClick={(e) => setLonger(e.currentTarget)}>
              Allow longer
            </Button>
            <Menu anchorEl={longer} open={!!longer} onClose={() => setLonger(null)}>
              <MenuItem onClick={() => void answer("day")}>For 24 hours</MenuItem>
              <MenuItem onClick={() => void answer("week")}>For 7 days</MenuItem>
              <MenuItem onClick={() => void answer("month")}>For 30 days</MenuItem>
              <MenuItem onClick={() => void answer("always")}>Always (never ask again)</MenuItem>
            </Menu>
            <Button variant="contained" disabled={busy || held} onClick={() => void answer("once")}>
              Allow this session
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
