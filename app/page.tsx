"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  CalendarCheck,
  Phone,
  Check,
  ArrowRight,
} from "lucide-react";

export default function Home() {
  const router = useRouter();

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({
      behavior: "smooth",
    });
  }

  return (
    <main className="min-h-screen bg-white text-gray-900">
      {/* NAVBAR */}
      <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="text-3xl font-bold tracking-tight text-green-600"
          >
            AnaAI
          </button>

          <div className="hidden items-center gap-8 text-sm font-medium text-gray-600 md:flex">
            <button
              type="button"
              onClick={() => scrollToSection("features")}
              className="transition hover:text-green-600"
            >
              Features
            </button>

            <button
              type="button"
              onClick={() => scrollToSection("pricing")}
              className="transition hover:text-green-600"
            >
              Pricing
            </button>

            <button
              type="button"
              onClick={() => scrollToSection("about")}
              className="transition hover:text-green-600"
            >
              About
            </button>

            <button
              type="button"
              onClick={() => scrollToSection("contact")}
              className="transition hover:text-green-600"
            >
              Contact
            </button>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden rounded-xl px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 sm:block"
            >
              Login
            </Link>

            <Link
              href="/signup"
              className="rounded-xl bg-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-green-700"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 py-28 text-center">
        <p className="rounded-full bg-green-50 px-5 py-2 text-sm font-semibold uppercase tracking-[0.25em] text-green-600">
          AI Receptionist For Salons
        </p>

        <h1 className="mt-10 max-w-5xl text-5xl font-extrabold leading-tight tracking-tight md:text-7xl">
          Never Miss Another
          <br />
          Customer Call
        </h1>

        <p className="mt-8 max-w-3xl text-xl leading-9 text-gray-600">
          AnaAI answers customer calls, books appointments automatically,
          answers common questions, and helps your business stay available 24/7.
        </p>

        <div className="mt-12 flex flex-wrap justify-center gap-4">
          <button
            type="button"
            onClick={() => router.push("/signup")}
            className="flex items-center gap-2 rounded-xl bg-green-600 px-8 py-4 font-semibold text-white shadow-sm transition hover:bg-green-700"
          >
            Start Free Trial
            <ArrowRight className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => scrollToSection("features")}
            className="rounded-xl border border-gray-300 bg-white px-8 py-4 font-semibold text-gray-800 transition hover:bg-gray-50"
          >
            Watch Demo
          </button>
        </div>
      </section>

      {/* FEATURES */}
      <section
        id="features"
        className="scroll-mt-24 bg-gray-50 py-24"
      >
        <div className="mx-auto max-w-7xl px-6 lg:px-10">
          <p className="text-center text-sm font-semibold uppercase tracking-[0.2em] text-green-600">
            Features
          </p>

          <h2 className="mt-3 text-center text-4xl font-bold tracking-tight md:text-5xl">
            Everything Your Business Needs
          </h2>

          <p className="mx-auto mt-5 max-w-3xl text-center text-lg text-gray-500">
            AnaAI works like a receptionist that can stay available around the
            clock.
          </p>

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <div className="inline-flex rounded-xl bg-green-50 p-3">
                <Phone className="h-6 w-6 text-green-600" />
              </div>

              <h3 className="mt-6 text-xl font-semibold">
                24/7 Receptionist
              </h3>

              <p className="mt-3 leading-7 text-gray-500">
                Answer customer calls even when staff are busy or the business
                is closed.
              </p>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <div className="inline-flex rounded-xl bg-green-50 p-3">
                <CalendarCheck className="h-6 w-6 text-green-600" />
              </div>

              <h3 className="mt-6 text-xl font-semibold">
                Smart Booking
              </h3>

              <p className="mt-3 leading-7 text-gray-500">
                Check services and availability and create appointments
                automatically.
              </p>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <div className="inline-flex rounded-xl bg-green-50 p-3">
                <Bot className="h-6 w-6 text-green-600" />
              </div>

              <h3 className="mt-6 text-xl font-semibold">
                AI Assistant
              </h3>

              <p className="mt-3 leading-7 text-gray-500">
                Answer questions about services, pricing, hours, policies, and
                more.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section
        id="pricing"
        className="scroll-mt-24 py-24"
      >
        <div className="mx-auto max-w-5xl px-6">
          <p className="text-center text-sm font-semibold uppercase tracking-[0.2em] text-green-600">
            Pricing
          </p>

          <h2 className="mt-3 text-center text-4xl font-bold">
            Simple Pricing
          </h2>

          <div className="mx-auto mt-12 max-w-lg rounded-3xl border border-gray-200 bg-white p-8 shadow-sm">
            <h3 className="text-2xl font-bold">AnaAI</h3>

            <p className="mt-2 text-gray-500">
              Everything needed to automate your receptionist workflow.
            </p>

            <div className="mt-7 space-y-4 text-sm text-gray-700">
              <p className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green-600" />
                AI receptionist settings
              </p>

              <p className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green-600" />
                Customer management
              </p>

              <p className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green-600" />
                Services and appointments
              </p>

              <p className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green-600" />
                Analytics dashboard
              </p>
            </div>

            <button
              type="button"
              onClick={() => router.push("/signup")}
              className="mt-8 w-full rounded-xl bg-green-600 px-6 py-3 font-semibold text-white transition hover:bg-green-700"
            >
              Start Free Trial
            </button>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section
        id="about"
        className="scroll-mt-24 bg-gray-50 py-24"
      >
        <div className="mx-auto max-w-4xl px-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-green-600">
            About
          </p>

          <h2 className="mt-3 text-4xl font-bold">
            Built to Make Customer Service Easier
          </h2>

          <p className="mt-6 text-lg leading-8 text-gray-600">
            AnaAI gives businesses one place to manage customers, services,
            appointments, business information, and an AI receptionist.
          </p>
        </div>
      </section>

      {/* CONTACT */}
      <section
        id="contact"
        className="scroll-mt-24 py-24"
      >
        <div className="mx-auto max-w-5xl px-6">
          <div className="rounded-3xl bg-green-50 p-10 text-center md:p-16">
            <h2 className="text-4xl font-bold">
              Ready to Grow Your Business?
            </h2>

            <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-600">
              Create an AnaAI account and start configuring your receptionist.
            </p>

            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <button
                type="button"
                onClick={() => router.push("/signup")}
                className="rounded-xl bg-green-600 px-8 py-4 font-semibold text-white transition hover:bg-green-700"
              >
                Create Account
              </button>

              <a
                href="mailto:hello@anaai.app"
                className="rounded-xl border border-gray-300 bg-white px-8 py-4 font-semibold text-gray-800 transition hover:bg-gray-50"
              >
                Book Demo
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-gray-200 bg-white py-12">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-5 px-6 text-center md:flex-row md:text-left">
          <div>
            <h3 className="text-2xl font-bold text-green-600">
              AnaAI
            </h3>

            <p className="mt-1 text-sm text-gray-500">
              AI Receptionist Platform
            </p>
          </div>

          <div className="flex gap-5 text-sm text-gray-500">
            <Link href="/login" className="hover:text-green-600">
              Login
            </Link>

            <Link href="/signup" className="hover:text-green-600">
              Sign Up
            </Link>
          </div>

          <p className="text-sm text-gray-400">
            © {new Date().getFullYear()} AnaAI
          </p>
        </div>
      </footer>
    </main>
  );
}