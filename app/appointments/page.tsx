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
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  service: string;
  appointment_date: string;
  appointment_time: string;
  status: string;
  notes: string;
};

export default function AppointmentsPage() {
  const router = useRouter();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [service, setService] = useState("");
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

    const { error } = await supabase.from("appointments").insert({
      user_id: user.id,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      service,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      notes,
      status: "Booked",
    });

    if (error) {
      alert(error.message);
      return;
    }

    setCustomerName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setService("");
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
            Create and manage customer bookings.
          </p>
        </header>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>New appointment</CardTitle>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit}>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  placeholder="Customer name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  required
                />

                <Input
                  placeholder="Phone number"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />

                <Input
                  type="email"
                  placeholder="Email address"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                />

                <Input
                  placeholder="Service"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                />

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