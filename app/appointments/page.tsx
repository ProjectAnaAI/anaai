"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Appointment = {
  id: string;
  customer_id: string | null;
  service_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  service: string;
  appointment_date: string;
  appointment_time: string;
  status: string;
  notes: string;
};

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
};

type Service = {
  id: string;
  name: string;
};

export default function AppointmentsPage() {
  const router = useRouter();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const [customerId, setCustomerId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [appointmentDate, setAppointmentDate] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    loadAppointments();
  }, []);

  async function loadAppointments() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return;
    }

    const { data: customerData } = await supabase
      .from("customers")
      .select("id, full_name, phone, email")
      .eq("user_id", user.id)
      .order("full_name");

    setCustomers(customerData || []);

    const { data: serviceData } = await supabase
      .from("services")
      .select("id, name")
      .eq("user_id", user.id)
      .order("name");

    setServices(serviceData || []);

    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("user_id", user.id)
      .order("appointment_date", { ascending: true })
      .order("appointment_time", { ascending: true });

    if (!error && data) {
      setAppointments(data);
    }

    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return;

    const selectedCustomer = customers.find(
      (customer) => customer.id === customerId
    );

    const selectedService = services.find(
      (service) => service.id === serviceId
    );

    if (!selectedCustomer) {
      alert("Please select a customer.");
      return;
    }

    if (!selectedService) {
      alert("Please select a service.");
      return;
    }

    const { error } = await supabase.from("appointments").insert({
      user_id: user.id,
      customer_id: selectedCustomer.id,
      service_id: selectedService.id,
      customer_name: selectedCustomer.full_name,
      customer_phone: selectedCustomer.phone,
      customer_email: selectedCustomer.email,
      service: selectedService.name,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      notes,
      status: "Booked",
    });

    if (error) {
      alert(error.message);
      return;
    }

    setCustomerId("");
    setServiceId("");
    setAppointmentDate("");
    setAppointmentTime("");
    setNotes("");

    loadAppointments();
  }

  async function deleteAppointment(id: string) {
    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    loadAppointments();
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            Scheduling
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Appointments
          </h1>

          <p className="mt-2 text-gray-500">
            Create bookings by selecting an existing customer and service.
          </p>
        </header>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>New appointment</CardTitle>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit}>
              <div className="grid gap-4 md:grid-cols-2">
                <select
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                >
                  <option value="">Select customer</option>

                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.full_name}
                    </option>
                  ))}
                </select>

                <select
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  required
                >
                  <option value="">Select service</option>

                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>

                <Input
                  type="date"
                  value={appointmentDate}
                  onChange={(e) => setAppointmentDate(e.target.value)}
                  required
                />

                <Input
                  type="time"
                  value={appointmentTime}
                  onChange={(e) => setAppointmentTime(e.target.value)}
                  required
                />
              </div>

              <Textarea
                className="mt-4"
                placeholder="Internal notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />

              <Button type="submit" className="mt-5">
                Save appointment
              </Button>
            </form>
          </CardContent>
        </Card>

        <section className="mt-10">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Upcoming appointments
          </h2>

          {loading ? (
            <p className="mt-4 text-gray-500">Loading appointments...</p>
          ) : appointments.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">No appointments yet</p>
              <p className="mt-2 text-sm text-gray-500">
                New bookings will appear here once they are created.
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {appointments.map((appointment) => (
                <div
                  key={appointment.id}
                  className="border-b border-gray-100 p-5 last:border-b-0"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {appointment.customer_name}
                      </h3>

                      <div className="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-2">
                        <p>
                          <span className="font-medium text-gray-900">
                            Phone:
                          </span>{" "}
                          {appointment.customer_phone || "Not provided"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Email:
                          </span>{" "}
                          {appointment.customer_email || "Not provided"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Service:
                          </span>{" "}
                          {appointment.service || "Not specified"}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Status:
                          </span>{" "}
                          {appointment.status}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Date:
                          </span>{" "}
                          {appointment.appointment_date}
                        </p>

                        <p>
                          <span className="font-medium text-gray-900">
                            Time:
                          </span>{" "}
                          {appointment.appointment_time}
                        </p>
                      </div>

                      {appointment.notes && (
                        <p className="mt-3 text-sm text-gray-500">
                          {appointment.notes}
                        </p>
                      )}
                    </div>

                    <Button
                      variant="destructive"
                      onClick={() => deleteAppointment(appointment.id)}
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