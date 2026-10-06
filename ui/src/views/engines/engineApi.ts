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

/** Switch engines, then reload the UI so every view and socket starts clean on the new engine. */
export async function activateEngine(id: string): Promise<void> {
  await api.post(`/engines/${encodeURIComponent(id)}/activate`);
  window.location.hash = "#/containers";
  window.location.reload();
}
