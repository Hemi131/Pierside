export interface VolumeUser {
  id: string;
  name: string;
  state: string;
  project: string | null;
  destination: string;
  rw: boolean;
}

export interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  scope: string;
  labels: Record<string, string>;
  project: string | null;
  anonymous: boolean;
  inUse: boolean;
  containers: VolumeUser[];
}
