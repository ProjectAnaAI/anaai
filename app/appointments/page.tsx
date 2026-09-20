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
  activeBusinessHeaders,
} from "@/lib/active-business";
import {
  navigateCalendar,
  todayInTimezone,
  type CalendarView,
} from "@/lib/appointment-calendar";
import {
  createRequestKeyStore,
} from "@/lib/appointment-request-key";
import {
  normalizeCustomerPhone,
  saveCustomer,
} from "@/lib/customer-mutations";
import {
  supabase,
} from "@/lib/supabase";

import AppointmentCalendar from "@/components/appointments/AppointmentCalendar";
import AppLayout from "@/components/layout/AppLayout";
import {
  Button,
} from "@/components/ui/button";
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

type CalendarSelectedAppointment = {
  id: string;
  appointment_date: string | null;
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
    businessTimezone,
    setBusinessTimezone,
  ] = useState<
    string | null
  >(null);

  const [
    calendarView,
    setCalendarView,
  ] = useState<CalendarView>(
    "month"
  );

  const [
    selectedCalendarDate,
    setSelectedCalendarDate,
  ] = useState("");

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

      timezone:
        data.business.timezone,
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

      setBusinessTimezone(
        context.timezone
      );

      const businessToday =
  todayInTimezone(
    context.timezone
  );

if (businessToday) {
  setSelectedCalendarDate(
    businessToday
  );
}

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

  function openNewAppointment(
  date?: string
) {
  let appointmentDate =
    date ||
    selectedCalendarDate;

  if (
    !appointmentDate &&
    businessTimezone
  ) {
    appointmentDate =
      todayInTimezone(
        businessTimezone
      ) || "";
  }

  if (appointmentDate) {
    setSelectedCalendarDate(
      appointmentDate
    );

    setCreateForm(
      (current) => ({
        ...current,
        appointmentDate,
      })
    );
  }

  requestAnimationFrame(
    () => {
      document
        .getElementById(
          "new-appointment"
        )
        ?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
    }
  );
}

  function selectCalendarDate(
    date: string
  ) {
    setSelectedCalendarDate(
      date
    );
  }

  function goToCalendarToday() {
  if (!businessTimezone) {
    return;
  }

  const businessToday =
    todayInTimezone(
      businessTimezone
    );

  if (!businessToday) {
    return;
  }

  setSelectedCalendarDate(
    businessToday
  );
}

  function navigateCalendarDate(
    direction: -1 | 1
  ) {
    if (
      !selectedCalendarDate
    ) {
      return;
    }

    setSelectedCalendarDate(
      navigateCalendar(
        selectedCalendarDate,
        calendarView,
        direction
      )
    );
  }

  function openCalendarAppointment(
    appointment: CalendarSelectedAppointment
  ) {
    if (
      appointment.appointment_date
    ) {
      setSelectedCalendarDate(
        appointment.appointment_date
      );
    }

    requestAnimationFrame(
      () => {
        document
          .getElementById(
            `appointment-${appointment.id}`
          )
          ?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
      }
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6 lg:space-y-7">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-green-700">
              Scheduling
            </p>

            <h1 className="anaai-page-title mt-2">
              Appointments
            </h1>

            <p className="anaai-page-description">
              Manage bookings created by
              your team and AnaAI.
            </p>
          </div>

          <Button
            type="button"
            onClick={() =>
              openNewAppointment(
                selectedCalendarDate ||
                  undefined
              )
            }
            className="w-full sm:w-auto"
          >
            New appointment
          </Button>
        </header>

        {notice && (
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm font-medium ${
              notice.type === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : notice.type ===
                    "warning"
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {notice.message}
          </div>
        )}

        {!loading &&
          businessTimezone &&
          selectedCalendarDate && (
            <AppointmentCalendar
              appointments={
                appointments
              }
              timezone={
                businessTimezone
              }
              selectedDate={
                selectedCalendarDate
              }
              view={
                calendarView
              }
              onSelectedDateChange={
                selectCalendarDate
              }
              onViewChange={
                setCalendarView
              }
              onToday={
                goToCalendarToday
              }
              onPrevious={() =>
                navigateCalendarDate(
                  -1
                )
              }
              onNext={() =>
                navigateCalendarDate(
                  1
                )
              }
              onNewAppointment={
                openNewAppointment
              }
              onAppointmentSelect={
                openCalendarAppointment
              }
            />
          )}

        <section
          id="new-appointment"
          className="anaai-surface scroll-mt-24 overflow-hidden"
        >
          <div className="border-b border-gray-100 px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="anaai-section-title">
                  New appointment
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Add a booking to the
                  business schedule.
                </p>
              </div>

              <span className="inline-flex w-fit rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                Manual booking
              </span>
            </div>
          </div>

          <div className="p-5 sm:p-6">
            <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
              <div className="min-w-0 space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-gray-950">
                    Customer
                  </h3>

                  <p className="mt-1 text-xs leading-5 text-gray-500">
                    Search active customers
                    or enter a new customer.
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium text-gray-700">
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

                  <label className="space-y-2 text-sm font-medium text-gray-700">
                    <span>
                      Phone number
                      <span className="ml-1 font-normal text-gray-400">
                        Optional
                      </span>
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
                      placeholder="Search by phone"
                    />
                  </label>
                </div>

                {selectedCreateCustomer ? (
                  <div
                    role="status"
                    className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 text-sm font-bold text-green-700">
                      {selectedCreateCustomer.full_name
                        .charAt(0)
                        .toUpperCase()}
                    </div>

                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-green-900">
                        {
                          selectedCreateCustomer.full_name
                        }
                      </p>

                      <p className="mt-0.5 text-xs leading-5 text-green-700">
                        Existing customer
                        selected
                        {selectedCreateCustomer.phone
                          ? ` · ${selectedCreateCustomer.phone}`
                          : ""}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p
                      role="status"
                      className="text-sm leading-6 text-gray-500"
                    >
                      {matchingCustomers.length
                        ? "Matching active customers — select one below, or continue with a new customer."
                        : customerName.trim() ||
                            customerPhone.trim()
                          ? "No active customer selected. A new customer will be created when this appointment is saved."
                          : "Enter a customer name. Phone and email are optional."}
                    </p>

                    {customerPhone.trim() && (
                      <p className="text-xs leading-5 text-gray-400">
                        Phone matches take
                        priority. Clear the
                        phone field to search
                        by name.
                      </p>
                    )}

                    {matchingCustomers.length >
                      0 && (
                      <div className="max-h-52 space-y-2 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-2">
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
                              className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5 text-left transition hover:bg-green-50 disabled:opacity-50"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-gray-900">
                                  {
                                    customer.full_name
                                  }
                                </p>

                                <p className="mt-0.5 truncate text-xs text-gray-500">
                                  {customer.phone ||
                                    "No phone number"}
                                  {customer.email
                                    ? ` · ${customer.email}`
                                    : ""}
                                </p>
                              </div>

                              <span className="shrink-0 text-xs font-semibold text-green-700">
                                Select
                              </span>
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}

                <label className="block space-y-2 text-sm font-medium text-gray-700">
                  <span>
                    Email
                    <span className="ml-1 font-normal text-gray-400">
                      Optional
                    </span>
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
                    placeholder="customer@example.com"
                  />
                </label>
              </div>

              <div className="min-w-0 rounded-2xl bg-gray-50 p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-gray-950">
                  Appointment details
                </h3>

                <div className="mt-4 space-y-4">
                  <label className="block space-y-2 text-sm font-medium text-gray-700">
                    <span>
                      Service
                    </span>

                    <select
                      className="min-h-11 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
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
                        Select service
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
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <label className="block space-y-2 text-sm font-medium text-gray-700">
                      <span>
                        Date
                      </span>

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
                        ) => {
                          const date =
                            event
                              .target
                              .value;

                          setCreateForm(
                            (
                              current
                            ) => ({
                              ...current,

                              appointmentDate:
                                date,
                            })
                          );

                          if (date) {
                            setSelectedCalendarDate(
                              date
                            );
                          }
                        }}
                      />
                    </label>

                    <label className="block space-y-2 text-sm font-medium text-gray-700">
                      <span>
                        Time
                      </span>

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
                    </label>
                  </div>

                  <label className="block space-y-2 text-sm font-medium text-gray-700">
                    <span>
                      Internal notes
                    </span>

                    <Textarea
                      disabled={
                        submitting
                      }
                      placeholder="Add notes for your team"
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
                  </label>

                  <Button
                    type="button"
                    onClick={
                      handleCreateAppointment
                    }
                    disabled={
                      submitting ||
                      !businessId ||
                      !userId
                    }
                    className="w-full"
                  >
                    {submitting
                      ? "Saving appointment..."
                      : "Save appointment"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          id="appointment-schedule"
          className="anaai-surface scroll-mt-24 overflow-hidden"
        >
          <div className="flex flex-col gap-4 border-b border-gray-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="anaai-section-title">
                Schedule
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Confirm, reschedule,
                complete, or cancel
                customer appointments.
              </p>
            </div>

            {!loading && (
              <div className="inline-flex w-fit rounded-full bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600">
                {appointments.length}{" "}
                {appointments.length ===
                1
                  ? "appointment"
                  : "appointments"}
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex min-h-48 items-center justify-center px-5 py-10">
              <div className="text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

                <p className="mt-3 text-sm font-medium text-gray-500">
                  Loading
                  appointments...
                </p>
              </div>
            </div>
          ) : appointments.length ===
            0 ? (
            <div className="px-5 py-12 text-center sm:px-6">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-green-50 text-xl">
                📅
              </div>

              <h3 className="mt-4 font-semibold text-gray-950">
                No appointments yet
              </h3>

              <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                New bookings will
                appear here once they
                are created.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
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
                    <article
                      id={`appointment-${appointment.id}`}
                      key={
                        appointment.id
                      }
                      className="scroll-mt-24 px-5 py-5 sm:px-6"
                    >
                      {isEditing ? (
                        <div className="rounded-2xl border border-green-200 bg-green-50/40 p-4 sm:p-5">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wide text-green-700">
                                Reschedule
                                appointment
                              </p>

                              <h3 className="mt-1 text-lg font-semibold text-gray-950">
                                {
                                  appointment.customer_name
                                }
                              </h3>
                            </div>

                            <span
                              className={`w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClasses(
                                appointment.status
                              )}`}
                            >
                              {appointment.status ||
                                "Booked"}
                            </span>
                          </div>

                          {appointmentCustomer &&
                            !appointmentCustomer.is_active && (
                              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
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
                                be newly assigned.
                              </div>
                            )}

                          <div className="mt-5 grid gap-4 sm:grid-cols-2">
                            <label className="space-y-2 text-sm font-medium text-gray-700">
                              <span>
                                Customer
                              </span>

                              <select
                                className="min-h-11 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none"
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
                            </label>

                            <label className="space-y-2 text-sm font-medium text-gray-700">
                              <span>
                                Service
                              </span>

                              <select
                                className="min-h-11 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none"
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
                            </label>

                            <label className="space-y-2 text-sm font-medium text-gray-700">
                              <span>
                                Date
                              </span>

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
                            </label>

                            <label className="space-y-2 text-sm font-medium text-gray-700">
                              <span>
                                Time
                              </span>

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
                            </label>
                          </div>

                          <label className="mt-4 block space-y-2 text-sm font-medium text-gray-700">
                            <span>
                              Internal notes
                            </span>

                            <Textarea
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
                          </label>

                          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                            <Button
                              onClick={() =>
                                saveAppointmentChanges(
                                  appointment
                                )
                              }
                              disabled={
                                actionInProgress
                              }
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
                              Cancel editing
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-base font-semibold text-gray-950 sm:text-lg">
                                {
                                  appointment.customer_name
                                }
                              </h3>

                              <span
                                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClasses(
                                  appointment.status
                                )}`}
                              >
                                {appointment.status ||
                                  "Booked"}
                              </span>

                              {appointmentCustomer &&
                                !appointmentCustomer.is_active && (
                                  <span className="rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">
                                    Customer
                                    archived
                                  </span>
                                )}
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                              <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                                <p className="text-xs font-medium text-gray-400">
                                  Date
                                </p>

                                <p className="mt-1 text-sm font-semibold text-gray-800">
                                  {appointment.appointment_date ||
                                    "Not specified"}
                                </p>
                              </div>

                              <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                                <p className="text-xs font-medium text-gray-400">
                                  Time
                                </p>

                                <p className="mt-1 text-sm font-semibold text-gray-800">
                                  {formatTimeForDisplay(
                                    appointment.appointment_time
                                  )}
                                </p>
                              </div>

                              <div className="rounded-xl bg-gray-50 px-3.5 py-3 sm:col-span-2 lg:col-span-1">
                                <p className="text-xs font-medium text-gray-400">
                                  Service
                                </p>

                                <p className="mt-1 truncate text-sm font-semibold text-gray-800">
                                  {appointment.service ||
                                    "Not specified"}
                                </p>
                              </div>
                            </div>

                            <div className="mt-4 grid gap-x-6 gap-y-2 text-sm text-gray-500 sm:grid-cols-2">
                              <p className="min-w-0 break-words">
                                <span className="font-medium text-gray-700">
                                  Phone:
                                </span>{" "}
                                {appointment.customer_phone ||
                                  "Not provided"}
                              </p>

                              <p className="min-w-0 break-words">
                                <span className="font-medium text-gray-700">
                                  Email:
                                </span>{" "}
                                {appointment.customer_email ||
                                  "Not provided"}
                              </p>
                            </div>

                            {appointment.notes && (
                              <div className="mt-4 rounded-xl border border-gray-100 bg-gray-50/70 px-4 py-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                  Internal notes
                                </p>

                                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                                  {
                                    appointment.notes
                                  }
                                </p>
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 flex-wrap gap-2 xl:max-w-[300px] xl:justify-end">
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
                                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </article>
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