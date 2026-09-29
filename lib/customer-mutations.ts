import { supabase } from "@/lib/supabase";
import { activeBusinessHeaders } from "@/lib/active-business";
import {
  customerPhoneTaken,
  normalizeCustomerPhone,
  validateCustomer,
  type CustomerInput,
} from "@/lib/customer-validation";

export type CustomerRecord = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_active: boolean;
};

export type { CustomerInput };
export { normalizeCustomerPhone, validateCustomer };

// Stops overlapping submissions in this browser context. Database uniqueness
// across independent sessions requires a separate schema decision.
const pending = new Set<string>();

export async function saveCustomer(
  businessId: string,
  input: CustomerInput,
  options: {
    id?: string;
  } = {}
): Promise<CustomerRecord> {
  const values = validateCustomer(input);
  const phoneKey = normalizeCustomerPhone(
    values.phone || ""
  );

  const key = `${businessId}:${
    options.id ||
    phoneKey ||
    values.full_name.toLowerCase()
  }`;

  function checkBusiness() {
    if (
      !businessId ||
      activeBusinessHeaders()[
        "x-anaai-business-id"
      ] !== businessId
    ) {
      throw new Error(
        "Business context changed. Please reload and try again."
      );
    }
  }

  checkBusiness();

  if (pending.has(key)) {
    throw new Error(
      "This customer is already being saved."
    );
  }

  pending.add(key);

  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      throw new Error(
        "Please log in again before saving a customer."
      );
    }

    if (phoneKey) {
      const phone = await customerPhoneTaken(
        supabase,
        businessId,
        phoneKey,
        options.id
      );

      if (phone === "error") {
        throw new Error(
          "Unable to check existing customers. Please try again."
        );
      }

      if (phone === "taken") {
        throw new Error(
          "A customer with this phone number already exists. Select or edit the existing customer."
        );
      }
    }

    checkBusiness();

    const query = options.id
      ? supabase
          .from("customers")
          .update(values)
          .eq("id", options.id)
          .eq(
            "business_id",
            businessId
          )
      : supabase
          .from("customers")
          .insert({
            ...values,
            business_id: businessId,
            user_id: user.id,
            is_active: true,
          });

    const { data, error } =
      await query
        .select(
          "id, full_name, phone, email, notes, is_active"
        )
        .single();

    if (error || !data) {
      throw new Error(
        "Unable to save the customer. Refresh the list before retrying."
      );
    }

    return data as CustomerRecord;
  } finally {
    pending.delete(key);
  }
}