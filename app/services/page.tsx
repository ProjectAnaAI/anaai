"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppLayout from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Service = {
  id: string;
  name: string;
  duration_minutes: number | null;
  price: number | null;
  description: string | null;
  is_active: boolean;
};

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

export default function ServicesPage() {
  const router = useRouter();

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    initializePage();
  }, []);

  async function getAuthenticatedContext() {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session?.access_token || !session.user) {
      return null;
    }

    const response = await fetch("/api/current-business", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    const data = (await response.json()) as CurrentBusinessResponse;

    if (!response.ok || !data.success || !data.business) {
      console.error("Could not resolve current business:", data.error);
      return null;
    }

    return {
      userId: session.user.id,
      businessId: data.business.id,
    };
  }

  async function initializePage() {
    setLoading(true);

    const context = await getAuthenticatedContext();

    if (!context) {
      router.push("/login");
      return;
    }

    setUserId(context.userId);
    setBusinessId(context.businessId);

    await loadServices(context.businessId);

    setLoading(false);
  }

  async function loadServices(selectedBusinessId?: string) {
    const activeBusinessId = selectedBusinessId ?? businessId;

    if (!activeBusinessId) {
      return;
    }

    const { data, error } = await supabase
      .from("services")
      .select(
        "id, name, duration_minutes, price, description, is_active"
      )
      .eq("business_id", activeBusinessId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Could not load services:", error);
      alert(error.message);
      return;
    }

    setServices(data ?? []);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!businessId || !userId) {
      alert("Business context is not available.");
      return;
    }

    const trimmedName = name.trim();

    if (!trimmedName) {
      alert("Service name is required.");
      return;
    }

    const { error } = await supabase.from("services").insert({
      business_id: businessId,

      // Temporary compatibility during the user_id → business_id migration.
      // We will remove this after every AnaAI feature is business-scoped.
      user_id: userId,

      name: trimmedName,
      duration_minutes: durationMinutes
        ? Number(durationMinutes)
        : null,
      price: price ? Number(price) : null,
      description: description.trim() || null,
      is_active: true,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setName("");
    setDurationMinutes("");
    setPrice("");
    setDescription("");

    await loadServices();
  }

  async function deleteService(id: string) {
    if (!businessId) {
      alert("Business context is not available.");
      return;
    }

    const { error } = await supabase
      .from("services")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) {
      alert(error.message);
      return;
    }

    await loadServices();
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            Business setup
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Services
          </h1>

          <p className="mt-2 text-gray-500">
            Create and manage the services your business offers.
          </p>
        </header>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>New service</CardTitle>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit}>
              <div className="grid gap-4 md:grid-cols-3">
                <Input
                  placeholder="Service name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />

                <Input
                  type="number"
                  min="1"
                  placeholder="Duration in minutes"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(e.target.value)}
                />

                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Price"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>

              <Textarea
                className="mt-4"
                placeholder="Service description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />

              <Button
                type="submit"
                className="mt-5"
                disabled={!businessId || !userId}
              >
                Save service
              </Button>
            </form>
          </CardContent>
        </Card>

        <section className="mt-10">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Service list
          </h2>

          {loading ? (
            <p className="mt-4 text-gray-500">Loading services...</p>
          ) : services.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No services yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                New services will appear here once they are created.
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {services.map((service) => (
                <div
                  key={service.id}
                  className="border-b border-gray-100 p-5 last:border-b-0"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {service.name}
                      </h3>

                      <div className="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-3">
                        <p>
                          <span className="font-medium text-gray-900">
                            Duration:
                          </span>{" "}
                          {service.duration_minutes
                            ? `${service.duration_minutes} minutes`
                            : "Not set"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Price:
                          </span>{" "}
                          {service.price !== null
                            ? `$${Number(service.price).toFixed(2)}`
                            : "Not set"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Status:
                          </span>{" "}
                          {service.is_active ? "Active" : "Inactive"}
                        </p>
                      </div>

                      {service.description && (
                        <p className="mt-3 text-sm text-gray-500">
                          {service.description}
                        </p>
                      )}
                    </div>

                    <Button
                      variant="destructive"
                      onClick={() => deleteService(service.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </AppLayout>
  );
}