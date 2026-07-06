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

  useEffect(() => {
    async function loadDashboard() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setEmail(user.email || "");

      const { data: businessData } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", user.id);

      setBusiness(businessData?.[0] || null);

      const today = new Date().toISOString().split("T")[0];

      const { count: todayAppointments } = await supabase
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("appointment_date", today);

      const { count: customers } = await supabase
        .from("customers")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id);

      const { count: services } = await supabase
        .from("services")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id);

      setAppointmentCount(todayAppointments || 0);
      setCustomerCount(customers || 0);
      setServiceCount(services || 0);

      setLoading(false);
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