import { ApiError, dd, extensionToken, fromDetail } from "./ddclient";
import { getWsInfo } from "./ws";

/** Fetch a binary endpoint straight from the backend's TCP port (vm.service can't carry binary) and save it. */
export async function downloadFromBackend(path: string, filename: string): Promise<void> {
  const info = await getWsInfo();
  const port = info.port;
  const token = dd ? await extensionToken() : info.token;
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`http://localhost:${port}${path}${sep}token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    // The same error as any other request (with the backend's structured detail, e.g. needsConsent),
    // so the file browser can react to it (ask, then retry).
    let detail: unknown = undefined;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* not json */
    }
    const err = detail !== undefined ? fromDetail(detail, res.status) : new ApiError(res.statusText || `HTTP ${res.status}`, res.status);
    err.message = `Download failed: ${err.message}`;
    throw err;
  }
  saveBlob(await res.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Upload a file's raw bytes to a backend endpoint on the TCP port (vm.service can't carry binary).
 * XHR rather than fetch for upload progress. Sent as text/plain so the browser treats it as a simple
 * request (no CORS preflight); the backend reads the body as bytes regardless.
 */
export async function uploadToBackend(path: string, file: Blob, onProgress?: (sent: number, total: number) => void): Promise<unknown> {
  const info = await getWsInfo();
  const token = dd ? await extensionToken() : info.token;
  const sep = path.includes("?") ? "&" : "?";
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `http://localhost:${info.port}${path}${sep}token=${encodeURIComponent(token)}`);
    xhr.setRequestHeader("Content-Type", "text/plain");
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      if (body && typeof body === "object" && "detail" in body) return reject(fromDetail((body as { detail: unknown }).detail, xhr.status));
      reject(new ApiError(xhr.statusText || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new Error("Upload failed: the backend isn't reachable"));
    xhr.send(file);
  });
}
