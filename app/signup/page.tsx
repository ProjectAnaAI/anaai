"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function SignUpPage() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSignUp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (inFlight.current) return;
    inFlight.current=true; setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({email,password});
      if(error) setMessage("Unable to create account. Check your details and try again.");
      else if(data.session) router.replace("/dashboard");
      else setMessage("Check your email to verify your account, then log in to finish setup.");
    } catch { setMessage("Unable to create account. Please try again."); }
    finally { inFlight.current=false; setBusy(false); }
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

        <form onSubmit={handleSignUp} className="mt-8 space-y-5">
          <div>
            <label className="block mb-2">Email</label>

            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 p-3"
              required
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
              required
            />
          </div>

          <button
            disabled={busy}
            type="submit"
            className="w-full rounded-lg bg-cyan-500 p-3 font-bold text-black hover:bg-cyan-400 transition"
          >
            {busy ? "Creating account..." : "Create Account"}
          </button>
        </form>
        {message && <p role="status" className="mt-4">{message}</p>}
      </div>
    </main>
  );
}