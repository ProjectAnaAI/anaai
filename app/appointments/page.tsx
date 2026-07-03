"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function AppointmentsPage() {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [service, setService] = useState("");
  const [appointmentDate, setAppointmentDate] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      alert("Please log in first.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.from("appointments").insert({
      user_id: user.id,
      customer_name: customerName,
      customer_phone: customerPhone,
      service,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
    });

    setLoading(false);

    if (error) {
      alert(error.message);
      return;
    }

    alert("Appointment saved successfully!");

    setCustomerName("");
    setCustomerPhone("");
    setService("");
    setAppointmentDate("");
    setAppointmentTime("");
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex justify-center py-10">
      <form
        onSubmit={handleSave}
        className="w-full max-w-xl bg-gray-900 p-8 rounded-xl space-y-4"
      >
        <h1 className="text-3xl font-bold text-cyan-400">
          New Appointment
        </h1>

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
          placeholder="Service"
          value={service}
          onChange={(e) => setService(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          type="date"
          value={appointmentDate}
          onChange={(e) => setAppointmentDate(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          type="time"
          value={appointmentTime}
          onChange={(e) => setAppointmentTime(e.target.value)}
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-cyan-500 text-black font-bold py-3 rounded hover:bg-cyan-400 disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save Appointment"}
        </button>
      </form>
    </main>
  );
}