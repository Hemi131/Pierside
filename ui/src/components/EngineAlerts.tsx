/**
 * Shows the problems the backend finds in the active engine (services/alerts.py): a container killed
 * for running out of memory, one turning unhealthy, one in a restart loop, a Swarm service whose task
 * keeps failing. Always as a toast; also as a desktop notification when the user switched that on and
 * isn't looking at Pierside.
 */
import { useEffect } from "react";
import { useEngine } from "../hooks/useEngine";
import { navigate } from "../hooks/useRoute";
import { readPref } from "../api/prefs";
import { useFeedback } from "./Feedback";

/** The setting (About dialog): desktop notifications for these problems. */
export const DESKTOP_ALERTS_PREF = "alerts.desktop";

export const desktopAlertsSupported = () => typeof window !== "undefined" && "Notification" in window;

/** Ask for the permission where it isn't decided yet. Resolves whether notifications may be shown. */
export async function allowDesktopAlerts(): Promise<boolean> {
  if (!desktopAlertsSupported()) return false;
  if (Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
  return Notification.permission === "granted";
}

export function showDesktopAlert(title: string, body: string, onClick?: () => void): boolean {
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
};

export function EngineAlerts() {
  const { onEvent, engine } = useEngine();
  const { toast } = useFeedback();
  const engineName = engine?.engine?.name;

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "alert" || !e.detail) return;
        toast(e.severity === "error" ? "error" : "warning", e.detail);
        // On the desktop only when Pierside isn't in front: the toast is enough otherwise.
        if (readPref<boolean>(DESKTOP_ALERTS_PREF) && (document.hidden || !document.hasFocus())) {
          const title = `${TITLES[e.action] ?? "Pierside"}${engineName ? ` · ${engineName}` : ""}`;
          showDesktopAlert(title, e.detail, () => (e.serviceId ? navigate("swarm", "services", e.serviceId) : e.id ? navigate("containers", e.id, "logs") : undefined));
        }
      }),
    [onEvent, toast, engineName],
  );

  return null;
}
