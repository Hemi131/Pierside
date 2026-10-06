import { DEV_BACKEND, dd, standalone } from "./api/ddclient";

// Posts uncaught errors to the backend so they can be read from the host with
// `curl -H "X-Pierside-Token: ..." http://127.0.0.1:<port>/diag` (Rancher gives no DevTools for
// extension views in packaged builds). POST /diag needs no token, so inside Rancher it goes through
// vm.service; elsewhere to the backend's TCP port.
export function report(kind: string, data: Record<string, unknown> = {}) {
  const body = { kind, at: new Date().toISOString(), href: location.href, ...data };
  if (dd) {
    const req = { method: "POST", url: "/diag", headers: { "Content-Type": "application/json" }, data: JSON.stringify(body) };
    Promise.resolve(dd.extension.vm?.service?.request(req)).catch(() => {});
    return;
  }
  fetch((standalone ? "" : DEV_BACKEND) + "/diag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

window.addEventListener("error", (e) => report("window.error", { message: e.message, source: e.filename, line: e.lineno, stack: e.error?.stack }));
window.addEventListener("unhandledrejection", (e) => report("unhandledrejection", { reason: String(e.reason?.stack ?? e.reason?.message ?? JSON.stringify(e.reason)) }));
report("boot", { hasDdClient: "ddClient" in window });
