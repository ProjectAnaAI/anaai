"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Building2,
  ChevronRight,
  LogOut,
  Settings2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ui/page-header";
import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";

export default function SettingsPage() {
  const router = useRouter();

  const [
    loggingOut,
    setLoggingOut,
  ] = useState(false);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);

    const { error } =
      await supabase.auth.signOut();

    if (error) {
      toast.error(
        "Unable to log out. Please try again."
      );
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
        "Manage your business name, contact details, timezone, and weekly hours.",
      href: "/business",
      icon: Building2,
      label: "Business",
    },
    {
      title: "AI Receptionist",
      description:
        "Manage AnaAI's greeting, personality, instructions, and human transfer settings.",
      href: "/ai",
      icon: Bot,
      label: "AnaAI",
    },
    {
      title: "Account",
      description:
        "Return to your AnaAI workspace and account session.",
      href: "/dashboard",
      icon: UserRound,
      label: "Workspace",
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6" data-page="settings">
        <PageHeader
          eyebrow="Your workspace"
          title={<>Settings</>}
          description={
            <>Manage the core areas of your AnaAI workspace and your current account session.</>
          }
        ></PageHeader>

        <section className="record-summary">
          <div className="anaai-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Business
                </p>

                <p className="mt-2 text-base font-semibold text-gray-950">
                  Profile & hours
                </p>
              </div>

              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <Building2 className="size-5" />
              </div>
            </div>

            <p className="mt-3 text-xs leading-5 text-gray-500">
              Business details,
              timezone, and
              scheduling hours.
            </p>
          </div>

          <div className="anaai-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  AnaAI
                </p>

                <p className="mt-2 text-base font-semibold text-gray-950">
                  Receptionist setup
                </p>
              </div>

              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <Bot className="size-5" />
              </div>
            </div>

            <p className="mt-3 text-xs leading-5 text-gray-500">
              Greeting,
              personality,
              instructions, and
              transfer settings.
            </p>
          </div>

          <div className="anaai-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Session
                </p>

                <p className="mt-2 text-base font-semibold text-gray-950">
                  Signed-in account
                </p>
              </div>

              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                <ShieldCheck className="size-5" />
              </div>
            </div>

            <p className="mt-3 text-xs leading-5 text-gray-500">
              Your current AnaAI
              authentication
              session.
            </p>
          </div>
        </section>

        <section className="anaai-surface overflow-hidden">
          <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <Settings2 className="size-5" />
              </div>

              <div>
                <h2 className="anaai-section-title">
                  Workspace settings
                </h2>

                <p className="mt-1 text-sm leading-6 text-gray-500">
                  Open an area to
                  manage its existing
                  configuration.
                </p>
              </div>
            </div>
          </div>

          <div className="divide-y divide-gray-100">
            {settings.map(
              (item) => {
                const Icon =
                  item.icon;

                return (
                  <button
                    key={
                      item.title
                    }
                    type="button"
                    onClick={() =>
                      router.push(
                        item.href
                      )
                    }
                    className="group flex min-h-[76px] w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-green-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-600 sm:px-6"
                  >
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 shadow-sm transition group-hover:border-green-200 group-hover:text-green-700">
                      <Icon className="size-5" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="text-sm font-semibold text-gray-950">
                          {
                            item.title
                          }
                        </h3>

                        <span className="rounded-md bg-gray-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          {
                            item.label
                          }
                        </span>
                      </div>

                      <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">
                        {
                          item.description
                        }
                      </p>
                    </div>

                    <ChevronRight className="size-5 shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-green-600" />
                  </button>
                );
              }
            )}
          </div>
        </section>

        <section className="anaai-surface overflow-hidden">
          <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
            <h2 className="anaai-section-title">
              Account session
            </h2>

            <p className="mt-1 text-sm leading-6 text-gray-500">
              Sign out of the
              current AnaAI account
              on this device.
            </p>
          </div>

          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                <UserRound className="size-5" />
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-950">
                  Current session
                </p>

                <p className="mt-1 max-w-xl text-sm leading-6 text-gray-500">
                  Logging out ends
                  your current
                  authenticated
                  session and returns
                  you to the AnaAI
                  login page.
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={
                handleLogout
              }
              disabled={loggingOut}
              className="w-full shrink-0 border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 sm:w-auto"
            >
              <LogOut className="size-4" />

              {loggingOut
                ? "Logging out..."
                : "Log out"}
            </Button>
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
