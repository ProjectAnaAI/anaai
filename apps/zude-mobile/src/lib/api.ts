import { supabase } from "./supabase";

export class ZudeApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ZudeApiError";
  }
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ZudeApiError(0, "CANCELLED", "Request cancelled.");
}

// Configuration is a public API origin, never a database connection string.
export function apiUrl(path: string) {
  try {
    const origin = new URL(process.env.EXPO_PUBLIC_ZUDE_API_URL || "");
    const development = typeof __DEV__ !== "undefined" && __DEV__;
    if ((origin.protocol !== "https:" && !(development && origin.protocol === "http:")) ||
        origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new Error();
    }
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith("/api/")) throw new Error();
    return url.toString();
  } catch {
    throw new ZudeApiError(0, "CONFIGURATION_ERROR", "ZUDE API configuration is unavailable.");
  }
}

// `headers` adds request headers (shared-device management authority); it is
// applied first, so it can never replace Authorization or the business header.
type Options = { businessId?: string; signal?: AbortSignal; expectedUserId?: string; headers?: Record<string, string> };
export function apiGet<T>(path: string, options: Options = {}): Promise<T> {
  return apiRequest<T>(path, options);
}
export function apiMutate<T>(body: Record<string, unknown>, options: Options & { method: "POST" | "PATCH"; requestKey: string }): Promise<T> {
  return apiRequest<T>("/api/appointments", { ...options, body });
}
// Customer/service records. Their write paths have no idempotency contract, so
// callers guard duplicate submits and never retry automatically.
export function apiWrite<T>(path: string, body: Record<string, unknown>, options: Options & { method: "POST" | "PATCH" }): Promise<T> {
  return apiRequest<T>(path, { ...options, body });
}
async function apiRequest<T>(path: string, options: Options & { method?: "POST" | "PATCH"; requestKey?: string; body?: Record<string, unknown> }): Promise<T> {
  checkCancelled(options.signal);
  const url = apiUrl(path);
  try {
    const { data, error } = await supabase.auth.getSession();
    checkCancelled(options.signal);
    const session = data.session;
    if (error || !session?.access_token) {
      throw new ZudeApiError(401, "UNAUTHORIZED", "Please sign in again.");
    }
    if (options.expectedUserId && session.user.id !== options.expectedUserId) {
      throw new ZudeApiError(401, "SESSION_CHANGED", "Your account session changed. Please sign in again.");
    }
    const response = await fetch(url, {
      method: options.method || "GET",
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers: {
        ...options.headers,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.requestKey ? { "Idempotency-Key": options.requestKey } : {}),
        Authorization: `Bearer ${session.access_token}`,
        ...(options.businessId ? { "x-anaai-business-id": options.businessId } : {}),
      },
      signal: options.signal,
      cache: "no-store",
      redirect: "error",
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ZudeApiError(response.status, "INVALID_RESPONSE", "Invalid response from ZUDE.");
    }
    checkCancelled(options.signal);
    const current = await supabase.auth.getSession();
    checkCancelled(options.signal);
    if (current.error || current.data.session?.user.id !== session.user.id) {
      throw new ZudeApiError(401, "SESSION_CHANGED", "Your account session changed. Please sign in again.");
    }
    if (!response.ok || payload?.success !== true) {
      const code = typeof payload?.code === "string" && /^[A-Z_]{1,64}$/.test(payload.code)
        ? payload.code : "REQUEST_FAILED";
      // Do not display arbitrary proxy/provider error bodies or log credentials.
      throw new ZudeApiError(response.status, code,
        response.status === 401 ? "Please sign in again." : "Unable to load ZUDE data. Please try again.");
    }
    return payload as T;
  } catch (error) {
    checkCancelled(options.signal);
    if (error instanceof ZudeApiError) throw error;
    throw new ZudeApiError(0, "NETWORK_ERROR", "Unable to reach ZUDE. Please try again.");
  }
}
