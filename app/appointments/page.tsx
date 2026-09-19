"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useRouter,
} from "next/navigation";
import { toast } from "sonner";

import {
  createRequestKeyStore,
} from "@/lib/appointment-request-key";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
import {
  normalizeCustomerPhone,
  saveCustomer,
} from "@/lib/customer-mutations";
import {
  supabase,
} from "@/lib/supabase";

import AppLayout from "@/components/layout/AppLayout";
import {
  Button,
} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Input,
} from "@/components/ui/input";
import {
  Textarea,
} from "@/components/ui/textarea";

type Appointment = {
  id: string;
  customer_id: string | null;
  service_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
  notes: string | null;
};

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
};

type Service = {
  id: string;
  name: string;
  duration_minutes: number | null;
};

type Notice = {
  type:
    | "success"
    | "warning"
    | "error";
  message: string;
};

type AppointmentFormValues = {
  customerId: string;
  serviceId: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
};

type AppointmentUpdateResponse = {
  message?: string;
  success?: boolean;
  error?: string;
  sms_sent?: boolean;
  sms_error?: string | null;
};

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

const emptyForm: AppointmentFormValues =
  {
    customerId: "",
    serviceId: "",
    appointmentDate: "",
    appointmentTime: "",
    notes: "",
  };

function normalizeCustomerName(
  value: string
) {
  return value
    .trim()
    .toLowerCase();
}

function findCustomerMatches(
  customers: Customer[],
  name: string,
  phone: string
) {
  const activeCustomers =
    customers.filter(
      (customer) =>
        customer.is_active
    );

  const normalizedName =
    normalizeCustomerName(name);

  const normalizedPhone =
    normalizeCustomerPhone(phone);

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

    const exactMatches =
      activeCustomers.filter(
        (customer) =>
          normalizeCustomerPhone(
            customer.phone || ""
          ) === normalizedPhone
      );

    if (
      exactMatches.length
    ) {
      return exactMatches;
    }

    return activeCustomers.filter(
      (customer) =>
        normalizeCustomerPhone(
          customer.phone || ""
        ).includes(
          normalizedPhone
        )
    );
  }

  if (!normalizedName) {
    return [];
  }

  return activeCustomers.filter(
    (customer) =>
      normalizeCustomerName(
        customer.full_name
      ).includes(
        normalizedName
      )
  );
}

function normalizeTime(
  value: string | null
) {
  if (!value) {
    return "";
  }

  const match =
    value.match(
      /^(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return value;
  }

  return `${match[1].padStart(
    2,
    "0"
  )}:${match[2]}`;
}

function formatTimeForDisplay(
  value: string | null
) {
  const normalized =
    normalizeTime(value);

  if (!normalized) {
    return "Not specified";
  }

  const [
    hourText,
    minuteText,
  ] =
    normalized.split(":");

  const hour =
    Number(hourText);

  const minute =
    Number(minuteText);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    return (
      value ||
      "Not specified"
    );
  }

  const period =
    hour >= 12
      ? "PM"
      : "AM";

  const displayHour =
    hour % 12 || 12;

  return `${displayHour}:${String(
    minute
  ).padStart(
    2,
    "0"
  )} ${period}`;
}

function statusBadgeClasses(
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

export default function AppointmentsPage() {
  const router =
    useRouter();

  const [
    appointments,
    setAppointments,
  ] = useState<
    Appointment[]
  >([]);

  const [
    customers,
    setCustomers,
  ] = useState<
    Customer[]
  >([]);

  const [
    services,
    setServices,
  ] = useState<
    Service[]
  >([]);

  const [
    businessId,
    setBusinessId,
  ] = useState<
    string | null
  >(null);

  const [
    userId,
    setUserId,
  ] = useState<
    string | null
  >(null);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    submitting,
    setSubmitting,
  ] = useState(false);

  const [
    actionAppointmentId,
    setActionAppointmentId,
  ] = useState<
    string | null
  >(null);

  const [
    createForm,
    setCreateForm,
  ] =
    useState<AppointmentFormValues>(
      emptyForm
    );

  const [
    customerName,
    setCustomerName,
  ] = useState("");

  const [
    customerPhone,
    setCustomerPhone,
  ] = useState("");

  const [
    customerEmail,
    setCustomerEmail,
  ] = useState("");

  const createInFlight =
    useRef(false);

  const actionKeys =
    useRef(
      createRequestKeyStore()
    );

  const mutationInFlight =
    useRef(false);

  const [
    editingAppointmentId,
    setEditingAppointmentId,
  ] = useState<
    string | null
  >(null);

  const [
    editForm,
    setEditForm,
  ] =
    useState<AppointmentFormValues>(
      emptyForm
    );

  const [
    notice,
    setNotice,
  ] = useState<
    Notice | null
  >(null);

  const matchingCustomers =
    findCustomerMatches(
      customers,
      customerName,
      customerPhone
    );

  const selectedCreateCustomer =
    customers.find(
      (customer) =>
        customer.id ===
          createForm.customerId &&
        customer.is_active
    );

  useEffect(() => {
    void initializePage();
  }, []);

  function showNotice(
    type:
      | "success"
      | "warning"
      | "error",
    message: string
  ) {
    setNotice({
      type,
      message,
    });

    if (
      type === "success"
    ) {
      toast.success(
        message
      );
    }

    if (
      type === "warning"
    ) {
      toast.warning(
        message
      );
    }

    if (
      type === "error"
    ) {
      toast.error(
        message
      );
    }
  }

  async function getAccessToken() {
    const {
      data: { session },
      error,
    } =
      await supabase.auth.getSession();

    if (
      error ||
      !session?.access_token
    ) {
      router.push(
        "/login"
      );

      return null;
    }

    return session.access_token;
  }

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

    const response =
      await fetch(
        "/api/current-business",
        {
          method: "GET",

          headers: {
            ...activeBusinessHeaders(),

            Authorization:
              `Bearer ${session.access_token}`,
          },

          cache: "no-store",
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
      userId:
        session.user.id,

      businessId:
        data.business.id,
    };
  }

  async function initializePage() {
    setLoading(true);

    try {
      const context =
        await getAuthenticatedContext();

      if (!context) {
        router.push(
          "/login"
        );

        return;
      }

      setUserId(
        context.userId
      );

      setBusinessId(
        context.businessId
      );

      await loadAppointments(
        context.businessId
      );
    } finally {
      setLoading(false);
    }
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

    const [
      customerResult,
      serviceResult,
      appointmentResult,
    ] =
      await Promise.all([
        /*
         * Load both active and archived customers.
         * Archived records are needed to preserve the
         * customer relationship on existing appointments.
         * New-booking selection is filtered separately.
         */
        supabase
          .from("customers")
          .select(
            "id, full_name, phone, email, is_active"
          )
          .eq(
            "business_id",
            activeBusinessId
          )
          .order(
            "is_active",
            {
              ascending: false,
            }
          )
          .order(
            "full_name"
          ),

        supabase
          .from("services")
          .select(
            "id, name, duration_minutes"
          )
          .eq(
            "business_id",
            activeBusinessId
          )
          .eq(
            "is_active",
            true
          )
          .order(
            "name"
          ),

        supabase
          .from(
            "appointments"
          )
          .select(
            "id, customer_id, service_id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status, notes"
          )
          .eq(
            "business_id",
            activeBusinessId
          )
          .order(
            "appointment_date",
            {
              ascending: true,
            }
          )
          .order(
            "appointment_time",
            {
              ascending: true,
            }
          ),
      ]);

    if (
      customerResult.error
    ) {
      showNotice(
        "error",
        customerResult.error
          .message
      );
    } else {
      setCustomers(
        customerResult.data ||
          []
      );
    }

    if (
      serviceResult.error
    ) {
      showNotice(
        "error",
        serviceResult.error
          .message
      );
    } else {
      setServices(
        serviceResult.data ||
          []
      );
    }

    if (
      appointmentResult.error
    ) {
      showNotice(
        "error",
        appointmentResult.error
          .message
      );
    } else {
      setAppointments(
        appointmentResult.data ||
          []
      );
    }
  }

  function updateCustomerLookup(
    field:
      | "name"
      | "phone",
    value: string
  ) {
    if (
      field === "name"
    ) {
      setCustomerName(
        value
      );
    } else {
      setCustomerPhone(
        value
      );
    }

    /*
     * Require explicit selection again after editing
     * either customer identity field.
     */
    setCreateForm(
      (current) => ({
        ...current,
        customerId: "",
      })
    );
  }

  function selectCreateCustomer(
    customer: Customer
  ) {
    if (
      !customer.is_active
    ) {
      showNotice(
        "warning",
        "Archived customers must be reactivated before they can be used for a new appointment."
      );

      return;
    }

    setCustomerEmail(
      customer.email || ""
    );

    setCustomerName(
      customer.full_name
    );

    setCustomerPhone(
      customer.phone || ""
    );

    setCreateForm(
      (current) => ({
        ...current,
        customerId:
          customer.id,
      })
    );
  }

  async function sendAppointmentUpdate({
    appointmentId,
    updates,
    notificationType,
    creating = false,
  }: {
    appointmentId?: string;

    creating?: boolean;

    updates: Record<
      string,
      string | null
    >;

    notificationType:
      | "confirm"
      | "reschedule"
      | "cancel"
      | "complete"
      | "none";
  }) {
    if (!businessId) {
      throw new Error(
        "Business context is unavailable."
      );
    }

    const accessToken =
      await getAccessToken();

    if (!accessToken) {
      throw new Error(
        "Your session has expired. Please log in again."
      );
    }

    if (
      mutationInFlight.current
    ) {
      throw new Error(
        "An appointment action is already in progress."
      );
    }

    mutationInFlight.current =
      true;

    try {
      const idempotencyKey =
        actionKeys.current.forRequest(
          {
            userId,
            businessId,
            creating,
            appointmentId,
            updates,
          }
        );

      const response =
        await fetch(
          "/api/appointments",
          {
            method:
              creating
                ? "POST"
                : "PATCH",

            headers: {
              "Idempotency-Key":
                idempotencyKey,

              ...activeBusinessHeaders(),

              "x-anaai-business-id":
                businessId,

              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${accessToken}`,
            },

            body:
              JSON.stringify({
                appointmentId,
                ...updates,
                notificationType,
              }),
          }
        );

      const result =
        (await response.json()) as AppointmentUpdateResponse;

      if (
        !response.ok ||
        result?.success !==
          true
      ) {
        throw new Error(
          result?.error ||
            "Appointment update failed."
        );
      }

      actionKeys.current.clear();

      return result;
    } finally {
      mutationInFlight.current =
        false;
    }
  }

  async function handleCreateAppointment() {
    if (
      createInFlight.current
    ) {
      return;
    }

    if (
      !businessId ||
      !userId
    ) {
      showNotice(
        "error",
        "Business context is not available."
      );

      return;
    }

    let selectedCustomer =
      customers.find(
        (customer) =>
          customer.id ===
            createForm.customerId &&
          customer.is_active
      );

    const selectedService =
      services.find(
        (service) =>
          service.id ===
          createForm.serviceId
      );

    if (
      createForm.customerId &&
      (
        !selectedCustomer ||
        normalizeCustomerName(
          customerName
        ) !==
          normalizeCustomerName(
            selectedCustomer.full_name
          ) ||
        normalizeCustomerPhone(
          customerPhone
        ) !==
          normalizeCustomerPhone(
            selectedCustomer.phone ||
              ""
          )
      )
    ) {
      showNotice(
        "warning",
        "Please select an active existing customer from the matches."
      );

      return;
    }

    if (!selectedService) {
      showNotice(
        "warning",
        "Please select a service."
      );

      return;
    }

    if (
      !createForm
        .appointmentDate
    ) {
      showNotice(
        "warning",
        "Please select an appointment date."
      );

      return;
    }

    if (
      !createForm
        .appointmentTime
    ) {
      showNotice(
        "warning",
        "Please select an appointment time."
      );

      return;
    }

    createInFlight.current =
      true;

    setSubmitting(true);

    try {
      if (!selectedCustomer) {
        selectedCustomer =
          await saveCustomer(
            businessId,
            {
              name:
                customerName,

              phone:
                customerPhone,

              email:
                customerEmail,
            }
          );

        const savedCustomer =
          selectedCustomer;

        setCustomers(
          (current) => [
            ...current.filter(
              (item) =>
                item.id !==
                savedCustomer.id
            ),

            savedCustomer,
          ]
        );

        selectCreateCustomer(
          savedCustomer
        );
      }

      if (
        !selectedCustomer.is_active
      ) {
        throw new Error(
          "Archived customers must be reactivated before they can be used for a new appointment."
        );
      }

      const result =
        await sendAppointmentUpdate(
          {
            creating: true,

            updates: {
              customerId:
                selectedCustomer.id,

              serviceId:
                selectedService.id,

              appointmentDate:
                createForm.appointmentDate,

              appointmentTime:
                createForm.appointmentTime,

              notes:
                createForm.notes.trim() ||
                null,
            },

            notificationType:
              "none",
          }
        );

      showNotice(
        "success",
        result.message ||
          "Appointment action succeeded."
      );

      setCreateForm(
        emptyForm
      );

      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not create appointment."
      );
    } finally {
      createInFlight.current =
        false;

      setSubmitting(false);
    }
  }

  function startEditingAppointment(
    appointment: Appointment
  ) {
    setEditingAppointmentId(
      appointment.id
    );

    setEditForm({
      customerId:
        appointment.customer_id ||
        "",

      serviceId:
        appointment.service_id ||
        "",

      appointmentDate:
        appointment.appointment_date ||
        "",

      appointmentTime:
        normalizeTime(
          appointment.appointment_time
        ),

      notes:
        appointment.notes || "",
    });

    setNotice(null);
  }

  function cancelEditing() {
    setEditingAppointmentId(
      null
    );

    setEditForm(
      emptyForm
    );
  }

  async function saveAppointmentChanges(
    appointment: Appointment
  ) {
    if (!businessId) {
      showNotice(
        "error",
        "Business context is not available."
      );

      return;
    }

    const selectedCustomer =
      customers.find(
        (customer) =>
          customer.id ===
          editForm.customerId
      );

    const selectedService =
      services.find(
        (service) =>
          service.id ===
          editForm.serviceId
      );

    if (!selectedCustomer) {
      showNotice(
        "warning",
        "Please select a customer."
      );

      return;
    }

    /*
     * An existing appointment may keep the archived
     * customer it already references. An archived customer
     * cannot be newly assigned to another appointment.
     */
    if (
      !selectedCustomer.is_active &&
      selectedCustomer.id !==
        appointment.customer_id
    ) {
      showNotice(
        "warning",
        "Archived customers must be reactivated before they can be assigned to an appointment."
      );

      return;
    }

    if (!selectedService) {
      showNotice(
        "warning",
        "Please select a service."
      );

      return;
    }

    if (
      !editForm.appointmentDate
    ) {
      showNotice(
        "warning",
        "Please select an appointment date."
      );

      return;
    }

    if (
      !editForm.appointmentTime
    ) {
      showNotice(
        "warning",
        "Please select an appointment time."
      );

      return;
    }

    setActionAppointmentId(
      appointment.id
    );

    try {
      const dateChanged =
        appointment.appointment_date !==
        editForm.appointmentDate;

      const timeChanged =
        normalizeTime(
          appointment.appointment_time
        ) !==
        normalizeTime(
          editForm.appointmentTime
        );

      const serviceChanged =
        appointment.service_id !==
        selectedService.id;

      const wasRescheduled =
        dateChanged ||
        timeChanged ||
        serviceChanged;

      const result =
        await sendAppointmentUpdate(
          {
            appointmentId:
              appointment.id,

            updates: {
              customerId:
                selectedCustomer.id,

              serviceId:
                selectedService.id,

              appointmentDate:
                editForm.appointmentDate,

              appointmentTime:
                editForm.appointmentTime,

              notes:
                editForm.notes.trim() ||
                null,
            },

            notificationType:
              wasRescheduled
                ? "reschedule"
                : "none",
          }
        );

      showNotice(
        "success",
        result.message ||
          "Appointment action succeeded."
      );

      setEditingAppointmentId(
        null
      );

      setEditForm(
        emptyForm
      );

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Appointment update failed."
      );
    } finally {
      setActionAppointmentId(
        null
      );
    }
  }

  async function confirmAppointment(
    appointment: Appointment
  ) {
    if (!businessId) {
      showNotice(
        "error",
        "Business context is not available."
      );

      return;
    }

    setActionAppointmentId(
      appointment.id
    );

    try {
      const result =
        await sendAppointmentUpdate(
          {
            appointmentId:
              appointment.id,

            updates: {
              status:
                "Confirmed",
            },

            notificationType:
              "confirm",
          }
        );

      showNotice(
        "success",
        result.message ||
          "Appointment action succeeded."
      );

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not confirm appointment."
      );
    } finally {
      setActionAppointmentId(
        null
      );
    }
  }

  async function completeAppointment(
    appointment: Appointment
  ) {
    const confirmed =
      window.confirm(
        `Mark the appointment for ${appointment.customer_name} as completed?`
      );

    if (!confirmed) {
      return;
    }

    setActionAppointmentId(
      appointment.id
    );

    try {
      const result =
        await sendAppointmentUpdate(
          {
            appointmentId:
              appointment.id,

            updates: {
              status:
                "Completed",
            },

            notificationType:
              "complete",
          }
        );

      showNotice(
        "success",
        result.message ||
          "Appointment marked completed."
      );

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not complete appointment."
      );
    } finally {
      setActionAppointmentId(
        null
      );
    }
  }

  async function cancelAppointment(
    appointment: Appointment
  ) {
    const confirmed =
      window.confirm(
        `Cancel the appointment for ${appointment.customer_name}?`
      );

    if (!confirmed) {
      return;
    }

    setActionAppointmentId(
      appointment.id
    );

    try {
      const result =
        await sendAppointmentUpdate(
          {
            appointmentId:
              appointment.id,

            updates: {
              status:
                "Cancelled",
            },

            notificationType:
              "cancel",
          }
        );

      showNotice(
        "success",
        result.message ||
          "Appointment action succeeded."
      );

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not cancel appointment."
      );
    } finally {
      setActionAppointmentId(
        null
      );
    }
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            Scheduling
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Appointments
          </h1>

          <p className="mt-2 text-gray-500">
            Manage bookings
            created by your team
            and AnaAI.
          </p>
        </header>

        {notice && (
          <div
            className={`mt-6 rounded-xl border px-4 py-3 text-sm font-medium ${
              notice.type ===
              "success"
                ? "border-green-200 bg-green-50 text-green-700"
                : notice.type ===
                    "warning"
                  ? "border-yellow-200 bg-yellow-50 text-yellow-800"
                  : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {notice.message}
          </div>
        )}

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>
              New appointment
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-4 md:col-span-2">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium">
                    <span>
                      Customer name
                    </span>

                    <Input
                      disabled={
                        submitting
                      }
                      value={
                        customerName
                      }
                      onChange={(
                        event
                      ) =>
                        updateCustomerLookup(
                          "name",
                          event
                            .target
                            .value
                        )
                      }
                      placeholder="Search by name"
                    />
                  </label>

                  <label className="space-y-2 text-sm font-medium">
                    <span>
                      Phone number
                      (optional)
                    </span>

                    <Input
                      type="tel"
                      disabled={
                        submitting
                      }
                      value={
                        customerPhone
                      }
                      onChange={(
                        event
                      ) =>
                        updateCustomerLookup(
                          "phone",
                          event
                            .target
                            .value
                        )
                      }
                      placeholder="Search by phone number"
                    />
                  </label>
                </div>

                {selectedCreateCustomer ? (
                  <p
                    role="status"
                    className="text-sm text-green-700"
                  >
                    Existing
                    customer
                    selected:{" "}
                    {
                      selectedCreateCustomer.full_name
                    }
                    {" — "}
                    {selectedCreateCustomer.phone ||
                      "No phone number"}
                  </p>
                ) : (
                  <div className="space-y-2 text-sm">
                    <p
                      className="text-gray-600"
                      role="status"
                    >
                      {matchingCustomers.length
                        ? "Matching active customers — select one, or save as a new customer if this is someone else."
                        : customerName.trim() ||
                            customerPhone.trim()
                          ? "New customer — created when you save the appointment."
                          : "Enter a customer name. Phone and email are optional."}
                    </p>

                    {customerPhone.trim() && (
                      <p className="text-gray-500">
                        Phone
                        matches take
                        priority.
                        Clear the
                        phone field
                        to search by
                        name.
                      </p>
                    )}

                    <div className="max-h-48 space-y-2 overflow-y-auto">
                      {matchingCustomers.map(
                        (
                          customer
                        ) => (
                          <button
                            key={
                              customer.id
                            }
                            type="button"
                            disabled={
                              submitting
                            }
                            onClick={() =>
                              selectCreateCustomer(
                                customer
                              )
                            }
                            className="block w-full rounded-lg border border-input px-3 py-2 text-left hover:bg-gray-50"
                          >
                            {
                              customer.full_name
                            }
                            {" — "}
                            {customer.phone ||
                              "No phone number"}
                            {customer.email
                              ? ` · ${customer.email}`
                              : ""}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}

                <label className="block space-y-2 text-sm">
                  <span>
                    Email
                    (optional)
                  </span>

                  <Input
                    type="email"
                    value={
                      customerEmail
                    }
                    disabled={
                      submitting ||
                      Boolean(
                        selectedCreateCustomer
                      )
                    }
                    onChange={(
                      event
                    ) =>
                      setCustomerEmail(
                        event
                          .target
                          .value
                      )
                    }
                  />
                </label>
              </div>

              <select
                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none"
                value={
                  createForm.serviceId
                }
                disabled={
                  submitting
                }
                onChange={(
                  event
                ) =>
                  setCreateForm(
                    (
                      current
                    ) => ({
                      ...current,

                      serviceId:
                        event
                          .target
                          .value,
                    })
                  )
                }
              >
                <option value="">
                  Select
                  service
                </option>

                {services.map(
                  (service) => (
                    <option
                      key={
                        service.id
                      }
                      value={
                        service.id
                      }
                    >
                      {
                        service.name
                      }
                      {service.duration_minutes
                        ? ` · ${service.duration_minutes} min`
                        : ""}
                    </option>
                  )
                )}
              </select>

              <Input
                type="date"
                disabled={
                  submitting
                }
                value={
                  createForm.appointmentDate
                }
                onChange={(
                  event
                ) =>
                  setCreateForm(
                    (
                      current
                    ) => ({
                      ...current,

                      appointmentDate:
                        event
                          .target
                          .value,
                    })
                  )
                }
              />

              <Input
                type="time"
                disabled={
                  submitting
                }
                value={
                  createForm.appointmentTime
                }
                onChange={(
                  event
                ) =>
                  setCreateForm(
                    (
                      current
                    ) => ({
                      ...current,

                      appointmentTime:
                        event
                          .target
                          .value,
                    })
                  )
                }
              />
            </div>

            <Textarea
              className="mt-4"
              disabled={
                submitting
              }
              placeholder="Internal notes"
              value={
                createForm.notes
              }
              onChange={(
                event
              ) =>
                setCreateForm(
                  (
                    current
                  ) => ({
                    ...current,

                    notes:
                      event
                        .target
                        .value,
                  })
                )
              }
            />

            <button
              type="button"
              onClick={
                handleCreateAppointment
              }
              disabled={
                submitting ||
                !businessId ||
                !userId
              }
              className="mt-5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting
                ? "Saving appointment..."
                : "Save appointment"}
            </button>
          </CardContent>
        </Card>

        <section className="mt-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
              Appointments
            </h2>

            <p className="mt-1 text-sm text-gray-500">
              Confirm,
              reschedule,
              complete, or
              cancel customer
              appointments.
            </p>
          </div>

          {loading ? (
            <p className="mt-4 text-gray-500">
              Loading
              appointments...
            </p>
          ) : appointments.length ===
            0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No
                appointments
                yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                New bookings
                will appear
                here once they
                are created.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {appointments.map(
                (
                  appointment
                ) => {
                  const isEditing =
                    editingAppointmentId ===
                    appointment.id;

                  const actionInProgress =
                    actionAppointmentId ===
                    appointment.id;

                  const appointmentCustomer =
                    customers.find(
                      (customer) =>
                        customer.id ===
                        appointment.customer_id
                    );

                  const editableCustomers =
                    customers.filter(
                      (customer) =>
                        customer.is_active ||
                        customer.id ===
                          appointment.customer_id
                    );

                  return (
                    <Card
                      key={
                        appointment.id
                      }
                      className="overflow-hidden"
                    >
                      <CardContent className="p-5">
                        {isEditing ? (
                          <div>
                            <p className="text-sm font-medium text-green-600">
                              Edit
                              appointment
                            </p>

                            <h3 className="mt-1 text-lg font-semibold text-gray-900">
                              {
                                appointment.customer_name
                              }
                            </h3>

                            {appointmentCustomer &&
                              !appointmentCustomer.is_active && (
                                <p className="mt-2 text-sm text-amber-700">
                                  This
                                  appointment
                                  belongs to an
                                  archived
                                  customer. The
                                  existing
                                  customer can
                                  remain attached,
                                  but archived
                                  customers cannot
                                  be newly assigned
                                  to appointments.
                                </p>
                              )}

                            <div className="mt-5 grid gap-4 md:grid-cols-2">
                              <select
                                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                                value={
                                  editForm.customerId
                                }
                                disabled={
                                  actionInProgress
                                }
                                onChange={(
                                  event
                                ) =>
                                  setEditForm(
                                    (
                                      current
                                    ) => ({
                                      ...current,

                                      customerId:
                                        event
                                          .target
                                          .value,
                                    })
                                  )
                                }
                              >
                                {editableCustomers.map(
                                  (
                                    customer
                                  ) => (
                                    <option
                                      key={
                                        customer.id
                                      }
                                      value={
                                        customer.id
                                      }
                                    >
                                      {
                                        customer.full_name
                                      }
                                      {!customer.is_active
                                        ? " (Archived)"
                                        : ""}
                                    </option>
                                  )
                                )}
                              </select>

                              <select
                                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                                value={
                                  editForm.serviceId
                                }
                                disabled={
                                  actionInProgress
                                }
                                onChange={(
                                  event
                                ) =>
                                  setEditForm(
                                    (
                                      current
                                    ) => ({
                                      ...current,

                                      serviceId:
                                        event
                                          .target
                                          .value,
                                    })
                                  )
                                }
                              >
                                {services.map(
                                  (
                                    service
                                  ) => (
                                    <option
                                      key={
                                        service.id
                                      }
                                      value={
                                        service.id
                                      }
                                    >
                                      {
                                        service.name
                                      }
                                    </option>
                                  )
                                )}
                              </select>

                              <Input
                                type="date"
                                disabled={
                                  actionInProgress
                                }
                                value={
                                  editForm.appointmentDate
                                }
                                onChange={(
                                  event
                                ) =>
                                  setEditForm(
                                    (
                                      current
                                    ) => ({
                                      ...current,

                                      appointmentDate:
                                        event
                                          .target
                                          .value,
                                    })
                                  )
                                }
                              />

                              <Input
                                type="time"
                                disabled={
                                  actionInProgress
                                }
                                value={
                                  editForm.appointmentTime
                                }
                                onChange={(
                                  event
                                ) =>
                                  setEditForm(
                                    (
                                      current
                                    ) => ({
                                      ...current,

                                      appointmentTime:
                                        event
                                          .target
                                          .value,
                                    })
                                  )
                                }
                              />
                            </div>

                            <Textarea
                              className="mt-4"
                              disabled={
                                actionInProgress
                              }
                              value={
                                editForm.notes
                              }
                              onChange={(
                                event
                              ) =>
                                setEditForm(
                                  (
                                    current
                                  ) => ({
                                    ...current,

                                    notes:
                                      event
                                        .target
                                        .value,
                                  })
                                )
                              }
                              placeholder="Internal notes"
                            />

                            <div className="mt-5 flex flex-wrap gap-2">
                              <Button
                                onClick={() =>
                                  saveAppointmentChanges(
                                    appointment
                                  )
                                }
                                disabled={
                                  actionInProgress
                                }
                                className="bg-green-600 text-white hover:bg-green-700"
                              >
                                {actionInProgress
                                  ? "Saving..."
                                  : "Save changes"}
                              </Button>

                              <Button
                                variant="outline"
                                onClick={
                                  cancelEditing
                                }
                                disabled={
                                  actionInProgress
                                }
                              >
                                Cancel
                                editing
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-3">
                                <h3 className="text-lg font-semibold text-gray-900">
                                  {
                                    appointment.customer_name
                                  }
                                </h3>

                                <span
                                  className={`rounded-full border px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                                    appointment.status
                                  )}`}
                                >
                                  {appointment.status ||
                                    "Booked"}
                                </span>

                                {appointmentCustomer &&
                                  !appointmentCustomer.is_active && (
                                    <span className="rounded-full border border-gray-200 bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                                      Customer
                                      archived
                                    </span>
                                  )}
                              </div>

                              <div className="mt-4 grid gap-x-8 gap-y-2 text-sm text-gray-600 md:grid-cols-2">
                                <p>
                                  <span className="font-medium text-gray-900">
                                    Phone:
                                  </span>{" "}
                                  {appointment.customer_phone ||
                                    "Not provided"}
                                </p>

                                <p>
                                  <span className="font-medium text-gray-900">
                                    Email:
                                  </span>{" "}
                                  {appointment.customer_email ||
                                    "Not provided"}
                                </p>

                                <p>
                                  <span className="font-medium text-gray-900">
                                    Service:
                                  </span>{" "}
                                  {appointment.service ||
                                    "Not specified"}
                                </p>

                                <p>
                                  <span className="font-medium text-gray-900">
                                    Date:
                                  </span>{" "}
                                  {appointment.appointment_date ||
                                    "Not specified"}
                                </p>

                                <p>
                                  <span className="font-medium text-gray-900">
                                    Time:
                                  </span>{" "}
                                  {formatTimeForDisplay(
                                    appointment.appointment_time
                                  )}
                                </p>
                              </div>

                              {appointment.notes && (
                                <div className="mt-4 rounded-xl bg-gray-50 px-4 py-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                    Internal
                                    notes
                                  </p>

                                  <p className="mt-1 text-sm text-gray-700">
                                    {
                                      appointment.notes
                                    }
                                  </p>
                                </div>
                              )}
                            </div>

                            <div className="flex shrink-0 flex-wrap gap-2 lg:max-w-sm lg:justify-end">
                              <Button
                                variant="outline"
                                onClick={() =>
                                  startEditingAppointment(
                                    appointment
                                  )
                                }
                                disabled={
                                  actionInProgress ||
                                  ![
                                    "Booked",
                                    "Confirmed",
                                  ].includes(
                                    appointment.status ||
                                      ""
                                  )
                                }
                              >
                                Reschedule
                              </Button>

                              {appointment.status ===
                                "Booked" && (
                                <Button
                                  onClick={() =>
                                    confirmAppointment(
                                      appointment
                                    )
                                  }
                                  disabled={
                                    actionInProgress
                                  }
                                  className="bg-green-600 text-white hover:bg-green-700"
                                >
                                  {actionInProgress
                                    ? "Working..."
                                    : "Confirm"}
                                </Button>
                              )}

                              {appointment.status ===
                                "Confirmed" && (
                                <Button
                                  onClick={() =>
                                    completeAppointment(
                                      appointment
                                    )
                                  }
                                  disabled={
                                    actionInProgress
                                  }
                                  className="bg-blue-600 text-white hover:bg-blue-700"
                                >
                                  {actionInProgress
                                    ? "Working..."
                                    : "Mark completed"}
                                </Button>
                              )}

                              {[
                                "Booked",
                                "Confirmed",
                              ].includes(
                                appointment.status ||
                                  ""
                              ) && (
                                <Button
                                  variant="outline"
                                  onClick={() =>
                                    cancelAppointment(
                                      appointment
                                    )
                                  }
                                  disabled={
                                    actionInProgress
                                  }
                                >
                                  Cancel
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                }
              )}
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
}