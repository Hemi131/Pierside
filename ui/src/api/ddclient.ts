/**
 * Thin wrapper around ddClient. The UI runs in three places:
 *   - inside Rancher Desktop: requests go through ddClient's vm.service, carrying the session token.
 *     vm.service is NOT private (Rancher publishes its proxy port on all interfaces), so the token is
 *     obtained over a local-only channel instead: Rancher's local docker CLI reads it from the
 *     backend container (see backend/app/security.py);
 *   - the standalone window (served by the backend at http://localhost:<port>/app/): same-origin
 *     requests to the backend, carrying the session token redeemed from a one-time ticket;
 *   - the Vite dev server (`npm run dev`): requests to the backend's TCP port (dev origin allowed).
 *     Docker picks that port; `make.ps1 dev` passes it in as VITE_PIERSIDE_BACKEND.
 */
import { createDockerDesktopClient } from "@docker/extension-api-client";

export const DEV_BACKEND: string = import.meta.env.VITE_PIERSIDE_BACKEND || "http://localhost:47811";

type DD = ReturnType<typeof createDockerDesktopClient>;

function detectClient(): DD | null {
  // Rancher injects window.ddClient via its preload; createDockerDesktopClient just returns it.
  if (typeof window !== "undefined" && (window as unknown as { ddClient?: DD }).ddClient) {
    return createDockerDesktopClient();
  }
  return null;
}

export const dd = detectClient();
export const inExtension = dd !== null;
/** Running as the standalone window served by the backend (not embedded in Rancher). */
export const standalone = !inExtension && typeof window !== "undefined" && window.location.pathname.startsWith("/app");

// ---- standalone session token (per browser tab; never in the URL) ----
const TOKEN_KEY = "pierside:standaloneToken";
export function standaloneToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Standalone window start-up: exchange the one-time `?ticket=` from the URL for the session token,
 * keep it for this tab, and remove the ticket from the address bar. Returns whether a token exists.
 */
export async function initStandaloneSession(): Promise<boolean> {
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get("ticket");
  if (ticket) {
    url.searchParams.delete("ticket");
    window.history.replaceState(null, "", url.pathname + url.search + (url.hash || "#/containers"));
    const res = await fetch("/standalone/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (res.ok) {
      const { token } = (await res.json()) as { token: string };
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* storage unavailable: token lives only in memory below */
      }
      memoryToken = token;
    }
  }
  return !!(memoryToken ?? standaloneToken());
}
let memoryToken: string | null = null;
export const sessionToken = () => memoryToken ?? standaloneToken();

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** The backend's `detail` when it is structured, e.g. {message, portConflict}. */
    public detail?: unknown,
  ) {
    super(message);
  }
}

/** FastAPI `detail`: a string, a {message, ...} object, or a validation error list. */
function fromDetail(detail: unknown, status?: number): ApiError {
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "message" in detail) {
    return new ApiError(String((detail as { message: unknown }).message), status, detail);
  }
  if (Array.isArray(detail)) {
    return new ApiError(detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d))).join("; "), status, detail);
  }
  return new ApiError(String(detail), status);
}

function errorFromRejection(e: unknown): ApiError {
  // Rancher rejects with {statusCode, name, message} where message may be parsed JSON.
  if (e && typeof e === "object") {
    const r = e as { statusCode?: number; message?: unknown; name?: string };
    let m = r.message;
    // On rejection Rancher passes the raw body string (it only JSON-parses successful responses).
    if (typeof m === "string") {
      try {
        m = JSON.parse(m);
      } catch {
        /* plain text */
      }
    }
    if (m && typeof m === "object" && "detail" in m) return fromDetail((m as { detail: unknown }).detail, r.statusCode);
    return new ApiError((m ? String(m) : r.name) ?? "Request failed", r.statusCode);
  }
  return new ApiError(String(e));
}

async function devFetch<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = standalone ? sessionToken() : null;
  if (token) headers["X-Pierside-Token"] = token;
  const res = await fetch((standalone ? "" : DEV_BACKEND) + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    if (standalone && res.status === 403) {
      throw new ApiError("This window's session has expired (Pierside was restarted). Open it again from Pierside in Rancher Desktop.", 403);
    }
    if (data && typeof data === "object" && "detail" in data) throw fromDetail((data as { detail: unknown }).detail, res.status);
    throw new ApiError(text || res.statusText, res.status);
  }
  return data as T;
}

// ---- extension session token (read from the backend container via the local docker CLI) ----
export const BACKEND_LABEL = "com.pierside.backend=true";
const TOKEN_FILE = "/run/pierside-token";
let extTokenPromise: Promise<string> | null = null;

async function readExtensionToken(): Promise<string> {
  const client = dd!;
  const ps = await client.docker.cli.exec("ps", ["--filter", `label=${BACKEND_LABEL}`, "--format", "{{.ID}},{{.Image}}"]);
  const rows = ps.stdout.trim().split("\n").filter(Boolean).map((l) => l.trim().split(","));
  // Another Pierside install (e.g. a local build next to the published image) has its own backend
  // and token: pick the container running this extension's image.
  const own = client.extension.image;
  const id = (rows.find(([, image]) => image === own) ?? rows[0])?.[0];
  if (!id) throw new ApiError("Pierside's backend container isn't running");
  const res = await client.docker.cli.exec("exec", [id, "cat", TOKEN_FILE]);
  const token = res.stdout.trim();
  if (!token) throw new ApiError("Couldn't read Pierside's session token");
  return token;
}

/** Session token inside Rancher; `refresh` re-reads it (the backend generates a new one on restart). */
export function extensionToken(refresh = false): Promise<string> {
  if (refresh || !extTokenPromise) {
    extTokenPromise = readExtensionToken().catch((e) => {
      extTokenPromise = null;
      throw e instanceof ApiError ? e : new ApiError(String((e as { stderr?: string })?.stderr || (e as Error)?.message || e));
    });
  }
  return extTokenPromise;
}

async function extRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  for (const refresh of [false, true]) {
    const token = await extensionToken(refresh);
    const headers: Record<string, string> = { "X-Pierside-Token": token };
    let data: string | undefined;
    if (method === "POST" || body !== undefined) {
      headers["Content-Type"] = "application/json";
      data = JSON.stringify(body ?? {});
    }
    try {
      return (await dd!.extension.vm!.service!.request({ method, url, headers, data })) as T;
    } catch (e) {
      const err = errorFromRejection(e);
      if (err.status === 403 && !refresh) continue; // token rotated (backend restarted): re-read once
      throw err;
    }
  }
  throw new ApiError("Request failed");
}

export const api = {
  get<T>(url: string): Promise<T> {
    return dd ? extRequest<T>("GET", url) : devFetch<T>("GET", url);
  },
  post<T>(url: string, body?: unknown): Promise<T> {
    return dd ? extRequest<T>("POST", url, body) : devFetch<T>("POST", url, body);
  },
  put<T>(url: string, body: unknown): Promise<T> {
    return dd ? extRequest<T>("PUT", url, body) : devFetch<T>("PUT", url, body);
  },
  patch<T>(url: string, body: unknown): Promise<T> {
    return dd ? extRequest<T>("PATCH", url, body) : devFetch<T>("PATCH", url, body);
  },
  del<T>(url: string): Promise<T> {
    return dd ? extRequest<T>("DELETE", url) : devFetch<T>("DELETE", url);
  },
};

export function openExternal(url: string) {
  if (dd) dd.host.openExternal(url);
  else window.open(url, "_blank", "noopener");
}
