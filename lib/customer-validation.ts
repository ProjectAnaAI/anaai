import type { SupabaseClient } from "@supabase/supabase-js";

// Shared by the web CRM (lib/customer-mutations.ts) and the ZUDE API so both
// apply exactly the same customer rules.

export type CustomerInput = {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
};

export function normalizeCustomerPhone(value: string) {
  return value.replace(/[^0-9]/g, "");
}

export function validateCustomer(input: CustomerInput) {
  const full_name = input.name.trim();
  const phone = input.phone.trim();
  const email = input.email?.trim() || null;
  const digits = normalizeCustomerPhone(phone);

  if (!full_name || full_name.length > 200) {
    throw new Error(
      "Enter a customer name (up to 200 characters)."
    );
  }

  if (
    phone &&
    (!/^[+\d\s().-]+$/.test(phone) ||
      digits.length < 7 ||
      digits.length > 15)
  ) {
    throw new Error(
      "Enter a valid phone number with 7–15 digits."
    );
  }

  if (
    email &&
    (email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) {
    throw new Error("Enter a valid email address.");
  }

  return {
    full_name,
    phone: phone || null,
    email,
    notes: input.notes?.trim() || null,
  };
}

/*
 * Supabase caps result sets. Check every page rather than silently missing an
 * existing customer beyond the first page.
 *
 * Archived customers remain part of the CRM identity set, so they participate
 * in duplicate-phone detection too.
 */
export async function customerPhoneTaken(
  db: Pick<SupabaseClient, "from">,
  businessId: string,
  phoneKey: string,
  excludeId?: string
): Promise<"taken" | "available" | "error"> {
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("customers")
      .select("id, phone")
      .eq("business_id", businessId)
      .order("id")
      .range(offset, offset + pageSize - 1);

    if (error) {
      return "error";
    }

    if (
      (data || []).some(
        (customer: { id: string; phone: string | null }) =>
          customer.id !== excludeId &&
          normalizeCustomerPhone(customer.phone || "") === phoneKey
      )
    ) {
      return "taken";
    }

    if (!data || data.length < pageSize) {
      return "available";
    }
  }
}
