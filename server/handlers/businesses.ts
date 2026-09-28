import { authenticateBusinessMemberships } from "@/lib/business-context";
import { bearerToken, missingAuthentication, readFailure, readJson } from "../read-api";
import { listMemberBusinesses } from "../repositories/today";

export async function GET(request: Request) {
  const token = bearerToken(request);
  if (!token) return missingAuthentication();
  try {
    const identity = await authenticateBusinessMemberships(token);
    if (!identity.success) return readFailure(identity.status, identity.code, identity.error);
    if (new URL(request.url).searchParams.size) {
      return readFailure(400, "INVALID_REQUEST", "Business listing does not accept query parameters.");
    }
    const businesses = await listMemberBusinesses(identity.db, identity.memberships);
    return readJson({ success: true, userId: identity.userId, businesses });
  } catch {
    return readFailure(500, "DATABASE_ERROR", "Unable to load businesses.");
  }
}
