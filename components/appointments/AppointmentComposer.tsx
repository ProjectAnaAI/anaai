"use client";

import { useImperativeHandle, useRef, useState, type Ref } from "react";

import {
  findCustomerMatches,
  normalizeCustomerName,
  type MatchableCustomer,
} from "@/lib/appointment-customers";
import {
  normalizeCustomerPhone,
  saveCustomer,
} from "@/lib/customer-mutations";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * The single manual appointment creation experience.
 *
 * Both the Appointments page and the Dashboard render this component, so
 * there is exactly one manual booking form in the product. Scheduling
 * authority stays on the server: this component collects intent and hands it
 * to the caller's authoritative /api/appointments submission.
 */

export type AppointmentComposerCustomer = MatchableCustomer;

export type AppointmentComposerService = {
  id: string;
  name: string;
  duration_minutes: number | null;
};

export type AppointmentComposerHandle = {
  setSchedule: (date?: string, time?: string) => void;
  reset: () => void;
};

type ComposerNoticeType = "success" | "warning" | "error";

type AppointmentComposerProps = {
  businessId: string | null;
  userId: string | null;
  customers: AppointmentComposerCustomer[];
  services: AppointmentComposerService[];

  /** Authoritative submission owned by the host page. */
  onSubmit: (input: {
    creating: true;
    notificationType: "none";
    updates: Record<string, string | null>;
  }) => Promise<{ message?: string }>;

  onNotice: (type: ComposerNoticeType, message: string) => void;
  onCreated: () => void | Promise<void>;
  onCustomerCreated?: (customer: AppointmentComposerCustomer) => void;
  onDateChange?: (date: string) => void;

  /** "panel" is the wide two-column page layout; "drawer" stacks for a sheet. */
  variant?: "panel" | "drawer";
  ref?: Ref<AppointmentComposerHandle>;
};

type FormValues = {
  customerId: string;
  serviceId: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
};

const emptyForm: FormValues = {
  customerId: "",
  serviceId: "",
  appointmentDate: "",
  appointmentTime: "",
  notes: "",
};

export default function AppointmentComposer({
  businessId,
  userId,
  customers,
  services,
  onSubmit,
  onNotice,
  onCreated,
  onCustomerCreated,
  onDateChange,
  variant = "panel",
  ref,
}: AppointmentComposerProps) {
  const [form, setForm] = useState<FormValues>(emptyForm);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const createInFlight = useRef(false);

  const matchingCustomers = findCustomerMatches(
    customers,
    customerName,
    customerPhone
  );

  const selectedCustomer = customers.find(
    (customer) => customer.id === form.customerId && customer.is_active
  );

  useImperativeHandle(ref, () => ({
    setSchedule(date, time) {
      setForm((current) => ({
        ...current,
        appointmentDate: date ?? current.appointmentDate,
        appointmentTime: time ?? current.appointmentTime,
      }));
    },

    reset() {
      setForm(emptyForm);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
    },
  }));

  function updateCustomerLookup(field: "name" | "phone", value: string) {
    if (field === "name") {
      setCustomerName(value);
    } else {
      setCustomerPhone(value);
    }

    /*
     * Require explicit selection again after editing
     * either customer identity field.
     */
    setForm((current) => ({
      ...current,
      customerId: "",
    }));
  }

  function selectCustomer(customer: AppointmentComposerCustomer) {
    if (!customer.is_active) {
      onNotice(
        "warning",
        "Archived customers must be reactivated before they can be used for a new appointment."
      );

      return;
    }

    setCustomerEmail(customer.email || "");
    setCustomerName(customer.full_name);
    setCustomerPhone(customer.phone || "");

    setForm((current) => ({
      ...current,
      customerId: customer.id,
    }));
  }

  async function handleCreateAppointment() {
    if (createInFlight.current) {
      return;
    }

    if (!businessId || !userId) {
      onNotice("error", "Business context is not available.");

      return;
    }

    let chosenCustomer = customers.find(
      (customer) => customer.id === form.customerId && customer.is_active
    );

    const chosenService = services.find(
      (service) => service.id === form.serviceId
    );

    if (
      form.customerId &&
      (!chosenCustomer ||
        normalizeCustomerName(customerName) !==
          normalizeCustomerName(chosenCustomer.full_name) ||
        normalizeCustomerPhone(customerPhone) !==
          normalizeCustomerPhone(chosenCustomer.phone || ""))
    ) {
      onNotice(
        "warning",
        "Please select an active existing customer from the matches."
      );

      return;
    }

    if (!chosenService) {
      onNotice("warning", "Please select a service.");

      return;
    }

    if (!form.appointmentDate) {
      onNotice("warning", "Please select an appointment date.");

      return;
    }

    if (!form.appointmentTime) {
      onNotice("warning", "Please select an appointment time.");

      return;
    }

    createInFlight.current = true;
    setSubmitting(true);

    try {
      if (!chosenCustomer) {
        chosenCustomer = await saveCustomer(businessId, {
          name: customerName,
          phone: customerPhone,
          email: customerEmail,
        });

        const savedCustomer = chosenCustomer;

        onCustomerCreated?.(savedCustomer);
        selectCustomer(savedCustomer);
      }

      if (!chosenCustomer.is_active) {
        throw new Error(
          "Archived customers must be reactivated before they can be used for a new appointment."
        );
      }

      const result = await onSubmit({
        creating: true,

        notificationType: "none",

        updates: {
          customerId: chosenCustomer.id,

          serviceId: chosenService.id,

          appointmentDate: form.appointmentDate,

          appointmentTime: form.appointmentTime,

          notes: form.notes.trim() || null,
        },
      });

      onNotice("success", result.message || "Appointment action succeeded.");

      setForm(emptyForm);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");

      await onCreated();
    } catch (error) {
      onNotice(
        "error",
        error instanceof Error
          ? error.message
          : "Could not create appointment."
      );
    } finally {
      createInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div
      className={
        variant === "drawer"
          ? "grid min-w-0 gap-6"
          : "grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]"
      }
    >
      <div className="min-w-0 space-y-4">
        <div>
          <h3 className="text-[15px] font-semibold leading-5 text-gray-950">
            Customer
          </h3>

          <p className="mt-1 text-[13px] leading-5 text-gray-500">
            Search active customers or enter a new customer.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium leading-5 text-gray-700">
            <span className="block">Customer name</span>

            <Input
              disabled={submitting}
              value={customerName}
              onChange={(event) =>
                updateCustomerLookup("name", event.target.value)
              }
              placeholder="Search by name"
            />
          </label>

          <label className="space-y-1.5 text-sm font-medium leading-5 text-gray-700">
            <span className="flex items-baseline gap-1.5">
              <span>Phone number</span>
              <span className="text-xs font-normal text-gray-400">
                Optional
              </span>
            </span>

            <Input
              type="tel"
              disabled={submitting}
              value={customerPhone}
              onChange={(event) =>
                updateCustomerLookup("phone", event.target.value)
              }
              placeholder="Search by phone"
            />
          </label>
        </div>

        {selectedCustomer ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 text-sm font-bold text-green-700">
              {selectedCustomer.full_name.charAt(0).toUpperCase()}
            </div>

            <div className="min-w-0">
              <p className="text-sm font-semibold text-green-900">
                {selectedCustomer.full_name}
              </p>

              <p className="mt-0.5 text-xs leading-5 text-green-700">
                Existing customer selected
                {selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p role="status" className="text-[13px] leading-5 text-gray-500">
              {matchingCustomers.length
                ? "Matching active customers — select one below, or continue with a new customer."
                : customerName.trim() || customerPhone.trim()
                  ? "No active customer selected. A new customer will be created when this appointment is saved."
                  : "Enter a customer name. Phone and email are optional."}
            </p>

            {customerPhone.trim() && (
              <p className="text-xs leading-5 text-gray-400">
                Phone matches take priority. Clear the phone field to search by
                name.
              </p>
            )}

            {matchingCustomers.length > 0 && (
              <div className="max-h-52 space-y-2 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-2">
                {matchingCustomers.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => selectCustomer(customer)}
                    className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5 text-left transition hover:bg-green-50 disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {customer.full_name}
                      </p>

                      <p className="mt-0.5 truncate text-xs text-gray-500">
                        {customer.phone || "No phone number"}
                        {customer.email ? ` · ${customer.email}` : ""}
                      </p>
                    </div>

                    <span className="shrink-0 text-xs font-semibold text-green-700">
                      Select
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <label className="block space-y-1.5 text-sm font-medium leading-5 text-gray-700">
          <span className="flex items-baseline gap-1.5">
            <span>Email</span>
            <span className="text-xs font-normal text-gray-400">Optional</span>
          </span>

          <Input
            type="email"
            value={customerEmail}
            disabled={submitting || Boolean(selectedCustomer)}
            onChange={(event) => setCustomerEmail(event.target.value)}
            placeholder="customer@example.com"
          />
        </label>
      </div>

      <div className="min-w-0 rounded-2xl bg-gray-50 p-4 sm:p-5">
        <h3 className="text-[15px] font-semibold leading-5 text-gray-950">
          Appointment details
        </h3>

        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5 text-sm font-medium leading-5 text-gray-700">
            <span>Service</span>

            <select
              className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base outline-none transition-colors focus-visible:border-ring"
              value={form.serviceId}
              disabled={submitting}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  serviceId: event.target.value,
                }))
              }
            >
              <option value="">Select service</option>

              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                  {service.duration_minutes
                    ? ` · ${service.duration_minutes} min`
                    : ""}
                </option>
              ))}
            </select>
          </label>

          <div
            className={
              variant === "drawer"
                ? "grid gap-4 sm:grid-cols-2"
                : "grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"
            }
          >
            <label className="block space-y-1.5 text-sm font-medium leading-5 text-gray-700">
              <span>Date</span>

              <Input
                type="date"
                disabled={submitting}
                value={form.appointmentDate}
                onChange={(event) => {
                  const date = event.target.value;

                  setForm((current) => ({
                    ...current,
                    appointmentDate: date,
                  }));

                  if (date) {
                    onDateChange?.(date);
                  }
                }}
              />
            </label>

            <label className="block space-y-1.5 text-sm font-medium leading-5 text-gray-700">
              <span>Time</span>

              <Input
                type="time"
                disabled={submitting}
                value={form.appointmentTime}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    appointmentTime: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <label className="block space-y-1.5 text-sm font-medium leading-5 text-gray-700">
            <span>Internal notes</span>

            <Textarea
              disabled={submitting}
              placeholder="Add notes for your team"
              value={form.notes}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
            />
          </label>

          <Button
            type="button"
            onClick={handleCreateAppointment}
            disabled={submitting || !businessId || !userId}
            className="w-full"
          >
            {submitting ? "Saving appointment..." : "Save appointment"}
          </Button>
        </div>
      </div>
    </div>
  );
}