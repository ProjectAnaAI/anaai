"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Users,
  Scissors,
  Bot,
} from "lucide-react";

import AppLayout from "@/components/layout/AppLayout";
import StatsCard from "@/components/dashboard/StatsCard";
import QuickActions from "@/components/dashboard/QuickActions";
import { activeBusinessHeaders } from "@/lib/active-business";
import { supabase } from "@/lib/supabase";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type BusinessProfile = {
  business_name: string;
  owner_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  business_hours: string | null;
};

export default function DashboardPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [appointmentCount, setAppointmentCount] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [serviceCount, setServiceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
          headers: { ...activeBusinessHeaders(), Authorization: `Bearer ${session.access_token}` },
        });
        const context = await response.json();

        if (!response.ok || !context.success || !context.business?.id) {
          throw new Error(context.error || "Unable to resolve your business.");
        }

        const businessId = context.business.id;

        setEmail(session.user.email || "");

        const { data: businessData, error: businessError } = await supabase
          .from("business_profiles")
          .select("*")
          .eq("business_id", businessId);

        if (businessError) throw new Error(businessError.message);
        setBusiness(businessData?.[0] || null);

        const today = new Date().toISOString().split("T")[0];

        const { count: todayAppointments, error: appointmentsError } = await supabase
          .from("appointments")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId)
          .eq("appointment_date", today);

        const { count: customers, error: customersError } = await supabase
          .from("customers")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);

        const { count: services, error: servicesError } = await supabase
          .from("services")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);

        const queryError = appointmentsError || customersError || servicesError;
        if (queryError) throw new Error(queryError.message);

        setAppointmentCount(todayAppointments || 0);
        setCustomerCount(customers || 0);
        setServiceCount(services || 0);

      } catch (error) {
        console.error("Business data load error:", error);
        setLoadError(error instanceof Error ? error.message : "Unable to load business data.");
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
  }, [router]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-gray-900">
        Loading dashboard...
      </main>
    );
  }

  if (loadError) {
    return <AppLayout><p role="alert" className="text-gray-500">{loadError}</p></AppLayout>;
  }

  return (
    <AppLayout>
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

      <section className="mt-8 grid gap-6 md:grid-cols-4">
        <StatsCard
          title="Today's appointments"
          value={appointmentCount}
          description="Bookings scheduled for today"
          icon={CalendarDays}
        />

        <StatsCard
          title="Customers"
          value={customerCount}
          description="Total saved customers"
          icon={Users}
        />

        <StatsCard
          title="Services"
          value={serviceCount}
          description="Active service catalog"
          icon={Scissors}
        />

        <StatsCard
          title="AI receptionist"
          value="Online"
          description="Ready for future call handling"
          icon={Bot}
        />
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Business overview</CardTitle>
          </CardHeader>

          <CardContent>
            {business ? (
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-gray-500">Business name</p>
                  <p className="font-medium text-gray-900">
                    {business.business_name}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500">Owner</p>
                  <p className="font-medium text-gray-900">
                    {business.owner_name}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500">Phone</p>
                  <p className="font-medium text-gray-900">
                    {business.phone || "Not provided"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500">Business hours</p>
                  <p className="font-medium text-gray-900">
                    {business.business_hours || "Not provided"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                No business profile found.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI status</CardTitle>
          </CardHeader>

          <CardContent>
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100">
              Online
            </Badge>

            <p className="mt-4 text-sm text-gray-500">
              The AI receptionist module will connect to business services,
              appointments, and customer history in a later milestone.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mt-8">
        <QuickActions />
      </section>
    </AppLayout>
  );
}