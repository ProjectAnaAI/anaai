"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  Scissors,
  Users,
  XCircle,
} from "lucide-react";

import AppLayout from "@/components/layout/AppLayout";
import StatsCard from "@/components/dashboard/StatsCard";
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

  return (
    <AppLayout>
      <div className="mx-auto max-w-7xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            Insights
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Analytics
          </h1>

          <p className="mt-2 text-gray-500">
            Review booking activity
            and operational trends
            for the last 30 days.
          </p>

          {!loading &&
            !loadError &&
            startDate &&
            endDate && (
              <p className="mt-2 text-sm text-gray-400">
                {formatShortDate(
                  startDate
                )}{" "}
                –{" "}
                {formatShortDate(
                  endDate
                )}
              </p>
            )}
        </header>

        {loading ? (
          <p className="mt-8 text-gray-500">
            Loading analytics...
          </p>
        ) : loadError ? (
          <p
            role="alert"
            className="mt-8 text-gray-500"
          >
            {loadError}
          </p>
        ) : (
          <>
            <section className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <StatsCard
                title="Appointments"
                value={
                  appointments.length
                }
                description="Scheduled in the last 30 days"
                icon={CalendarDays}
              />

              <StatsCard
                title="Completed"
                value={
                  statusCounts.Completed
                }
                description={`${completionRate}% of appointments`}
                icon={CheckCircle2}
              />

              <StatsCard
                title="Active customers"
                value={activeCustomers}
                description="Customers available for booking"
                icon={Users}
              />

              <StatsCard
                title="Active services"
                value={activeServices}
                description="Services available for booking"
                icon={Scissors}
              />
            </section>

            <section className="mt-8 grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>
                    Appointment status
                  </CardTitle>
                </CardHeader>

                <CardContent>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-xl bg-blue-50 p-4">
                      <p className="text-sm font-medium text-blue-700">
                        Booked
                      </p>

                      <p className="mt-2 text-2xl font-semibold text-gray-900">
                        {
                          statusCounts.Booked
                        }
                      </p>
                    </div>

                    <div className="rounded-xl bg-green-50 p-4">
                      <p className="text-sm font-medium text-green-700">
                        Confirmed
                      </p>

                      <p className="mt-2 text-2xl font-semibold text-gray-900">
                        {
                          statusCounts.Confirmed
                        }
                      </p>
                    </div>

                    <div className="rounded-xl bg-gray-50 p-4">
                      <p className="text-sm font-medium text-gray-600">
                        Completed
                      </p>

                      <p className="mt-2 text-2xl font-semibold text-gray-900">
                        {
                          statusCounts.Completed
                        }
                      </p>
                    </div>

                    <div className="rounded-xl bg-red-50 p-4">
                      <p className="text-sm font-medium text-red-700">
                        Cancelled
                      </p>

                      <p className="mt-2 text-2xl font-semibold text-gray-900">
                        {
                          statusCounts.Cancelled
                        }
                      </p>
                    </div>
                  </div>

                  {statusCounts.Other >
                    0 && (
                    <p className="mt-4 text-sm text-gray-500">
                      Other statuses:{" "}
                      {
                        statusCounts.Other
                      }
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    Performance
                  </CardTitle>
                </CardHeader>

                <CardContent>
                  <div className="space-y-5">
                    <div>
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm text-gray-500">
                          Completion rate
                        </p>

                        <p className="font-semibold text-gray-900">
                          {completionRate}%
                        </p>
                      </div>

                      <p className="mt-1 text-xs text-gray-400">
                        Completed
                        appointments divided
                        by all appointments
                        in this 30-day
                        period.
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm text-gray-500">
                          Cancellation rate
                        </p>

                        <p className="font-semibold text-gray-900">
                          {cancellationRate}%
                        </p>
                      </div>

                      <p className="mt-1 text-xs text-gray-400">
                        Cancelled
                        appointments divided
                        by all appointments
                        in this 30-day
                        period.
                      </p>
                    </div>

                    <div className="border-t border-gray-100 pt-5">
                      <p className="text-sm text-gray-500">
                        All-time
                        appointments
                      </p>

                      <p className="mt-2 text-3xl font-semibold text-gray-900">
                        {
                          allTimeAppointments
                        }
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </section>

            <section className="mt-8">
              <Card>
                <CardHeader>
                  <CardTitle>
                    Appointment trend
                  </CardTitle>
                </CardHeader>

                <CardContent>
                  {appointments.length ===
                  0 ? (
                    <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center">
                      <CalendarDays className="mx-auto h-8 w-8 text-gray-400" />

                      <p className="mt-3 font-medium text-gray-900">
                        No appointments
                        in this period
                      </p>

                      <p className="mt-1 text-sm text-gray-500">
                        Appointment
                        activity will
                        appear here once
                        bookings are
                        recorded.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto pb-2">
                      <div className="flex min-w-[760px] items-end gap-1">
                        {dailyCounts.map(
                          (item) => {
                            const height =
                              item.count ===
                              0
                                ? 4
                                : Math.max(
                                    12,
                                    Math.round(
                                      (item.count /
                                        maxDailyCount) *
                                        160
                                    )
                                  );

                            return (
                              <div
                                key={
                                  item.date
                                }
                                className="flex min-w-0 flex-1 flex-col items-center justify-end"
                              >
                                <span className="mb-1 text-xs font-medium text-gray-500">
                                  {item.count >
                                  0
                                    ? item.count
                                    : ""}
                                </span>

                                <div
                                  className="w-full rounded-t bg-green-500"
                                  style={{
                                    height: `${height}px`,
                                  }}
                                  title={`${formatShortDate(
                                    item.date
                                  )}: ${
                                    item.count
                                  } appointments`}
                                />

                                <span className="mt-2 text-[10px] text-gray-400">
                                  {item.date ===
                                    dailyCounts[
                                      0
                                    ]?.date ||
                                  item.date ===
                                    dailyCounts[
                                      dailyCounts.length -
                                        1
                                    ]?.date
                                    ? formatShortDate(
                                        item.date
                                      )
                                    : ""}
                                </span>
                              </div>
                            );
                          }
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            <section className="mt-8">
              <Card>
                <CardHeader>
                  <CardTitle>
                    Service mix
                  </CardTitle>
                </CardHeader>

                <CardContent>
                  {serviceCounts.length ===
                  0 ? (
                    <p className="text-sm text-gray-500">
                      No service booking
                      data is available
                      for this period.
                    </p>
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

                                  <p className="shrink-0 text-sm text-gray-500">
                                    {
                                      item.count
                                    }{" "}
                                    {item.count ===
                                    1
                                      ? "appointment"
                                      : "appointments"}
                                  </p>
                                </div>

                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
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
                </CardContent>
              </Card>
            </section>

            <section className="mt-8">
              <Card>
                <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-gray-500" />

                      <p className="font-medium text-gray-900">
                        Cancellation
                        rate
                      </p>
                    </div>

                    <p className="mt-1 text-sm text-gray-500">
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

                  <p className="text-3xl font-semibold text-gray-900">
                    {cancellationRate}%
                  </p>
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}