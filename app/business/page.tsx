"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function BusinessPage() {
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [businessHours, setBusinessHours] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      alert("Please login first.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.from("business_profiles").insert({
      user_id: user.id,
      business_name: businessName,
      owner_name: ownerName,
      phone,
      email,
      address,
      business_hours: businessHours,
    });

    setLoading(false);

    if (error) {
      alert(error.message);
    } else {
      alert("Business profile saved successfully!");
    }
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex justify-center py-10">
      <form
        onSubmit={handleSave}
        className="w-full max-w-xl bg-gray-900 p-8 rounded-xl space-y-4"
      >
        <h1 className="text-3xl font-bold text-cyan-400">
          Business Profile
        </h1>

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Business Name"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          required
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Owner Name"
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          required
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Phone Number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Business Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Business Address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />

        <textarea
          className="w-full p-3 rounded bg-gray-800"
          placeholder="Business Hours (e.g. Mon–Fri 9AM–6PM)"
          value={businessHours}
          onChange={(e) => setBusinessHours(e.target.value)}
          rows={4}
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-cyan-500 text-black font-bold py-3 rounded hover:bg-cyan-400 disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save Business Profile"}
        </button>
      </form>
    </main>
  );
}