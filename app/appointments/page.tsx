"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

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
    <main className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <div className="flex items-center justify-between border-b border-gray-200 pb-6">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-green-600">
              Scheduling
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
              Appointments
            </h1>
            <p className="mt-2 text-gray-500">
              Create and manage customer bookings.
            </p>
          </div>

          <button
            onClick={() => router.push("/dashboard")}
            className="rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Back to dashboard
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="mt-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
        >
          <h2 className="text-xl font-semibold tracking-tight">
            New appointment
          </h2>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              required
            />

            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Phone number"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
            />

            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              type="email"
              placeholder="Email address"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
            />

            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Service"
              value={service}
              onChange={(e) => setService(e.target.value)}
            />

            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              type="date"
              value={appointmentDate}
              onChange={(e) => setAppointmentDate(e.target.value)}
              required
            />

            <input
              className="rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
              type="time"
              value={appointmentTime}
              onChange={(e) => setAppointmentTime(e.target.value)}
              required
            />
          </div>

          <textarea
            className="mt-4 w-full rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="Internal notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <button
            type="submit"
            className="mt-5 rounded-xl bg-green-600 px-6 py-3 text-sm font-medium text-white transition hover:bg-green-700"
          >
            Save appointment
          </button>
        </form>

        <section className="mt-10">
          <h2 className="text-2xl font-semibold tracking-tight">
            Upcoming appointments
          </h2>

          {loading ? (
            <p className="mt-4 text-gray-500">Loading appointments...</p>
          ) : appointments.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 p-8 text-center">
              <p className="font-medium text-gray-900">No appointments yet</p>
              <p className="mt-2 text-sm text-gray-500">
                New bookings will appear here once they are created.
              </p>
            </div>
          ) : (
            <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
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

                    <button
                      onClick={() => deleteAppointment(appointment.id)}
                      className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}