"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Scissors,
  TrendingUp,
  Users,
  XCircle,
} from "lucide-react";

import AppLayout from "@/components/layout/AppLayout";
import {
  activeBusinessHeaders,
} from "@/lib/active-business";
import {
  countStatuses,
  dailyAppointmentCounts,
  percentage,
  reportingWindow,
  serviceAppointmentCounts,
  type AnalyticsAppointment,
} from "@/lib/analytics";
import { supabase } from "@/lib/supabase";

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

function formatShortDate(
  value: string
) {
  const [
    year,
    month,
    day,
  ] = value
    .split("-")
    .map(Number);

  const date = new Date(
    year,
    month - 1,
    day
  );

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "numeric",
    }
  ).format(date);
}

function pluralizeAppointments(
  count: number
) {
  return count === 1
    ? "appointment"
    : "appointments";
}

export default function AnalyticsPage() {
  const router = useRouter();

  const [
    appointments,
    setAppointments,
  ] = useState<
    AnalyticsAppointment[]
  >([]);

  const [
    allTimeAppointments,
    setAllTimeAppointments,
  ] = useState(0);

  const [
    activeCustomers,
    setActiveCustomers,
  ] = useState(0);

  const [
    activeServices,
    setActiveServices,
  ] = useState(0);

  const [
    startDate,
    setStartDate,
  ] = useState("");

  const [
    endDate,
    setEndDate,
  ] = useState("");

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
    async function loadAnalytics() {
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

        const window =
          reportingWindow(
            context.business.timezone,
            30
          );

        setStartDate(
          window.startDate
        );

        setEndDate(
          window.endDate
        );

        const [
          periodAppointmentsResult,
          allAppointmentsResult,
          customersResult,
          servicesResult,
        ] = await Promise.all([
          supabase
            .from("appointments")
            .select(
              "id, service, appointment_date, status"
            )
            .eq(
              "business_id",
              businessId
            )
            .gte(
              "appointment_date",
              window.startDate
            )
            .lte(
              "appointment_date",
              window.endDate
            )
            .order(
              "appointment_date",
              {
                ascending: true,
              }
            ),

          supabase
            .from("appointments")
            .select("*", {
              count: "exact",
              head: true,
            })
            .eq(
              "business_id",
              businessId
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
        ]);

        const queryError =
          periodAppointmentsResult.error ||
          allAppointmentsResult.error ||
          customersResult.error ||
          servicesResult.error;

        if (queryError) {
          throw new Error(
            queryError.message
          );
        }

        setAppointments(
          (periodAppointmentsResult.data ||
            []) as AnalyticsAppointment[]
        );

        setAllTimeAppointments(
          allAppointmentsResult.count ??
            0
        );

        setActiveCustomers(
          customersResult.count ?? 0
        );

        setActiveServices(
          servicesResult.count ?? 0
        );
      } catch (error) {
        console.error(
          "Analytics data load error:",
          error
        );

        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load analytics."
        );
      } finally {
        setLoading(false);
      }
    }

    void loadAnalytics();
  }, [router]);

  const statusCounts =
    useMemo(
      () =>
        countStatuses(
          appointments
        ),
      [appointments]
    );

  const dailyCounts =
    useMemo(
      () =>
        startDate
          ? dailyAppointmentCounts(
              appointments,
              startDate,
              30
            )
          : [],
      [
        appointments,
        startDate,
      ]
    );

  const serviceCounts =
    useMemo(
      () =>
        serviceAppointmentCounts(
          appointments
        ),
      [appointments]
    );

  const completionRate =
    percentage(
      statusCounts.Completed,
      appointments.length
    );

  const cancellationRate =
    percentage(
      statusCounts.Cancelled,
      appointments.length
    );

  const maxDailyCount =
    Math.max(
      1,
      ...dailyCounts.map(
        (item) => item.count
      )
    );

  const maxServiceCount =
    Math.max(
      1,
      ...serviceCounts.map(
        (item) => item.count
      )
    );

  const busiestDay =
    dailyCounts.reduce<
      | {
          date: string;
          count: number;
        }
      | undefined
    >(
      (current, item) => {
        if (
          !current ||
          item.count >
            current.count
        ) {
          return item;
        }

        return current;
      },
      undefined
    );

  const topService =
    serviceCounts[0];

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 border-b border-gray-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
              Insights
            </p>

            <h1 className="anaai-page-title mt-2">
              Analytics
            </h1>

            <p className="anaai-page-description mt-2 max-w-2xl">
              Review appointment
              activity, customer
              coverage, and booking
              trends for your
              business.
            </p>
          </div>

          {!loading &&
            !loadError &&
            startDate &&
            endDate && (
              <div className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-600 shadow-sm">
                <CalendarDays className="size-4 text-gray-400" />

                <span>
                  {formatShortDate(
                    startDate
                  )}{" "}
                  –{" "}
                  {formatShortDate(
                    endDate
                  )}
                </span>
              </div>
            )}
        </header>

        {loading ? (
          <div className="anaai-surface p-8">
            <div className="flex items-center gap-3">
              <div className="size-5 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

              <p className="text-sm text-gray-500">
                Loading analytics...
              </p>
            </div>
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="anaai-surface p-6"
          >
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <XCircle className="size-5" />
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-950">
                  Analytics could
                  not be loaded
                </p>

                <p className="mt-1 text-sm leading-6 text-gray-500">
                  {loadError}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="anaai-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-gray-500">
                      Appointments
                    </p>

                    <p className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
                      {
                        appointments.length
                      }
                    </p>
                  </div>

                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                    <CalendarDays className="size-5" />
                  </div>
                </div>

                <p className="mt-3 text-xs leading-5 text-gray-500">
                  Scheduled during
                  this 30-day period.
                </p>
              </div>

              <div className="anaai-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-gray-500">
                      Completed
                    </p>

                    <p className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
                      {
                        statusCounts.Completed
                      }
                    </p>
                  </div>

                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                    <CheckCircle2 className="size-5" />
                  </div>
                </div>

                <p className="mt-3 text-xs leading-5 text-gray-500">
                  {completionRate}% of
                  appointments in the
                  reporting period.
                </p>
              </div>

              <div className="anaai-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-gray-500">
                      Active customers
                    </p>

                    <p className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
                      {activeCustomers}
                    </p>
                  </div>

                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                    <Users className="size-5" />
                  </div>
                </div>

                <p className="mt-3 text-xs leading-5 text-gray-500">
                  Active customer
                  records available
                  for booking.
                </p>
              </div>

              <div className="anaai-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-gray-500">
                      Active services
                    </p>

                    <p className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
                      {activeServices}
                    </p>
                  </div>

                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                    <Scissors className="size-5" />
                  </div>
                </div>

                <p className="mt-3 text-xs leading-5 text-gray-500">
                  Services currently
                  available for
                  booking.
                </p>
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.7fr)]">
              <div className="anaai-surface overflow-hidden">
                <div className="flex flex-col gap-2 border-b border-gray-200 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div>
                    <h2 className="anaai-section-title">
                      Appointment trend
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      Daily appointment
                      volume across the
                      current 30-day
                      reporting window.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                    <span className="size-2 rounded-full bg-green-500" />
                    Appointments
                  </div>
                </div>

                <div className="p-5 sm:p-6">
                  {appointments.length ===
                  0 ? (
                    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 px-6 py-10 text-center">
                      <div className="flex size-11 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
                        <CalendarDays className="size-5" />
                      </div>

                      <p className="mt-4 text-sm font-semibold text-gray-900">
                        No appointments
                        in this period
                      </p>

                      <p className="mt-1 max-w-sm text-sm leading-6 text-gray-500">
                        Appointment
                        activity will
                        appear here once
                        bookings are
                        recorded.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto pb-2">
                      <div className="min-w-[720px]">
                        <div className="flex h-56 items-end gap-1 border-b border-gray-200">
                          {dailyCounts.map(
                            (item) => {
                              const height =
                                item.count ===
                                0
                                  ? 3
                                  : Math.max(
                                      12,
                                      Math.round(
                                        (item.count /
                                          maxDailyCount) *
                                          180
                                      )
                                    );

                              return (
                                <div
                                  key={
                                    item.date
                                  }
                                  className="group flex min-w-0 flex-1 flex-col items-center justify-end self-stretch"
                                  title={`${formatShortDate(
                                    item.date
                                  )}: ${
                                    item.count
                                  } ${pluralizeAppointments(
                                    item.count
                                  )}`}
                                >
                                  <div className="flex flex-1 items-end">
                                    {item.count >
                                      0 && (
                                      <span className="mb-1 text-[10px] font-semibold text-gray-500">
                                        {
                                          item.count
                                        }
                                      </span>
                                    )}
                                  </div>

                                  <div
                                    className="w-full rounded-t-sm bg-green-500 transition-opacity group-hover:opacity-80"
                                    style={{
                                      height: `${height}px`,
                                    }}
                                  />
                                </div>
                              );
                            }
                          )}
                        </div>

                        <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                          <span>
                            {dailyCounts[0]
                              ? formatShortDate(
                                  dailyCounts[0]
                                    .date
                                )
                              : ""}
                          </span>

                          <span>
                            {dailyCounts[
                              dailyCounts.length -
                                1
                            ]
                              ? formatShortDate(
                                  dailyCounts[
                                    dailyCounts.length -
                                      1
                                  ].date
                                )
                              : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="anaai-section-title">
                    Period overview
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Operational
                    highlights from
                    appointment data.
                  </p>
                </div>

                <div className="divide-y divide-gray-100">
                  <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-700">
                        <TrendingUp className="size-4" />
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs text-gray-500">
                          Completion rate
                        </p>

                        <p className="mt-0.5 text-sm font-medium text-gray-900">
                          Completed / all
                          period
                          appointments
                        </p>
                      </div>
                    </div>

                    <p className="shrink-0 text-lg font-semibold text-gray-950">
                      {completionRate}%
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
                        <XCircle className="size-4" />
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs text-gray-500">
                          Cancellation
                          rate
                        </p>

                        <p className="mt-0.5 text-sm font-medium text-gray-900">
                          Cancelled / all
                          period
                          appointments
                        </p>
                      </div>
                    </div>

                    <p className="shrink-0 text-lg font-semibold text-gray-950">
                      {cancellationRate}%
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
                        <CalendarDays className="size-4" />
                      </div>

                      <div>
                        <p className="text-xs text-gray-500">
                          All-time
                          appointments
                        </p>

                        <p className="mt-0.5 text-sm font-medium text-gray-900">
                          Business-wide
                          appointment
                          total
                        </p>
                      </div>
                    </div>

                    <p className="shrink-0 text-lg font-semibold text-gray-950">
                      {
                        allTimeAppointments
                      }
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
                        <Clock3 className="size-4" />
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs text-gray-500">
                          Busiest day
                        </p>

                        <p className="mt-0.5 truncate text-sm font-medium text-gray-900">
                          {busiestDay &&
                          busiestDay.count >
                            0
                            ? formatShortDate(
                                busiestDay.date
                              )
                            : "No activity"}
                        </p>
                      </div>
                    </div>

                    <p className="shrink-0 text-lg font-semibold text-gray-950">
                      {busiestDay?.count ??
                        0}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="anaai-section-title">
                    Appointment status
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Lifecycle status
                    distribution for
                    appointments in this
                    reporting period.
                  </p>
                </div>

                <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
                  <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-blue-700">
                        Booked
                      </p>

                      <span className="size-2 rounded-full bg-blue-500" />
                    </div>

                    <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-950">
                      {
                        statusCounts.Booked
                      }
                    </p>
                  </div>

                  <div className="rounded-xl border border-green-100 bg-green-50/70 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-green-700">
                        Confirmed
                      </p>

                      <span className="size-2 rounded-full bg-green-500" />
                    </div>

                    <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-950">
                      {
                        statusCounts.Confirmed
                      }
                    </p>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-gray-600">
                        Completed
                      </p>

                      <CheckCircle2 className="size-4 text-gray-400" />
                    </div>

                    <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-950">
                      {
                        statusCounts.Completed
                      }
                    </p>
                  </div>

                  <div className="rounded-xl border border-red-100 bg-red-50/70 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-red-700">
                        Cancelled
                      </p>

                      <XCircle className="size-4 text-red-400" />
                    </div>

                    <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-950">
                      {
                        statusCounts.Cancelled
                      }
                    </p>
                  </div>
                </div>

                {statusCounts.Other >
                  0 && (
                  <div className="border-t border-gray-100 px-5 py-4 sm:px-6">
                    <p className="text-sm text-gray-500">
                      Other statuses:{" "}
                      <span className="font-semibold text-gray-900">
                        {
                          statusCounts.Other
                        }
                      </span>
                    </p>
                  </div>
                )}
              </div>

              <div className="anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="anaai-section-title">
                        Service mix
                      </h2>

                      <p className="mt-1 text-sm text-gray-500">
                        Appointment
                        volume by
                        recorded service
                        snapshot.
                      </p>
                    </div>

                    {topService && (
                      <div className="hidden rounded-lg bg-green-50 px-3 py-2 text-right sm:block">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-green-700">
                          Most booked
                        </p>

                        <p className="mt-0.5 max-w-32 truncate text-xs font-semibold text-green-900">
                          {
                            topService.service
                          }
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-5 sm:p-6">
                  {serviceCounts.length ===
                  0 ? (
                    <div className="flex min-h-48 flex-col items-center justify-center text-center">
                      <div className="flex size-11 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
                        <Scissors className="size-5" />
                      </div>

                      <p className="mt-4 text-sm font-semibold text-gray-900">
                        No service data
                      </p>

                      <p className="mt-1 max-w-sm text-sm leading-6 text-gray-500">
                        No service
                        booking data is
                        available for
                        this reporting
                        period.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {serviceCounts
                        .slice(0, 8)
                        .map(
                          (item) => {
                            const width =
                              Math.max(
                                4,
                                Math.round(
                                  (item.count /
                                    maxServiceCount) *
                                    100
                                )
                              );

                            return (
                              <div
                                key={
                                  item.service
                                }
                              >
                                <div className="flex items-center justify-between gap-4">
                                  <p className="truncate text-sm font-medium text-gray-900">
                                    {
                                      item.service
                                    }
                                  </p>

                                  <p className="shrink-0 text-xs font-medium text-gray-500">
                                    {
                                      item.count
                                    }{" "}
                                    {pluralizeAppointments(
                                      item.count
                                    )}
                                  </p>
                                </div>

                                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-gray-100">
                                  <div
                                    className="h-full rounded-full bg-green-500"
                                    style={{
                                      width: `${width}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          }
                        )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="anaai-surface overflow-hidden">
              <div className="grid gap-0 md:grid-cols-2">
                <div className="border-b border-gray-100 p-5 sm:p-6 md:border-b-0 md:border-r">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                      <Activity className="size-5" />
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-gray-950">
                        Completion rate
                      </p>

                      <p className="mt-1 text-sm leading-6 text-gray-500">
                        {
                          statusCounts.Completed
                        }{" "}
                        completed out of{" "}
                        {
                          appointments.length
                        }{" "}
                        appointments in
                        this reporting
                        period.
                      </p>
                    </div>
                  </div>

                  <p className="mt-5 text-3xl font-semibold tracking-tight text-gray-950">
                    {completionRate}%
                  </p>
                </div>

                <div className="p-5 sm:p-6">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                      <XCircle className="size-5" />
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-gray-950">
                        Cancellation
                        rate
                      </p>

                      <p className="mt-1 text-sm leading-6 text-gray-500">
                        {
                          statusCounts.Cancelled
                        }{" "}
                        cancelled out of{" "}
                        {
                          appointments.length
                        }{" "}
                        appointments in
                        this reporting
                        period.
                      </p>
                    </div>
                  </div>

                  <p className="mt-5 text-3xl font-semibold tracking-tight text-gray-950">
                    {cancellationRate}%
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}