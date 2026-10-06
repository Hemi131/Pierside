/**
 * Watches engine events and toasts the problems you'd otherwise miss: a container killed for
 * running out of memory, one stuck in a restart loop, one turning unhealthy.
 */
import { useEffect, useRef } from "react";
import { useEngine } from "../hooks/useEngine";
import { isPending } from "../hooks/useActions";
import { useFeedback } from "./Feedback";

const LOOP_WINDOW_MS = 2 * 60_000;
const LOOP_CRASHES = 3;
const REPEAT_AFTER_MS = 5 * 60_000; // don't repeat the same alert for a container more often

// Exit codes of a normal stop (0, SIGTERM); SIGKILL (137) also covers the OOM killer, so it counts.
const CLEAN_EXIT = new Set(["0", "143"]);

export function EngineAlerts() {
  const { onEvent } = useEngine();
  const { toast } = useFeedback();
  const crashes = useRef(new Map<string, number[]>());
  const lastAlert = useRef(new Map<string, number>());

  useEffect(() => {
    const alertOnce = (key: string, fn: () => void) => {
      const now = Date.now();
      if (now - (lastAlert.current.get(key) ?? 0) < REPEAT_AFTER_MS) return;
      lastAlert.current.set(key, now);
      fn();
    };
    return onEvent((e) => {
      if (e.type !== "container" || !e.id) return;
      const name = e.name ?? e.id.slice(0, 12);
      if (e.action === "oom") {
        alertOnce(`oom:${e.id}`, () => toast("error", `"${name}" ran out of memory and was killed (OOM). Raise its memory limit or check for a leak.`));
      } else if (e.action === "health_status" && e.detail === "unhealthy") {
        alertOnce(`health:${e.id}`, () => toast("warning", `"${name}" is unhealthy: its health check is failing.`));
      } else if (e.action === "die" && !CLEAN_EXIT.has(e.exitCode ?? "") && !isPending(e.id)) {
        const now = Date.now();
        const recent = (crashes.current.get(e.id) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
        recent.push(now);
        crashes.current.set(e.id, recent);
        if (recent.length >= LOOP_CRASHES) {
          alertOnce(`loop:${e.id}`, () =>
            toast("warning", `"${name}" keeps restarting: it crashed ${recent.length} times in the last 2 minutes (exit code ${e.exitCode}). Check its logs.`),
          );
        }
      } else if (e.action === "destroy") {
        crashes.current.delete(e.id);
      }
    });
  }, [onEvent, toast]);

  return null;
}
