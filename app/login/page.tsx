"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
        return;
      }
      await supabase.auth.getSession();
      router.push("/dashboard");
    } catch {
      setError("Unable to sign in. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title="Welcome back."
      description="Sign in to take a look at your day."
      footer={
        <>
          New to AnaAI?{" "}
          <Link href="/signup">
            Create an account <ArrowRight size={15} />
          </Link>
        </>
      }
    >
      <form onSubmit={handleLogin} className="auth-fields" aria-busy={busy}>
        <label htmlFor="login-email">
          Email address
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourbusiness.com"
            required
          />
        </label>
        <label htmlFor="login-password">
          Password
          <span className="password-field">
            <Input
              id="login-password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
          <ArrowRight size={17} />
        </Button>
      </form>
    </AuthFrame>
  );
}
