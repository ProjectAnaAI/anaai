"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  status: string;
};

const emptyForm: AppointmentFormValues = {
  customerId: "",
  serviceId: "",
  appointmentDate: "",
  appointmentTime: "",
  notes: "",
  status: "Booked",
};

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

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    return value || "Not specified";
  }

  const date = new Date();
  date.setHours(hour, minute, 0, 0);

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
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

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [actionAppointmentId, setActionAppointmentId] =
    useState<string | null>(null);

  const [createForm, setCreateForm] =
    useState<AppointmentFormValues>(emptyForm);

  const [editingAppointmentId, setEditingAppointmentId] =
    useState<string | null>(null);

  const [editForm, setEditForm] =
    useState<AppointmentFormValues>(emptyForm);

  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    loadAppointments();
  }, []);

  function showNotice(
    type: "success" | "warning" | "error",
    message: string
  ) {
    setNotice({ type, message });

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

  async function getCurrentUser() {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      router.push("/login");
      return null;
    }

    return user;
  }

  async function loadAppointments() {
    setLoading(true);

    const user = await getCurrentUser();

    if (!user) {
      setLoading(false);
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
        .eq("user_id", user.id)
        .order("full_name"),

      supabase
        .from("services")
        .select("id, name, duration_minutes")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("name"),

      supabase
        .from("appointments")
        .select(
          "id, customer_id, service_id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status, notes"
        )
        .eq("user_id", user.id)
        .order("appointment_date", {
          ascending: true,
        })
        .order("appointment_time", {
          ascending: true,
        }),

      supabase
        .from("business_profiles")
        .select("id, business_hours")
        .eq("user_id", user.id)
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

    setLoading(false);
  }

  async function validateAppointmentAvailability({
    userId,
    serviceId,
    appointmentDate,
    appointmentTime,
    status,
    excludeAppointmentId,
  }: {
    userId: string;
    serviceId: string;
    appointmentDate: string;
    appointmentTime: string;
    status: string;
    excludeAppointmentId?: string;
  }) {
    /*
     * Cancelled and completed appointments are not active scheduling
     * reservations, so we do not need to reject their time slot.
     */
    if (
      status === "Cancelled" ||
      status === "Completed"
    ) {
      return {
        valid: true,
        message: "",
      };
    }

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

    if (
      openMinutes == null ||
      closeMinutes == null
    ) {
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

    const {
      data: sameDayAppointments,
      error,
    } = await supabase
      .from("appointments")
      .select(
        "id, service_id, service, appointment_time, status"
      )
      .eq("user_id", userId)
      .eq("appointment_date", appointmentDate)
      .in("status", ["Booked", "Confirmed"]);

    if (error) {
      return {
        valid: false,
        message: `Could not check appointment availability: ${error.message}`,
      };
    }

    const blockingAppointments =
      sameDayAppointments || [];

    for (const existingAppointment of blockingAppointments) {
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
        (service) =>
          service.id === existingAppointment.service_id
      );

      if (
        !existingService &&
        existingAppointment.service
      ) {
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
        existingStart +
        existingService.duration_minutes;

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

  async function handleCreateAppointment() {
    const user = await getCurrentUser();

    if (!user) {
      return;
    }

    const selectedCustomer = customers.find(
      (customer) =>
        customer.id === createForm.customerId
    );

    const selectedService = services.find(
      (service) =>
        service.id === createForm.serviceId
    );

    if (!selectedCustomer) {
      showNotice(
        "warning",
        "Please select a customer."
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

    setSubmitting(true);

    const availability =
      await validateAppointmentAvailability({
        userId: user.id,
        serviceId: selectedService.id,
        appointmentDate:
          createForm.appointmentDate,
        appointmentTime:
          createForm.appointmentTime,
        status: "Booked",
      });

    if (!availability.valid) {
      setSubmitting(false);
      showNotice(
        "warning",
        availability.message
      );
      return;
    }

    const { error } = await supabase
      .from("appointments")
      .insert({
        user_id: user.id,
        customer_id: selectedCustomer.id,
        service_id: selectedService.id,
        customer_name:
          selectedCustomer.full_name,
        customer_phone:
          selectedCustomer.phone,
        customer_email:
          selectedCustomer.email,
        service: selectedService.name,
        appointment_date:
          createForm.appointmentDate,
        appointment_time:
          createForm.appointmentTime,
        notes: createForm.notes.trim() || null,
        status: "Booked",
      });

    setSubmitting(false);

    if (error) {
      showNotice("error", error.message);
      return;
    }

    showNotice(
      "success",
      "Appointment created successfully."
    );

    setCreateForm(emptyForm);

    await loadAppointments();
  }

  function startEditingAppointment(
    appointment: Appointment
  ) {
    setEditingAppointmentId(appointment.id);

    setEditForm({
      customerId: appointment.customer_id || "",
      serviceId: appointment.service_id || "",
      appointmentDate:
        appointment.appointment_date || "",
      appointmentTime: normalizeTime(
        appointment.appointment_time
      ),
      notes: appointment.notes || "",
      status: appointment.status || "Booked",
    });

    setNotice(null);
  }

  function cancelEditing() {
    setEditingAppointmentId(null);
    setEditForm(emptyForm);
  }

  async function saveAppointmentChanges(
    appointmentId: string
  ) {
    const user = await getCurrentUser();

    if (!user) {
      return;
    }

    const selectedCustomer = customers.find(
      (customer) =>
        customer.id === editForm.customerId
    );

    const selectedService = services.find(
      (service) =>
        service.id === editForm.serviceId
    );

    if (!selectedCustomer) {
      showNotice(
        "warning",
        "Please select a customer."
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

    setActionAppointmentId(appointmentId);

    const availability =
      await validateAppointmentAvailability({
        userId: user.id,
        serviceId: selectedService.id,
        appointmentDate:
          editForm.appointmentDate,
        appointmentTime:
          editForm.appointmentTime,
        status: editForm.status,
        excludeAppointmentId: appointmentId,
      });

    if (!availability.valid) {
      setActionAppointmentId(null);

      showNotice(
        "warning",
        availability.message
      );

      return;
    }

    const { error } = await supabase
      .from("appointments")
      .update({
        customer_id: selectedCustomer.id,
        service_id: selectedService.id,
        customer_name:
          selectedCustomer.full_name,
        customer_phone:
          selectedCustomer.phone,
        customer_email:
          selectedCustomer.email,
        service: selectedService.name,
        appointment_date:
          editForm.appointmentDate,
        appointment_time:
          editForm.appointmentTime,
        notes: editForm.notes.trim() || null,
        status: editForm.status,
      })
      .eq("id", appointmentId)
      .eq("user_id", user.id);

    setActionAppointmentId(null);

    if (error) {
      showNotice("error", error.message);
      return;
    }

    showNotice(
      "success",
      "Appointment updated successfully."
    );

    setEditingAppointmentId(null);
    setEditForm(emptyForm);

    await loadAppointments();
  }

  async function updateAppointmentStatus(
    appointment: Appointment,
    status: string
  ) {
    const user = await getCurrentUser();

    if (!user) {
      return;
    }

    setActionAppointmentId(appointment.id);

    /*
     * Moving a cancelled/completed appointment back into an active
     * state must re-check availability because its old time may now
     * be occupied.
     */
    if (
      status === "Booked" ||
      status === "Confirmed"
    ) {
      if (
        !appointment.service_id ||
        !appointment.appointment_date ||
        !appointment.appointment_time
      ) {
        setActionAppointmentId(null);

        showNotice(
          "warning",
          "This appointment is missing scheduling information. Edit it before changing it to an active status."
        );

        return;
      }

      const availability =
        await validateAppointmentAvailability({
          userId: user.id,
          serviceId: appointment.service_id,
          appointmentDate:
            appointment.appointment_date,
          appointmentTime:
            appointment.appointment_time,
          status,
          excludeAppointmentId:
            appointment.id,
        });

      if (!availability.valid) {
        setActionAppointmentId(null);

        showNotice(
          "warning",
          availability.message
        );

        return;
      }
    }

    const { error } = await supabase
      .from("appointments")
      .update({ status })
      .eq("id", appointment.id)
      .eq("user_id", user.id);

    setActionAppointmentId(null);

    if (error) {
      showNotice("error", error.message);
      return;
    }

    showNotice(
      "success",
      `Appointment marked as ${status}.`
    );

    await loadAppointments();
  }

  async function deleteAppointment(id: string) {
    const user = await getCurrentUser();

    if (!user) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this appointment permanently? This cannot be undone."
    );

    if (!confirmed) {
      return;
    }

    setActionAppointmentId(id);

    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    setActionAppointmentId(null);

    if (error) {
      showNotice("error", error.message);
      return;
    }

    if (editingAppointmentId === id) {
      cancelEditing();
    }

    showNotice(
      "success",
      "Appointment deleted."
    );

    await loadAppointments();
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
              <select
                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={createForm.customerId}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    customerId: event.target.value,
                  }))
                }
              >
                <option value="">
                  Select customer
                </option>

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
                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={createForm.serviceId}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    serviceId: event.target.value,
                  }))
                }
              >
                <option value="">
                  Select service
                </option>

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
                    appointmentDate:
                      event.target.value,
                  }))
                }
              />

              <Input
                type="time"
                value={createForm.appointmentTime}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    appointmentTime:
                      event.target.value,
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
              disabled={submitting}
              className="mt-5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting
                ? "Checking availability..."
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
              Confirm, edit, complete, cancel, or remove appointments.
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
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-sm font-medium text-green-600">
                                Editing appointment
                              </p>

                              <h3 className="mt-1 text-lg font-semibold text-gray-900">
                                {appointment.customer_name}
                              </h3>
                            </div>

                            <span
                              className={`w-fit rounded-full border px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                                editForm.status
                              )}`}
                            >
                              {editForm.status}
                            </span>
                          </div>

                          <div className="mt-5 grid gap-4 md:grid-cols-2">
                            <div>
                              <label className="mb-2 block text-sm font-medium text-gray-700">
                                Customer
                              </label>

                              <select
                                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                                value={editForm.customerId}
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    customerId:
                                      event.target.value,
                                  }))
                                }
                              >
                                <option value="">
                                  Select customer
                                </option>

                                {customers.map((customer) => (
                                  <option
                                    key={customer.id}
                                    value={customer.id}
                                  >
                                    {customer.full_name}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label className="mb-2 block text-sm font-medium text-gray-700">
                                Service
                              </label>

                              <select
                                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                                value={editForm.serviceId}
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    serviceId:
                                      event.target.value,
                                  }))
                                }
                              >
                                <option value="">
                                  Select service
                                </option>

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
                            </div>

                            <div>
                              <label className="mb-2 block text-sm font-medium text-gray-700">
                                Date
                              </label>

                              <Input
                                type="date"
                                value={
                                  editForm.appointmentDate
                                }
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    appointmentDate:
                                      event.target.value,
                                  }))
                                }
                              />
                            </div>

                            <div>
                              <label className="mb-2 block text-sm font-medium text-gray-700">
                                Time
                              </label>

                              <Input
                                type="time"
                                value={
                                  editForm.appointmentTime
                                }
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    appointmentTime:
                                      event.target.value,
                                  }))
                                }
                              />
                            </div>

                            <div>
                              <label className="mb-2 block text-sm font-medium text-gray-700">
                                Status
                              </label>

                              <select
                                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                                value={editForm.status}
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    status:
                                      event.target.value,
                                  }))
                                }
                              >
                                <option value="Booked">
                                  Booked
                                </option>

                                <option value="Confirmed">
                                  Confirmed
                                </option>

                                <option value="Completed">
                                  Completed
                                </option>

                                <option value="Cancelled">
                                  Cancelled
                                </option>
                              </select>
                            </div>
                          </div>

                          <div className="mt-4">
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                              Internal notes
                            </label>

                            <Textarea
                              placeholder="Internal notes"
                              value={editForm.notes}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...current,
                                  notes:
                                    event.target.value,
                                }))
                              }
                            />
                          </div>

                          <div className="mt-5 flex flex-wrap gap-2">
                            <Button
                              onClick={() =>
                                saveAppointmentChanges(
                                  appointment.id
                                )
                              }
                              disabled={actionInProgress}
                              className="bg-green-600 text-white hover:bg-green-700"
                            >
                              {actionInProgress
                                ? "Checking..."
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
                              disabled={actionInProgress}
                            >
                              Edit
                            </Button>

                            {appointment.status !==
                              "Confirmed" && (
                              <Button
                                onClick={() =>
                                  updateAppointmentStatus(
                                    appointment,
                                    "Confirmed"
                                  )
                                }
                                disabled={actionInProgress}
                                className="bg-green-600 text-white hover:bg-green-700"
                              >
                                Confirm
                              </Button>
                            )}

                            {appointment.status !==
                              "Completed" && (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  updateAppointmentStatus(
                                    appointment,
                                    "Completed"
                                  )
                                }
                                disabled={actionInProgress}
                              >
                                Complete
                              </Button>
                            )}

                            {appointment.status !==
                              "Cancelled" && (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  updateAppointmentStatus(
                                    appointment,
                                    "Cancelled"
                                  )
                                }
                                disabled={actionInProgress}
                              >
                                Cancel
                              </Button>
                            )}

                            <Button
                              variant="destructive"
                              onClick={() =>
                                deleteAppointment(
                                  appointment.id
                                )
                              }
                              disabled={actionInProgress}
                            >
                              Delete
                            </Button>
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