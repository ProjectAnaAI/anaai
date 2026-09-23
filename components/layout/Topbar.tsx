"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Menu,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import {
  BusinessSelector,
} from "./ActiveBusinessProvider";
import { Button } from "@/components/ui/button";

type TopbarProps = {
  onOpenNavigation: () => void;
};

export default function Topbar({
  onOpenNavigation,
}: TopbarProps) {
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

  return (
    <header className="workspace-topbar sticky top-0 z-30 border-b border-gray-200 bg-white">
      <div className="flex min-h-[64px] items-center gap-3 px-4 sm:px-6 lg:px-7 xl:px-8">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={
            onOpenNavigation
          }
          className="anaai-touch-target flex shrink-0 items-center justify-center rounded-xl text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex min-w-0 flex-1 items-center">
          <div className="lg:hidden">
            <p className="truncate text-lg font-bold tracking-tight text-gray-950">
              AnaAI
            </p>
          </div>

          <div className="hidden lg:block">
            <p className="text-sm font-semibold text-gray-900">
              Your workspace
            </p>

            <p className="text-xs text-gray-400">
              Appointments, people, and a little peace of mind
            </p>
          </div>
        </div>

        <div className="hidden min-w-0 sm:block">
          <BusinessSelector />
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-label={
            loggingOut
              ? "Logging out"
              : "Logout"
          }
          title={
            loggingOut
              ? "Logging out"
              : "Logout"
          }
        >
          <LogOut className="h-[18px] w-[18px]" />
        </Button>
      </div>

      <div className="border-t border-gray-100 px-4 py-2.5 sm:hidden">
        <BusinessSelector />
      </div>
    </header>
  );
}
