"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { activeBusinessHeaders } from "@/lib/active-business";
import { saveCustomer, normalizeCustomerPhone } from "@/lib/customer-mutations";
import { supabase } from "@/lib/supabase";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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
};

type Service = {
  id: string;
  name: string;
  duration_minutes: number | null;
};

type BusinessDay = {
  open: string;
  close: string;
  closed: boolean;
};

type BusinessHours = {
  monday?: BusinessDay;
  tuesday?: BusinessDay;
  wednesday?: BusinessDay;
  thursday?: BusinessDay;
  friday?: BusinessDay;
  saturday?: BusinessDay;
  sunday?: BusinessDay;
};

type BusinessProfile = {
  id: string;
  business_hours: string | null;
};

type Notice = {
  type: "success" | "warning" | "error";
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
    role: "owner" | "manager" | "staff";
  };
};

const emptyForm: AppointmentFormValues = {
  customerId: "",
  serviceId: "",
  appointmentDate: "",
  appointmentTime: "",
  notes: "",
};

function normalizeCustomerName(value: string) {
  return value.trim().toLowerCase();
}

function findCustomerMatches(customers: Customer[], name: string, phone: string) {
  const normalizedName = normalizeCustomerName(name);
  const normalizedPhone = normalizeCustomerPhone(phone);

  // Phone takes precedence over names; never infer identity from a name alone.
  if (phone.trim()) {
    if (!normalizedPhone) return [];
    const exactMatches = customers.filter(
      (customer) => normalizeCustomerPhone(customer.phone || "") === normalizedPhone
    );
    if (exactMatches.length) return exactMatches;
    return customers.filter((customer) =>
      normalizeCustomerPhone(customer.phone || "").includes(normalizedPhone)
    );
  }

  if (!normalizedName) return [];
  return customers.filter((customer) =>
    normalizeCustomerName(customer.full_name).includes(normalizedName)
  );
}

function normalizeTime(value: string | null) {
  if (!value) {
    return "";
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);

  if (!match) {
    return value;
  }

  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function timeToMinutes(value: string) {
  const normalized = normalizeTime(value);
  const [hours, minutes] = normalized.split(":").map(Number);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function getDayKey(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const dayKeys = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ] as const;

  return dayKeys[parsed.getUTCDay()];
}

function parseBusinessHours(value: string | null): BusinessHours | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed as BusinessHours;
  } catch {
    return null;
  }
}

function intervalsOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
) {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function formatTimeForDisplay(value: string | null) {
  const normalized = normalizeTime(value);

  if (!normalized) {
    return "Not specified";
  }

  const [hourText, minuteText] = normalized.split(":");

  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return value || "Not specified";
  }

  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function statusBadgeClasses(status: string | null) {
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
  const router = useRouter();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [services, setServices] = useState<Service[]>([]);

  const [businessProfile, setBusinessProfile] =
    useState<BusinessProfile | null>(null);

  const [businessId, setBusinessId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [actionAppointmentId, setActionAppointmentId] =
    useState<string | null>(null);

  const [createForm, setCreateForm] =
    useState<AppointmentFormValues>(emptyForm);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const createInFlight = useRef(false);

  const matchingCustomers = findCustomerMatches(customers, customerName, customerPhone);
  const selectedCreateCustomer = customers.find(
    (customer) => customer.id === createForm.customerId
  );

  function updateCustomerLookup(field: "name" | "phone", value: string) {
    if (field === "name") setCustomerName(value);
    else setCustomerPhone(value);
    // Require explicit selection again after editing either identity field.
    setCreateForm((current) => ({ ...current, customerId: "" }));
  }

  function selectCreateCustomer(customer: Customer) {
    setCustomerEmail(customer.email || "");
    setCustomerName(customer.full_name);
    setCustomerPhone(customer.phone || "");
    setCreateForm((current) => ({ ...current, customerId: customer.id }));
  }

  const [editingAppointmentId, setEditingAppointmentId] =
    useState<string | null>(null);

  const [editForm, setEditForm] =
    useState<AppointmentFormValues>(emptyForm);

  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    initializePage();
  }, []);

  function showNotice(
    type: "success" | "warning" | "error",
    message: string
  ) {
    setNotice({
      type,
      message,
    });

    if (type === "success") {
      toast.success(message);
    }

    if (type === "warning") {
      toast.warning(message);
    }

    if (type === "error") {
      toast.error(message);
    }
  }

  async function getAccessToken() {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error || !session?.access_token) {
      router.push("/login");
      return null;
    }

    return session.access_token;
  }

  async function getAuthenticatedContext() {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session?.access_token || !session.user) {
      return null;
    }

    const response = await fetch("/api/current-business", {
      method: "GET",
      headers: {
        ...activeBusinessHeaders(),
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    const data = (await response.json()) as CurrentBusinessResponse;

    if (!response.ok || !data.success || !data.business) {
      console.error("Could not resolve current business:", data.error);
      return null;
    }

    return {
      userId: session.user.id,
      businessId: data.business.id,
    };
  }

  async function initializePage() {
    setLoading(true);

    const context = await getAuthenticatedContext();

    if (!context) {
      setLoading(false);
      router.push("/login");
      return;
    }

    setUserId(context.userId);
    setBusinessId(context.businessId);

    await loadAppointments(context.businessId);

    setLoading(false);
  }

  async function loadAppointments(selectedBusinessId?: string) {
    const activeBusinessId = selectedBusinessId ?? businessId;

    if (!activeBusinessId) {
      return;
    }

    const [
      customerResult,
      serviceResult,
      appointmentResult,
      businessResult,
    ] = await Promise.all([
      supabase
        .from("customers")
        .select("id, full_name, phone, email")
        .eq("business_id", activeBusinessId)
        .order("full_name"),

      supabase
        .from("services")
        .select("id, name, duration_minutes")
        .eq("business_id", activeBusinessId)
        .eq("is_active", true)
        .order("name"),

      supabase
        .from("appointments")
        .select(
          "id, customer_id, service_id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status, notes"
        )
        .eq("business_id", activeBusinessId)
        .order("appointment_date", {
          ascending: true,
        })
        .order("appointment_time", {
          ascending: true,
        }),

      supabase
        .from("business_profiles")
        .select("id, business_hours")
        .eq("business_id", activeBusinessId)
        .order("created_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle(),
    ]);

    if (customerResult.error) {
      showNotice("error", customerResult.error.message);
    } else {
      setCustomers(customerResult.data || []);
    }

    if (serviceResult.error) {
      showNotice("error", serviceResult.error.message);
    } else {
      setServices(serviceResult.data || []);
    }

    if (appointmentResult.error) {
      showNotice("error", appointmentResult.error.message);
    } else {
      setAppointments(appointmentResult.data || []);
    }

    if (businessResult.error) {
      showNotice("error", businessResult.error.message);
    } else {
      setBusinessProfile(businessResult.data || null);
    }
  }

  async function validateAppointmentAvailability({
    activeBusinessId,
    serviceId,
    appointmentDate,
    appointmentTime,
    excludeAppointmentId,
  }: {
    activeBusinessId: string;
    serviceId: string;
    appointmentDate: string;
    appointmentTime: string;
    excludeAppointmentId?: string;
  }) {
    const selectedService = services.find(
      (service) => service.id === serviceId
    );

    if (!selectedService) {
      return {
        valid: false,
        message: "Please select a valid service.",
      };
    }

    if (
      selectedService.duration_minutes == null ||
      selectedService.duration_minutes <= 0
    ) {
      return {
        valid: false,
        message: `${selectedService.name} does not have a valid duration configured.`,
      };
    }

    const durationMinutes = selectedService.duration_minutes;

    const requestedStart = timeToMinutes(appointmentTime);

    if (requestedStart == null) {
      return {
        valid: false,
        message: "The appointment time is invalid.",
      };
    }

    const requestedEnd = requestedStart + durationMinutes;

    const businessHours = parseBusinessHours(
      businessProfile?.business_hours ?? null
    );

    if (!businessHours) {
      return {
        valid: false,
        message:
          "Business hours are not configured correctly. Update them on the Business page before scheduling appointments.",
      };
    }

    const dayKey = getDayKey(appointmentDate);

    if (!dayKey) {
      return {
        valid: false,
        message: "The appointment date is invalid.",
      };
    }

    const dayHours = businessHours[dayKey];

    if (!dayHours) {
      return {
        valid: false,
        message:
          "Business hours are not configured for the selected day.",
      };
    }

    if (dayHours.closed) {
      return {
        valid: false,
        message: "The business is closed on the selected day.",
      };
    }

    const openMinutes = timeToMinutes(dayHours.open);
    const closeMinutes = timeToMinutes(dayHours.close);

    if (openMinutes == null || closeMinutes == null) {
      return {
        valid: false,
        message:
          "The business hours for the selected day are invalid.",
      };
    }

    if (requestedStart < openMinutes) {
      return {
        valid: false,
        message: `The appointment cannot start before the business opens at ${dayHours.open}.`,
      };
    }

    if (requestedEnd > closeMinutes) {
      return {
        valid: false,
        message: `${selectedService.name} takes ${durationMinutes} minutes and would finish after closing time at ${dayHours.close}.`,
      };
    }

    const { data: sameDayAppointments, error } = await supabase
      .from("appointments")
      .select("id, service_id, service, appointment_time, status")
      .eq("business_id", activeBusinessId)
      .eq("appointment_date", appointmentDate)
      .in("status", ["Booked", "Confirmed"]);

    if (error) {
      return {
        valid: false,
        message: `Could not check appointment availability: ${error.message}`,
      };
    }

    for (const existingAppointment of sameDayAppointments || []) {
      if (
        excludeAppointmentId &&
        existingAppointment.id === excludeAppointmentId
      ) {
        continue;
      }

      const existingStart = timeToMinutes(
        existingAppointment.appointment_time
      );

      if (existingStart == null) {
        continue;
      }

      let existingService = services.find(
        (service) => service.id === existingAppointment.service_id
      );

      if (!existingService && existingAppointment.service) {
        existingService = services.find(
          (service) =>
            service.name.toLowerCase() ===
            existingAppointment.service.toLowerCase()
        );
      }

      if (
        !existingService ||
        existingService.duration_minutes == null ||
        existingService.duration_minutes <= 0
      ) {
        return {
          valid: false,
          message:
            "An existing appointment does not have a valid service duration, so this time cannot be safely checked.",
        };
      }

      const existingEnd =
        existingStart + existingService.duration_minutes;

      if (
        intervalsOverlap(
          requestedStart,
          requestedEnd,
          existingStart,
          existingEnd
        )
      ) {
        return {
          valid: false,
          message:
            "That time conflicts with another booked or confirmed appointment.",
        };
      }
    }

    return {
      valid: true,
      message: "",
    };
  }

  async function sendAppointmentUpdate({
    appointmentId,
    updates,
    notificationType,
    creating = false,
  }: {
    appointmentId?: string;
    creating?: boolean;
    updates: Record<string, string | null>;
    notificationType:
      | "confirm"
      | "reschedule"
      | "cancel"
      | "none";
  }) {
    if (!businessId) throw new Error("Business context is unavailable.");

    const accessToken = await getAccessToken();

    if (!accessToken) {
      throw new Error("Your session has expired. Please log in again.");
    }

    const response = await fetch("/api/appointments", {
      method: creating ? "POST" : "PATCH",
      headers: {
        ...activeBusinessHeaders(),
        "x-anaai-business-id": businessId,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        appointmentId,
        ...updates,
        notificationType,
      }),
    });

    const result =
      (await response.json()) as AppointmentUpdateResponse;

    if (!response.ok || result?.success !== true) {
      throw new Error(
        result?.error || "Appointment update failed."
      );
    }

    return result;
  }

  async function handleCreateAppointment() {
    if (createInFlight.current) return;
    if (!businessId || !userId) {
      showNotice(
        "error",
        "Business context is not available."
      );
      return;
    }

    let selectedCustomer = customers.find(
      (customer) => customer.id === createForm.customerId
    );

    const selectedService = services.find(
      (service) => service.id === createForm.serviceId
    );

    if (
      createForm.customerId && (!selectedCustomer ||
      normalizeCustomerName(customerName) !== normalizeCustomerName(selectedCustomer.full_name) ||
      normalizeCustomerPhone(customerPhone) !== normalizeCustomerPhone(selectedCustomer.phone || ""))
    ) {
      showNotice("warning", "Please select an existing customer from the matches.");
      return;
    }

    if (!selectedService) {
      showNotice("warning", "Please select a service.");
      return;
    }

    if (!createForm.appointmentDate) {
      showNotice(
        "warning",
        "Please select an appointment date."
      );
      return;
    }

    if (!createForm.appointmentTime) {
      showNotice(
        "warning",
        "Please select an appointment time."
      );
      return;
    }

    createInFlight.current = true;
    setSubmitting(true);

    try {
      if (!selectedCustomer) {
        selectedCustomer = await saveCustomer(businessId, { name: customerName, phone: customerPhone, email: customerEmail });
        // Preserve selection even when booking fails, so retry never creates
        // another customer. Editing identity explicitly clears this selection.
        const savedCustomer = selectedCustomer;
        setCustomers(current => [...current.filter(item => item.id !== savedCustomer.id), savedCustomer]);
        selectCreateCustomer(savedCustomer);
      }
      await sendAppointmentUpdate({
        creating: true,
        updates: {
          customerId: selectedCustomer.id,
          serviceId: selectedService.id,
          appointmentDate: createForm.appointmentDate,
          appointmentTime: createForm.appointmentTime,
          notes: createForm.notes.trim() || null,
        },
        notificationType: "none",
      });
      showNotice("success", "Appointment created successfully.");
      setCreateForm(emptyForm);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
      await loadAppointments();
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "Could not create appointment.");
    } finally {
      createInFlight.current = false;
      setSubmitting(false);
    }
  }

  function startEditingAppointment(
    appointment: Appointment
  ) {
    setEditingAppointmentId(appointment.id);

    setEditForm({
      customerId: appointment.customer_id || "",
      serviceId: appointment.service_id || "",
      appointmentDate: appointment.appointment_date || "",
      appointmentTime: normalizeTime(
        appointment.appointment_time
      ),
      notes: appointment.notes || "",
    });

    setNotice(null);
  }

  function cancelEditing() {
    setEditingAppointmentId(null);
    setEditForm(emptyForm);
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

    const selectedCustomer = customers.find(
      (customer) => customer.id === editForm.customerId
    );

    const selectedService = services.find(
      (service) => service.id === editForm.serviceId
    );

    if (!selectedCustomer) {
      showNotice("warning", "Please select a customer.");
      return;
    }

    if (!selectedService) {
      showNotice("warning", "Please select a service.");
      return;
    }

    if (!editForm.appointmentDate) {
      showNotice(
        "warning",
        "Please select an appointment date."
      );
      return;
    }

    if (!editForm.appointmentTime) {
      showNotice(
        "warning",
        "Please select an appointment time."
      );
      return;
    }

    setActionAppointmentId(appointment.id);

    try {
      const dateChanged =
        appointment.appointment_date !==
        editForm.appointmentDate;

      const timeChanged =
        normalizeTime(appointment.appointment_time) !==
        normalizeTime(editForm.appointmentTime);

      const serviceChanged =
        appointment.service_id !== selectedService.id;

      const wasRescheduled =
        dateChanged || timeChanged || serviceChanged;

      const result = await sendAppointmentUpdate({
        appointmentId: appointment.id,
        updates: {
          customerId: selectedCustomer.id,
          serviceId: selectedService.id,
          appointmentDate: editForm.appointmentDate,
          appointmentTime: editForm.appointmentTime,
          notes: editForm.notes.trim() || null,
        },
        notificationType: wasRescheduled
          ? "reschedule"
          : "none",
      });

      if (wasRescheduled && result.sms_sent) {
        showNotice(
          "success",
          "Appointment rescheduled and customer SMS sent."
        );
      } else if (wasRescheduled && !result.sms_sent) {
        showNotice(
          "warning",
          "Appointment rescheduled successfully, but the customer SMS could not be sent."
        );
      } else {
        showNotice(
          "success",
          "Appointment updated successfully."
        );
      }

      setEditingAppointmentId(null);
      setEditForm(emptyForm);

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Appointment update failed."
      );
    } finally {
      setActionAppointmentId(null);
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

    if (
      !appointment.service_id ||
      !appointment.appointment_date ||
      !appointment.appointment_time
    ) {
      showNotice(
        "warning",
        "This appointment is missing scheduling information."
      );
      return;
    }

    setActionAppointmentId(appointment.id);

    try {
      const availability =
        await validateAppointmentAvailability({
          activeBusinessId: businessId,
          serviceId: appointment.service_id,
          appointmentDate: appointment.appointment_date,
          appointmentTime: appointment.appointment_time,
          excludeAppointmentId: appointment.id,
        });

      if (!availability.valid) {
        showNotice("warning", availability.message);
        return;
      }

      const result = await sendAppointmentUpdate({
        appointmentId: appointment.id,
        updates: {
          status: "Confirmed",
        },
        notificationType: "confirm",
      });

      if (result.sms_sent) {
        showNotice(
          "success",
          "Appointment confirmed and customer SMS sent."
        );
      } else {
        showNotice(
          "warning",
          "Appointment confirmed successfully, but the customer SMS could not be sent."
        );
      }

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not confirm appointment."
      );
    } finally {
      setActionAppointmentId(null);
    }
  }

  async function cancelAppointment(
    appointment: Appointment
  ) {
    const confirmed = window.confirm(
      `Cancel the appointment for ${appointment.customer_name}?`
    );

    if (!confirmed) {
      return;
    }

    setActionAppointmentId(appointment.id);

    try {
      const result = await sendAppointmentUpdate({
        appointmentId: appointment.id,
        updates: {
          status: "Cancelled",
        },
        notificationType: "cancel",
      });

      if (result.sms_sent) {
        showNotice(
          "success",
          "Appointment cancelled and customer SMS sent."
        );
      } else {
        showNotice(
          "warning",
          "Appointment cancelled successfully, but the customer SMS could not be sent."
        );
      }

      await loadAppointments();
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not cancel appointment."
      );
    } finally {
      setActionAppointmentId(null);
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
            Manage bookings created by your team and AnaAI.
          </p>
        </header>

        {notice && (
          <div
            className={`mt-6 rounded-xl border px-4 py-3 text-sm font-medium ${
              notice.type === "success"
                ? "border-green-200 bg-green-50 text-green-700"
                : notice.type === "warning"
                ? "border-yellow-200 bg-yellow-50 text-yellow-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {notice.message}
          </div>
        )}

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>New appointment</CardTitle>
          </CardHeader>

          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-4 md:col-span-2">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium">
                    <span>Customer name</span>
                    <Input
                      disabled={submitting}
                      value={customerName}
                      onChange={(event) => updateCustomerLookup("name", event.target.value)}
                      placeholder="Search by name"
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium">
                    <span>Phone number (optional)</span>
                    <Input
                      type="tel"
                      disabled={submitting}
                      value={customerPhone}
                      onChange={(event) => updateCustomerLookup("phone", event.target.value)}
                      placeholder="Search by phone number"
                    />
                  </label>
                </div>
                {selectedCreateCustomer ? (
                  <p role="status" className="text-sm text-green-700">
                    Existing customer selected: {selectedCreateCustomer.full_name}
                    {" — "}{selectedCreateCustomer.phone || "No phone number"}
                  </p>
                ) : (
                  <div className="space-y-2 text-sm">
                    <p className="text-gray-600" role="status">
                      {matchingCustomers.length
                        ? "Matching customers — select one, or save as a new customer if this is someone else."
                        : customerName.trim() || customerPhone.trim()
                        ? "New customer — created when you save the appointment."
                        : "Enter a customer name. Phone and email are optional."}
                    </p>
                    {customerPhone.trim() && (
                      <p className="text-gray-500">Phone matches take priority. Clear the phone field to search by name.</p>
                    )}
                    <div className="max-h-48 space-y-2 overflow-y-auto">
                      {matchingCustomers.map((customer) => (
                        <button
                          key={customer.id}
                          type="button"
                          disabled={submitting}
                          onClick={() => selectCreateCustomer(customer)}
                          className="block w-full rounded-lg border border-input px-3 py-2 text-left hover:bg-gray-50"
                        >
                          {customer.full_name}{" — "}{customer.phone || "No phone number"}
                          {customer.email ? ` · ${customer.email}` : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="block space-y-2 text-sm">
                  <span>Email (optional)</span>
                  <Input type="email" value={customerEmail} disabled={submitting || Boolean(selectedCreateCustomer)} onChange={event => setCustomerEmail(event.target.value)} />
                </label>
              </div>

              <select
                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none"
                value={createForm.serviceId}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    serviceId: event.target.value,
                  }))
                }
              >
                <option value="">Select service</option>

                {services.map((service) => (
                  <option
                    key={service.id}
                    value={service.id}
                  >
                    {service.name}
                    {service.duration_minutes
                      ? ` · ${service.duration_minutes} min`
                      : ""}
                  </option>
                ))}
              </select>

              <Input
                type="date"
                value={createForm.appointmentDate}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    appointmentDate: event.target.value,
                  }))
                }
              />

              <Input
                type="time"
                value={createForm.appointmentTime}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    appointmentTime: event.target.value,
                  }))
                }
              />
            </div>

            <Textarea
              className="mt-4"
              placeholder="Internal notes"
              value={createForm.notes}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
            />

            <button
              type="button"
              onClick={handleCreateAppointment}
              disabled={
                submitting || !businessId || !userId
              }
              className="mt-5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
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
              Confirm, reschedule, or cancel customer appointments.
            </p>
          </div>

          {loading ? (
            <p className="mt-4 text-gray-500">
              Loading appointments...
            </p>
          ) : appointments.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No appointments yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                New bookings will appear here once they are created.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {appointments.map((appointment) => {
                const isEditing =
                  editingAppointmentId === appointment.id;

                const actionInProgress =
                  actionAppointmentId === appointment.id;

                return (
                  <Card
                    key={appointment.id}
                    className="overflow-hidden"
                  >
                    <CardContent className="p-5">
                      {isEditing ? (
                        <div>
                          <p className="text-sm font-medium text-green-600">
                            Reschedule appointment
                          </p>

                          <h3 className="mt-1 text-lg font-semibold text-gray-900">
                            {appointment.customer_name}
                          </h3>

                          <div className="mt-5 grid gap-4 md:grid-cols-2">
                            <select
                              className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                              value={editForm.customerId}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...current,
                                  customerId: event.target.value,
                                }))
                              }
                            >
                              {customers.map((customer) => (
                                <option
                                  key={customer.id}
                                  value={customer.id}
                                >
                                  {customer.full_name}
                                </option>
                              ))}
                            </select>

                            <select
                              className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                              value={editForm.serviceId}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...current,
                                  serviceId: event.target.value,
                                }))
                              }
                            >
                              {services.map((service) => (
                                <option
                                  key={service.id}
                                  value={service.id}
                                >
                                  {service.name}
                                </option>
                              ))}
                            </select>

                            <Input
                              type="date"
                              value={editForm.appointmentDate}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...current,
                                  appointmentDate:
                                    event.target.value,
                                }))
                              }
                            />

                            <Input
                              type="time"
                              value={editForm.appointmentTime}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...current,
                                  appointmentTime:
                                    event.target.value,
                                }))
                              }
                            />
                          </div>

                          <Textarea
                            className="mt-4"
                            value={editForm.notes}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...current,
                                notes: event.target.value,
                              }))
                            }
                            placeholder="Internal notes"
                          />

                          <div className="mt-5 flex gap-2">
                            <Button
                              onClick={() =>
                                saveAppointmentChanges(
                                  appointment
                                )
                              }
                              disabled={actionInProgress}
                              className="bg-green-600 text-white hover:bg-green-700"
                            >
                              {actionInProgress
                                ? "Saving..."
                                : "Save changes"}
                            </Button>

                            <Button
                              variant="outline"
                              onClick={cancelEditing}
                              disabled={actionInProgress}
                            >
                              Cancel editing
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-3">
                              <h3 className="text-lg font-semibold text-gray-900">
                                {appointment.customer_name}
                              </h3>

                              <span
                                className={`rounded-full border px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                                  appointment.status
                                )}`}
                              >
                                {appointment.status || "Booked"}
                              </span>
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
                                  Internal notes
                                </p>

                                <p className="mt-1 text-sm text-gray-700">
                                  {appointment.notes}
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
                                appointment.status ===
                                  "Cancelled"
                              }
                            >
                              Reschedule
                            </Button>

                            {appointment.status !==
                              "Confirmed" &&
                              appointment.status !==
                                "Cancelled" && (
                                <Button
                                  onClick={() =>
                                    confirmAppointment(
                                      appointment
                                    )
                                  }
                                  disabled={actionInProgress}
                                  className="bg-green-600 text-white hover:bg-green-700"
                                >
                                  Confirm
                                </Button>
                              )}

                            {appointment.status !==
                              "Cancelled" && (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  cancelAppointment(
                                    appointment
                                  )
                                }
                                disabled={actionInProgress}
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
              })}
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
}