import { useSyncExternalStore } from "react";
import { api } from "../../api/ddclient";

export interface EngineMeta {
  id: string;
  name: string;
  type: "local" | "ssh";
  publicHost?: string;
  target?: string;
  color?: string;
}

export interface EngineEntry {
  id: string;
  name: string;
  type: "local" | "ssh";
  active: boolean;
  host?: string;
  port?: number;
  user?: string;
  socketPath?: string;
  mode?: "socket" | "stdio";
  publicHost?: string;
  fingerprint?: string | null;
  hasKey?: boolean;
  hasPassword?: boolean;
  color?: string;
}

export interface EngineList {
  engines: EngineEntry[];
  active: EngineMeta;
  error: string | null;
}

/**
 * Second line under an SSH engine's name: its address, unless the name already is the address (the
 * default when no name was given), which would just show it twice.
 */
export function engineSubtitle(name: string, address: string | undefined): string {
  return address && !isDefaultName(name, address) ? address : "SSH engine";
}

/** Whether an engine's name is just its address: `user@host`, which `address` may follow with `:port`. */
export function isDefaultName(name: string, address: string | undefined): boolean {
  return !!address && address.replace(/:\d+$/, "") === name;
}

/** Rename an engine ("" = back to the default, user@host) or set its colour ("" = none). */
export function updateEngine(id: string, patch: { name?: string; color?: string }): Promise<unknown> {
  return api.patch(`/engines/${encodeURIComponent(id)}`, patch);
}

/** A request URL for the server a page shows: the backend refuses it if another engine is active by then
 *  (a second window can still show the old server after a switch). */
export function onEngine(url: string, engineId: string | undefined): string {
  return engineId ? `${url}${url.includes("?") ? "&" : "?"}engine=${encodeURIComponent(engineId)}` : url;
}

/** A switch the user cancelled: nothing changed, nothing to report. */
export class SwitchCancelled extends Error {}

// One switch at a time in this window, whichever page started it, and every page shows the same one.
let switchingTo: string | null = null;
const listeners = new Set<() => void>();

function setSwitching(id: string | null): void {
  switchingTo = id;
  listeners.forEach((l) => l());
}

/** The engine this window is switching to. */
export function useSwitching(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => switchingTo,
  );
}

/** Switch engines and start over on `hash` (a page of the new engine), reloading the UI so every view
 *  and socket starts clean. Rejects with `SwitchCancelled` after `cancelSwitch()`. */
export async function activateEngine(id: string, hash = "#/containers"): Promise<void> {
  if (switchingTo) throw new Error("Another engine switch is running: wait for it or cancel it first.");
  setSwitching(id);
  try {
    await api.post(`/engines/${encodeURIComponent(id)}/activate`);
  } catch (e) {
    setSwitching(null);
    throw (e as Error).message === "Switch cancelled" ? new SwitchCancelled("Switch cancelled") : e;
  }
  window.location.hash = hash;
  window.location.reload();
}

/** Stop this window's switch while it is still connecting (an offline server would hold it until the time limit). */
export async function cancelSwitch(): Promise<void> {
  if (switchingTo) await api.post("/engines/switch/cancel", { engine: switchingTo });
}

/** Show a failed switch, unless it was cancelled. */
export function switchFailed(err: unknown, show: (message: string) => void): void {
  if (!(err instanceof SwitchCancelled)) show((err as Error).message);
}
