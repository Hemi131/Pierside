import { useCallback, useState } from "react";
import { readPref, writePref } from "../api/prefs";

/** useState that remembers per-viewer UI preferences (browser storage, or the backend for the separate window). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref<T>(key) ?? initial);
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        writePref(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
