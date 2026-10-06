export type ContainerState = "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead";

export interface Port {
  ip?: string;
  private: number;
  public?: number;
  type: string;
}

export interface Mount {
  type: string;
  name?: string;
  source: string;
  destination: string;
  rw: boolean;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  imageId: string;
  command: string;
  created: number;
  state: ContainerState;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  ports: Port[];
  project: string | null;
  service: string | null;
  containerNumber: string | null;
  projectWorkingDir: string | null;
  projectConfigFiles: string | null;
  isSystem: boolean;
  isExtension: boolean;
  stack: string | null;
  swarmService: string | null;
  swarmServiceId: string | null;
  swarmTaskId: string | null;
  mounts: Mount[];
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  /** Last exit was the kernel's OOM killer. */
  oomKilled?: boolean;
}

export interface ContainerStats {
  cpu: number;
  mem: number;
  memLimit: number;
}

export interface StatsTotals {
  cpu: number;
  mem: number;
  ncpu?: number;
  memTotal?: number;
}

export interface EngineStatus {
  ok: boolean;
  error?: string;
  version?: string;
  info?: { ncpu: number; memTotal: number; name: string; os: string };
  /** Which engine the backend is talking to (local Rancher or a remote SSH host). */
  engine?: { id: string; name: string; type: "local" | "ssh"; publicHost?: string; target?: string; color?: string };
}

export interface EngineEvent {
  type: string;
  /** e.g. "unhealthy" for health_status */
  detail?: string;
  exitCode?: string;
  action: string;
  id: string;
  name?: string;
}

export type WsMessage =
  | ({ type: "engine" } & EngineStatus)
  | { type: "containers"; containers: Container[] }
  | { type: "stats"; stats: Record<string, ContainerStats>; totals: StatsTotals }
  | { type: "event"; event: EngineEvent };
