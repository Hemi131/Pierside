export interface SwarmState {
  state: "inactive" | "pending" | "active" | "error" | "locked";
  active: boolean;
  isManager: boolean;
  nodeId: string | null;
  nodeAddr: string | null;
  nodes: number | null;
  managers: number | null;
  error: string | null;
  clusterId?: string;
  createdAt?: string;
  joinTokens?: { worker: string; manager: string };
}

export interface SwarmPort {
  published: number | null;
  target: number;
  protocol: string;
  mode: "ingress" | "host";
}

export interface SwarmService {
  id: string;
  name: string;
  stack: string | null;
  image: string;
  mode: "replicated" | "global" | "replicated-job" | "global-job";
  desired: number | null;
  running: number | null;
  ports: SwarmPort[];
  createdAt: string;
  updatedAt: string;
  update: { state: string | null; message: string | null } | null;
  hasPrevious: boolean;
}

export interface SwarmTask {
  id: string;
  serviceId: string;
  slot: number | null;
  nodeId: string;
  node: string;
  state: string;
  desiredState: string;
  message: string;
  error: string | null;
  timestamp: string;
  containerId: string | null;
  exitCode: number | null;
  createdAt: string;
}

export interface SwarmStack {
  name: string;
  services: number;
  running: number;
  desired: number;
  createdAt: string;
  updating: boolean;
}

export interface SwarmNode {
  id: string;
  hostname: string;
  role: "manager" | "worker";
  availability: "active" | "pause" | "drain";
  state: string;
  addr: string;
  leader: boolean;
  reachability: string | null;
  engine: string;
  os: string;
  cpus: number;
  memory: number;
  labels: Record<string, string>;
}

export interface SwarmObject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  stack: string | null;
}

/** Service name without its stack prefix ("demostack_api" -> "api"). */
export const shortServiceName = (s: { name: string; stack: string | null }) =>
  s.stack && s.name.startsWith(s.stack + "_") ? s.name.slice(s.stack.length + 1) : s.name;

export const SWARM_EVENTS = ["service", "node", "container", "secret", "config"];
