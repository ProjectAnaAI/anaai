// Shared HTTP conventions for authenticated domain reads. Mutation contracts stay unchanged.
export function bearerToken(request: Request): string | null {
  return request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

export function readJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function readFailure(status: number, code: string, error: string) {
  return readJson({ success: false, code, error }, status);
}

export function missingAuthentication() {
  return readFailure(401, "UNAUTHORIZED", "Missing authorization token.");
}

export function validLocalDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
