"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppLayout from "@/components/layout/AppLayout";
import { activeBusinessHeaders } from "@/lib/active-business";
import { saveCustomer } from "@/lib/customer-mutations";
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

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
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

export default function CustomersPage() {
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

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
        ...activeBusinessHeaders(),
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

    await loadCustomers(context.businessId);

    setLoading(false);
  }

  async function loadCustomers(selectedBusinessId?: string) {
    const activeBusinessId = selectedBusinessId ?? businessId;

    if (!activeBusinessId) {
      return;
    }

    const { data, error } = await supabase
      .from("customers")
      .select("id, full_name, phone, email, notes")
      .eq("business_id", activeBusinessId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Could not load customers:", error);
      alert(error.message);
      return;
    }

    setCustomers(data ?? []);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!businessId || !userId) {
      alert("Business context is not available.");
      return;
    }

    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const customer = await saveCustomer(businessId, { name: fullName, phone, email, notes }, { id: editingId || undefined });
      setCustomers(current => [customer, ...current.filter(item => item.id !== customer.id)]);
      setFeedback(editingId ? "Customer updated." : "Customer created.");
      setEditingId(null);
      setFullName(""); setPhone(""); setEmail(""); setNotes("");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Unable to save customer.");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function editCustomer(customer: Customer) {
    if (saveInFlight.current) return;
    setEditingId(customer.id);
    setFullName(customer.full_name); setPhone(customer.phone || "");
    setEmail(customer.email || ""); setNotes(customer.notes || "");
    setFeedback("");
    document.getElementById("customer-editor")?.scrollIntoView({ behavior: "smooth" });
  }

  function cancelEdit() {
    if (saveInFlight.current) return;
    setEditingId(null); setFullName(""); setPhone(""); setEmail(""); setNotes(""); setFeedback("");
  }

  async function deleteCustomer(id: string) {
    if (!businessId) {
      alert("Business context is not available.");
      return;
    }

    const { error } = await supabase
      .from("customers")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) {
      alert(error.message);
      return;
    }

    if (editingId === id) cancelEdit();
    await loadCustomers();
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            CRM
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Customers
          </h1>

          <p className="mt-2 text-gray-500">
            Manage customer information and relationship history.
          </p>
        </header>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>{editingId ? "Edit customer" : "New customer"}</CardTitle>
          </CardHeader>

          <CardContent>
            <form id="customer-editor" onSubmit={handleSubmit}>
              <fieldset disabled={saving}>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  placeholder="Full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />

                <Input
                  placeholder="Phone number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />

                <Input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <Textarea
                className="mt-4"
                placeholder="Customer notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />

              <Button
                type="submit"
                className="mt-5"
                disabled={saving || !businessId || !userId}
              >
                {saving ? "Saving..." : editingId ? "Save changes" : "Save customer"}
              </Button>
              {editingId && <Button type="button" variant="outline" className="ml-2" onClick={cancelEdit}>Cancel</Button>}
              </fieldset>
              {feedback && <p role="status" className="mt-3 text-sm">{feedback}</p>}
            </form>
          </CardContent>
        </Card>

        <section className="mt-10">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Customer list
          </h2>

          {loading ? (
            <p className="mt-4 text-gray-500">Loading customers...</p>
          ) : customers.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No customers yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                New customers will appear here once they are created.
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {customers.map((customer) => (
                <div
                  key={customer.id}
                  className="border-b border-gray-100 p-5 last:border-b-0"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {customer.full_name}
                      </h3>

                      <div className="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-2">
                        <p>
                          <span className="font-medium text-gray-900">
                            Phone:
                          </span>{" "}
                          {customer.phone || "Not provided"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Email:
                          </span>{" "}
                          {customer.email || "Not provided"}
                        </p>
                      </div>

                      {customer.notes && (
                        <p className="mt-3 text-sm text-gray-500">
                          {customer.notes}
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2">
                    <Button variant="outline" disabled={saving} onClick={() => editCustomer(customer)}>Edit</Button>
                    <Button
                      disabled={saving}
                      variant="destructive"
                      onClick={() => deleteCustomer(customer.id)}
                    >
                      Delete
                    </Button>
                    </div>
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