import { createClient } from "@supabase/supabase-js";

export type BusinessRole = "owner" | "manager" | "staff";

export type BusinessContext = {
  userId: string;
  businessId: string;
  businessName: string;
  timezone: string;
  role: BusinessRole;
};

type ResolveBusinessContextResult =
  | {
      success: true;
      context: BusinessContext;
    }
  | {
      success: false;
      status: number;
      error: string;
      code:
        | "CONFIGURATION_ERROR"
        | "UNAUTHORIZED"
        | "NO_BUSINESS_MEMBERSHIP"
        | "BUSINESS_SELECTION_REQUIRED"
        | "BUSINESS_ACCESS_DENIED"
        | "BUSINESS_NOT_FOUND"
        | "DATABASE_ERROR";
    };

export async function resolveBusinessContext({
  accessToken,
  requestedBusinessId,
}: {
  accessToken: string;
  requestedBusinessId?: string | null;
}): Promise<ResolveBusinessContextResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      success: false,
      status: 500,
      error: "Supabase configuration is missing.",
      code: "CONFIGURATION_ERROR",
    };
  }

  if (!accessToken.trim()) {
    return {
      success: false,
      status: 401,
      error: "Authentication token is missing.",
      code: "UNAUTHORIZED",
    };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(accessToken);

  if (userError || !user) {
    console.error("AnaAI business context authentication error:", userError);

    return {
      success: false,
      status: 401,
      error: "Unauthorized.",
      code: "UNAUTHORIZED",
    };
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", user.id);

  if (membershipError) {
    console.error("AnaAI business membership lookup error:", membershipError);

    return {
      success: false,
      status: 500,
      error: "Could not load business membership.",
      code: "DATABASE_ERROR",
    };
  }

  if (!memberships || memberships.length === 0) {
    return {
      success: false,
      status: 403,
      error: "No business membership was found for this account.",
      code: "NO_BUSINESS_MEMBERSHIP",
    };
  }

  let selectedMembership:
    | {
        business_id: string;
        role: string;
      }
    | undefined;

  if (requestedBusinessId) {
    selectedMembership = memberships.find(
      (membership) => membership.business_id === requestedBusinessId
    );

    if (!selectedMembership) {
      return {
        success: false,
        status: 403,
        error: "You do not have access to this business.",
        code: "BUSINESS_ACCESS_DENIED",
      };
    }
  } else {
    if (memberships.length > 1) {
      return {
        success: false,
        status: 409,
        error: "A business must be selected.",
        code: "BUSINESS_SELECTION_REQUIRED",
      };
    }

    selectedMembership = memberships[0];
  }

  if (!selectedMembership) {
    return {
      success: false,
      status: 403,
      error: "No accessible business was found.",
      code: "NO_BUSINESS_MEMBERSHIP",
    };
  }

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, name, timezone")
    .eq("id", selectedMembership.business_id)
    .maybeSingle();

  if (businessError) {
    console.error("AnaAI business lookup error:", businessError);

    return {
      success: false,
      status: 500,
      error: "Could not load business.",
      code: "DATABASE_ERROR",
    };
  }

  if (!business) {
    return {
      success: false,
      status: 404,
      error: "Business not found.",
      code: "BUSINESS_NOT_FOUND",
    };
  }

  const role = selectedMembership.role;

  if (role !== "owner" && role !== "manager" && role !== "staff") {
    return {
      success: false,
      status: 403,
      error: "Business membership role is invalid.",
      code: "BUSINESS_ACCESS_DENIED",
    };
  }

  return {
    success: true,
    context: {
      userId: user.id,
      businessId: business.id,
      businessName: business.name,
      timezone: business.timezone,
      role,
    },
  };
}