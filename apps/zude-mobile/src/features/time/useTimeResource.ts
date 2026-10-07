import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { ZudeApiError } from "../../lib/api";

// Loads authoritative time data. Unlike useResource it keeps the last good
// view while refreshing (no flash on a running clock), keeps the raw error so
// screens can show time-specific messages, and records when data arrived so a
// running display can advance from it.
export function useTimeResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const loader = useRef(load);
  useEffect(() => { loader.current = load; }, [load]);
  const [revision, setRevision] = useState(0);
  const identity = key === null ? null : `${key}:${revision}`;
  const [result, setResult] = useState<{ base: string; identity: string; data?: T; error?: unknown; at: number } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setRevision((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (identity === null || key === null) return;
    const controller = new AbortController();
    let cancelled = false;
    void loader.current(controller.signal).then((data) => {
      if (!cancelled) setResult({ base: key, identity, data, at: Date.now() });
    }, (error: unknown) => {
      if (cancelled || (error instanceof ZudeApiError && error.code === "CANCELLED")) return;
      setResult((previous) => previous?.base === key
        ? { ...previous, identity, error }
        : { base: key, identity, error, at: 0 });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [identity, key]);
  const same = !!key && result?.base === key;
  return {
    data: same ? result.data : undefined,
    error: same && result.identity === identity ? result.error : undefined,
    loading: identity !== null && result?.identity !== identity,
    fetchedAt: same ? result.at : 0,
    refresh: () => setRevision((value) => value + 1),
    // A mutation response is itself the server's authoritative view.
    replace: (data: T) => { if (identity !== null && key !== null) setResult({ base: key, identity, data, at: Date.now() }); },
  };
}
