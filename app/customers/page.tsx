"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Mail,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  UserCheck,
  Users,
  X,
} from "lucide-react";

import { DialogSurface } from "@/components/ui/dialog-surface";
import { PageHeader } from "@/components/ui/page-header";
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
  const firstKey = `${
    first.appointment_date || ""
  }T${first.appointment_time || ""}`;

  const secondKey = `${
    second.appointment_date || ""
  }T${second.appointment_time || ""}`;

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
      return "border-green-200 bg-green-50 text-green-700";

    case "Booked":
      return "border-blue-200 bg-blue-50 text-blue-700";

    case "Completed":
      return "border-gray-200 bg-gray-100 text-gray-700";

    case "Cancelled":
      return "border-red-200 bg-red-50 text-red-700";

    default:
      return "border-gray-200 bg-gray-100 text-gray-600";
  }
}

function initials(
  name: string
) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(
      (part) =>
        part.charAt(0).toUpperCase()
    )
    .join("");
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

  const [
    editorOpen,
    setEditorOpen,
  ] = useState(false);

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

      for (
        const appointment
        of appointments
      ) {
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

  function openNewCustomer() {
    if (
      saveInFlight.current ||
      customerActionId
    ) {
      return;
    }

    resetEditor();
    setFeedback("");
    setEditorOpen(true);
  }

  function closeEditor() {
    if (saveInFlight.current) {
      return;
    }

    resetEditor();
    setFeedback("");
    setEditorOpen(false);
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
      setEditorOpen(false);
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
    setEditorOpen(true);
  }

  function cancelEdit() {
    closeEditor();
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
        setEditorOpen(false);
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
      <div className="space-y-6" data-page="customers">
        <PageHeader
          eyebrow="People & relationships"
          title={<>Customers</>}
          description={<>Manage customer information and review appointment history.</>}
        >
          <Button
            type="button"
            onClick={openNewCustomer}
            disabled={saving || Boolean(customerActionId)}
            className="shrink-0 gap-2"
          >
            <Plus className="size-4" />
            Add customer
          </Button>
        </PageHeader>

        {feedback &&
          !editorOpen && (
            <div
              role="status"
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm"
            >
              {feedback}
            </div>
          )}

        <div className="record-summary">
          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Total customers
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {customers.length}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                <Users className="size-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Active customers
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {activeCount}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <UserCheck className="size-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Archived
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {archivedCount}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
                <Archive className="size-5" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden border-gray-200 shadow-none">
          <CardContent className="p-0">
            <div className="border-b border-gray-200 p-4 sm:p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative w-full lg:max-w-md">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <Input
                    type="search"
                    aria-label="Search customers"
                    placeholder="Search name, phone, or email"
                    value={
                      searchQuery
                    }
                    onChange={(
                      event
                    ) =>
                      setSearchQuery(
                        event.target
                          .value
                      )
                    }
                    className="pl-10"
                  />
                </div>

                <div
                  className="grid grid-cols-3 rounded-xl border border-gray-200 bg-gray-50 p-1 sm:flex"
                  aria-label="Customer status filter"
                >
                  <button
                    type="button"
                    aria-pressed={
                      customerFilter ===
                      "active"
                    }
                    onClick={() =>
                      setCustomerFilter(
                        "active"
                      )
                    }
                    className={`min-h-11 rounded-lg px-3 text-sm font-medium transition ${
                      customerFilter ===
                      "active"
                        ? "bg-white text-gray-950 shadow-sm"
                        : "text-gray-500 hover:text-gray-900"
                    }`}
                  >
                    Active{" "}
                    <span className="text-gray-400">
                      {activeCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    aria-pressed={
                      customerFilter ===
                      "archived"
                    }
                    onClick={() =>
                      setCustomerFilter(
                        "archived"
                      )
                    }
                    className={`min-h-11 rounded-lg px-3 text-sm font-medium transition ${
                      customerFilter ===
                      "archived"
                        ? "bg-white text-gray-950 shadow-sm"
                        : "text-gray-500 hover:text-gray-900"
                    }`}
                  >
                    Archived{" "}
                    <span className="text-gray-400">
                      {archivedCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    aria-pressed={
                      customerFilter ===
                      "all"
                    }
                    onClick={() =>
                      setCustomerFilter(
                        "all"
                      )
                    }
                    className={`min-h-11 rounded-lg px-3 text-sm font-medium transition ${
                      customerFilter ===
                      "all"
                        ? "bg-white text-gray-950 shadow-sm"
                        : "text-gray-500 hover:text-gray-900"
                    }`}
                  >
                    All{" "}
                    <span className="text-gray-400">
                      {
                        customers.length
                      }
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {loading ? (
              <div className="p-8 text-center">
                <p className="text-sm text-gray-500">
                  Loading customers...
                </p>
              </div>
            ) : customers.length ===
              0 ? (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <Users className="size-5" />
                </div>

                <p className="mt-4 font-semibold text-gray-950">
                  No customers yet
                </p>

                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                  Customer records will
                  appear here when they
                  are created.
                </p>

                <Button
                  type="button"
                  onClick={
                    openNewCustomer
                  }
                  className="mt-5 gap-2"
                >
                  <Plus className="size-4" />
                  Add customer
                </Button>
              </div>
            ) : visibleCustomers.length ===
              0 ? (
              <div className="px-6 py-14 text-center">
                <Search className="mx-auto size-6 text-gray-400" />

                <p className="mt-4 font-semibold text-gray-950">
                  No matching customers
                </p>

                <p className="mt-1 text-sm text-gray-500">
                  Try another search or
                  status filter.
                </p>
              </div>
            ) : (
              <>
                <div className="hidden min-w-0 md:block">
                  <div className="grid customer-row customer-row-heading gap-4 border-b border-gray-200 bg-gray-50/70 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <span>
                      Customer
                    </span>
                    <span>
                      Phone
                    </span>
                    <span>
                      Email
                    </span>
                    <span>
                      Visits
                    </span>
                    <span>
                      Last appointment
                    </span>
                    <span className="sr-only">
                      Actions
                    </span>
                  </div>

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
                          className="border-b border-gray-100 last:border-b-0"
                        >
                          <div className="grid min-h-[76px] customer-row items-center gap-4 px-5 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-50 text-xs font-semibold text-green-700">
                                {initials(
                                  customer.full_name
                                ) ||
                                  "C"}
                              </div>

                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() =>
                                    toggleHistory(
                                      customer.id
                                    )
                                  }
                                  className="block max-w-full truncate text-left text-sm font-semibold text-gray-950 hover:text-green-700"
                                >
                                  {
                                    customer.full_name
                                  }
                                </button>

                                <div className="mt-1 flex items-center gap-2">
                                  <span
                                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
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
                              </div>
                            </div>

                            <p className="truncate text-sm text-gray-600">
                              {customer.phone ||
                                "Not provided"}
                            </p>

                            <p className="truncate text-sm text-gray-600">
                              {customer.email ||
                                "Not provided"}
                            </p>

                            <p className="text-sm font-medium text-gray-700">
                              {
                                history.length
                              }
                            </p>

                            <div className="min-w-0">
                              {mostRecent ? (
                                <>
                                  <p className="truncate text-sm font-medium text-gray-700">
                                    {formatAppointmentDate(
                                      mostRecent.appointment_date
                                    )}
                                  </p>

                                  <p className="mt-0.5 text-xs text-gray-500">
                                    {formatAppointmentTime(
                                      mostRecent.appointment_time
                                    )}
                                  </p>
                                </>
                              ) : (
                                <p className="text-sm text-gray-400">
                                  No appointments
                                </p>
                              )}
                            </div>

                            <button
                              type="button"
                              aria-label={`${
                                historyOpen
                                  ? "Hide"
                                  : "View"
                              } ${customer.full_name} details`}
                              aria-expanded={
                                historyOpen
                              }
                              onClick={() =>
                                toggleHistory(
                                  customer.id
                                )
                              }
                              className="flex size-11 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                            >
                              {historyOpen ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </button>
                          </div>

                          {historyOpen && (
                            <CustomerDetails
                              customer={
                                customer
                              }
                              history={
                                history
                              }
                              actionInProgress={
                                actionInProgress
                              }
                              saving={
                                saving
                              }
                              customerActionId={
                                customerActionId
                              }
                              onEdit={() =>
                                editCustomer(
                                  customer
                                )
                              }
                              onToggleActive={() =>
                                void toggleCustomerActive(
                                  customer
                                )
                              }
                            />
                          )}
                        </div>
                      );
                    }
                  )}
                </div>

                <div className="divide-y divide-gray-100 md:hidden">
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
                          className="p-4"
                        >
                          <button
                            type="button"
                            aria-expanded={
                              historyOpen
                            }
                            onClick={() =>
                              toggleHistory(
                                customer.id
                              )
                            }
                            className="flex min-h-11 w-full items-start gap-3 text-left"
                          >
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-green-50 text-xs font-semibold text-green-700">
                              {initials(
                                customer.full_name
                              ) ||
                                "C"}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate font-semibold text-gray-950">
                                    {
                                      customer.full_name
                                    }
                                  </p>

                                  <p className="mt-1 truncate text-sm text-gray-500">
                                    {customer.phone ||
                                      customer.email ||
                                      "No contact details"}
                                  </p>
                                </div>

                                {historyOpen ? (
                                  <ChevronDown className="mt-1 size-4 shrink-0 text-gray-400" />
                                ) : (
                                  <ChevronRight className="mt-1 size-4 shrink-0 text-gray-400" />
                                )}
                              </div>

                              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                <span
                                  className={`rounded-full px-2 py-1 font-medium ${
                                    customer.is_active
                                      ? "bg-green-50 text-green-700"
                                      : "bg-gray-100 text-gray-600"
                                  }`}
                                >
                                  {customer.is_active
                                    ? "Active"
                                    : "Archived"}
                                </span>

                                <span>
                                  {
                                    history.length
                                  }{" "}
                                  {history.length ===
                                  1
                                    ? "appointment"
                                    : "appointments"}
                                </span>

                                {mostRecent && (
                                  <span>
                                    Last{" "}
                                    {formatAppointmentDate(
                                      mostRecent.appointment_date
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>

                          {historyOpen && (
                            <div className="-mx-4 mt-4">
                              <CustomerDetails
                                customer={
                                  customer
                                }
                                history={
                                  history
                                }
                                actionInProgress={
                                  actionInProgress
                                }
                                saving={
                                  saving
                                }
                                customerActionId={
                                  customerActionId
                                }
                                onEdit={() =>
                                  editCustomer(
                                    customer
                                  )
                                }
                                onToggleActive={() =>
                                  void toggleCustomerActive(
                                    customer
                                  )
                                }
                              />
                            </div>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {editorOpen && (
        <DialogSurface
          aria-labelledby="customer-editor-title"
          onClose={() => {
            if (!saving) closeEditor();
          }}
        >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-5 sm:px-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
                  Customer record
                </p>

                <h2
                  id="customer-editor-title"
                  className="mt-1 text-xl font-semibold tracking-tight text-gray-950"
                >
                  {editingId
                    ? "Edit customer"
                    : "Add customer"}
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  {editingId
                    ? "Update customer contact information and notes."
                    : "Create a customer record for future appointments."}
                </p>
              </div>

              <button
                type="button"
                aria-label="Close customer editor"
                disabled={saving}
                onClick={
                  closeEditor
                }
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
              >
                <X className="size-5" />
              </button>
            </div>

            <form
              id="customer-editor"
              onSubmit={
                handleSubmit
              }
            >
              <fieldset
                disabled={saving}
                className="space-y-5 p-5 sm:p-6"
              >
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-gray-800">
                    Full name
                  </span>

                  <Input
                    placeholder="Customer name"
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
                    autoFocus
                  />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-gray-800">
                      Phone
                    </span>

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
                  </label>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-gray-800">
                      Email
                    </span>

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
                  </label>
                </div>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-gray-800">
                    Notes
                  </span>

                  <Textarea
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
                    className="min-h-28"
                  />
                </label>

                {feedback && (
                  <p
                    role="status"
                    className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700"
                  >
                    {feedback}
                  </p>
                )}
              </fieldset>

              <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-gray-200 bg-white px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
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
                    editingId
                      ? cancelEdit
                      : closeEditor
                  }
                >
                  Cancel
                </Button>

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
                      : "Add customer"}
                </Button>
              </div>
            </form>
        </DialogSurface>
      )}
    </AppLayout>
  );
}

function CustomerDetails({
  customer,
  history,
  actionInProgress,
  saving,
  customerActionId,
  onEdit,
  onToggleActive,
}: {
  customer: CustomerRecord;
  history: CustomerAppointment[];
  actionInProgress: boolean;
  saving: boolean;
  customerActionId: string | null;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-5">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Customer details
              </p>

              <h3 className="mt-1 font-semibold text-gray-950">
                {customer.full_name}
              </h3>
            </div>

            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                customer.is_active
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-200 text-gray-600"
              }`}
            >
              {customer.is_active
                ? "Active"
                : "Archived"}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <div className="flex items-start gap-3">
              <Phone className="mt-0.5 size-4 shrink-0 text-gray-400" />

              <div className="min-w-0">
                <p className="text-xs text-gray-500">
                  Phone
                </p>

                <p className="mt-0.5 break-words text-sm font-medium text-gray-800">
                  {customer.phone ||
                    "Not provided"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 size-4 shrink-0 text-gray-400" />

              <div className="min-w-0">
                <p className="text-xs text-gray-500">
                  Email
                </p>

                <p className="mt-0.5 break-words text-sm font-medium text-gray-800">
                  {customer.email ||
                    "Not provided"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 size-4 shrink-0 text-gray-400" />

              <div>
                <p className="text-xs text-gray-500">
                  Appointment history
                </p>

                <p className="mt-0.5 text-sm font-medium text-gray-800">
                  {history.length}{" "}
                  {history.length === 1
                    ? "appointment"
                    : "appointments"}
                </p>
              </div>
            </div>
          </div>

          {customer.notes && (
            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">
                Notes
              </p>

              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                {customer.notes}
              </p>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={
                saving ||
                Boolean(
                  customerActionId
                )
              }
              onClick={onEdit}
              className="gap-2"
            >
              <Pencil className="size-4" />
              Edit customer
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
              onClick={
                onToggleActive
              }
              className="gap-2"
            >
              {customer.is_active ? (
                <Archive className="size-4" />
              ) : (
                <RotateCcw className="size-4" />
              )}

              {actionInProgress
                ? "Updating..."
                : customer.is_active
                  ? "Archive"
                  : "Reactivate"}
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Appointment history
            </p>

            <p className="text-xs text-gray-500">
              {history.length} total
            </p>
          </div>

          {history.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white px-5 py-8 text-center">
              <CircleUserRound className="mx-auto size-5 text-gray-400" />

              <p className="mt-2 text-sm text-gray-500">
                No linked appointments
                for this customer.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {history.map(
                (
                  appointment
                ) => (
                  <div
                    key={
                      appointment.id
                    }
                    className="rounded-xl border border-gray-200 bg-white p-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-gray-900">
                          {appointment.service ||
                            "Service unavailable"}
                        </p>

                        <p className="mt-1 text-sm text-gray-500">
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
                        className={`w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClasses(
                          appointment.status
                        )}`}
                      >
                        {appointment.status ||
                          "Unknown"}
                      </span>
                    </div>

                    {appointment.notes && (
                      <p className="mt-3 whitespace-pre-wrap border-t border-gray-100 pt-3 text-sm leading-6 text-gray-500">
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
      </div>
    </div>
  );
}
