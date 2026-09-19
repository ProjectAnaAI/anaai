"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Building2,
  ChevronRight,
  LogOut,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";

export default function SettingsPage() {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);

    const { error } = await supabase.auth.signOut();

    if (error) {
      toast.error("Unable to log out. Please try again.");
      setLoggingOut(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  const settings = [
    {
      title: "Business Profile",
      description:
        "Manage your business name, contact details, and hours.",
      href: "/business",
      icon: Building2,
    },
    {
      title: "AI Receptionist",
      description:
        "Manage AnaAI's greeting, tone, and call instructions.",
      href: "/ai",
      icon: Bot,
    },
    {
      title: "Account",
      description:
        "Your AnaAI account and authentication settings.",
      href: "/dashboard",
      icon: UserRound,
    },
  ];

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            Account
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Settings
          </h1>

          <p className="mt-2 text-gray-500">
            Manage your AnaAI workspace and receptionist configuration.
          </p>
        </header>

        <div className="mt-8 space-y-4">
          {settings.map((item) => {
            const Icon = item.icon;

            return (
              <button
                key={item.title}
                type="button"
                onClick={() =>
                  router.push(item.href)
                }
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm transition hover:border-green-200 hover:bg-green-50/30"
              >
                <div className="flex items-center gap-4">
                  <div className="rounded-xl bg-green-50 p-3">
                    <Icon className="h-5 w-5 text-green-600" />
                  </div>

                  <div>
                    <h2 className="font-semibold text-gray-900">
                      {item.title}
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      {item.description}
                    </p>
                  </div>
                </div>

                <ChevronRight className="h-5 w-5 text-gray-400" />
              </button>
            );
          })}
        </div>

        <div className="mt-8 rounded-2xl border border-red-100 bg-white p-6">
          <h2 className="font-semibold text-gray-900">
            Session
          </h2>

          <p className="mt-1 text-sm text-gray-500">
            Sign out of the current AnaAI account.
          </p>

          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-5 flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" />

            {loggingOut
              ? "Logging out..."
              : "Logout"}
          </button>
        </div>
      </div>
    </AppLayout>
  );
}