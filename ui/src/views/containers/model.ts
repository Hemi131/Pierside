import type { Container, ContainerState, ContainerStats } from "../../api/types";

export type SortKey = "name" | "image" | "status" | "cpu" | "started";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

export interface ProjectGroup {
  kind: "project";
  /** compose project, or swarm stack (task containers grouped by com.docker.stack.namespace) */
  source: "compose" | "swarm";
  name: string;
  containers: Container[];
  running: number;
  state: ContainerState | "partial";
}
export interface SingleRow {
  kind: "container";
  c: Container;
}
export type TopRow = ProjectGroup | SingleRow;

/** Exited containers of old swarm tasks (swarm keeps a task history); hidden by default. */
export const isSwarmHistory = (c: Container) => !!c.swarmServiceId && !isActive(c.state) && c.state !== "created";

/** "alpine:3.20@sha256:…" -> "alpine:3.20" for display. */
export const displayImage = (image: string) => image.replace(/@sha256:[0-9a-f]+$/, "");

export const isActive = (s: ContainerState) => s === "running" || s === "paused" || s === "restarting";

export function statusLabel(c: Container): string {
  switch (c.state) {
    case "running":
      return c.health ? `Running (${c.health})` : "Running";
    case "exited":
      return c.oomKilled ? `Exited (${c.exitCode ?? 0}) · out of memory` : `Exited (${c.exitCode ?? 0})`;
    case "paused":
      return "Paused";
    case "restarting":
      return c.restartCount ? `Restarting (${c.restartCount}×)` : "Restarting";
    case "created":
      return "Created";
    case "dead":
      return "Dead";
    case "removing":
      return "Removing";
    default:
      return c.state;
  }
}

export function projectStatus(g: ProjectGroup): string {
  const total = g.containers.length;
  if (g.running === 0) return g.containers.some((c) => c.state === "paused") ? "Paused" : "Exited";
  const unhealthy = g.containers.filter((c) => c.health === "unhealthy").length;
  return `Running (${g.running}/${total})${unhealthy ? ` · ${unhealthy} unhealthy` : ""}`;
}

function aggregateState(cs: Container[]): ProjectGroup["state"] {
  const running = cs.filter((c) => c.state === "running").length;
  if (running === cs.length) return "running";
  if (running > 0) return "partial";
  if (cs.some((c) => c.state === "paused")) return "paused";
  if (cs.some((c) => c.state === "restarting")) return "restarting";
  return "exited";
}

export function matches(c: Container, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return [c.name, c.image, c.id.slice(0, 12), c.project ?? "", c.service ?? "", c.stack ?? "", c.swarmService ?? "", ...c.ports.map((p) => `${p.public ?? ""}:${p.private}`)].some((v) =>
    v.toLowerCase().includes(s),
  );
}

const startedMs = (c: Container) => (c.startedAt ? new Date(c.startedAt).getTime() : 0);
const stateRank = (s: string) => ({ running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 })[s] ?? 6;

function cmpContainers(a: Container, b: Container, key: SortKey, stats: Record<string, ContainerStats>): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "image":
      return a.image.localeCompare(b.image);
    case "status":
      return stateRank(a.state) - stateRank(b.state);
    case "cpu":
      return (stats[a.id]?.cpu ?? -1) - (stats[b.id]?.cpu ?? -1);
    case "started":
      return startedMs(a) - startedMs(b);
  }
}

function cmpTop(a: TopRow, b: TopRow, key: SortKey, stats: Record<string, ContainerStats>): number {
  const name = (r: TopRow) => (r.kind === "project" ? r.name : r.c.name);
  const members = (r: TopRow) => (r.kind === "project" ? r.containers : [r.c]);
  switch (key) {
    case "name":
      return name(a).localeCompare(name(b));
    case "image":
      return (a.kind === "project" ? "" : a.c.image).localeCompare(b.kind === "project" ? "" : b.c.image);
    case "status":
      return Math.min(...members(a).map((c) => stateRank(c.state))) - Math.min(...members(b).map((c) => stateRank(c.state)));
    case "cpu": {
      const sum = (r: TopRow) => members(r).reduce((s, c) => s + (stats[c.id]?.cpu ?? 0), 0);
      return sum(a) - sum(b);
    }
    case "started": {
      const max = (r: TopRow) => Math.max(...members(r).map(startedMs));
      return max(a) - max(b);
    }
  }
}

export function buildRows(list: Container[], sort: Sort, stats: Record<string, ContainerStats>): TopRow[] {
  const groups = new Map<string, Container[]>();
  const rows: TopRow[] = [];
  for (const c of list) {
    const key = c.project ? `compose:${c.project}` : c.stack ? `swarm:${c.stack}` : c.swarmService ? `swarm:${c.swarmService}` : null;
    if (key) {
      const g = groups.get(key);
      if (g) g.push(c);
      else groups.set(key, [c]);
    } else rows.push({ kind: "container", c });
  }
  const sign = sort.dir === "asc" ? 1 : -1;
  for (const [key, cs] of groups) {
    cs.sort((a, b) => sign * cmpContainers(a, b, sort.key, stats) || a.name.localeCompare(b.name));
    const [source, name] = key.split(/:(.*)/s) as ["compose" | "swarm", string];
    rows.push({ kind: "project", source, name, containers: cs, running: cs.filter((c) => c.state === "running").length, state: aggregateState(cs) });
  }
  rows.sort((a, b) => sign * cmpTop(a, b, sort.key, stats) || (a.kind === "project" ? a.name : a.c.name).localeCompare(b.kind === "project" ? b.name : b.c.name));
  return rows;
}
