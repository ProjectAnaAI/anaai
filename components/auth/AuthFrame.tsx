import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { Brand, VoiceLine } from "@/components/brand/Brand";

export function AuthFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link href="/" aria-label="AnaAI home">
          <Brand inverse />
        </Link>
        <div>
          <p className="eyebrow">A little more room for your day</p>
          <h2>
            Be there for the customer.
            <br />
            <em>We’ll take the call.</em>
          </h2>
          <VoiceLine />
          <p>
            An AI receptionist and a clear view of your appointments, customers,
            and business.
          </p>
          <ul>
            {[
              "A welcome that sounds like your business",
              "Appointments that respect your availability",
              "A person in the loop when it matters",
            ].map((item) => (
              <li key={item}>
                <Check size={17} />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <span className="auth-story-foot">
          Thoughtful service. From the first hello.
        </span>
      </section>
      <section className="auth-form-side">
        <Link className="auth-back" href="/">
          <ArrowLeft size={16} />
          Back to AnaAI
        </Link>
        <div className="auth-form">
          <div className="auth-mobile-brand">
            <Brand />
          </div>
          <p className="eyebrow">Your business, connected</p>
          <h1>{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
          <div className="auth-footer">{footer}</div>
        </div>
        <p className="auth-bottom">
          AnaAI <span>by ZUDE</span>
        </p>
      </section>
    </main>
  );
}
