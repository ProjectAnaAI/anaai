"use client";

import {
  useEffect,
  useMemo,
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

type CustomerFilter =
  | "active"
  | "archived"
  | "all";

type CustomerAppointment = {
  id: string;
  customer_id: string | null;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
  notes: string | null;
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

function compareAppointmentsNewestFirst(
  first: CustomerAppointment,
  second: CustomerAppointment
) {
  const firstKey = `${first.appointment_date || ""}T${
    first.appointment_time || ""
  }`;

  const secondKey = `${second.appointment_date || ""}T${
    second.appointment_time || ""
  }`;

  return secondKey.localeCompare(
    firstKey
  );
}

function formatAppointmentDate(
  value: string | null
) {
  if (!value) {
    return "Date unavailable";
  }

  const parts = value.split("-");

  if (parts.length !== 3) {
    return value;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return value;
  }

  const date = new Date(
    year,
    month - 1,
    day
  );

  if (
    Number.isNaN(date.getTime())
  ) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  ).format(date);
}

function formatAppointmentTime(
  value: string | null
) {
  if (!value) {
    return "Time unavailable";
  }

  const match = value.match(
    /^(\d{1,2}):(\d{2})/
  );

  if (!match) {
    return value;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return value;
  }

  const suffix =
    hours >= 12 ? "PM" : "AM";

  const displayHour =
    hours % 12 || 12;

  return `${displayHour}:${String(
    minutes
  ).padStart(2, "0")} ${suffix}`;
}

function statusClasses(
  status: string | null
) {
  switch (status) {
    case "Confirmed":
      return "bg-green-50 text-green-700";

    case "Booked":
      return "bg-blue-50 text-blue-700";

    case "Completed":
      return "bg-gray-100 text-gray-700";

    case "Cancelled":
      return "bg-red-50 text-red-700";

    default:
      return "bg-gray-100 text-gray-600";
  }
}

export default function CustomersPage() {
  const router = useRouter();

  const [
    customers,
    setCustomers,
  ] = useState<CustomerRecord[]>([]);

  const [
    appointments,
    setAppointments,
  ] = useState<
    CustomerAppointment[]
  >([]);

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

  const [
    searchQuery,
    setSearchQuery,
  ] = useState("");

  const [
    customerFilter,
    setCustomerFilter,
  ] =
    useState<CustomerFilter>(
      "active"
    );

  const [
    historyCustomerId,
    setHistoryCustomerId,
  ] = useState<string | null>(
    null
  );

  const saveInFlight =
    useRef(false);

  useEffect(() => {
    void initializePage();
  }, []);

  const activeCount = useMemo(
    () =>
      customers.filter(
        (customer) =>
          customer.is_active
      ).length,
    [customers]
  );

  const archivedCount = useMemo(
    () =>
      customers.filter(
        (customer) =>
          !customer.is_active
      ).length,
    [customers]
  );

  const appointmentMap =
    useMemo(() => {
      const map = new Map<
        string,
        CustomerAppointment[]
      >();

      for (const appointment of appointments) {
        if (
          !appointment.customer_id
        ) {
          continue;
        }

        const current =
          map.get(
            appointment.customer_id
          ) || [];

        current.push(appointment);

        map.set(
          appointment.customer_id,
          current
        );
      }

      for (const [
        customerId,
        history,
      ] of map) {
        map.set(
          customerId,
          [...history].sort(
            compareAppointmentsNewestFirst
          )
        );
      }

      return map;
    }, [appointments]);

  const visibleCustomers =
    useMemo(() => {
      const normalizedSearch =
        searchQuery
          .trim()
          .toLowerCase();

      return customers.filter(
        (customer) => {
          if (
            customerFilter ===
              "active" &&
            !customer.is_active
          ) {
            return false;
          }

          if (
            customerFilter ===
              "archived" &&
            customer.is_active
          ) {
            return false;
          }

          if (!normalizedSearch) {
            return true;
          }

          const searchable =
            [
              customer.full_name,
              customer.phone || "",
              customer.email || "",
            ]
              .join(" ")
              .toLowerCase();

          return searchable.includes(
            normalizedSearch
          );
        }
      );
    }, [
      customers,
      customerFilter,
      searchQuery,
    ]);

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

    await Promise.all([
      loadCustomers(
        context.businessId
      ),
      loadAppointments(
        context.businessId
      ),
    ]);

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

  async function loadAppointments(
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
        .from("appointments")
        .select(
          "id, customer_id, service, appointment_date, appointment_time, status, notes"
        )
        .eq(
          "business_id",
          activeBusinessId
        )
        .order(
          "appointment_date",
          {
            ascending: false,
          }
        )
        .order(
          "appointment_time",
          {
            ascending: false,
          }
        );

    if (error) {
      console.error(
        "Could not load customer appointment history:",
        error
      );

      setFeedback(
        "Customers loaded, but appointment history could not be loaded."
      );

      return;
    }

    setAppointments(
      ((data ||
        []) as CustomerAppointment[]).sort(
        compareAppointmentsNewestFirst
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

  function toggleHistory(
    customerId: string
  ) {
    setHistoryCustomerId(
      (current) =>
        current === customerId
          ? null
          : customerId
    );
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
            information and review
            appointment history.
          </p>
        </header>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm font-medium text-gray-500">
                Total customers
              </p>

              <p className="mt-2 text-3xl font-semibold text-gray-900">
                {customers.length}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <p className="text-sm font-medium text-gray-500">
                Active
              </p>

              <p className="mt-2 text-3xl font-semibold text-gray-900">
                {activeCount}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <p className="text-sm font-medium text-gray-500">
                Archived
              </p>

              <p className="mt-2 text-3xl font-semibold text-gray-900">
                {archivedCount}
              </p>
            </CardContent>
          </Card>
        </div>

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
              Search customers,
              review appointment
              history, or manage
              archived records.
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="w-full md:max-w-md">
              <Input
                type="search"
                aria-label="Search customers"
                placeholder="Search name, phone, or email"
                value={searchQuery}
                onChange={(event) =>
                  setSearchQuery(
                    event.target.value
                  )
                }
              />
            </div>

            <div
              className="flex flex-wrap gap-2"
              aria-label="Customer status filter"
            >
              <Button
                type="button"
                variant={
                  customerFilter ===
                  "active"
                    ? "default"
                    : "outline"
                }
                onClick={() =>
                  setCustomerFilter(
                    "active"
                  )
                }
              >
                Active ({activeCount})
              </Button>

              <Button
                type="button"
                variant={
                  customerFilter ===
                  "archived"
                    ? "default"
                    : "outline"
                }
                onClick={() =>
                  setCustomerFilter(
                    "archived"
                  )
                }
              >
                Archived (
                {archivedCount})
              </Button>

              <Button
                type="button"
                variant={
                  customerFilter ===
                  "all"
                    ? "default"
                    : "outline"
                }
                onClick={() =>
                  setCustomerFilter(
                    "all"
                  )
                }
              >
                All (
                {customers.length})
              </Button>
            </div>
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
          ) : visibleCustomers.length ===
            0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No matching customers
              </p>

              <p className="mt-2 text-sm text-gray-500">
                Try another search or
                customer status
                filter.
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {visibleCustomers.map(
                (customer) => {
                  const actionInProgress =
                    customerActionId ===
                    customer.id;

                  const history =
                    appointmentMap.get(
                      customer.id
                    ) || [];

                  const historyOpen =
                    historyCustomerId ===
                    customer.id;

                  const mostRecent =
                    history[0];

                  return (
                    <div
                      key={
                        customer.id
                      }
                      className="border-b border-gray-100 p-5 last:border-b-0"
                    >
                      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0 flex-1">
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

                            <p>
                              <span className="font-medium text-gray-900">
                                Appointments:
                              </span>{" "}
                              {
                                history.length
                              }
                            </p>

                            <p>
                              <span className="font-medium text-gray-900">
                                Most recent:
                              </span>{" "}
                              {mostRecent
                                ? `${formatAppointmentDate(
                                    mostRecent.appointment_date
                                  )} at ${formatAppointmentTime(
                                    mostRecent.appointment_time
                                  )}`
                                : "No appointments"}
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
                            type="button"
                            variant="outline"
                            onClick={() =>
                              toggleHistory(
                                customer.id
                              )
                            }
                          >
                            {historyOpen
                              ? "Hide history"
                              : "View history"}
                          </Button>

                          <Button
                            type="button"
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
                            type="button"
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

                      {historyOpen && (
                        <div className="mt-5 border-t border-gray-100 pt-5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-semibold text-gray-900">
                              Appointment
                              history
                            </h4>

                            <p className="text-sm text-gray-500">
                              {
                                history.length
                              }{" "}
                              {history.length ===
                              1
                                ? "appointment"
                                : "appointments"}
                            </p>
                          </div>

                          {history.length ===
                          0 ? (
                            <div className="mt-3 rounded-xl bg-gray-50 p-4">
                              <p className="text-sm text-gray-500">
                                No linked
                                appointments
                                for this
                                customer.
                              </p>
                            </div>
                          ) : (
                            <div className="mt-3 space-y-3">
                              {history.map(
                                (
                                  appointment
                                ) => (
                                  <div
                                    key={
                                      appointment.id
                                    }
                                    className="rounded-xl border border-gray-200 bg-gray-50 p-4"
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div>
                                        <p className="font-medium text-gray-900">
                                          {appointment.service ||
                                            "Service unavailable"}
                                        </p>

                                        <p className="mt-1 text-sm text-gray-600">
                                          {formatAppointmentDate(
                                            appointment.appointment_date
                                          )}{" "}
                                          at{" "}
                                          {formatAppointmentTime(
                                            appointment.appointment_time
                                          )}
                                        </p>
                                      </div>

                                      <span
                                        className={`w-fit rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(
                                          appointment.status
                                        )}`}
                                      >
                                        {appointment.status ||
                                          "Unknown"}
                                      </span>
                                    </div>

                                    {appointment.notes && (
                                      <p className="mt-3 whitespace-pre-wrap text-sm text-gray-500">
                                        {
                                          appointment.notes
                                        }
                                      </p>
                                    )}
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      )}
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