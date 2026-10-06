import { useEffect, useState } from "react";

/** Minimal hash router: "#/containers/abc/logs" -> ["containers", "abc", "logs"]. */
export function parseHash(hash = window.location.hash): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
}

export function navigate(...segments: string[]) {
  window.location.hash = "/" + segments.map(encodeURIComponent).join("/");
}

export function href(...segments: string[]) {
  return "#/" + segments.map(encodeURIComponent).join("/");
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
