export interface NetworkMember {
  id: string;
  name: string;
  state: string;
  project: string | null;
  ipv4: string | null;
  ipv6: string | null;
  mac: string | null;
  aliases: string[];
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  ipv6: boolean;
  created: string;
  subnets: string[];
  gateways: string[];
  labels: Record<string, string>;
  project: string | null;
  /** bridge / host / none (and swarm's): created by the engine, can't be removed */
  builtin: boolean;
  containers: NetworkMember[];
}
