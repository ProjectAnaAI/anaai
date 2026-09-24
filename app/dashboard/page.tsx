"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  MapPin,
  Plus,
  Scissors,
  Users,
  UserPlus,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import AppLayout from "@/components/layout/AppLayout";
import AppointmentComposer, {
  type AppointmentComposerCustomer,
  type AppointmentComposerHandle,
  type AppointmentComposerService,
} from "@/components/appointments/AppointmentComposer";
import { DialogSurface } from "@/components/ui/dialog-surface";
import { activeBusinessHeaders } from "@/lib/active-business";
import { sendAppointmentMutation } from "@/lib/appointment-api";
import { createRequestKeyStore } from "@/lib/appointment-request-key";
import {
  parseDateKey,
  shiftDateKey,
  todayInTimezone,
} from "@/lib/appointment-calendar";
import { supabase } from "@/lib/supabase";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

type BusinessProfile = {
  business_name: string;
  owner_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  business_hours: string | null;
};

type AiSettings = {
  receptionist_name: string | null;
  greeting: string | null;
  tone: string | null;
};

type ScheduleAppointment = {
  id: string;
  customer_name: string | null;
  service: string | null;
  appointment_time: string | null;
  status: string | null;
};

/** Days ahead counted by the "Upcoming" metric, starting tomorrow. */
const upcomingWindowDays = 7;

function formatBusinessDate(value: string) {
  const parsed = parseDateKey(value);

  if (!parsed) {
    return value;
  }

  const date = new Date(parsed.year, parsed.month - 1, parsed.day);

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** Compact label for the schedule date control, e.g. "Thu, Sep 24, 2026". */
function formatScheduleDate(value: string) {
  const parsed = parseDateKey(value);

  if (!parsed) {
    return value;
  }

  const date = new Date(parsed.year, parsed.month - 1, parsed.day);

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** Relative wording is only used for the days either side of the business date. */
function relativeDayLabel(value: string, today: string) {
  if (!today || !value) {
    return "";
  }

  if (value === today) {
    return "Today";
  }

  if (value === shiftDateKey(today, 1)) {
    return "Tomorrow";
  }

  if (value === shiftDateKey(today, -1)) {
    return "Yesterday";
  }

  return "";
}

function formatAppointmentTime(value: string | null) {
  if (!value) {
    return "Time unavailable";
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);

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

  const suffix = hours >= 12 ? "PM" : "AM";

  const displayHour = hours % 12 || 12;

  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function appointmentStatusClasses(status: string | null) {
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
      return "border-gray-200 bg-gray-50 text-gray-600";
  }
}

function firstNameFromEmail(email: string) {
  const local = email.split("@")[0]?.trim();

  if (!local) {
    return "";
  }

  const firstPart = local.split(/[._+-]/)[0];

  if (!firstPart) {
    return "";
  }

  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
}

type MetricCardProps = {
  label: string;
  value: string | number;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
  iconContainerClassName: string;
};

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
  iconClassName,
  iconContainerClassName,
}: MetricCardProps) {
  return (
    <div className="anaai-surface p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500">{label}</p>

          <p className="mt-3 text-3xl font-semibold tracking-tight text-gray-950">
            {value}
          </p>
        </div>

        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconContainerClassName}`}
        >
          <Icon className={`h-5 w-5 ${iconClassName}`} />
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-gray-400">{description}</p>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [timezone, setTimezone] = useState("");
  const [today, setToday] = useState("");
  const [selectedDate, setSelectedDate] = useState("");

  const [scheduleAppointments, setScheduleAppointments] = useState<
    ScheduleAppointment[]
  >([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [todayCount, setTodayCount] = useState(0);
  const [upcomingCount, setUpcomingCount] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [serviceCount, setServiceCount] = useState(0);

  const [customers, setCustomers] = useState<AppointmentComposerCustomer[]>([]);
  const [services, setServices] = useState<AppointmentComposerService[]>([]);

  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  const composerRef = useRef<AppointmentComposerHandle>(null);

  /*
   * Day navigation can be tapped faster than Supabase responds. The sequence
   * guard keeps a slow earlier response from overwriting the newest day.
   */
  const scheduleRequestId = useRef(0);

  const actionKeys = useRef(createRequestKeyStore());

  const mutationInFlight = useRef(false);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError || !session?.access_token) {
          router.push("/login");
          return;
        }

        const response = await fetch("/api/current-business", {
          headers: {
            ...activeBusinessHeaders(),
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        const context = (await response.json()) as CurrentBusinessResponse;

        if (!response.ok || !context.success || !context.business?.id) {
          throw new Error(
            context.error || "Unable to resolve your business."
          );
        }

        const businessId = context.business.id;

        const businessTimezone = context.business.timezone;

        /*
         * "Today" is the business's own calendar day. The browser timezone is
         * never used to decide which day the owner is looking at.
         */
        const currentBusinessDate = todayInTimezone(businessTimezone);

        if (!currentBusinessDate) {
          throw new Error("Unable to determine the business date.");
        }

        const upcomingStart = shiftDateKey(currentBusinessDate, 1);

        const upcomingEnd = shiftDateKey(
          currentBusinessDate,
          upcomingWindowDays
        );

        setEmail(session.user.email || "");
        setUserId(session.user.id);
        setBusinessId(businessId);
        setTimezone(businessTimezone);
        setToday(currentBusinessDate);
        setSelectedDate(currentBusinessDate);

        const [
          businessResult,
          todayResult,
          upcomingResult,
          customersResult,
          servicesResult,
          customerListResult,
          serviceListResult,
          aiResult,
        ] = await Promise.all([
          supabase
            .from("business_profiles")
            .select(
              "business_name, owner_name, phone, email, address, business_hours"
            )
            .eq("business_id", businessId)
            .maybeSingle(),

          supabase
            .from("appointments")
            .select("*", { count: "exact", head: true })
            .eq("business_id", businessId)
            .eq("appointment_date", currentBusinessDate),

          supabase
            .from("appointments")
            .select("*", { count: "exact", head: true })
            .eq("business_id", businessId)
            .gte("appointment_date", upcomingStart)
            .lte("appointment_date", upcomingEnd)
            .in("status", ["Booked", "Confirmed"]),

          supabase
            .from("customers")
            .select("*", { count: "exact", head: true })
            .eq("business_id", businessId)
            .eq("is_active", true),

          supabase
            .from("services")
            .select("*", { count: "exact", head: true })
            .eq("business_id", businessId)
            .eq("is_active", true),

          /*
           * Archived customers are loaded alongside active ones so the shared
           * composer applies the same active-only selection rules as the
           * Appointments page.
           */
          supabase
            .from("customers")
            .select("id, full_name, phone, email, is_active")
            .eq("business_id", businessId)
            .order("is_active", { ascending: false })
            .order("full_name"),

          supabase
            .from("services")
            .select("id, name, duration_minutes")
            .eq("business_id", businessId)
            .eq("is_active", true)
            .order("name"),

          supabase
            .from("ai_settings")
            .select("receptionist_name, greeting, tone")
            .eq("business_id", businessId)
            .maybeSingle(),
        ]);

        const queryError =
          businessResult.error ||
          todayResult.error ||
          upcomingResult.error ||
          customersResult.error ||
          servicesResult.error ||
          customerListResult.error ||
          serviceListResult.error ||
          aiResult.error;

        if (queryError) {
          throw new Error(queryError.message);
        }

        setBusiness((businessResult.data || null) as BusinessProfile | null);
        setTodayCount(todayResult.count ?? 0);
        setUpcomingCount(upcomingResult.count ?? 0);
        setCustomerCount(customersResult.count ?? 0);
        setServiceCount(servicesResult.count ?? 0);
        setCustomers(
          (customerListResult.data ||
            []) as AppointmentComposerCustomer[]
        );
        setServices(
          (serviceListResult.data || []) as AppointmentComposerService[]
        );
        setAiSettings((aiResult.data || null) as AiSettings | null);
      } catch (error) {
        console.error("Business data load error:", error);

        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load business data."
        );
      } finally {
        setLoading(false);
      }
    }

    void loadDashboard();
  }, [router]);

  /** Loads the appointments for whichever business day is being viewed. */
  useEffect(() => {
    if (!businessId || !selectedDate) {
      return;
    }

    const requestId = scheduleRequestId.current + 1;

    scheduleRequestId.current = requestId;

    let cancelled = false;

    async function loadSchedule() {
      setScheduleLoading(true);

      const { data, error } = await supabase
        .from("appointments")
        .select("id, customer_name, service, appointment_time, status")
        .eq("business_id", businessId)
        .eq("appointment_date", selectedDate)
        .order("appointment_time", { ascending: true });

      if (cancelled || scheduleRequestId.current !== requestId) {
        return;
      }

      if (error) {
        setScheduleError(error.message);
        setScheduleAppointments([]);
      } else {
        setScheduleError(null);
        setScheduleAppointments((data || []) as ScheduleAppointment[]);
      }

      setScheduleLoading(false);
    }

    void loadSchedule();

    return () => {
      cancelled = true;
    };
  }, [businessId, selectedDate]);

  /** Refreshes the counts that a new booking can change. */
  const refreshCounts = useCallback(async () => {
    if (!businessId || !today) {
      return;
    }

    const upcomingStart = shiftDateKey(today, 1);

    const upcomingEnd = shiftDateKey(today, upcomingWindowDays);

    const [todayResult, upcomingResult] = await Promise.all([
      supabase
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("appointment_date", today),

      supabase
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("appointment_date", upcomingStart)
        .lte("appointment_date", upcomingEnd)
        .in("status", ["Booked", "Confirmed"]),
    ]);

    if (!todayResult.error) {
      setTodayCount(todayResult.count ?? 0);
    }

    if (!upcomingResult.error) {
      setUpcomingCount(upcomingResult.count ?? 0);
    }
  }, [businessId, today]);

  const reloadSchedule = useCallback(async () => {
    if (!businessId || !selectedDate) {
      return;
    }

    const requestId = scheduleRequestId.current + 1;

    scheduleRequestId.current = requestId;

    const { data, error } = await supabase
      .from("appointments")
      .select("id, customer_name, service, appointment_time, status")
      .eq("business_id", businessId)
      .eq("appointment_date", selectedDate)
      .order("appointment_time", { ascending: true });

    if (scheduleRequestId.current !== requestId) {
      return;
    }

    if (error) {
      setScheduleError(error.message);
      return;
    }

    setScheduleError(null);
    setScheduleAppointments((data || []) as ScheduleAppointment[]);
  }, [businessId, selectedDate]);

  /*
   * Mirrors the Appointments page: one mutation at a time, one idempotency key
   * per distinct request. The server and its database RPCs remain the only
   * authority on whether a booking is allowed.
   */
  const submitAppointment = useCallback(
    async (input: {
      creating: true;
      notificationType: "none";
      updates: Record<string, string | null>;
    }) => {
      if (!businessId) {
        throw new Error("Business context is unavailable.");
      }

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        throw new Error(
          "Your session has expired. Please log in again."
        );
      }

      if (mutationInFlight.current) {
        throw new Error("An appointment action is already in progress.");
      }

      mutationInFlight.current = true;

      try {
        const idempotencyKey = actionKeys.current.forRequest({
          userId,
          businessId,
          creating: input.creating,
          updates: input.updates,
        });

        const result = await sendAppointmentMutation({
          accessToken: session.access_token,
          businessId,
          idempotencyKey,
          creating: input.creating,
          updates: input.updates,
          notificationType: input.notificationType,
        });

        actionKeys.current.clear();

        return result;
      } finally {
        mutationInFlight.current = false;
      }
    },
    [businessId, userId]
  );

  const statusCounts = useMemo(() => {
    const counts = {
      Booked: 0,
      Confirmed: 0,
      Completed: 0,
      Cancelled: 0,
    };

    for (const appointment of scheduleAppointments) {
      switch (appointment.status) {
        case "Booked":
          counts.Booked += 1;
          break;

        case "Confirmed":
          counts.Confirmed += 1;
          break;

        case "Completed":
          counts.Completed += 1;
          break;

        case "Cancelled":
          counts.Cancelled += 1;
          break;
      }
    }

    return counts;
  }, [scheduleAppointments]);

  const aiConfigured = Boolean(
    aiSettings?.receptionist_name?.trim() && aiSettings?.greeting?.trim()
  );

  const displayName =
    business?.owner_name?.trim() || firstNameFromEmail(email);

  const relativeLabel = relativeDayLabel(selectedDate, today);

  const isToday = Boolean(selectedDate) && selectedDate === today;

  function goToPreviousDay() {
    setSelectedDate((current) =>
      current ? shiftDateKey(current, -1) : current
    );
  }

  function goToNextDay() {
    setSelectedDate((current) =>
      current ? shiftDateKey(current, 1) : current
    );
  }

  function goToToday() {
    if (today) {
      setSelectedDate(today);
    }
  }

  function openComposer() {
    setComposerNotice(null);
    setComposerOpen(true);

    /*
     * Prefill with the day the owner is looking at. The date stays editable and
     * the server still validates it.
     */
    composerRef.current?.setSchedule(selectedDate || today || undefined);
  }

  function closeComposer() {
    setComposerOpen(false);
    setComposerNotice(null);
  }

  if (loading) {
    return (
      <AppLayout>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

            <p className="mt-4 text-sm font-medium text-gray-500">
              Loading your dashboard...
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (loadError) {
    return (
      <AppLayout>
        <div role="alert" className="anaai-surface mx-auto max-w-2xl p-6">
          <div className="flex gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-50">
              <CircleAlert className="h-5 w-5 text-red-600" />
            </div>

            <div>
              <h1 className="font-semibold text-gray-950">
                Unable to load dashboard
              </h1>

              <p className="mt-1 text-sm leading-6 text-gray-500">
                {loadError}
              </p>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6 lg:space-y-7" data-page="dashboard">
        <PageHeader
          eyebrow="Today at your business"
          title={
            <>
              {displayName
                ? `Good to see you, ${displayName}`
                : "Dashboard"}
            </>
          }
          description={
            <>
              {business?.business_name || "Your business"}
              {today ? ` · ${formatBusinessDate(today)}` : ""}
            </>
          }
        >
          <Button onClick={openComposer} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            New appointment
          </Button>
        </PageHeader>

        <section aria-label="Business summary" className="workspace-metrics">
          <MetricCard
            label="Today's appointments"
            value={todayCount}
            description="Appointments scheduled for the business today"
            icon={CalendarDays}
            iconContainerClassName="bg-green-50"
            iconClassName="text-green-600"
          />

          <MetricCard
            label="Upcoming"
            value={upcomingCount}
            description="Booked or confirmed over the next 7 days"
            icon={CalendarRange}
            iconContainerClassName="bg-blue-50"
            iconClassName="text-blue-600"
          />

          <MetricCard
            label="Active customers"
            value={customerCount}
            description="Customers currently available for booking"
            icon={Users}
            iconContainerClassName="bg-violet-50"
            iconClassName="text-violet-600"
          />

          <MetricCard
            label="AI receptionist"
            value={aiConfigured ? "Configured" : "Needs setup"}
            description={
              aiConfigured
                ? "Receptionist configuration is ready"
                : "Finish the receptionist configuration"
            }
            icon={Bot}
            iconContainerClassName={
              aiConfigured ? "bg-emerald-50" : "bg-amber-50"
            }
            iconClassName={
              aiConfigured ? "text-emerald-600" : "text-amber-600"
            }
          />
        </section>

        <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(250px,0.75fr)]">
          <div className="anaai-surface min-w-0 overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-5 sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="anaai-section-title">Schedule</h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Appointments for the selected business day
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => router.push("/appointments")}
                  className="flex min-h-11 items-center gap-1 self-start rounded-lg px-2 text-sm font-semibold text-green-700 transition hover:bg-green-50 sm:self-auto"
                >
                  View calendar
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Previous day"
                  onClick={goToPreviousDay}
                  disabled={!selectedDate}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                <div
                  aria-live="polite"
                  className="min-w-0 flex-1 text-center sm:flex-none sm:text-left"
                >
                  <p className="text-sm font-semibold text-gray-950">
                    {selectedDate
                      ? formatScheduleDate(selectedDate)
                      : "Date unavailable"}
                  </p>

                  {relativeLabel && (
                    <p className="text-xs font-medium text-green-700">
                      {relativeLabel}
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Next day"
                  onClick={goToNextDay}
                  disabled={!selectedDate}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={goToToday}
                  disabled={!today || isToday}
                  className="ml-auto sm:ml-2"
                >
                  Today
                </Button>
              </div>

              {scheduleAppointments.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {(
                    [
                      "Booked",
                      "Confirmed",
                      "Completed",
                      "Cancelled",
                    ] as const
                  )
                    .filter((status) => statusCounts[status] > 0)
                    .map((status) => (
                      <Badge
                        key={status}
                        variant="outline"
                        className={appointmentStatusClasses(status)}
                      >
                        {status} · {statusCounts[status]}
                      </Badge>
                    ))}
                </div>
              )}
            </div>

            {scheduleError ? (
              <div role="alert" className="px-5 py-8 text-center sm:px-6">
                <p className="text-sm font-semibold text-gray-950">
                  Unable to load this day
                </p>

                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                  {scheduleError}
                </p>
              </div>
            ) : scheduleLoading && scheduleAppointments.length === 0 ? (
              <div className="px-5 py-12 text-center sm:px-6">
                <p role="status" className="text-sm text-gray-500">
                  Loading schedule...
                </p>
              </div>
            ) : scheduleAppointments.length === 0 ? (
              <div className="px-5 py-12 text-center sm:px-6">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50">
                  <CalendarDays className="h-5 w-5 text-gray-400" />
                </div>

                <h3 className="mt-4 font-semibold text-gray-950">
                  No appointments scheduled for this day.
                </h3>

                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                  Use the arrows to check another day, or add a booking to
                  this one.
                </p>

                <Button className="mt-5" onClick={openComposer}>
                  <Plus className="h-4 w-4" />
                  New appointment
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {scheduleAppointments.map((appointment) => (
                  <button
                    key={appointment.id}
                    type="button"
                    onClick={() => router.push("/appointments")}
                    className="group flex min-h-[76px] w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-gray-50/80 sm:px-6"
                  >
                    <div className="w-[72px] shrink-0">
                      <p className="text-sm font-semibold text-gray-950">
                        {formatAppointmentTime(appointment.appointment_time)}
                      </p>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-950">
                        {appointment.customer_name || "Customer"}
                      </p>

                      <p className="mt-1 truncate text-sm text-gray-500">
                        {appointment.service || "Service"}
                      </p>
                    </div>

                    <Badge
                      variant="outline"
                      className={`hidden shrink-0 sm:inline-flex ${appointmentStatusClasses(
                        appointment.status
                      )}`}
                    >
                      {appointment.status || "Unknown"}
                    </Badge>

                    <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-500" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="anaai-surface min-w-0 overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-5 sm:px-6">
              <h2 className="anaai-section-title">Quick actions</h2>

              <p className="mt-1 text-sm text-gray-500">
                Everyday tasks for your front desk
              </p>
            </div>

            <div className="space-y-3 p-5 sm:p-6">
              <Button onClick={openComposer} className="w-full justify-start">
                <CalendarPlus className="h-4 w-4" />
                New appointment
              </Button>

              <p className="px-1 text-xs leading-5 text-gray-500">
                Schedule a customer without leaving the dashboard.
              </p>

              <div className="space-y-2 border-t border-gray-100 pt-4">
                <Button
                  variant="outline"
                  onClick={() => router.push("/customers")}
                  className="w-full justify-start"
                >
                  <UserPlus className="h-4 w-4" />
                  New customer
                </Button>

                <Button
                  variant="outline"
                  onClick={() => router.push("/services")}
                  className="w-full justify-start"
                >
                  <Scissors className="h-4 w-4" />
                  New service
                </Button>

                <Button
                  variant="outline"
                  onClick={() => router.push("/appointments")}
                  className="w-full justify-start"
                >
                  <CalendarDays className="h-4 w-4" />
                  View calendar
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="grid min-w-0 gap-5 lg:grid-cols-2">
          <div className="anaai-surface overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-5 sm:px-6">
              <div>
                <h2 className="anaai-section-title">AI receptionist</h2>

                <p className="mt-1 text-sm text-gray-500">
                  Current configuration
                </p>
              </div>

              <Badge
                variant="outline"
                className={
                  aiConfigured
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }
              >
                {aiConfigured ? "Configured" : "Needs setup"}
              </Badge>
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex gap-4">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
                    aiConfigured ? "bg-green-50" : "bg-amber-50"
                  }`}
                >
                  <Bot
                    className={`h-5 w-5 ${
                      aiConfigured ? "text-green-600" : "text-amber-600"
                    }`}
                  />
                </div>

                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-950">
                    {aiSettings?.receptionist_name ||
                      "Receptionist not named"}
                  </p>

                  <p className="mt-1 text-sm text-gray-500">
                    {aiSettings?.tone
                      ? `${aiSettings.tone} tone`
                      : "Tone not configured"}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Greeting
                  </p>

                  <p className="mt-2 text-sm font-semibold text-gray-800">
                    {aiSettings?.greeting?.trim()
                      ? "Configured"
                      : "Not configured"}
                  </p>
                </div>

                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Setup
                  </p>

                  <p className="mt-2 text-sm font-semibold text-gray-800">
                    {aiConfigured ? "Ready" : "Action needed"}
                  </p>
                </div>
              </div>

              <Button
                variant="outline"
                className="mt-5 w-full justify-between"
                onClick={() => router.push("/ai")}
              >
                Manage AI receptionist
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="anaai-surface overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-5 sm:px-6">
              <div>
                <h2 className="anaai-section-title">Business</h2>

                <p className="mt-1 text-sm text-gray-500">Workspace details</p>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/business")}
              >
                Manage
              </Button>
            </div>

            <div className="p-5 sm:p-6">
              {business ? (
                <>
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-green-50 text-lg font-bold text-green-700">
                      {business.business_name
                        ?.trim()
                        ?.charAt(0)
                        ?.toUpperCase() || "B"}
                    </div>

                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-gray-950">
                        {business.business_name}
                      </p>

                      <p className="mt-1 text-sm text-gray-500">
                        {business.owner_name}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 space-y-3">
                    {business.address && (
                      <div className="flex items-start gap-3 text-sm">
                        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />

                        <span className="leading-5 text-gray-600">
                          {business.address}
                        </span>
                      </div>
                    )}

                    <div className="flex items-start gap-3 text-sm">
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />

                      <span className="leading-5 text-gray-600">
                        {timezone || "Timezone not provided"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => router.push("/customers")}
                      className="min-h-[76px] rounded-xl bg-gray-50 p-3 text-left transition hover:bg-gray-100"
                    >
                      <p className="text-xl font-semibold text-gray-950">
                        {customerCount}
                      </p>

                      <p className="mt-1 text-xs font-medium text-gray-500">
                        Active customers
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => router.push("/services")}
                      className="min-h-[76px] rounded-xl bg-gray-50 p-3 text-left transition hover:bg-gray-100"
                    >
                      <p className="text-xl font-semibold text-gray-950">
                        {serviceCount}
                      </p>

                      <p className="mt-1 text-xs font-medium text-gray-500">
                        Active services
                      </p>
                    </button>
                  </div>
                </>
              ) : (
                <div className="py-6 text-center">
                  <p className="text-sm font-medium text-gray-900">
                    No business profile found
                  </p>

                  <p className="mt-1 text-sm text-gray-500">
                    Business details will appear here once configured.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {composerOpen && (
        <DialogSurface
          onClose={closeComposer}
          aria-labelledby="dashboard-new-appointment-title"
          className="appointment-drawer"
        >
          <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-5 sm:px-6">
            <div className="min-w-0">
              <h2
                id="dashboard-new-appointment-title"
                className="anaai-section-title"
              >
                New appointment
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Add a booking to the business schedule.
              </p>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close new appointment"
              onClick={closeComposer}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {composerNotice && (
            <div
              role="alert"
              className="mx-5 mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 sm:mx-6"
            >
              {composerNotice}
            </div>
          )}

          <div className="p-5 sm:p-6">
            <AppointmentComposer
              ref={composerRef}
              variant="drawer"
              businessId={businessId}
              userId={userId}
              customers={customers}
              services={services}
              onSubmit={submitAppointment}
              onNotice={(type, message) => {
                /* Same feedback the Appointments page shows. */
                setComposerNotice(
                  type === "success" ? null : message
                );

                if (type === "success") {
                  toast.success(message);
                } else if (type === "warning") {
                  toast.warning(message);
                } else {
                  toast.error(message);
                }
              }}
              onCustomerCreated={(customer) =>
                setCustomers((current) => [
                  ...current.filter((item) => item.id !== customer.id),
                  customer,
                ])
              }
              onCreated={async () => {
                setComposerOpen(false);
                setComposerNotice(null);

                await Promise.all([reloadSchedule(), refreshCounts()]);
              }}
              onDateChange={setSelectedDate}
            />
          </div>
        </DialogSurface>
      )}
    </AppLayout>
  );
}
