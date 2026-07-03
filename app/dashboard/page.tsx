"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function Dashboard() {
  const router = useRouter();
  const [email, setEmail] = useState("");

  useEffect(() => {
    async function loadUser() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setEmail(user.email || "");
    }

    loadUser();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold text-cyan-400">
        Welcome to AnaAI
      </h1>

      <p className="text-gray-300">
        Logged in as: <strong>{email}</strong>
      </p>

      <button
        onClick={handleLogout}
        className="bg-red-500 px-6 py-3 rounded-lg font-bold hover:bg-red-600"
      >
        Logout
      </button>
    </main>
  );
}