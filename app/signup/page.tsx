"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function SignUpPage() {
    const [email, setEmail] = useState("");
const [password, setPassword] = useState("")
async function handleSignUp(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();

  const { error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    alert(error.message);
  } else {
    alert("Account created! Check your email to verify your account.");
  }
}

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-md rounded-2xl bg-gray-900 p-8 shadow-lg">

        <h1 className="text-3xl font-bold text-center text-cyan-400">
          Create Your AnaAI Account
        </h1>

        <p className="mt-3 text-center text-gray-400">
          Start using your AI Receptionist today.
        </p>

        <form className="mt-8 space-y-5">

          <div>
            <label className="block mb-2">Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 p-3"
            />
          </div>

          <div>
            <label className="block mb-2">Password</label>
            <input
  type="password"
  placeholder="Enter your password"
  value={password}
  onChange={(e) => setPassword(e.target.value)}
  className="w-full rounded-lg border border-gray-700 bg-gray-800 p-3"
/>
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-cyan-500 p-3 font-bold text-black hover:bg-cyan-400 transition"
          >
            Create Account
          </button>

        </form>

      </div>
    </main>
  );
}