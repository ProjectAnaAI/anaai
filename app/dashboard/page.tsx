"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Scissors,
  Users,
  XCircle,
} from "lucide-react";

import AppLayout from "@/components/layout/AppLayout";
import StatsCard from "@/components/dashboard/StatsCard";
import QuickActions from "@/components/dashboard/QuickActions";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
import { supabase } from "@/lib/supabase";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
      return "bg-green-100 text-green-700 hover:bg-green-100";

    case "Booked":
      return "bg-blue-100 text-blue-700 hover:bg-blue-100";

    case "Completed":
      return "bg-gray-100 text-gray-700 hover:bg-gray-100";

    case "Cancelled":
      return "bg-red-100 text-red-700 hover:bg-red-100";

    default:
      return "bg-gray-100 text-gray-600 hover:bg-gray-100";
  }
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

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-gray-900">
        Loading dashboard...
      </main>
    );
  }

  if (loadError) {
    return (
      <AppLayout>
        <p
          role="alert"
          className="text-gray-500"
        >
          {loadError}
        </p>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-7xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            AnaAI
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Dashboard
          </h1>

          <p className="mt-2 text-gray-500">
            Welcome back, {email}
          </p>
        </header>

        <section className="mt-8 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <StatsCard
            title="Today's appointments"
            value={
              todayAppointments.length
            }
            description="Bookings scheduled for today"
            icon={CalendarDays}
          />

          <StatsCard
            title="Active customers"
            value={customerCount}
            description="Customers available for booking"
            icon={Users}
          />

          <StatsCard
            title="Active services"
            value={serviceCount}
            description="Services available for booking"
            icon={Scissors}
          />

          <StatsCard
            title="AI receptionist"
            value={
              aiConfigured
                ? "Configured"
                : "Needs setup"
            }
            description={
              aiConfigured
                ? "Receptionist settings are ready"
                : "Complete receptionist settings"
            }
            icon={Bot}
          />
        </section>

        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>
                  Today&apos;s schedule
                </CardTitle>

                {today && (
                  <p className="text-sm text-gray-500">
                    {today}
                  </p>
                )}
              </div>
            </CardHeader>

            <CardContent>
              {todayAppointments.length ===
              0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center">
                  <CalendarDays className="mx-auto h-8 w-8 text-gray-400" />

                  <p className="mt-3 font-medium text-gray-900">
                    No appointments
                    today
                  </p>

                  <p className="mt-1 text-sm text-gray-500">
                    New bookings for
                    today will appear
                    here.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {todayAppointments.map(
                    (appointment) => (
                      <div
                        key={
                          appointment.id
                        }
                        className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">
                            {appointment.customer_name ||
                              "Customer"}
                          </p>

                          <p className="mt-1 text-sm text-gray-500">
                            {appointment.service ||
                              "Service"}{" "}
                            ·{" "}
                            {formatAppointmentTime(
                              appointment.appointment_time
                            )}
                          </p>
                        </div>

                        <Badge
                          className={appointmentStatusClasses(
                            appointment.status
                          )}
                        >
                          {appointment.status ||
                            "Unknown"}
                        </Badge>
                      </div>
                    )
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                Today&apos;s breakdown
              </CardTitle>
            </CardHeader>

            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-xl bg-blue-50 p-4">
                  <div className="flex items-center gap-3">
                    <Clock3 className="h-5 w-5 text-blue-600" />

                    <span className="text-sm font-medium text-gray-900">
                      Booked
                    </span>
                  </div>

                  <span className="text-lg font-semibold text-gray-900">
                    {
                      statusCounts.Booked
                    }
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-xl bg-green-50 p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />

                    <span className="text-sm font-medium text-gray-900">
                      Confirmed
                    </span>
                  </div>

                  <span className="text-lg font-semibold text-gray-900">
                    {
                      statusCounts.Confirmed
                    }
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-xl bg-gray-50 p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-gray-600" />

                    <span className="text-sm font-medium text-gray-900">
                      Completed
                    </span>
                  </div>

                  <span className="text-lg font-semibold text-gray-900">
                    {
                      statusCounts.Completed
                    }
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-xl bg-red-50 p-4">
                  <div className="flex items-center gap-3">
                    <XCircle className="h-5 w-5 text-red-600" />

                    <span className="text-sm font-medium text-gray-900">
                      Cancelled
                    </span>
                  </div>

                  <span className="text-lg font-semibold text-gray-900">
                    {
                      statusCounts.Cancelled
                    }
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                Business overview
              </CardTitle>
            </CardHeader>

            <CardContent>
              {business ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <p className="text-sm text-gray-500">
                      Business name
                    </p>

                    <p className="mt-1 font-medium text-gray-900">
                      {
                        business.business_name
                      }
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-500">
                      Owner
                    </p>

                    <p className="mt-1 font-medium text-gray-900">
                      {
                        business.owner_name
                      }
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-500">
                      Phone
                    </p>

                    <p className="mt-1 font-medium text-gray-900">
                      {business.phone ||
                        "Not provided"}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-500">
                      Email
                    </p>

                    <p className="mt-1 break-words font-medium text-gray-900">
                      {business.email ||
                        "Not provided"}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-500">
                      Address
                    </p>

                    <p className="mt-1 font-medium text-gray-900">
                      {business.address ||
                        "Not provided"}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-500">
                      Timezone
                    </p>

                    <p className="mt-1 font-medium text-gray-900">
                      {timezone ||
                        "Not provided"}
                    </p>
                  </div>

                  <div className="sm:col-span-2">
                    <p className="text-sm text-gray-500">
                      Business hours
                    </p>

                    <p className="mt-1 whitespace-pre-wrap font-medium text-gray-900">
                      {business.business_hours ||
                        "Not provided"}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  No business profile
                  found.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                AI receptionist
              </CardTitle>
            </CardHeader>

            <CardContent>
              <Badge
                className={
                  aiConfigured
                    ? "bg-green-100 text-green-700 hover:bg-green-100"
                    : "bg-amber-100 text-amber-700 hover:bg-amber-100"
                }
              >
                {aiConfigured
                  ? "Configured"
                  : "Needs setup"}
              </Badge>

              <div className="mt-5 space-y-4 text-sm">
                <div>
                  <p className="text-gray-500">
                    Receptionist name
                  </p>

                  <p className="mt-1 font-medium text-gray-900">
                    {aiSettings
                      ?.receptionist_name ||
                      "Not configured"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500">
                    Tone
                  </p>

                  <p className="mt-1 font-medium capitalize text-gray-900">
                    {aiSettings?.tone ||
                      "Not configured"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500">
                    Greeting
                  </p>

                  <p className="mt-1 font-medium text-gray-900">
                    {aiSettings?.greeting
                      ?.trim()
                      ? "Configured"
                      : "Not configured"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="mt-8">
          <QuickActions />
        </section>
      </div>
    </AppLayout>
  );
}