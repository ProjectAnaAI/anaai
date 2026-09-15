import { supabase } from "@/lib/supabase";
import { activeBusinessHeaders } from "@/lib/active-business";

export function normalizeCustomerPhone(value: string) {
  return value.replace(/[^0-9]/g, "");
}

export type CustomerInput = { name: string; phone: string; email?: string; notes?: string };

export function validateCustomer(input: CustomerInput) {
  const full_name = input.name.trim();
  const phone = input.phone.trim();
  const email = input.email?.trim() || null;
  const digits = normalizeCustomerPhone(phone);
  if (!full_name || full_name.length > 200) throw new Error("Enter a customer name (up to 200 characters).");
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15)) {
    throw new Error("Enter a valid phone number with 7–15 digits.");
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Enter a valid email address.");
  return { full_name, phone: phone || null, email, notes: input.notes?.trim() || null };
}

// Stops overlapping submissions in this browser context. Database uniqueness
// across independent sessions requires a separate schema decision.
const pending = new Set<string>();

export async function saveCustomer(businessId: string, input: CustomerInput, options: { id?: string } = {}) {
  const values = validateCustomer(input);
  const phoneKey = normalizeCustomerPhone(values.phone || "");
  const key = `${businessId}:${options.id || phoneKey || values.full_name.toLowerCase()}`;
  function checkBusiness() {
    if (!businessId || activeBusinessHeaders()["x-anaai-business-id"] !== businessId) {
      throw new Error("Business context changed. Please reload and try again.");
    }
  }
  checkBusiness();
  if (pending.has(key)) throw new Error("This customer is already being saved.");
  pending.add(key);
  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Please log in again before saving a customer.");
    if (phoneKey) {
      // Supabase caps result sets; check every page rather than silently missing
      // an existing customer beyond the default first page.
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase.from("customers").select("id, phone")
          .eq("business_id", businessId).order("id").range(offset, offset + pageSize - 1);
        if (error) throw new Error("Unable to check existing customers. Please try again.");
        if ((data || []).some(customer => customer.id !== options.id && normalizeCustomerPhone(customer.phone || "") === phoneKey)) {
          throw new Error("A customer with this phone number already exists. Select or edit the existing customer.");
        }
        if (!data || data.length < pageSize) break;
      }
    }
    checkBusiness();
    const query = options.id
      ? supabase.from("customers").update(values).eq("id", options.id).eq("business_id", businessId)
      : supabase.from("customers").insert({ ...values, business_id: businessId, user_id: user.id });
    const { data, error } = await query.select("id, full_name, phone, email, notes").single();
    if (error || !data) throw new Error("Unable to save the customer. Refresh the list before retrying.");
    return data as { id: string; full_name: string; phone: string | null; email: string | null; notes: string | null };
  } finally {
    pending.delete(key);
  }
}
