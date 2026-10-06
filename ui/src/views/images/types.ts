export interface ImageRow {
  id: string;
  ref: string; // "repo:tag" or the id for untagged images
  repo: string;
  tag: string;
  created: number;
  size: number;
  inUse: boolean;
  containers: number;
  digests: string[];
  labels: Record<string, string>;
  dangling: boolean;
  isSystem: boolean;
}
