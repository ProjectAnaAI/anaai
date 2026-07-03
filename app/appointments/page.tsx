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

  async function handleSubmit(e: React.FormEvent) {
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

  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <h1 className="text-4xl font-bold text-cyan-400">
        Appointments
      </h1>

      <form
        onSubmit={handleSubmit}
        className="mt-8 bg-gray-900 p-6 rounded-xl space-y-4"
      >
        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Customer Name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          required
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Phone Number"
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          type="email"
          placeholder="Email"
          value={customerEmail}
          onChange={(e) => setCustomerEmail(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Service"
          value={service}
          onChange={(e) => setService(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          type="date"
          value={appointmentDate}
          onChange={(e) => setAppointmentDate(e.target.value)}
          required
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          type="time"
          value={appointmentTime}
          onChange={(e) => setAppointmentTime(e.target.value)}
          required
        />

        <textarea
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <button
          type="submit"
          className="w-full bg-cyan-500 text-black font-bold py-3 rounded-lg hover:bg-cyan-400"
        >
          Save Appointment
        </button>
      </form>

      <div className="mt-10">
        <h2 className="text-2xl font-bold mb-4">
          Upcoming Appointments
        </h2>

        {loading ? (
          <p>Loading...</p>
        ) : appointments.length === 0 ? (
          <p>No appointments yet.</p>
        ) : (
          <div className="space-y-4">
            {appointments.map((appointment) => (
              <div
                key={appointment.id}
                className="bg-gray-900 p-5 rounded-xl"
              >
                <h3 className="text-xl font-semibold text-cyan-400">
                  {appointment.customer_name}
                </h3>

                <p>📞 {appointment.customer_phone}</p>
                <p>✉️ {appointment.customer_email}</p>
                <p>🛠 {appointment.service}</p>
                <p>
                  📅 {appointment.appointment_date} at{" "}
                  {appointment.appointment_time}
                </p>
                <p>📌 {appointment.status}</p>

                {appointment.notes && (
                  <p className="text-gray-400 mt-2">
                    {appointment.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}