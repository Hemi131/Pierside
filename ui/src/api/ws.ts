import { api, dd, extensionToken, sessionToken, standalone } from "./ddclient";

interface WsInfo {
  port: number;
  token: string;
}

// Docker gives the backend a new host port when its container restarts, so the answer is only
// reused briefly: a socket that reconnects after a backend restart asks again and finds the new port.
const INFO_TTL_MS = 10_000;
let info: { at: number; promise: Promise<WsInfo> } | null = null;

export function getWsInfo(): Promise<WsInfo> {
  // Standalone window: same backend it was served from; token redeemed at start-up.
  if (standalone) {
    const token = sessionToken();
    if (token) return Promise.resolve({ port: Number(window.location.port) || 80, token });
  }
  if (!info || Date.now() - info.at > INFO_TTL_MS) {
    const promise = api.get<WsInfo>("/ws-info").catch((e) => {
      if (info?.promise === promise) info = null; // retry next time
      throw e;
    });
    info = { at: Date.now(), promise };
  }
  return info.promise;
}

/** Build an authenticated ws:// URL for a backend WebSocket path. */
export async function wsUrl(path: string, params: Record<string, string> = {}): Promise<string> {
  const ws = await getWsInfo();
  const port = ws.port;
  // Inside Rancher use the live token (it's re-read when the backend restarts); elsewhere the cached one.
  const token = dd ? await extensionToken() : ws.token;
  const qs = new URLSearchParams({ ...params, token });
  return `ws://localhost:${port}${path}?${qs}`;
}
