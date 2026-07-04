"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Calendar } from "lucide-react";
import { supabase } from "@/lib/supabase";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setEmail(user.email || "");

      const { data, error } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", user.id);

      if (!error && data) {
        setBusiness(data[0] || null);
      }

      setLoading(false);
    }

    loadData();
  }, [router]);

  if (loading) {
    return (
      <main className="min-h-screen bg-white text-gray-900 flex items-center justify-center">
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

        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          Dashboard
        </h1>

        <p className="mt-2 text-gray-500">
          Welcome back, {email}
        </p>
      </header>

      <section className="mt-8 grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-green-600" />
              Business
            </CardTitle>
          </CardHeader>

          <CardContent>
            {business ? (
              <div className="space-y-3 text-sm">
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
            <CardTitle>AI Receptionist</CardTitle>
          </CardHeader>

          <CardContent>
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100">
              Online
            </Badge>

            <p className="mt-4 text-sm text-gray-500">
              AI call handling will be connected in a later milestone.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appointments</CardTitle>
          </CardHeader>

          <CardContent>
            <p className="text-3xl font-semibold tracking-tight">Active</p>

            <p className="mt-2 text-sm text-gray-500">
              Manage bookings and customer schedule.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mt-8">
        <Card>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
          </CardHeader>

          <CardContent className="flex flex-wrap gap-3">
            <Button onClick={() => router.push("/appointments")}>
              <Calendar className="mr-2 h-4 w-4" />
              Appointments
            </Button>

            <Button
              variant="outline"
              onClick={() => router.push("/business")}
            >
              <Building2 className="mr-2 h-4 w-4" />
              Business profile
            </Button>
          </CardContent>
        </Card>
      </section>
    </AppLayout>
  );
}