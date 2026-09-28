import { resolveBusinessContext } from "@/lib/business-context";
import { bearerToken } from "../read-api";

export async function GET(request: Request) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) {
      return Response.json(
        { success: false, error: "Missing authorization token." },
        { status: 401 }
      );
    }

    const requestedBusinessId =
      request.headers.get("x-anaai-business-id")?.trim() || null;

    const result = await resolveBusinessContext({
      accessToken,
      requestedBusinessId,
    });

    if (!result.success) {
      return Response.json(
        {
          success: false,
          error: result.error,
          code: result.code,
        },
        { status: result.status }
      );
    }

    return Response.json({
      success: true,
      business: {
        id: result.context.businessId,
        name: result.context.businessName,
        timezone: result.context.timezone,
        role: result.context.role,
      },
    });
  } catch {
    console.error("Current business request failed.");

    return Response.json(
      {
        success: false,
        error: "Unexpected current business error.",
      },
      { status: 500 }
    );
  }
}