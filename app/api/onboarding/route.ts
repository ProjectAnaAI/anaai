import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { validateOnboarding } from "@/lib/onboarding";

export async function POST(request: Request) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];

  if (!token) {
    return NextResponse.json(
      { error: "Please log in again." },
      { status: 401 }
    );
  }

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw Error("configuration");
    }

    const db = createClient(url, key, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await db.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json(
        { error: "Please log in again." },
        { status: 401 }
      );
    }

    let draft;

    try {
      draft = validateOnboarding(await request.json());
    } catch {
      return NextResponse.json(
        {
          error:
            "Check your business details, timezone, hours, capacity, services and greeting.",
        },
        { status: 400 }
      );
    }

    // No user or business identifier is accepted from the browser.
    const { data, error } = await db.rpc(
      "create_business_for_current_user",
      {
        p_setup: {
          name: draft.name,
          phone: draft.phone,
          email: draft.email,
          address: draft.address,
          timezone: draft.timezone,
          appointment_capacity: draft.appointment_capacity,
          hours: draft.hours,
          services: draft.services.map(({ name, duration, price, description }) => ({
            name,
            duration,
            price,
            description,
          })),
          receptionist: draft.receptionist,
          greeting: draft.greeting,
        },
      }
    );

    if (!error && data?.success === true) {
      return NextResponse.json({ success: true });
    }

    if (!error && data?.code === "ALREADY_PROVISIONED") {
      return NextResponse.json(
        {
          error:
            "This account already has a business. Continue to your dashboard.",
          code: "ALREADY_PROVISIONED",
        },
        { status: 409 }
      );
    }

    if (!error && data?.code === "INVALID_SETUP") {
      return NextResponse.json(
        {
          error: "Check the setup details and try again.",
        },
        { status: 400 }
      );
    }

    console.error("Business provisioning failed.");

    return NextResponse.json(
      {
        error:
          "Unable to finish setup. Your details are saved in this tab; retry or return to the dashboard.",
      },
      { status: 500 }
    );
  } catch {
    return NextResponse.json(
      {
        error: "Unable to finish setup. Please try again.",
      },
      { status: 500 }
    );
  }
}
