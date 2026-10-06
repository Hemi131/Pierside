/**
 * Where view settings (sidebar, filters, sort, column widths, ...) are kept:
 *   - Rancher's view and the dev server: browser storage, as always;
 *   - the separate window: the backend (routers/standalone.py). Its address includes the backend's
 *     host port, which changes when the backend container is recreated, and browser storage is per
 *     address, so it would lose its settings. They are loaded once before the first render and saved
 *     shortly after each change; the two views keep separate settings either way.
 */
import { api, sessionToken, standalone } from "./ddclient";

const PREFIX = "pierside:";
const SAVE_DELAY_MS = 500;

let windowPrefs: Record<string, unknown> | null = null; // set only in the separate window
let saveTimer: number | undefined;

/** Separate window start-up: fetch its settings (falls back to defaults if that fails). */
export async function loadWindowPrefs(): Promise<void> {
  if (!standalone) return;
  try {
    windowPrefs = await api.get<Record<string, unknown>>("/standalone/prefs");
  } catch {
    windowPrefs = {};
  }
  // Last changes before the window closes: a keepalive request outlives the page.
  window.addEventListener("pagehide", () => {
    if (saveTimer === undefined) return;
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    void fetch("/standalone/prefs", {
      method: "PUT",
      keepalive: true,
      headers: { "Content-Type": "application/json", "X-Pierside-Token": sessionToken() ?? "" },
      body: JSON.stringify(windowPrefs),
    }).catch(() => undefined);
  });
}

export function readPref<T>(key: string): T | undefined {
  if (windowPrefs) return key in windowPrefs ? (windowPrefs[key] as T) : undefined;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw != null ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writePref(key: string, value: unknown): void {
  if (windowPrefs) {
    windowPrefs[key] = value;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void api.put("/standalone/prefs", windowPrefs).catch(() => undefined);
    }, SAVE_DELAY_MS);
    return;
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
