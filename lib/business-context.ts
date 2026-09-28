import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type BusinessRole = "owner" | "manager" | "staff";

export type BusinessContext = {
  userId: string;
  businessId: string;
  businessName: string;
  timezone: string;
  role: BusinessRole;
};

export type BusinessContextFailure = {
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

export function isBusinessRole(role: string): role is BusinessRole {
  return role === "owner" || role === "manager" || role === "staff";
}

type ResolveBusinessContextResult =
  | {
      success: true;
      context: BusinessContext;
      db: SupabaseClient;
    }
  | BusinessContextFailure;

// Server-only identity boundary shared by existing mutations and new read APIs.
// Never accept a user ID or role supplied by a client.
export async function authenticateBusinessMemberships(accessToken: string): Promise<
  | {
      success: true;
      userId: string;
      memberships: { business_id: string; role: string }[];
      db: SupabaseClient;
    }
  | BusinessContextFailure
> {
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
    console.error("Business context authentication failed.");

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
    console.error("Business membership lookup failed.");

    return {
      success: false,
      status: 500,
      error: "Could not load business membership.",
      code: "DATABASE_ERROR",
    };
  }

  return { success: true, userId: user.id, memberships: memberships ?? [], db: supabase };
}

export async function resolveBusinessContext({
  accessToken,
  requestedBusinessId,
}: {
  accessToken: string;
  requestedBusinessId?: string | null;
}): Promise<ResolveBusinessContextResult> {
  const authenticated = await authenticateBusinessMemberships(accessToken);
  if (!authenticated.success) return authenticated;
  const { memberships, userId, db: supabase } = authenticated;

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
    console.error("Business lookup failed.");

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

  if (!isBusinessRole(role)) {
    return {
      success: false,
      status: 403,
      error: "Business membership role is invalid.",
      code: "BUSINESS_ACCESS_DENIED",
    };
  }

  return {
    success: true,
    db: supabase,
    context: {
      userId,
      businessId: business.id,
      businessName: business.name,
      timezone: business.timezone,
      role,
    },
  };
}
