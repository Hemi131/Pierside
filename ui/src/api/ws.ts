import { api, dd, extensionToken, sessionToken, standalone } from "./ddclient";

interface WsInfo {
  port: number;
  token: string;
}

let infoPromise: Promise<WsInfo> | null = null;

export function getWsInfo(): Promise<WsInfo> {
  // Standalone window: same backend it was served from; token redeemed at start-up.
  if (standalone) {
    const token = sessionToken();
    if (token) return Promise.resolve({ port: Number(window.location.port) || 80, token });
  }
  infoPromise ??= api.get<WsInfo>("/ws-info").catch((e) => {
    infoPromise = null; // retry next time
    throw e;
  });
  return infoPromise;
}

/** Build an authenticated ws:// URL for a backend WebSocket path. */
export async function wsUrl(path: string, params: Record<string, string> = {}): Promise<string> {
  const info = await getWsInfo();
  const port = info.port;
  // Inside Rancher use the live token (it's re-read when the backend restarts); elsewhere the cached one.
  const token = dd ? await extensionToken() : info.token;
  const qs = new URLSearchParams({ ...params, token });
  return `ws://localhost:${port}${path}?${qs}`;
}
