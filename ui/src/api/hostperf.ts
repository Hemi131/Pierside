/** Server performance of the active SSH engine's server (backend routers/hostperf.py, services/hostperf.py). */
import { api } from "./ddclient";

export interface PerfProcess {
  pid: number;
  ppid: number;
  /** Start time (clock ticks since boot): sent back with an action, so a reused pid is refused. */
  start: number;
  name: string;
  cmd: string;
  user: string;
  state: string;
  nice: number;
  threads: number;
  /** 100 = one core. */
  cpu: number;
  /** Resident memory, bytes. */
  mem: number;
  /** Bytes per second; null when not readable (another user's process without root). */
  read: number | null;
  write: number | null;
  kernel: boolean;
  container: { id: string; name: string; project: string | null; service: string | null } | null;
  seconds: number | null;
}

export interface CpuSplit {
  user: number;
  system: number;
  iowait: number;
  steal: number;
  busy: number;
}

export interface PerfPoint {
  t: number;
  cpu: number | null;
  mem: number;
  read: number;
  write: number;
  rx: number;
  tx: number;
}

export interface HostPerf {
  engine: string;
  via: "ssh" | "docker";
  user: string;
  ioAll: boolean;
  ioSeen: boolean;
  warming: boolean;
  alerts: boolean;
  useDocker: boolean | null;
  dockerProblem: string | null;
  summary: {
    cpus: number;
    uptime: number;
    cpu: CpuSplit | null;
    cores: (CpuSplit | null)[];
    load: number[];
    mem: { total: number; used: number; available: number; cached: number; swapTotal: number; swapUsed: number; swapRate: number };
    psi: Record<string, number>;
    /** virtual: LVM / dm-crypt / RAID, built on the other disks (not counted in totals). */
    disks: { name: string; read: number; write: number; util: number; virtual: boolean }[];
    net: { name: string; rx: number; tx: number }[];
    processes: number;
  };
  hints: { severity: "warning" | "error"; text: string }[];
  history: PerfPoint[];
  processes: PerfProcess[];
  /** The busiest this many are sent when there are more (summary.processes is the full count). */
  processesShown: number;
  /** Processes left out because what they report about themselves couldn't be read unambiguously. */
  unreadable: number;
}

export const loadHostPerf = () => api.get<HostPerf>("/hostperf");
export const leaveHostPerf = () => api.del("/hostperf");
/** `engine`: the server the process was seen on; the backend refuses when another one is active now. */
export const actOnProcess = (engine: string, p: PerfProcess, action: "end" | "kill" | "lower") =>
  api.post<{ ok: boolean; via: string }>("/hostperf/act", { engine, pid: p.pid, start: p.start, action });
export const setServerAlerts = (engine: string, on: boolean) => api.put("/glance/settings", { serverAlerts: { [engine]: on } });
