"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function DashboardPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("Loading...");

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

      const { data } = await supabase
        .from("business_profiles")
        .select("business_name")
        .eq("user_id", user.id)
        .single();

      if (data) {
        setBusinessName(data.business_name);
      }
    }

    loadData();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white p-10">
      <h1 className="text-4xl font-bold text-cyan-400">
        AnaAI Dashboard
      </h1>

      <p className="mt-2 text-gray-400">
        Welcome back, {email}
      </p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-900 rounded-xl p-6">
          <h2 className="text-xl font-semibold">Business</h2>
          <p className="mt-3 text-cyan-400 text-lg">
            {businessName}
          </p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6">
          <h2 className="text-xl font-semibold">
            Today's Appointments
          </h2>

          <p className="mt-3 text-4xl font-bold">
            Coming Soon
          </p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6">
          <h2 className="text-xl font-semibold">
            AI Receptionist
          </h2>

          <p className="mt-3 text-green-400">
            Coming Soon
          </p>
        </div>
      </div>

      <div className="mt-10 flex flex-wrap gap-4">
        <button
          onClick={() => router.push("/appointments")}
          className="bg-cyan-500 text-black px-6 py-3 rounded-lg font-bold hover:bg-cyan-400"
        >
          Appointments
        </button>

        <button
          onClick={() => router.push("/business")}
          className="bg-cyan-500 text-black px-6 py-3 rounded-lg font-bold hover:bg-cyan-400"
        >
          Business Profile
        </button>

        <button
          onClick={handleLogout}
          className="bg-red-500 px-6 py-3 rounded-lg font-bold hover:bg-red-600"
        >
          Logout
        </button>
      </div>
    </main>
  );
}