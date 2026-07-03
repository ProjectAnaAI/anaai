"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function DashboardPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [business, setBusiness] = useState<any>(null);
  const [loading, setLoading] = useState(true);

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

      const { data, error } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", user.id);

      if (error) {
        console.log("Database Error:", error.message);
        setBusiness(null);
      } else {
        setBusiness(data?.[0] || null);
      }

      setLoading(false);
    }

    loadData();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <h2 className="text-xl">Loading Dashboard...</h2>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white p-10">
      {/* HEADER */}
      <h1 className="text-4xl font-bold text-cyan-400">
        AnaAI Dashboard
      </h1>

      <p className="mt-2 text-gray-400">
        Welcome back, {email}
      </p>

      {/* BUSINESS PROFILE */}
      <div className="mt-8 bg-gray-900 rounded-xl p-6 shadow-lg">
        <h2 className="text-2xl font-semibold text-cyan-400 mb-4">
          Business Profile
        </h2>

        {business ? (
          <div className="space-y-2 text-gray-300">
            <p>
              <span className="font-bold text-white">Business:</span>{" "}
              {business.business_name}
            </p>

            <p>
              <span className="font-bold text-white">Owner:</span>{" "}
              {business.owner_name}
            </p>

            <p>
              <span className="font-bold text-white">Phone:</span>{" "}
              {business.phone}
            </p>

            <p>
              <span className="font-bold text-white">Email:</span>{" "}
              {business.email}
            </p>

            <p>
              <span className="font-bold text-white">Address:</span>{" "}
              {business.address}
            </p>

            <p>
              <span className="font-bold text-white">Business Hours:</span>{" "}
              {business.business_hours}
            </p>
          </div>
        ) : (
          <p className="text-red-400">
            No business profile found.
          </p>
        )}
      </div>

      {/* QUICK ACTIONS */}
      <div className="mt-10">
        <h2 className="text-2xl font-semibold text-cyan-400 mb-4">
          Quick Actions
        </h2>

        <div className="flex flex-wrap gap-4">
          <button
            onClick={() => router.push("/appointments")}
            className="bg-green-500 hover:bg-green-400 text-black font-bold px-6 py-3 rounded-lg transition"
          >
            📅 Appointments
          </button>

          <button
            onClick={() => router.push("/business")}
            className="bg-cyan-500 hover:bg-cyan-400 text-black font-bold px-6 py-3 rounded-lg transition"
          >
            🏢 Edit Business
          </button>

          <button
            onClick={handleLogout}
            className="bg-red-500 hover:bg-red-600 text-white font-bold px-6 py-3 rounded-lg transition"
          >
            🚪 Logout
          </button>
        </div>
      </div>
    </main>
  );
}