/**
 * Shows the problems the backend finds (services/alerts.py) in the active engine and in engines watched
 * in the background (services/watch.py): a container killed for running out of memory, one turning
 * unhealthy, one in a restart loop, a Swarm service whose task keeps failing, a watched engine that
 * can't be reached (and is back). As a notification in the window; also as a desktop notification when
 * the user switched that on and isn't looking at Pierside. An alert about another engine than the active
 * one names it, and its notification opens Engines at a glance.
 *
 * The backend already reports a problem once while it goes on (with a reminder every two hours). Here:
 *   - alerts arriving while one is shown join it (one notification "3 alerts"), instead of queueing up
 *     one after another for minutes;
 *   - desktop notifications at most every DESKTOP_GAP_MS, the ones in between summed up in the next;
 *   - the same problem from two engines (two managers of one Swarm) only once within SAME_MS;
 *   - "Mute 1 h" (what the notification is about) and "Pause all 15 min", kept in the prefs, so they
 *     last across the reload of an engine switch. Both silence the desktop notifications too.
 *
 * How a desktop notification is shown depends on where Pierside runs:
 *   - inside Rancher Desktop: through Rancher's own toast call (ddClient.desktopUI.toast), which its
 *     main program shows as a system notification. The browser's Notification API is allowed there
 *     too, but on Windows nothing appears (verified: created without error, never shown);
 *   - the separate window: the browser's Notification API, after its permission question.
 * Rancher's call fixes the title ("Warning" / "Error"), has no click action and no buttons.
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Snackbar, Stack, Typography } from "@mui/material";
import type { EngineEvent } from "../api/types";
import { useEngine } from "../hooks/useEngine";
import { navigate } from "../hooks/useRoute";
import { readPref, writePref } from "../api/prefs";
import { dd } from "../api/ddclient";
import { useFeedback } from "./Feedback";

/** The setting (About dialog): desktop notifications for these problems. */
export const DESKTOP_ALERTS_PREF = "alerts.desktop";
const MUTES_PREF = "alerts.mutes"; // alert key -> muted until (ms)
const PAUSE_PREF = "alerts.pausedUntil"; // ms
const MUTE_MS = 60 * 60 * 1000;
const PAUSE_MS = 15 * 60 * 1000;
const DESKTOP_GAP_MS = 30 * 1000;
const SAME_MS = 60 * 1000;
const SHOW_MS = 10 * 1000; // how long the window's notification stays after the last alert joined it
const LISTED = 3;

export const desktopAlertsSupported = () => !!dd || (typeof window !== "undefined" && "Notification" in window);

/** Ask for the permission where it isn't decided yet. Resolves whether notifications may be shown. */
export async function allowDesktopAlerts(): Promise<boolean> {
  if (dd) return true; // Rancher Desktop shows them itself: nothing to ask
  if (!desktopAlertsSupported()) return false;
  if (Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
  return Notification.permission === "granted";
}

export function showDesktopAlert(title: string, body: string, onClick?: () => void, severity: "success" | "warning" | "error" = "warning"): boolean {
  if (dd) {
    try {
      dd.desktopUI.toast[severity](`${title}: ${body}`);
      return true;
    } catch {
      return false;
    }
  }
  if (!desktopAlertsSupported() || Notification.permission !== "granted") return false;
  try {
    const n = new Notification(title, { body, tag: `${title}: ${body}` }); // the whole text: two different alerts don't replace each other
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false; // some embedded browsers have the API but refuse to show anything
  }
}

const TITLES: Record<string, string> = {
  oom: "Container out of memory",
  unhealthy: "Container unhealthy",
  loop: "Container keeps restarting",
  service: "Swarm service keeps failing",
  "engine-down": "Engine can't be reached",
  "server-memory": "Server memory almost full",
  "server-swap": "Server is swapping",
  "server-load": "Server under high load",
  "server-disk": "Server disk almost full",
  "engine-up": "Engine is back",
};

type Severity = "success" | "warning" | "error";

interface Item {
  key: string;
  /** What "Mute 1 h" names: the container, service, engine or server check. */
  subject: string;
  title: string;
  text: string;
  severity: Severity;
  open: () => void;
}

/** What an alert is about, for muting it and for telling the same problem from two engines apart. */
function alertKey(e: EngineEvent): string {
  if (e.serviceId) return `service:${e.serviceId}`; // the same service whichever manager reports it
  if (e.action.startsWith("engine-")) return `${e.engineId}:engine`;
  if (e.action.startsWith("server-")) return `${e.engineId}:${e.action}`;
  return `${e.engineId}:container:${e.name ?? e.id}`; // by name: a recreated container keeps it
}

function mutedUntil(key: string, now: number): number {
  const paused = readPref<number>(PAUSE_PREF) ?? 0;
  const muted = readPref<Record<string, number>>(MUTES_PREF)?.[key] ?? 0;
  return Math.max(paused > now ? paused : 0, muted > now ? muted : 0);
}

function mute(keys: string[], until: number): void {
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(readPref<Record<string, number>>(MUTES_PREF) ?? {}).filter(([, t]) => t > now));
  for (const k of keys) kept[k] = until;
  writePref(MUTES_PREF, kept);
}

const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const worst = (items: Item[]): Severity => (items.some((i) => i.severity === "error") ? "error" : items.some((i) => i.severity === "warning") ? "warning" : "success");

export function EngineAlerts() {
  const { onEvent, engine } = useEngine();
  const { toast } = useFeedback();
  const activeId = engine?.engine?.id;
  const activeName = engine?.engine?.name;
  const [items, setItems] = useState<Item[]>([]);
  const [lastAdded, setLastAdded] = useState(0);
  const [hovered, setHovered] = useState(false); // kept open while the pointer is on it (reaching for Mute)
  const seen = useRef(new Map<string, number>()); // key -> when last shown (SAME_MS)
  const desktop = useRef<{ last: number; waiting: Item[]; timer?: number }>({ last: 0, waiting: [] });

  const sendDesktop = (list: Item[]) => {
    const now = Date.now();
    const live = list.filter((i) => mutedUntil(i.key, now) === 0);
    if (!live.length) return;
    desktop.current.last = now;
    const [first] = live;
    if (live.length === 1) showDesktopAlert(first.title, first.text, first.open, first.severity);
    else showDesktopAlert(`${dd ? "Pierside: " : ""}${live.length} alerts`, `${first.text} And ${live.length - 1} more.`, () => navigate("glance"), worst(live));
  };

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "alert" || !e.detail) return;
        const now = Date.now();
        const key = alertKey(e);
        if (mutedUntil(key, now)) return;
        if ((seen.current.get(key) ?? 0) > now - SAME_MS && !e.action.startsWith("engine-")) return; // the same problem, reported by another engine
        seen.current.set(key, now);
        const elsewhere = !!e.engineId && e.engineId !== activeId;
        const engineName = e.engineName ?? activeName;
        const severity: Severity = e.severity === "error" ? "error" : e.severity === "info" ? "success" : "warning";
        const server = e.action.startsWith("server-");
        // The engine's own alerts and server alerts name it already.
        const text = elsewhere && !e.action.startsWith("engine-") && !server ? `${engineName}: ${e.detail}` : e.detail;
        const item: Item = {
          key,
          subject: e.serviceId || e.id ? `"${e.name}"` : e.action.startsWith("engine-") ? `engine "${engineName}"` : "this server check",
          title: `${dd ? "Pierside: " : ""}${TITLES[e.action] ?? "Pierside"}${engineName ? ` · ${engineName}` : ""}`,
          text,
          severity,
          open: () =>
            server && !elsewhere
              ? navigate(e.action === "server-disk" ? "server-disk" : "server-perf")
              : elsewhere || (!e.id && !e.serviceId)
                ? navigate("glance")
                : e.serviceId
                  ? navigate("swarm", "services", e.serviceId)
                  : navigate("containers", e.id, "logs"),
        };
        setItems((list) => [...list.filter((i) => i.key !== key), item]);
        setLastAdded(now);
        // In the separate window, on the desktop only when Pierside isn't in front: the notification in
        // the window is enough otherwise. Inside Rancher Desktop always: its extension view keeps
        // reporting itself as focused and visible when another window is in front.
        if (readPref<boolean>(DESKTOP_ALERTS_PREF) && (dd || document.hidden || !document.hasFocus())) {
          const d = desktop.current;
          if (now - d.last >= DESKTOP_GAP_MS && !d.waiting.length) sendDesktop([item]);
          else {
            d.waiting.push(item);
            d.timer ??= window.setTimeout(() => {
              const waiting = d.waiting;
              d.waiting = [];
              d.timer = undefined;
              sendDesktop(waiting);
            }, Math.max(0, d.last + DESKTOP_GAP_MS - now));
          }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onEvent, activeId, activeName],
  );

  // Gone SHOW_MS after the last alert joined (each new one gives the whole notification its time again),
  // or after the pointer left it.
  useEffect(() => {
    if (!items.length || hovered) return;
    const left = Math.max(0, lastAdded + SHOW_MS + (worst(items) === "error" ? 5000 : 0) - Date.now());
    const timer = window.setTimeout(() => setItems([]), left);
    return () => window.clearTimeout(timer);
  }, [items, lastAdded, hovered]);

  useEffect(() => () => window.clearTimeout(desktop.current.timer), []);

  const close = () => {
    setItems([]);
    setHovered(false);
  };
  const muteShown = () => {
    const until = Date.now() + MUTE_MS;
    mute(
      items.map((i) => i.key),
      until,
    );
    close();
    toast("success", items.length === 1 ? `Alerts about ${items[0].subject} are muted until ${at(until)}.` : `Alerts about these ${items.length} are muted until ${at(until)}.`);
  };
  const pauseAll = () => {
    const until = Date.now() + PAUSE_MS;
    writePref(PAUSE_PREF, until);
    close();
    toast("success", `All alerts are paused until ${at(until)}.`);
  };

  const listed = items.slice(-LISTED).reverse();
  return (
    <Snackbar open={items.length > 0} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} sx={{ mb: 4 }}>
      {items.length ? (
        <Alert
          severity={worst(items)}
          variant="filled"
          onClose={close}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setLastAdded(Date.now()); // its full time again from here
          }}
          sx={{ maxWidth: 560, wordBreak: "break-word", "& .MuiAlert-message": { width: "100%" } }}
        >
          {items.length === 1 ? (
            <Typography variant="body2">{items[0].text}</Typography>
          ) : (
            <Stack spacing={0.5}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {items.length} alerts
              </Typography>
              {listed.map((i) => (
                <Typography key={i.key} variant="body2" sx={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {i.text}
                </Typography>
              ))}
              {items.length > LISTED && <Typography variant="body2">And {items.length - LISTED} more.</Typography>}
            </Stack>
          )}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 1 }}>
            <Button size="small" color="inherit" variant="outlined" onClick={() => (items.length === 1 ? items[0].open() : navigate("glance"), close())}>
              {items.length === 1 ? "Show" : "Engines at a glance"}
            </Button>
            <Button size="small" color="inherit" variant="outlined" onClick={muteShown}>
              {items.length === 1 ? "Mute 1 h" : "Mute these 1 h"}
            </Button>
            <Button size="small" color="inherit" variant="outlined" onClick={pauseAll}>
              Pause all 15 min
            </Button>
          </Box>
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}
