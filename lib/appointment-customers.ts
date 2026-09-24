import { normalizeCustomerPhone } from "@/lib/customer-mutations";

export type MatchableCustomer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
};

export function normalizeCustomerName(value: string) {
  return value.trim().toLowerCase();
}

export function findCustomerMatches<T extends MatchableCustomer>(
  customers: T[],
  name: string,
  phone: string
) {
  const activeCustomers = customers.filter((customer) => customer.is_active);

  const normalizedName = normalizeCustomerName(name);

  const normalizedPhone = normalizeCustomerPhone(phone);

  /*
   * Only active customers are eligible for a new
   * appointment selection.
   *
   * Phone takes precedence over names.
   * Never infer identity from a name alone.
   */
  if (phone.trim()) {
    if (!normalizedPhone) {
      return [];
    }

    const exactMatches = activeCustomers.filter(
      (customer) =>
        normalizeCustomerPhone(customer.phone || "") === normalizedPhone
    );

    if (exactMatches.length) {
      return exactMatches;
    }

    return activeCustomers.filter((customer) =>
      normalizeCustomerPhone(customer.phone || "").includes(normalizedPhone)
    );
  }

  if (!normalizedName) {
    return [];
  }

  return activeCustomers.filter((customer) =>
    normalizeCustomerName(customer.full_name).includes(normalizedName)
  );
}
