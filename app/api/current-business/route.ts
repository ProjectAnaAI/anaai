import { NextResponse } from "next/server";
import { resolveBusinessContext } from "@/lib/business-context";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing authorization token.",
        },
        { status: 401 }
      );
    }

    const accessToken = authorization.slice("Bearer ".length).trim();

    if (!accessToken) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing authorization token.",
        },
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
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          code: result.code,
        },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      business: {
        id: result.context.businessId,
        name: result.context.businessName,
        timezone: result.context.timezone,
        role: result.context.role,
      },
    });
  } catch (error: unknown) {
    console.error("AnaAI current business error:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Unexpected current business error.",
      },
      { status: 500 }
    );
  }
}