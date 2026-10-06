import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/ddclient";
import { useEngine } from "./useEngine";

/**
 * GET a backend resource and re-fetch it (debounced) whenever an engine event of one of `eventTypes`
 * arrives, so non-container lists (volumes, images) update live like Docker Desktop.
 */
export function useResource<T>(url: string | null, eventTypes: string[] = [], debounceMs = 300, pollMs = 0) {
  const { onEvent } = useEngine();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api.get<T>(url);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  // Optional polling backstop (e.g. swarm replica counts converge without discrete events).
  useEffect(() => {
    if (!pollMs || !url) return;
    const id = window.setInterval(() => void reload(), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, url, reload]);

  const typesKey = eventTypes.join(",");
  useEffect(() => {
    if (!typesKey) return;
    const types = new Set(typesKey.split(","));
    let timer: number | undefined;
    const off = onEvent((e) => {
      if (!types.has(e.type)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), debounceMs);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [onEvent, reload, typesKey, debounceMs]);

  return { data, error, loading, reload, setData };
}
