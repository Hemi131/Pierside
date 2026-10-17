export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || n < 0 || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatPercent(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "N/A";
  return `${v.toFixed(2)}%`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(date: string | number | Date | null | undefined, now = Date.now()): string {
  if (date == null) return "—";
  const t = typeof date === "number" ? (date < 1e12 ? date * 1000 : date) : new Date(date).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), "month");
  return rtf.format(Math.round(s / (86400 * 365)), "year");
}

export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts where the async clipboard API is blocked.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** A host for a URL: an IPv6 address goes in brackets (http://[::1]:8080). */
export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
