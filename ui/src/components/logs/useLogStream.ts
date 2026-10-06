import { useEffect, useRef, useState } from "react";
import { wsUrl } from "../../api/ws";

export interface LogLine {
  t: string; // RFC3339Nano
  k: number; // ns sort key
  s: "stdout" | "stderr" | string;
  m: string;
  svc?: string; // service name (merged project logs)
}

export type StreamState = "connecting" | "streaming" | "stopped" | "removed" | "error" | "closed";

export const MAX_LINES = 50_000;

interface Handlers {
  onLines: (lines: LogLine[]) => void;
  onReset: () => void;
}

/**
 * Connects to a backend log WebSocket and pushes batches to `handlers` (outside React state, for
 * throughput). Reconnects with backoff; on reconnect the view is reset and re-tailed.
 */
export function useLogStream(path: string, params: Record<string, string>, handlers: Handlers) {
  const [state, setState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const h = useRef(handlers);
  h.current = handlers;
  const paramKey = JSON.stringify(params);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retry = 0;
    let timer: number | undefined;
    let terminal = false; // removed / server error: don't reconnect

    const connect = async () => {
      setState("connecting");
      let url: string;
      try {
        url = await wsUrl(path, JSON.parse(paramKey));
      } catch (e) {
        setError((e as Error).message);
        setState("error");
        schedule();
        return;
      }
      if (disposed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        if (retry > 0) h.current.onReset();
        retry = 0;
        setError(null);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "lines":
            h.current.onLines(msg.lines);
            break;
          case "status":
            setState(msg.state);
            if (msg.state === "removed") terminal = true;
            break;
          case "dropped":
            setDropped((d) => d + msg.count);
            break;
          case "error":
            terminal = true;
            setError(msg.message);
            setState("error");
            break;
        }
      };
      ws.onclose = () => {
        ws = null;
        if (disposed || terminal) return;
        setState("closed");
        schedule();
      };
    };
    const schedule = () => {
      if (disposed) return;
      timer = window.setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
    };

    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [path, paramKey]);

  return { state, error, dropped };
}
