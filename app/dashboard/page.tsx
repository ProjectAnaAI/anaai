"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  MapPin,
  Scissors,
  Users,
  XCircle,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import AppLayout from "@/components/layout/AppLayout";
import QuickActions from "@/components/dashboard/QuickActions";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
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
    role:
      | "owner"
      | "manager"
      | "staff";
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

type TodayAppointment = {
  id: string;
  customer_name: string | null;
  service: string | null;
  appointment_time: string | null;
  status: string | null;
};

function businessDate(
  timezone: string
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const year = parts.find(
    (part) =>
      part.type === "year"
  )?.value;

  const month = parts.find(
    (part) =>
      part.type === "month"
  )?.value;

  const day = parts.find(
    (part) =>
      part.type === "day"
  )?.value;

  if (!year || !month || !day) {
    throw new Error(
      "Unable to determine the business date."
    );
  }

  return `${year}-${month}-${day}`;
}

function formatBusinessDate(
  value: string
) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    return value;
  }

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );

  return new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "long",
      month: "long",
      day: "numeric",
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

function appointmentStatusClasses(
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
      return "border-gray-200 bg-gray-50 text-gray-600";
  }
}

function firstNameFromEmail(
  email: string
) {
  const local =
    email.split("@")[0]?.trim();

  if (!local) {
    return "";
  }

  const firstPart =
    local.split(/[._+-]/)[0];

  if (!firstPart) {
    return "";
  }

  return (
    firstPart.charAt(0).toUpperCase() +
    firstPart.slice(1)
  );
}

type MetricCardProps = {
  label: string;
  value: string | number;
  description: string;
  icon: React.ComponentType<{
    className?: string;
  }>;
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
          <p className="text-sm font-medium text-gray-500">
            {label}
          </p>

          <p className="mt-3 text-3xl font-semibold tracking-tight text-gray-950">
            {value}
          </p>
        </div>

        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconContainerClassName}`}
        >
          <Icon
            className={`h-5 w-5 ${iconClassName}`}
          />
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-gray-400">
        {description}
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();

  const [
    email,
    setEmail,
  ] = useState("");

  const [
    business,
    setBusiness,
  ] =
    useState<BusinessProfile | null>(
      null
    );

  const [
    timezone,
    setTimezone,
  ] = useState("");

  const [
    today,
    setToday,
  ] = useState("");

  const [
    todayAppointments,
    setTodayAppointments,
  ] = useState<
    TodayAppointment[]
  >([]);

  const [
    customerCount,
    setCustomerCount,
  ] = useState(0);

  const [
    serviceCount,
    setServiceCount,
  ] = useState(0);

  const [
    aiSettings,
    setAiSettings,
  ] =
    useState<AiSettings | null>(
      null
    );

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    loadError,
    setLoadError,
  ] = useState<string | null>(
    null
  );

  useEffect(() => {
    async function loadDashboard() {
      try {
        const {
          data: { session },
          error: sessionError,
        } =
          await supabase.auth.getSession();

        if (
          sessionError ||
          !session?.access_token
        ) {
          router.push("/login");
          return;
        }

        const response = await fetch(
          "/api/current-business",
          {
            headers: {
              ...activeBusinessHeaders(),
              Authorization:
                `Bearer ${session.access_token}`,
            },
          }
        );

        const context =
          (await response.json()) as CurrentBusinessResponse;

        if (
          !response.ok ||
          !context.success ||
          !context.business?.id
        ) {
          throw new Error(
            context.error ||
              "Unable to resolve your business."
          );
        }

        const businessId =
          context.business.id;

        const businessTimezone =
          context.business.timezone;

        const currentBusinessDate =
          businessDate(
            businessTimezone
          );

        setEmail(
          session.user.email || ""
        );

        setTimezone(
          businessTimezone
        );

        setToday(
          currentBusinessDate
        );

        const [
          businessResult,
          appointmentsResult,
          customersResult,
          servicesResult,
          aiResult,
        ] = await Promise.all([
          supabase
            .from(
              "business_profiles"
            )
            .select(
              "business_name, owner_name, phone, email, address, business_hours"
            )
            .eq(
              "business_id",
              businessId
            )
            .maybeSingle(),

          supabase
            .from("appointments")
            .select(
              "id, customer_name, service, appointment_time, status"
            )
            .eq(
              "business_id",
              businessId
            )
            .eq(
              "appointment_date",
              currentBusinessDate
            )
            .order(
              "appointment_time",
              {
                ascending: true,
              }
            ),

          supabase
            .from("customers")
            .select("*", {
              count: "exact",
              head: true,
            })
            .eq(
              "business_id",
              businessId
            )
            .eq(
              "is_active",
              true
            ),

          supabase
            .from("services")
            .select("*", {
              count: "exact",
              head: true,
            })
            .eq(
              "business_id",
              businessId
            )
            .eq(
              "is_active",
              true
            ),

          supabase
            .from("ai_settings")
            .select(
              "receptionist_name, greeting, tone"
            )
            .eq(
              "business_id",
              businessId
            )
            .maybeSingle(),
        ]);

        const queryError =
          businessResult.error ||
          appointmentsResult.error ||
          customersResult.error ||
          servicesResult.error ||
          aiResult.error;

        if (queryError) {
          throw new Error(
            queryError.message
          );
        }

        setBusiness(
          (businessResult.data ||
            null) as BusinessProfile | null
        );

        setTodayAppointments(
          (appointmentsResult.data ||
            []) as TodayAppointment[]
        );

        setCustomerCount(
          customersResult.count ?? 0
        );

        setServiceCount(
          servicesResult.count ?? 0
        );

        setAiSettings(
          (aiResult.data ||
            null) as AiSettings | null
        );
      } catch (error) {
        console.error(
          "Business data load error:",
          error
        );

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

  const statusCounts =
    useMemo(() => {
      const counts = {
        Booked: 0,
        Confirmed: 0,
        Completed: 0,
        Cancelled: 0,
      };

      for (const appointment of todayAppointments) {
        switch (
          appointment.status
        ) {
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
    }, [todayAppointments]);

  const aiConfigured =
    Boolean(
      aiSettings?.receptionist_name?.trim() &&
        aiSettings?.greeting?.trim()
    );

  const displayName =
    business?.owner_name?.trim() ||
    firstNameFromEmail(email);

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
        <div
          role="alert"
          className="anaai-surface mx-auto max-w-2xl p-6"
        >
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
          title={<>{displayName ? `Good to see you, ${displayName}` : "Dashboard"}</>}
          description={
            <>
              Here&apos;s what&apos;s happening with{" "}
              {business?.business_name || "your business"}
              {today ? ` on ${formatBusinessDate(today)}.` : "."}
            </>
          }
        >
          <Button onClick={() => router.push("/appointments")} className="w-full sm:w-auto">
            <CalendarDays className="h-4 w-4" />
            View appointments
          </Button>
        </PageHeader>

        <section
          aria-label="Business summary"
          className="workspace-metrics"
        >
          <MetricCard
            label="Today's appointments"
            value={
              todayAppointments.length
            }
            description="Appointments scheduled for the business today"
            icon={CalendarDays}
            iconContainerClassName="bg-green-50"
            iconClassName="text-green-600"
          />

          <MetricCard
            label="Active customers"
            value={customerCount}
            description="Customers currently available for booking"
            icon={Users}
            iconContainerClassName="bg-blue-50"
            iconClassName="text-blue-600"
          />

          <MetricCard
            label="Active services"
            value={serviceCount}
            description="Services currently available for booking"
            icon={Scissors}
            iconContainerClassName="bg-violet-50"
            iconClassName="text-violet-600"
          />

          <MetricCard
            label="AI receptionist"
            value={
              aiConfigured
                ? "Configured"
                : "Needs setup"
            }
            description={
              aiConfigured
                ? "Receptionist configuration is ready"
                : "Finish the receptionist configuration"
            }
            icon={Bot}
            iconContainerClassName={
              aiConfigured
                ? "bg-emerald-50"
                : "bg-amber-50"
            }
            iconClassName={
              aiConfigured
                ? "text-emerald-600"
                : "text-amber-600"
            }
          />
        </section>

        <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(220px,0.8fr)]">
          <div className="anaai-surface min-w-0 overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <h2 className="anaai-section-title">
                  Today&apos;s appointments
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Your schedule at a
                  glance
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  router.push(
                    "/appointments"
                  )
                }
                className="flex min-h-11 items-center gap-1 self-start rounded-lg px-2 text-sm font-semibold text-green-700 transition hover:bg-green-50 sm:self-auto"
              >
                View all
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {todayAppointments.length ===
            0 ? (
              <div className="px-5 py-12 text-center sm:px-6">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50">
                  <CalendarDays className="h-5 w-5 text-gray-400" />
                </div>

                <h3 className="mt-4 font-semibold text-gray-950">
                  No appointments
                  today
                </h3>

                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
                  New bookings scheduled
                  for today will appear
                  here.
                </p>

                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() =>
                    router.push(
                      "/appointments"
                    )
                  }
                >
                  Open appointments
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {todayAppointments.map(
                  (appointment) => (
                    <button
                      key={
                        appointment.id
                      }
                      type="button"
                      onClick={() =>
                        router.push(
                          "/appointments"
                        )
                      }
                      className="group flex min-h-[76px] w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-gray-50/80 sm:px-6"
                    >
                      <div className="w-[72px] shrink-0">
                        <p className="text-sm font-semibold text-gray-950">
                          {formatAppointmentTime(
                            appointment.appointment_time
                          )}
                        </p>
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-gray-950">
                          {appointment.customer_name ||
                            "Customer"}
                        </p>

                        <p className="mt-1 truncate text-sm text-gray-500">
                          {appointment.service ||
                            "Service"}
                        </p>
                      </div>

                      <Badge
                        variant="outline"
                        className={`hidden shrink-0 sm:inline-flex ${appointmentStatusClasses(
                          appointment.status
                        )}`}
                      >
                        {appointment.status ||
                          "Unknown"}
                      </Badge>

                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-500" />
                    </button>
                  )
                )}
              </div>
            )}
          </div>

          <div className="anaai-surface overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-5 sm:px-6">
              <h2 className="anaai-section-title">
                Today&apos;s status
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Appointment lifecycle
                breakdown
              </p>
            </div>

            <div className="space-y-2 p-4 sm:p-5">
              <div className="flex min-h-14 items-center justify-between rounded-xl px-3.5 transition hover:bg-blue-50/60">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50">
                    <Clock3 className="h-4 w-4 text-blue-600" />
                  </div>

                  <span className="text-sm font-medium text-gray-700">
                    Booked
                  </span>
                </div>

                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {
                    statusCounts.Booked
                  }
                </span>
              </div>

              <div className="flex min-h-14 items-center justify-between rounded-xl px-3.5 transition hover:bg-green-50/60">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  </div>

                  <span className="text-sm font-medium text-gray-700">
                    Confirmed
                  </span>
                </div>

                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {
                    statusCounts.Confirmed
                  }
                </span>
              </div>

              <div className="flex min-h-14 items-center justify-between rounded-xl px-3.5 transition hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-100">
                    <CheckCircle2 className="h-4 w-4 text-gray-600" />
                  </div>

                  <span className="text-sm font-medium text-gray-700">
                    Completed
                  </span>
                </div>

                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {
                    statusCounts.Completed
                  }
                </span>
              </div>

              <div className="flex min-h-14 items-center justify-between rounded-xl px-3.5 transition hover:bg-red-50/60">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-50">
                    <XCircle className="h-4 w-4 text-red-600" />
                  </div>

                  <span className="text-sm font-medium text-gray-700">
                    Cancelled
                  </span>
                </div>

                <span className="text-lg font-semibold tabular-nums text-gray-950">
                  {
                    statusCounts.Cancelled
                  }
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="grid min-w-0 gap-5 lg:grid-cols-2">
          <div className="anaai-surface overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-5 sm:px-6">
              <div>
                <h2 className="anaai-section-title">
                  AI receptionist
                </h2>

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
                {aiConfigured
                  ? "Configured"
                  : "Needs setup"}
              </Badge>
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex gap-4">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
                    aiConfigured
                      ? "bg-green-50"
                      : "bg-amber-50"
                  }`}
                >
                  <Bot
                    className={`h-5 w-5 ${
                      aiConfigured
                        ? "text-green-600"
                        : "text-amber-600"
                    }`}
                  />
                </div>

                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-950">
                    {aiSettings
                      ?.receptionist_name ||
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
                    {aiSettings?.greeting
                      ?.trim()
                      ? "Configured"
                      : "Not configured"}
                  </p>
                </div>

                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Setup
                  </p>

                  <p className="mt-2 text-sm font-semibold text-gray-800">
                    {aiConfigured
                      ? "Ready"
                      : "Action needed"}
                  </p>
                </div>
              </div>

              <Button
                variant="outline"
                className="mt-5 w-full justify-between"
                onClick={() =>
                  router.push("/ai")
                }
              >
                Manage AI receptionist
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="anaai-surface overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-5 sm:px-6">
              <div>
                <h2 className="anaai-section-title">
                  Business
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Workspace details
                </p>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  router.push(
                    "/business"
                  )
                }
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
                        ?.toUpperCase() ||
                        "B"}
                    </div>

                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-gray-950">
                        {
                          business.business_name
                        }
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
                          {
                            business.address
                          }
                        </span>
                      </div>
                    )}

                    <div className="flex items-start gap-3 text-sm">
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />

                      <span className="leading-5 text-gray-600">
                        {timezone ||
                          "Timezone not provided"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        router.push(
                          "/customers"
                        )
                      }
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
                      onClick={() =>
                        router.push(
                          "/services"
                        )
                      }
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
                    No business profile
                    found
                  </p>

                  <p className="mt-1 text-sm text-gray-500">
                    Business details will
                    appear here once
                    configured.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section>
          <QuickActions />
        </section>
      </div>
    </AppLayout>
  );
}
