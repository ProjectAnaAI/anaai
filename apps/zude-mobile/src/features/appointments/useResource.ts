import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { safeMessage } from "./state";

export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const loader = useRef(load);
  useEffect(() => { loader.current = load; }, [load]);
  const [revision, setRevision] = useState(0);
  const identity = key === null ? null : `${key}:${revision}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setRevision((r) => r + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (identity === null) return;
    const controller = new AbortController();
    let cancelled = false;
    void loader.current(controller.signal).then((data) => {
      if (!cancelled) setResult({ key: identity, data });
    }).catch((error) => {
      if (!cancelled) setResult({ key: identity, error: safeMessage(error) });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [identity]);
  const current = result?.key === identity ? result : null;
  return { data: current?.data, error: current?.error,
    loading: identity !== null && !current, refresh: () => setRevision((r) => r + 1) };
}
