/**
 * Shows the problems the backend finds (services/alerts.py) in the active engine and in engines watched
 * in the background (services/watch.py): a container killed for running out of memory, one turning
 * unhealthy, one in a restart loop, a Swarm service whose task keeps failing, a watched engine that
 * can't be reached (and is back). Always as a toast; also as a desktop notification when the user
 * switched that on and isn't looking at Pierside. An alert about another engine than the active one
 * names it, and its notification opens Engines at a glance.
 *
 * How a desktop notification is shown depends on where Pierside runs:
 *   - inside Rancher Desktop: through Rancher's own toast call (ddClient.desktopUI.toast), which its
 *     main program shows as a system notification. The browser's Notification API is allowed there
 *     too, but on Windows nothing appears (verified: created without error, never shown);
 *   - the separate window: the browser's Notification API, after its permission question.
 * Rancher's call fixes the title ("Warning" / "Error") and has no click action.
 */
import { useEffect } from "react";
import { useEngine } from "../hooks/useEngine";
import { navigate } from "../hooks/useRoute";
import { readPref } from "../api/prefs";
import { dd } from "../api/ddclient";
import { useFeedback } from "./Feedback";

/** The setting (About dialog): desktop notifications for these problems. */
export const DESKTOP_ALERTS_PREF = "alerts.desktop";

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
    const n = new Notification(title, { body, tag: body.slice(0, 60) });
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
  "engine-up": "Engine is back",
};

export function EngineAlerts() {
  const { onEvent, engine } = useEngine();
  const { toast } = useFeedback();
  const activeId = engine?.engine?.id;
  const activeName = engine?.engine?.name;

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "alert" || !e.detail) return;
        const elsewhere = !!e.engineId && e.engineId !== activeId;
        const engineName = e.engineName ?? activeName;
        const severity = e.severity === "error" ? "error" : e.severity === "info" ? "success" : "warning";
        // The engine's own alerts (can't be reached / back) name it already.
        toast(severity, elsewhere && !e.action.startsWith("engine-") ? `${engineName}: ${e.detail}` : e.detail);
        // In the separate window, on the desktop only when Pierside isn't in front: the toast is enough
        // otherwise. Inside Rancher Desktop always: its extension view keeps reporting itself as
        // focused and visible when another window is in front, so there is nothing to go by.
        if (readPref<boolean>(DESKTOP_ALERTS_PREF) && (dd || document.hidden || !document.hasFocus())) {
          const title = `${dd ? "Pierside: " : ""}${TITLES[e.action] ?? "Pierside"}${engineName ? ` · ${engineName}` : ""}`;
          const open = () =>
            elsewhere || (!e.id && !e.serviceId) ? navigate("glance") : e.serviceId ? navigate("swarm", "services", e.serviceId) : navigate("containers", e.id, "logs");
          showDesktopAlert(title, e.detail, open, severity);
        }
      }),
    [onEvent, toast, activeId, activeName],
  );

  return null;
}
