/**
 * Container / project actions with shared "pending" state (spinners), toasts on result and
 * confirmation for destructive actions. The list itself is reconciled from engine events,
 * never from optimistic updates.
 */
import { useCallback, useSyncExternalStore } from "react";
import { api, ApiError } from "../api/ddclient";
import type { Container } from "../api/types";
import { copyText } from "../utils/format";
import { RANCHER_WARNING, useFeedback } from "../components/Feedback";

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "kill";
export type ProjectAction = "start" | "stop" | "restart" | "pause" | "unpause";

// ---- tiny pending store (key -> action label) ----
const pending = new Map<string, string>();
const subs = new Set<() => void>();
let snapshot: ReadonlyMap<string, string> = new Map();
function setPending(key: string, label: string | null) {
  if (label) pending.set(key, label);
  else pending.delete(key);
  snapshot = new Map(pending);
  subs.forEach((s) => s());
}
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

/** Whether a Pierside action on this container is in flight (its stop/restart isn't a crash). */
export const isPending = (key: string) => pending.has(key);

export function usePending(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const projectKey = (name: string) => `project:${name}`;

const PAST: Record<string, string> = {
  start: "started",
  stop: "stopped",
  restart: "restarted",
  pause: "paused",
  unpause: "resumed",
  kill: "killed",
};

interface PortConflict {
  port: number;
  /** Container publishing the port; null when it's some other program on the host. */
  holder: { id: string; name: string; project?: string | null } | null;
  container: { id: string; name?: string | null };
}

function portConflictOf(e: unknown): PortConflict | null {
  const d = e instanceof ApiError ? e.detail : null;
  return d && typeof d === "object" && "portConflict" in d ? (d as { portConflict: PortConflict }).portConflict : null;
}

export function useActions() {
  const { toast, confirm } = useFeedback();

  const run = useCallback(
    async (key: string, label: string, fn: () => Promise<unknown>, success?: string) => {
      const attempt = async (): Promise<boolean> => {
        setPending(key, label);
        try {
          await fn();
          if (success) toast("success", success);
          return true;
        } catch (e) {
          setPending(key, null);
          const conflict = portConflictOf(e);
          if (!conflict) {
            toast("error", (e as Error).message || String(e));
            return false;
          }
          // Start failed because another container publishes the same host port: offer to stop it.
          const { holder, port } = conflict;
          if (!holder) {
            toast("error", `${(e as Error).message} Free the port or change the container's port mapping.`);
            return false;
          }
          const target = conflict.container.name ? `"${conflict.container.name}"` : "the container";
          const ok = await confirm({
            title: `Port ${port} is already in use`,
            message: `"${holder.name}"${holder.project ? ` (project ${holder.project})` : ""} is publishing port ${port}, so ${target} can't start. Stop "${holder.name}" and try again?`,
            confirmLabel: `Stop ${holder.name} and start`,
          });
          if (!ok) return false;
          try {
            await api.post(`/containers/${holder.id}/stop`);
          } catch (e2) {
            toast("error", `Couldn't stop ${holder.name}: ${(e2 as Error).message}`);
            return false;
          }
          return attempt();
        } finally {
          setPending(key, null);
        }
      };
      return attempt();
    },
    [toast, confirm],
  );

  const containerAction = useCallback(
    async (c: Container, action: ContainerAction) => {
      if (c.swarmServiceId && (action === "stop" || action === "kill" || action === "pause")) {
        const ok = await confirm({
          title: "Container is managed by Swarm",
          message: `"${c.name}" is a task of service ${c.swarmService}. If you ${action} it, Swarm will start a replacement. To stop the service, scale it to 0 in the Swarm view.`,
          confirmLabel: `${action[0].toUpperCase()}${action.slice(1)} anyway`,
        });
        if (!ok) return false;
      }
      return run(c.id, action, () => api.post(`/containers/${c.id}/${action}`), `Container ${c.name} ${PAST[action]}`);
    },
    [run, confirm],
  );

  const deleteContainers = useCallback(
    async (cs: Container[], opts: { skipConfirm?: boolean } = {}) => {
      if (cs.length === 0) return false;
      if (!opts.skipConfirm) {
        const ok = await confirm({
          title: cs.length === 1 ? "Delete container?" : `Delete ${cs.length} containers?`,
          message:
            (cs.length === 1
              ? `"${cs[0].name}" will be stopped (if running) and permanently removed.`
              : `${cs.length} containers will be stopped (if running) and permanently removed.`) +
            (cs.some((c) => c.swarmServiceId) ? " Swarm will create replacements for deleted swarm tasks. Remove or scale the service instead." : ""),
          warning: cs.some((c) => c.isExtension) ? RANCHER_WARNING.extension : cs.some((c) => c.isSystem) ? RANCHER_WARNING.system : undefined,
          confirmLabel: "Delete forever",
          destructive: true,
        });
        if (!ok) return false;
      }
      const results = await Promise.all(
        cs.map((c) => run(c.id, "delete", () => api.del(`/containers/${c.id}?force=true`))),
      );
      const done = results.filter(Boolean).length;
      if (done) toast("success", done === 1 && cs.length === 1 ? `Container ${cs[0].name} deleted` : `${done} containers deleted`);
      return done > 0;
    },
    [confirm, run, toast],
  );

  const bulkAction = useCallback(
    async (cs: Container[], action: "start" | "stop") => {
      const targets = cs.filter((c) =>
        action === "start" ? ["created", "exited", "dead"].includes(c.state) : ["running", "paused", "restarting"].includes(c.state),
      );
      if (targets.length === 0) {
        toast("info", `No selected containers to ${action}`);
        return;
      }
      const results = await Promise.all(targets.map((c) => run(c.id, action, () => api.post(`/containers/${c.id}/${action}`))));
      const done = results.filter(Boolean).length;
      if (done) toast("success", `${done} container${done > 1 ? "s" : ""} ${PAST[action]}`);
    },
    [run, toast],
  );

  const projectAction = useCallback(
    (name: string, action: ProjectAction) =>
      run(projectKey(name), action, () => api.post(`/projects/${encodeURIComponent(name)}/${action}`), `Project ${name} ${PAST[action]}`),
    [run],
  );

  const deleteProject = useCallback(
    async (name: string, count: number) => {
      const ok = await confirm({
        title: "Delete compose project?",
        message: `All ${count} container${count > 1 ? "s" : ""} of "${name}" and its networks will be removed. Volumes are kept.`,
        warning: name.startsWith("rd-extension-") ? RANCHER_WARNING.extension : undefined,
        confirmLabel: "Delete forever",
        destructive: true,
      });
      if (!ok) return false;
      return run(projectKey(name), "delete", () => api.del(`/projects/${encodeURIComponent(name)}`), `Project ${name} deleted`);
    },
    [confirm, run],
  );

  const copyRunCommand = useCallback(
    async (c: Container) => {
      try {
        const { command } = await api.get<{ command: string }>(`/containers/${c.id}/run-command`);
        await copyText(command);
        toast("success", "docker run command copied to clipboard");
      } catch (e) {
        toast("error", (e as Error).message);
      }
    },
    [toast],
  );

  return { containerAction, deleteContainers, bulkAction, projectAction, deleteProject, copyRunCommand };
}
