/**
 * EngineProvider: one shared /ws/events connection for the whole UI.
 * Holds the authoritative container list + stats pushed by the backend. If the socket can't
 * connect, it falls back to polling /containers through vm.service so the UI stays usable.
 */
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "../api/ddclient";
import { wsUrl } from "../api/ws";
import type { Container, ContainerStats, EngineEvent, EngineStatus, StatsTotals, WsMessage } from "../api/types";
import type { EngineList } from "../views/engines/engineApi";

type Listener = (e: EngineEvent) => void;

interface EngineCtx {
  engine: EngineStatus | null;
  socket: "connecting" | "open" | "polling";
  containers: Container[] | null;
  stats: Record<string, ContainerStats>;
  totals: StatsTotals | null;
  /** Subscribe to raw engine events (image/volume/network changes etc.). */
  onEvent: (l: Listener) => () => void;
}

const Ctx = createContext<EngineCtx | null>(null);

const POLL_MS = 3000;

export function EngineProvider({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [socket, setSocket] = useState<EngineCtx["socket"]>("connecting");
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [stats, setStats] = useState<Record<string, ContainerStats>>({});
  const [totals, setTotals] = useState<StatsTotals | null>(null);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;

    const poll = async () => {
      try {
        // Engine meta too, so the engine's colour frame shows even without the WebSocket.
        const [list, engines] = await Promise.all([api.get<Container[]>("/containers?all=true"), api.get<EngineList>("/engines")]);
        if (!disposed) {
          setContainers(list);
          setEngine((e) => ({ ...(e?.ok ? e : { ok: true }), engine: engines.active }));
        }
      } catch (e) {
        if (!disposed) setEngine({ ok: false, error: (e as Error).message });
      }
    };
    const startPolling = () => {
      if (pollTimer !== undefined) return;
      setSocket("polling");
      void poll();
      pollTimer = window.setInterval(poll, POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const connect = async () => {
      if (disposed) return;
      let url: string;
      try {
        url = await wsUrl("/ws/events");
      } catch (e) {
        setEngine({ ok: false, error: `Backend not reachable: ${(e as Error).message}` });
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        stopPolling();
        setSocket("open");
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as WsMessage;
        switch (m.type) {
          case "engine": {
            const { type: _t, ...status } = m;
            setEngine(status);
            break;
          }
          case "containers":
            setContainers(m.containers);
            break;
          case "stats":
            setStats(m.stats);
            setTotals(m.totals);
            break;
          case "event":
            listeners.current.forEach((l) => l(m.event));
            break;
        }
      };
      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        startPolling();
        scheduleReconnect();
      };
    };
    const scheduleReconnect = () => {
      if (disposed) return;
      startPolling();
      const delay = Math.min(1000 * 2 ** retry, 10000);
      retry++;
      retryTimer = window.setTimeout(connect, delay);
    };

    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      stopPolling();
      ws?.close();
    };
  }, []);

  const onEvent = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  return <Ctx.Provider value={{ engine, socket, containers, stats, totals, onEvent }}>{children}</Ctx.Provider>;
}

/** Host that published container ports are reachable on (localhost for the local engine). */
export function usePortHost(): string {
  const { engine } = useEngine();
  return engine?.engine?.publicHost || "localhost";
}

export function useEngine(): EngineCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEngine outside EngineProvider");
  return ctx;
}
