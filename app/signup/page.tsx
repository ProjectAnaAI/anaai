"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function SignUpPage() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSignUp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error)
        setMessage(
          "Unable to create account. Check your details and try again.",
        );
      else if (data.session) router.replace("/dashboard");
      else
        setMessage(
          "Check your email to verify your account, then log in to finish setup.",
        );
    } catch {
      setMessage("Unable to create account. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="A better first hello."
      description="Create your account. Then make AnaAI part of your business."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login">
            Sign in <ArrowRight size={15} />
          </Link>
        </>
      }
    >
      <form onSubmit={handleSignUp} className="auth-fields" aria-busy={busy}>
        <label htmlFor="signup-email">
          Email address
          <Input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourbusiness.com"
            required
          />
        </label>
        <label htmlFor="signup-password">
          Password
          <span className="password-field">
            <Input
              id="signup-password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="new-password"
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
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account..." : "Create account"}
          <ArrowRight size={17} />
        </Button>
      </form>
    </AuthFrame>
  );
}
