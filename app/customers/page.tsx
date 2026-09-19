"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import AppLayout from "@/components/layout/AppLayout";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
import {
  saveCustomer,
  type CustomerRecord,
} from "@/lib/customer-mutations";
import { supabase } from "@/lib/supabase";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type CurrentBusinessResponse = {
  success: boolean;
  error?: string;
  business?: {
    id: string;
    name: string;
    timezone: string;
    role:
      | "owner"
      | "manager"
      | "staff";
  };
};

function sortCustomers(
  customers: CustomerRecord[]
) {
  return [...customers].sort(
    (first, second) => {
      if (
        first.is_active !==
        second.is_active
      ) {
        return first.is_active
          ? -1
          : 1;
      }

      return first.full_name.localeCompare(
        second.full_name
      );
    }
  );
}

export default function CustomersPage() {
  const router = useRouter();

  const [
    customers,
    setCustomers,
  ] = useState<CustomerRecord[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    businessId,
    setBusinessId,
  ] = useState<string | null>(null);

  const [
    userId,
    setUserId,
  ] = useState<string | null>(null);

  const [
    fullName,
    setFullName,
  ] = useState("");

  const [
    phone,
    setPhone,
  ] = useState("");

  const [
    email,
    setEmail,
  ] = useState("");

  const [
    notes,
    setNotes,
  ] = useState("");

  const [
    editingId,
    setEditingId,
  ] = useState<string | null>(null);

  const [
    feedback,
    setFeedback,
  ] = useState("");

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    customerActionId,
    setCustomerActionId,
  ] = useState<string | null>(null);

  const saveInFlight =
    useRef(false);

  useEffect(() => {
    void initializePage();
  }, []);

  async function getAuthenticatedContext() {
    const {
      data: { session },
      error: sessionError,
    } =
      await supabase.auth.getSession();

    if (
      sessionError ||
      !session?.access_token ||
      !session.user
    ) {
      return null;
    }

    const response = await fetch(
      "/api/current-business",
      {
        method: "GET",
        headers: {
          ...activeBusinessHeaders(),
          Authorization:
            `Bearer ${session.access_token}`,
        },
      }
    );

    const data =
      (await response.json()) as CurrentBusinessResponse;

    if (
      !response.ok ||
      !data.success ||
      !data.business
    ) {
      console.error(
        "Could not resolve current business:",
        data.error
      );

      return null;
    }

    return {
      userId: session.user.id,
      businessId:
        data.business.id,
    };
  }

  async function initializePage() {
    setLoading(true);

    const context =
      await getAuthenticatedContext();

    if (!context) {
      router.push("/login");
      return;
    }

    setUserId(context.userId);
    setBusinessId(
      context.businessId
    );

    await loadCustomers(
      context.businessId
    );

    setLoading(false);
  }

  async function loadCustomers(
    selectedBusinessId?: string
  ) {
    const activeBusinessId =
      selectedBusinessId ??
      businessId;

    if (!activeBusinessId) {
      return;
    }

    const { data, error } =
      await supabase
        .from("customers")
        .select(
          "id, full_name, phone, email, notes, is_active"
        )
        .eq(
          "business_id",
          activeBusinessId
        )
        .order("is_active", {
          ascending: false,
        })
        .order("full_name", {
          ascending: true,
        });

    if (error) {
      console.error(
        "Could not load customers:",
        error
      );

      setFeedback(
        "Unable to load customers."
      );

      return;
    }

    setCustomers(
      sortCustomers(
        (data ||
          []) as CustomerRecord[]
      )
    );
  }

  function resetEditor() {
    setEditingId(null);
    setFullName("");
    setPhone("");
    setEmail("");
    setNotes("");
  }

  async function handleSubmit(
    event:
      React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!businessId || !userId) {
      setFeedback(
        "Business context is not available."
      );

      return;
    }

    if (saveInFlight.current) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setFeedback("");

    try {
      const customer =
        await saveCustomer(
          businessId,
          {
            name: fullName,
            phone,
            email,
            notes,
          },
          {
            id:
              editingId ||
              undefined,
          }
        );

      setCustomers(
        (current) =>
          sortCustomers([
            customer,
            ...current.filter(
              (item) =>
                item.id !==
                customer.id
            ),
          ])
      );

      setFeedback(
        editingId
          ? "Customer updated."
          : "Customer created."
      );

      resetEditor();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Unable to save customer."
      );
    } finally {
      saveInFlight.current =
        false;

      setSaving(false);
    }
  }

  function editCustomer(
    customer: CustomerRecord
  ) {
    if (
      saveInFlight.current ||
      customerActionId
    ) {
      return;
    }

    setEditingId(customer.id);
    setFullName(
      customer.full_name
    );
    setPhone(
      customer.phone || ""
    );
    setEmail(
      customer.email || ""
    );
    setNotes(
      customer.notes || ""
    );
    setFeedback("");

    document
      .getElementById(
        "customer-editor"
      )
      ?.scrollIntoView({
        behavior: "smooth",
      });
  }

  function cancelEdit() {
    if (saveInFlight.current) {
      return;
    }

    resetEditor();
    setFeedback("");
  }

  async function toggleCustomerActive(
    customer: CustomerRecord
  ) {
    if (
      !businessId ||
      customerActionId ||
      saveInFlight.current
    ) {
      return;
    }

    const nextActive =
      !customer.is_active;

    const confirmed =
      window.confirm(
        nextActive
          ? `Reactivate ${customer.full_name}?`
          : `Archive ${customer.full_name}? Their appointment history will be preserved.`
      );

    if (!confirmed) {
      return;
    }

    setCustomerActionId(
      customer.id
    );
    setFeedback("");

    try {
      if (
        activeBusinessHeaders()[
          "x-anaai-business-id"
        ] !== businessId
      ) {
        throw new Error(
          "Business context changed. Please reload and try again."
        );
      }

      const { data, error } =
        await supabase
          .from("customers")
          .update({
            is_active:
              nextActive,
          })
          .eq(
            "id",
            customer.id
          )
          .eq(
            "business_id",
            businessId
          )
          .select(
            "id, full_name, phone, email, notes, is_active"
          )
          .single();

      if (error || !data) {
        throw new Error(
          "Unable to update customer status."
        );
      }

      const updatedCustomer =
        data as CustomerRecord;

      setCustomers(
        (current) =>
          sortCustomers(
            current.map(
              (item) =>
                item.id ===
                updatedCustomer.id
                  ? updatedCustomer
                  : item
            )
          )
      );

      if (
        editingId ===
          customer.id &&
        !nextActive
      ) {
        resetEditor();
      }

      setFeedback(
        nextActive
          ? "Customer reactivated."
          : "Customer archived. Appointment history was preserved."
      );
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Unable to update customer status."
      );
    } finally {
      setCustomerActionId(
        null
      );
    }
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            CRM
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Customers
          </h1>

          <p className="mt-2 text-gray-500">
            Manage customer
            information while
            preserving appointment
            history.
          </p>
        </header>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>
              {editingId
                ? "Edit customer"
                : "New customer"}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <form
              id="customer-editor"
              onSubmit={
                handleSubmit
              }
            >
              <fieldset
                disabled={saving}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    placeholder="Full name"
                    value={
                      fullName
                    }
                    onChange={(
                      event
                    ) =>
                      setFullName(
                        event.target
                          .value
                      )
                    }
                    required
                  />

                  <Input
                    type="tel"
                    placeholder="Phone number"
                    value={phone}
                    onChange={(
                      event
                    ) =>
                      setPhone(
                        event.target
                          .value
                      )
                    }
                  />

                  <Input
                    type="email"
                    placeholder="Email address"
                    value={email}
                    onChange={(
                      event
                    ) =>
                      setEmail(
                        event.target
                          .value
                      )
                    }
                  />
                </div>

                <Textarea
                  className="mt-4"
                  placeholder="Customer notes"
                  value={notes}
                  onChange={(
                    event
                  ) =>
                    setNotes(
                      event.target
                        .value
                    )
                  }
                />

                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={
                      saving ||
                      Boolean(
                        customerActionId
                      ) ||
                      !businessId ||
                      !userId
                    }
                  >
                    {saving
                      ? "Saving..."
                      : editingId
                        ? "Save changes"
                        : "Save customer"}
                  </Button>

                  {editingId && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        saving ||
                        Boolean(
                          customerActionId
                        )
                      }
                      onClick={
                        cancelEdit
                      }
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </fieldset>

              {feedback && (
                <p
                  role="status"
                  className="mt-3 text-sm text-gray-600"
                >
                  {feedback}
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        <section className="mt-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
              Customer list
            </h2>

            <p className="mt-1 text-sm text-gray-500">
              Archived customers
              remain available for
              historical records and
              can be reactivated.
            </p>
          </div>

          {loading ? (
            <p className="mt-4 text-gray-500">
              Loading customers...
            </p>
          ) : customers.length ===
            0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No customers yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                New customers will
                appear here once they
                are created.
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {customers.map(
                (customer) => {
                  const actionInProgress =
                    customerActionId ===
                    customer.id;

                  return (
                    <div
                      key={
                        customer.id
                      }
                      className="border-b border-gray-100 p-5 last:border-b-0"
                    >
                      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-3">
                            <h3 className="text-lg font-semibold text-gray-900">
                              {
                                customer.full_name
                              }
                            </h3>

                            <span
                              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                                customer.is_active
                                  ? "bg-green-50 text-green-700"
                                  : "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {customer.is_active
                                ? "Active"
                                : "Archived"}
                            </span>
                          </div>

                          <div className="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-2">
                            <p>
                              <span className="font-medium text-gray-900">
                                Phone:
                              </span>{" "}
                              {customer.phone ||
                                "Not provided"}
                            </p>

                            <p>
                              <span className="font-medium text-gray-900">
                                Email:
                              </span>{" "}
                              {customer.email ||
                                "Not provided"}
                            </p>
                          </div>

                          {customer.notes && (
                            <p className="mt-3 whitespace-pre-wrap text-sm text-gray-500">
                              {
                                customer.notes
                              }
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={
                              saving ||
                              Boolean(
                                customerActionId
                              )
                            }
                            onClick={() =>
                              editCustomer(
                                customer
                              )
                            }
                          >
                            Edit
                          </Button>

                          <Button
                            variant="outline"
                            disabled={
                              saving ||
                              Boolean(
                                customerActionId
                              )
                            }
                            onClick={() =>
                              void toggleCustomerActive(
                                customer
                              )
                            }
                          >
                            {actionInProgress
                              ? "Updating..."
                              : customer.is_active
                                ? "Archive"
                                : "Reactivate"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                }
              )}
            </Card>
          )}
        </section>
      </div>
    </AppLayout>
  );
}