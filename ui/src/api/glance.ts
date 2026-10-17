/** Engines at a glance (backend routers/glance.py, services/watch.py). */
import { api } from "./ddclient";

export interface GlanceProblem {
  name: string;
  id: string;
  what: string;
}

export interface GlanceEngine {
  id: string;
  name: string;
  type: "local" | "ssh";
  color: string;
  active: boolean;
  target: string | null;
  /** Watched in the background: state and alerts even while another engine is active. */
  watched: boolean;
  /** Being asked right now. */
  polling: boolean;
  /** A watched engine whose connection keeps failing. */
  down: boolean;
  // The last snapshot (absent until the first one).
  updatedAt?: number;
  reachable?: boolean;
  error?: string | null;
  version?: string;
  os?: string;
  cpus?: number;
  memory?: number;
  images?: number;
  swarm?: boolean;
  running?: number;
  paused?: number;
  stopped?: number;
  total?: number;
  problems?: GlanceProblem[];
  /** CPU of the running containers, 100 = one core; null while the first measurement is running. */
  cpu?: number | null;
  /** Memory of the running containers, bytes; null while the first measurement is running. */
  mem?: number | null;
  /** Some containers' samples are missing: cpu / mem are lower bounds. */
  usagePartial?: boolean | null;
}

export interface GlanceAlert {
  kind: string;
  severity: "info" | "warning" | "error";
  name: string;
  containerId: string;
  serviceId?: string;
  message: string;
  at: number;
  engineId: string;
  engineName: string;
}

export interface Glance {
  /** Seconds between updates; 0 = only on Refresh. */
  interval: number;
  intervals: number[];
  engines: GlanceEngine[];
  /** Newest first. */
  recent: GlanceAlert[];
}

export const loadGlance = () => api.get<Glance>("/glance");
export const saveGlanceSettings = (s: { interval?: number; watch?: Record<string, boolean> }) => api.put<Glance>("/glance/settings", s);
export const refreshGlance = () => api.post<{ ok: boolean }>("/glance/refresh", {});
