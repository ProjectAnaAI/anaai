"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppLayout from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
};

export default function CustomersPage() {
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    loadCustomers();
  }, []);

  async function loadCustomers() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return;
    }

    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (!error && data) {
      setCustomers(data);
    }

    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return;

    const { error } = await supabase.from("customers").insert({
      user_id: user.id,
      full_name: fullName,
      phone,
      email,
      notes,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setFullName("");
    setPhone("");
    setEmail("");
    setNotes("");

    loadCustomers();
  }

  async function deleteCustomer(id: string) {
    const { error } = await supabase.from("customers").delete().eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    loadCustomers();
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
            <CardTitle>New customer</CardTitle>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit}>
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

              <Button type="submit" className="mt-5">
                Save customer
              </Button>
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
              <p className="font-medium text-gray-900">No customers yet</p>
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

                    <Button
                      variant="destructive"
                      onClick={() => deleteCustomer(customer.id)}
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