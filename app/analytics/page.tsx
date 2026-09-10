"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  Users,
  Scissors,
} from "lucide-react";

import AppLayout from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";

export default function AnalyticsPage() {
  const router = useRouter();

  const [appointments, setAppointments] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [customers, setCustomers] = useState(0);
  const [services, setServices] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAnalytics() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const [
        appointmentsResult,
        completedResult,
        customersResult,
        servicesResult,
      ] = await Promise.all([
        supabase
          .from("appointments")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id),

        supabase
          .from("appointments")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("status", "Completed"),

        supabase
          .from("customers")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id),

        supabase
          .from("services")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id),
      ]);

      setAppointments(appointmentsResult.count ?? 0);
      setCompleted(completedResult.count ?? 0);
      setCustomers(customersResult.count ?? 0);
      setServices(servicesResult.count ?? 0);

      setLoading(false);
    }

    loadAnalytics();
  }, [router]);

  const stats = [
    {
      label: "Total Appointments",
      value: appointments,
      icon: CalendarDays,
    },
    {
      label: "Completed",
      value: completed,
      icon: CheckCircle2,
    },
    {
      label: "Customers",
      value: customers,
      icon: Users,
    },
    {
      label: "Services",
      value: services,
      icon: Scissors,
    },
  ];

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            Insights
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Analytics
          </h1>

          <p className="mt-2 text-gray-500">
            Track your business activity and booking performance.
          </p>
        </header>

        {loading ? (
          <p className="mt-8 text-gray-500">Loading analytics...</p>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => {
              const Icon = stat.icon;

              return (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-500">
                      {stat.label}
                    </p>

                    <div className="rounded-xl bg-green-50 p-2.5">
                      <Icon className="h-5 w-5 text-green-600" />
                    </div>
                  </div>

                  <p className="mt-5 text-3xl font-bold text-gray-900">
                    {stat.value}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900">
            More analytics coming soon
          </h2>

          <p className="mt-2 text-gray-500">
            Call volume, conversion rate, revenue, missed calls, AI performance,
            and appointment trends can be added once call handling is connected.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}