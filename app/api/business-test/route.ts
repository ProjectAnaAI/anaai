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

    const result = await resolveBusinessContext({
      accessToken,
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
      membershipCount: 1,
      businessCount: 1,
      memberships: [
        {
          business_id: result.context.businessId,
          role: result.context.role,
        },
      ],
      businesses: [
        {
          id: result.context.businessId,
          name: result.context.businessName,
          timezone: result.context.timezone,
        },
      ],
    });
  } catch (error: unknown) {
    console.error("AnaAI business test error:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Unexpected business test error.",
      },
      { status: 500 }
    );
  }
}