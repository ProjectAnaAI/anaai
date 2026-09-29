import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBusinessContext, type BusinessContext } from "@/lib/business-context";
import { bearerToken, missingAuthentication, readFailure } from "./read-api";

// Verified member identity for CRM/catalog routes. The business comes only from
// the caller's memberships (the header is a selection, never authorization) and
// every query runs on the member's JWT client so Supabase RLS still applies.
export async function authorizedMember(request: Request): Promise<
  | { ok: true; db: SupabaseClient; context: BusinessContext }
  | { ok: false; response: Response }
> {
  const token = bearerToken(request);
  if (!token) return { ok: false, response: missingAuthentication() };
  const resolved = await resolveBusinessContext({
    accessToken: token,
    requestedBusinessId: request.headers.get("x-anaai-business-id")?.trim() || null,
  });
  if (!resolved.success) return { ok: false, response: readFailure(resolved.status, resolved.code, resolved.error) };
  return { ok: true, db: resolved.db, context: resolved.context };
}

export function canManageCatalog(context: BusinessContext) {
  return context.role === "owner" || context.role === "manager";
}

// The last path segment of /api/<resource>/:id. Identifiers are validated by the caller.
export function pathId(request: Request) {
  try {
    return decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

// Strict JSON object body with an explicit field allow-list. Unknown fields,
// including business_id/user_id, are rejected rather than ignored.
export async function jsonBody(request: Request, allowed: readonly string[]) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
  return body as Record<string, unknown>;
}

export function optionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export async function readAllPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await page(offset, offset + 499);
    if (error) throw new Error("Read failed.");
    rows.push(...(data ?? []));
    if (!data || data.length < 500) return rows;
  }
}
