import { resolveBusinessContext } from "@/lib/business-context";
import { bearerToken, missingAuthentication, readFailure, readJson, validLocalDate } from "../read-api";
import { listTodayAppointments } from "../repositories/today";

export async function GET(request: Request) {
  const token = bearerToken(request);
  if (!token) return missingAuthentication();
  try {
    const result = await resolveBusinessContext({
      accessToken: token,
      requestedBusinessId: request.headers.get("x-anaai-business-id")?.trim() || null,
    });
    if (!result.success) return readFailure(result.status, result.code, result.error);
    const params = new URL(request.url).searchParams;
    const date = params.get("date");
    if (params.size !== 1 || !validLocalDate(date)) {
      return readFailure(400, "INVALID_REQUEST", "A single valid date (YYYY-MM-DD) is required.");
    }
    const appointments = await listTodayAppointments(result.db, result.context, date);
    return readJson({ success: true, businessId: result.context.businessId, date, appointments });
  } catch {
    return readFailure(500, "DATABASE_ERROR", "Unable to load appointments.");
  }
}
