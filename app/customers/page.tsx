"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Mail,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Users,
  X,
} from "lucide-react";

import { DialogSurface } from "@/components/ui/dialog-surface";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirmation } from "@/components/ui/use-confirmation";
import AppLayout from "@/components/layout/AppLayout";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
import {
  saveCustomer,
  type CustomerRecord,
} from "@/lib/customer-mutations";
import {
  businessNowKey,
  compareAppointmentsNewestFirst,
  formatAppointmentDate,
  formatAppointmentTime,
  isUpcomingAppointment,
  summarizeCustomerHistory,
  type CustomerAppointment,
  type CustomerHistorySummary,
} from "@/lib/customer-insights";
import { supabase } from "@/lib/supabase";

import { Button } from "@/components/ui/button";
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

const FILTER_LABELS: Record<
  CustomerFilter,
  string
> = {
  active: "Active",
  archived: "Archived",
  all: "All",
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

/* Matches the Appointments page so a status reads the same everywhere. */
function statusClasses(
  status: string | null
) {
  switch (status) {
    case "Confirmed":
      return "border-green-200 bg-green-50 text-green-700";

    case "Completed":
      return "border-blue-200 bg-blue-50 text-blue-700";

    case "Cancelled":
      return "border-gray-200 bg-gray-100 text-gray-600";

    default:
      return "border-amber-200 bg-amber-50 text-amber-700";
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

function appointmentCountLabel(
  count: number
) {
  return `${count} ${
    count === 1
      ? "appointment"
      : "appointments"
  }`;
}

function shortDate(
  value: string | null
) {
  return formatAppointmentDate(
    value,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  );
}

const EMPTY_SUMMARY: CustomerHistorySummary =
  summarizeCustomerHistory([], null);

export default function CustomersPage() {
  const router = useRouter();
  const { confirm, confirmation } =
    useConfirmation();

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

  /* Business-local "now"; drives upcoming vs past without UTC parsing. */
  const [
    nowKey,
    setNowKey,
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
    selectedCustomerId,
    setSelectedCustomerId,
  ] = useState<string | null>(
    null
  );

  const [
    editorOpen,
    setEditorOpen,
  ] = useState(false);

  const saveInFlight =
    useRef(false);

  const actionInFlight =
    useRef(false);

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

  const summaryMap =
    useMemo(() => {
      const map = new Map<
        string,
        CustomerHistorySummary
      >();

      for (const [
        customerId,
        history,
      ] of appointmentMap) {
        map.set(
          customerId,
          summarizeCustomerHistory(
            history,
            nowKey
          )
        );
      }

      return map;
    }, [appointmentMap, nowKey]);

  const upcomingCount = useMemo(
    () =>
      customers.filter(
        (customer) =>
          summaryMap.get(customer.id)
            ?.upcoming
      ).length,
    [customers, summaryMap]
  );

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

  const filterCounts: Record<
    CustomerFilter,
    number
  > = {
    active: activeCount,
    archived: archivedCount,
    all: customers.length,
  };

  const selectedCustomer =
    selectedCustomerId
      ? customers.find(
          (customer) =>
            customer.id ===
            selectedCustomerId
        ) || null
      : null;

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
      timezone:
        data.business.timezone,
    };
  }

  /* `loading` starts true; a business switch remounts this page. */
  async function initializePage() {
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
    setNowKey(
      businessNowKey(
        context.timezone
      )
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

    /* Read-only: the CRM never updates or deletes appointments. */
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

  useEffect(() => {
    void initializePage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function openCustomerDetails(
    customerId: string
  ) {
    setSelectedCustomerId(
      customerId
    );
  }

  function closeCustomerDetails() {
    setSelectedCustomerId(null);
  }

  async function toggleCustomerActive(
    customer: CustomerRecord
  ) {
    if (
      !businessId ||
      customerActionId ||
      actionInFlight.current ||
      saveInFlight.current
    ) {
      return;
    }

    const nextActive =
      !customer.is_active;

    const confirmed =
      await confirm(
        nextActive
          ? `Reactivate ${customer.full_name}? They can be selected for new appointments again.`
          : `Archive ${customer.full_name}? Their appointment history will be preserved and you can reactivate them later.`,
        {
          destructive:
            !nextActive,
        }
      );

    if (!confirmed) {
      return;
    }

    if (
      actionInFlight.current ||
      saveInFlight.current
    ) {
      return;
    }

    actionInFlight.current = true;

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
      actionInFlight.current = false;

      setCustomerActionId(
        null
      );
    }
  }

  const selectedHistory =
    selectedCustomer
      ? appointmentMap.get(
          selectedCustomer.id
        ) || []
      : [];

  return (
    <AppLayout>
      <div className="space-y-5" data-page="customers">
        <PageHeader
          eyebrow="People & relationships"
          title={<>Customers</>}
          description={<>Contact details, notes, and appointment history for every client.</>}
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
              className="customer-feedback"
            >
              <p className="min-w-0 flex-1">
                {feedback}
              </p>

              <button
                type="button"
                aria-label="Dismiss message"
                onClick={() =>
                  setFeedback("")
                }
                className="customer-icon-button"
              >
                <X className="size-4" />
              </button>
            </div>
          )}

        <dl
          className="customer-summary"
          aria-label="Customer summary"
        >
          <div>
            <dt>Total customers</dt>
            <dd>{customers.length}</dd>
          </div>

          <div>
            <dt>Active</dt>
            <dd>{activeCount}</dd>
          </div>

          <div>
            <dt>Archived</dt>
            <dd>{archivedCount}</dd>
          </div>

          <div>
            <dt>With upcoming appointment</dt>
            <dd>
              {loading ||
              nowKey
                ? upcomingCount
                : "—"}
            </dd>
          </div>
        </dl>

        <section
          aria-label="Customer directory"
          className="customer-directory-panel"
        >
          <div className="customer-toolbar">
            <div className="customer-search">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              />

              <Input
                type="search"
                aria-label="Search customers"
                placeholder="Search name, phone, or email"
                autoComplete="off"
                enterKeyHint="search"
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
                className="h-11 pl-10 pr-12"
              />

              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() =>
                    setSearchQuery("")
                  }
                  className="customer-icon-button absolute right-0 top-0"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            <div
              className="customer-filter"
              role="group"
              aria-label="Customer status filter"
            >
              {(
                [
                  "active",
                  "archived",
                  "all",
                ] as const
              ).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={
                    customerFilter ===
                    filter
                  }
                  onClick={() =>
                    setCustomerFilter(
                      filter
                    )
                  }
                >
                  {FILTER_LABELS[filter]}
                  <span className="customer-filter-count">
                    {filterCounts[filter]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {!loading &&
            customers.length > 0 && (
              <p
                className="customer-result-count"
                aria-live="polite"
              >
                {visibleCustomers.length ===
                customers.length
                  ? `${customers.length} customers`
                  : `Showing ${visibleCustomers.length} of ${customers.length} customers`}
              </p>
            )}

          {loading ? (
            <div
              className="customer-empty"
              role="status"
            >
              <p className="text-sm text-gray-500">
                Loading customers...
              </p>
            </div>
          ) : customers.length ===
            0 ? (
            <div className="customer-empty">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <Users className="size-5" />
              </div>

              <p className="mt-4 font-semibold text-gray-950">
                No customers yet
              </p>

              <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                Add your first customer,
                or they will appear here
                as appointments are
                booked.
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
            <div className="customer-empty">
              <Search className="mx-auto size-6 text-gray-400" />

              <p className="mt-4 font-semibold text-gray-950">
                {searchQuery.trim()
                  ? "No matching customers"
                  : `No ${FILTER_LABELS[
                      customerFilter
                    ].toLowerCase()} customers`}
              </p>

              <p className="mt-1 text-sm text-gray-500">
                Try another search or
                status filter.
              </p>

              {searchQuery && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setSearchQuery("")
                  }
                  className="mt-5"
                >
                  Clear search
                </Button>
              )}
            </div>
          ) : (
            <div className="customer-directory">
              <div
                className="customer-directory-heading"
                aria-hidden="true"
              >
                <span>Customer</span>
                <span className="cd-contact">
                  Contact
                </span>
                <span className="cd-count">
                  Appts
                </span>
                <span className="cd-next">
                  Next appointment
                </span>
                <span className="cd-last">
                  Last appointment
                </span>
                <span className="cd-timing">
                  Appointments
                </span>
                <span />
              </div>

              <ul>
                {visibleCustomers.map(
                  (customer) => (
                    <li
                      key={
                        customer.id
                      }
                    >
                      <CustomerRow
                        customer={
                          customer
                        }
                        summary={
                          summaryMap.get(
                            customer.id
                          ) ||
                          EMPTY_SUMMARY
                        }
                        timingKnown={Boolean(
                          nowKey
                        )}
                        selected={
                          selectedCustomerId ===
                          customer.id
                        }
                        onOpen={() =>
                          openCustomerDetails(
                            customer.id
                          )
                        }
                      />
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
        </section>
      </div>

      {selectedCustomer && (
        <DialogSurface
          aria-labelledby="customer-details-title"
          className="customer-drawer"
          onClose={
            closeCustomerDetails
          }
        >
          <CustomerDetails
            customer={
              selectedCustomer
            }
            history={
              selectedHistory
            }
            summary={
              summaryMap.get(
                selectedCustomer.id
              ) || EMPTY_SUMMARY
            }
            nowKey={nowKey}
            actionInProgress={
              customerActionId ===
              selectedCustomer.id
            }
            saving={saving}
            customerActionId={
              customerActionId
            }
            onClose={
              closeCustomerDetails
            }
            onEdit={() =>
              editCustomer(
                selectedCustomer
              )
            }
            onToggleActive={() =>
              void toggleCustomerActive(
                selectedCustomer
              )
            }
          />
        </DialogSurface>
      )}

      {editorOpen && (
        <DialogSurface
          aria-labelledby="customer-editor-title"
          onClose={() => {
            if (!saving) closeEditor();
          }}
        >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="eyebrow">
                  Customer record
                </p>

                <h2
                  id="customer-editor-title"
                  className="mt-1 text-lg font-semibold tracking-tight text-gray-950"
                >
                  {editingId
                    ? "Edit customer"
                    : "Add customer"}
                </h2>

                <p className="mt-0.5 text-sm text-gray-500">
                  {editingId
                    ? "Update contact details and notes. Appointment history is unchanged."
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
                    name="full_name"
                    placeholder="Customer name"
                    autoComplete="off"
                    autoCapitalize="words"
                    enterKeyHint="next"
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

                <div className="customer-editor-group">
                  <p className="customer-editor-group-title">
                    Contact
                  </p>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block space-y-2">
                      <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-800">
                        Phone
                        <span className="text-xs font-normal text-gray-500">
                          Optional
                        </span>
                      </span>

                      <Input
                        type="tel"
                        name="phone"
                        placeholder="Phone number"
                        autoComplete="off"
                        enterKeyHint="next"
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
                      <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-800">
                        Email
                        <span className="text-xs font-normal text-gray-500">
                          Optional
                        </span>
                      </span>

                      <Input
                        type="email"
                        name="email"
                        placeholder="Email address"
                        autoComplete="off"
                        autoCapitalize="none"
                        enterKeyHint="next"
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

                  <p className="text-xs leading-5 text-gray-500">
                    Each phone number can
                    belong to only one
                    customer in this
                    business, including
                    archived customers.
                  </p>
                </div>

                <label className="block space-y-2">
                  <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-800">
                    Notes
                    <span className="text-xs font-normal text-gray-500">
                      Optional
                    </span>
                  </span>

                  <Textarea
                    name="notes"
                    placeholder="Preferences, allergies, or anything your team should know"
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
                    className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"
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
                    closeEditor
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

      {confirmation}
    </AppLayout>
  );
}

function CustomerAvatar({
  customer,
  large = false,
}: {
  customer: CustomerRecord;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`customer-avatar ${
        large
          ? "customer-avatar-large"
          : ""
      }`}
      data-archived={
        !customer.is_active ||
        undefined
      }
    >
      {initials(
        customer.full_name
      ) || "C"}
    </span>
  );
}

function AppointmentMoment({
  appointment,
  empty,
  tone,
}: {
  appointment: CustomerAppointment | null;
  empty: string;
  tone?: "upcoming";
}) {
  if (!appointment) {
    return (
      <span className="block text-sm text-gray-400">
        {empty}
      </span>
    );
  }

  return (
    <>
      <span
        className={`block truncate text-sm font-medium ${
          tone === "upcoming"
            ? "text-green-800"
            : "text-gray-800"
        }`}
      >
        {shortDate(
          appointment.appointment_date
        )}
        {" · "}
        {formatAppointmentTime(
          appointment.appointment_time
        )}
      </span>

      <span className="block truncate text-xs text-gray-500">
        {appointment.service ||
          "Service unavailable"}
      </span>
    </>
  );
}

function CustomerRow({
  customer,
  summary,
  timingKnown,
  selected,
  onOpen,
}: {
  customer: CustomerRecord;
  summary: CustomerHistorySummary;
  timingKnown: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const contactLine =
    customer.phone ||
    customer.email ||
    "No contact details";

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-selected={
        selected || undefined
      }
      onClick={onOpen}
      className="customer-directory-row"
    >
      <span className="cd-identity">
        <CustomerAvatar
          customer={customer}
        />

        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-gray-950">
              {customer.full_name}
            </span>

            {!customer.is_active && (
              <span className="customer-archived-pill">
                Archived
              </span>
            )}
          </span>

          <span className="cd-meta cd-meta-contact">
            {contactLine}
          </span>

          <span className="cd-meta cd-meta-count">
            {appointmentCountLabel(
              summary.count
            )}
            {summary.upcoming && (
              <>
                {" · "}
                <span className="text-green-800">
                  Next{" "}
                  {shortDate(
                    summary.upcoming
                      .appointment_date
                  )}
                </span>
              </>
            )}
          </span>
        </span>
      </span>

      <span className="cd-contact">
        <span className="block truncate text-sm text-gray-700">
          {customer.phone || (
            <span className="text-gray-400">
              No phone
            </span>
          )}
        </span>

        <span className="block truncate text-xs text-gray-500">
          {customer.email ||
            "No email"}
        </span>
      </span>

      <span className="cd-count">
        <span className="text-sm font-semibold tabular-nums text-gray-800">
          {summary.count}
        </span>
        <span className="sr-only">
          {" "}
          {summary.count === 1
            ? "appointment"
            : "appointments"}
        </span>
      </span>

      <span className="cd-next">
        <span className="sr-only">
          Next appointment:{" "}
        </span>
        <AppointmentMoment
          appointment={
            summary.upcoming
          }
          empty={
            timingKnown
              ? "None scheduled"
              : "Unavailable"
          }
          tone="upcoming"
        />
      </span>

      <span className="cd-last">
        <span className="sr-only">
          Last appointment:{" "}
        </span>
        <AppointmentMoment
          appointment={
            summary.lastPast
          }
          empty={
            timingKnown
              ? "No past visits"
              : "Unavailable"
          }
        />
      </span>

      <span className="cd-timing">
        {summary.upcoming ? (
          <>
            <span className="customer-upcoming-label">
              Next
            </span>
            <AppointmentMoment
              appointment={
                summary.upcoming
              }
              empty=""
              tone="upcoming"
            />
          </>
        ) : summary.lastPast ? (
          <>
            <span className="customer-muted-label">
              Last
            </span>
            <AppointmentMoment
              appointment={
                summary.lastPast
              }
              empty=""
            />
          </>
        ) : (
          <span className="block text-sm text-gray-400">
            {timingKnown ||
            !summary.count
              ? "No appointments"
              : appointmentCountLabel(
                  summary.count
                )}
          </span>
        )}
      </span>

      <ChevronRight
        aria-hidden="true"
        className="cd-chevron size-4 text-gray-400"
      />
    </button>
  );
}

function CustomerDetails({
  customer,
  history,
  summary,
  nowKey,
  actionInProgress,
  saving,
  customerActionId,
  onClose,
  onEdit,
  onToggleActive,
}: {
  customer: CustomerRecord;
  history: CustomerAppointment[];
  summary: CustomerHistorySummary;
  nowKey: string | null;
  actionInProgress: boolean;
  saving: boolean;
  customerActionId: string | null;
  onClose: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  const busy =
    saving ||
    Boolean(customerActionId);

  return (
    <div className="customer-drawer-layout">
      <header className="customer-drawer-header">
        <div className="flex min-w-0 items-center gap-3">
          <CustomerAvatar
            customer={customer}
            large
          />

          <div className="min-w-0">
            <h2
              id="customer-details-title"
              className="truncate text-lg font-semibold tracking-tight text-gray-950"
            >
              {customer.full_name}
            </h2>

            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
              <span
                className={
                  customer.is_active
                    ? "customer-active-pill"
                    : "customer-archived-pill"
                }
              >
                {customer.is_active
                  ? "Active"
                  : "Archived"}
              </span>

              <span>
                {appointmentCountLabel(
                  summary.count
                )}
              </span>
            </p>
          </div>
        </div>

        <button
          type="button"
          aria-label="Close customer details"
          onClick={onClose}
          className="customer-icon-button shrink-0"
        >
          <X className="size-5" />
        </button>
      </header>

      <div className="customer-drawer-body">
        <section aria-labelledby="customer-contact-heading">
          <h3
            id="customer-contact-heading"
            className="customer-section-title"
          >
            Contact
          </h3>

          <div className="customer-contact-list">
            {customer.phone ? (
              <a
                href={`tel:${customer.phone}`}
                className="customer-contact-link"
              >
                <Phone
                  aria-hidden="true"
                  className="size-4 shrink-0 text-gray-500"
                />
                <span className="min-w-0 truncate">
                  {customer.phone}
                </span>
                <span className="sr-only">
                  (call)
                </span>
              </a>
            ) : (
              <p className="customer-contact-link text-gray-400">
                <Phone
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
                No phone on file
              </p>
            )}

            {customer.email ? (
              <a
                href={`mailto:${customer.email}`}
                className="customer-contact-link"
              >
                <Mail
                  aria-hidden="true"
                  className="size-4 shrink-0 text-gray-500"
                />
                <span className="min-w-0 truncate">
                  {customer.email}
                </span>
                <span className="sr-only">
                  (email)
                </span>
              </a>
            ) : (
              <p className="customer-contact-link text-gray-400">
                <Mail
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
                No email on file
              </p>
            )}
          </div>
        </section>

        <section aria-labelledby="customer-overview-heading">
          <h3
            id="customer-overview-heading"
            className="customer-section-title"
          >
            Overview
          </h3>

          <dl className="customer-overview">
            <div data-tone={
              summary.upcoming
                ? "upcoming"
                : undefined
            }>
              <dt>
                <CalendarClock
                  aria-hidden="true"
                  className="size-3.5"
                />
                Next appointment
              </dt>
              <dd>
                <AppointmentMoment
                  appointment={
                    summary.upcoming
                  }
                  empty={
                    nowKey
                      ? "None scheduled"
                      : "Unavailable"
                  }
                  tone="upcoming"
                />
              </dd>
            </div>

            <div>
              <dt>
                <CalendarDays
                  aria-hidden="true"
                  className="size-3.5"
                />
                Last appointment
              </dt>
              <dd>
                <AppointmentMoment
                  appointment={
                    summary.lastPast
                  }
                  empty={
                    nowKey
                      ? "No past visits"
                      : "Unavailable"
                  }
                />
              </dd>
            </div>

            <div>
              <dt>Appointments</dt>
              <dd>
                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {summary.count}
                </span>
              </dd>
            </div>

            <div>
              <dt>Completed · Cancelled</dt>
              <dd>
                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {summary.completedCount}
                  <span className="px-1.5 text-gray-300">
                    ·
                  </span>
                  {summary.cancelledCount}
                </span>
              </dd>
            </div>
          </dl>

          {summary.services.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-gray-500">
                Services booked
                <span className="font-normal">
                  {" "}
                  (excluding cancelled)
                </span>
              </p>

              <ul className="mt-2 flex flex-wrap gap-1.5">
                {summary.services.map(
                  (service) => (
                    <li
                      key={service.name}
                      className="customer-service-chip"
                    >
                      <span className="truncate">
                        {service.name}
                      </span>
                      <span className="tabular-nums text-gray-500">
                        ×{service.count}
                      </span>
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
        </section>

        <section aria-labelledby="customer-notes-heading">
          <div className="flex items-center justify-between gap-3">
            <h3
              id="customer-notes-heading"
              className="customer-section-title"
            >
              Notes
            </h3>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onEdit}
              className="-my-2 -mr-2 gap-1.5 text-green-800"
            >
              <NotebookPen className="size-3.5" />
              {customer.notes
                ? "Edit notes"
                : "Add note"}
            </Button>
          </div>

          {customer.notes ? (
            <p className="customer-notes">
              {customer.notes}
            </p>
          ) : (
            <p className="mt-2 text-sm text-gray-400">
              No notes saved for this
              customer.
            </p>
          )}
        </section>

        <section aria-labelledby="customer-history-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h3
              id="customer-history-heading"
              className="customer-section-title"
            >
              Appointment history
            </h3>

            <p className="text-xs text-gray-500">
              Newest first
            </p>
          </div>

          {history.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-gray-300 px-5 py-7 text-center">
              <CalendarDays className="mx-auto size-5 text-gray-400" />

              <p className="mt-2 text-sm text-gray-500">
                No linked appointments
                for this customer.
              </p>
            </div>
          ) : (
            <ol className="customer-history">
              {history.map(
                (appointment) => {
                  const upcoming =
                    isUpcomingAppointment(
                      appointment,
                      nowKey
                    );

                  return (
                    <li
                      key={
                        appointment.id
                      }
                      data-upcoming={
                        upcoming ||
                        undefined
                      }
                    >
                      <div
                        className="customer-history-date"
                        aria-hidden="true"
                      >
                        <span>
                          {formatAppointmentDate(
                            appointment.appointment_date,
                            {
                              month:
                                "short",
                            }
                          )}
                        </span>
                        <strong>
                          {formatAppointmentDate(
                            appointment.appointment_date,
                            {
                              day: "numeric",
                            }
                          )}
                        </strong>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                          <p className="min-w-0 text-sm font-semibold text-gray-900">
                            {appointment.service ||
                              "Service unavailable"}
                          </p>

                          <span className="flex shrink-0 items-center gap-1.5">
                            {upcoming && (
                              <span className="customer-active-pill">
                                Upcoming
                              </span>
                            )}

                            <span
                              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses(
                                appointment.status
                              )}`}
                            >
                              {appointment.status ||
                                "Unknown"}
                            </span>
                          </span>
                        </div>

                        <p className="mt-0.5 text-sm text-gray-500">
                          {formatAppointmentDate(
                            appointment.appointment_date,
                            {
                              weekday:
                                "short",
                              month:
                                "short",
                              day: "numeric",
                              year: "numeric",
                            }
                          )}{" "}
                          at{" "}
                          {formatAppointmentTime(
                            appointment.appointment_time
                          )}
                        </p>

                        {appointment.notes && (
                          <p className="mt-2 whitespace-pre-wrap border-t border-gray-100 pt-2 text-sm leading-6 text-gray-600">
                            {
                              appointment.notes
                            }
                          </p>
                        )}
                      </div>
                    </li>
                  );
                }
              )}
            </ol>
          )}

          <p className="mt-3 text-xs leading-5 text-gray-500">
            History is read-only here.
            To reschedule or update a
            visit, use{" "}
            <Link
              href="/appointments"
              className="font-medium text-green-800 underline underline-offset-2"
            >
              Appointments
            </Link>
            .
          </p>
        </section>
      </div>

      <footer className="customer-drawer-footer">
        <p className="text-xs leading-5 text-gray-500">
          {customer.is_active
            ? "Archiving hides this customer from new bookings. Appointment history is preserved."
            : "Archived customers keep their history but can't be booked until reactivated."}
        </p>

        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={
              onToggleActive
            }
            className="flex-1 gap-2 sm:flex-none"
          >
            {customer.is_active ? (
              <Archive className="size-4" />
            ) : (
              <RotateCcw className="size-4" />
            )}

            {actionInProgress
              ? "Updating..."
              : customer.is_active
                ? "Archive customer"
                : "Reactivate customer"}
          </Button>

          <Button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="flex-1 gap-2 sm:flex-none"
          >
            <Pencil className="size-4" />
            Edit customer
          </Button>
        </div>
      </footer>
    </div>
  );
}
