"use client";

import {
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Menu,
} from "lucide-react";

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
    setLoggingOut(true);

    const { error } =
      await supabase.auth.signOut();

    if (error) {
      alert(error.message);
      setLoggingOut(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="flex min-h-16 items-center gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={
            onOpenNavigation
          }
          className="shrink-0 rounded-lg p-2 text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 sm:text-sm sm:normal-case sm:tracking-normal sm:text-gray-500">
            Workspace
          </p>

          <h2 className="truncate text-base font-semibold text-gray-900 sm:text-lg">
            AnaAI
          </h2>
        </div>

        <div className="hidden min-w-0 md:block">
          <BusinessSelector />
        </div>

        <Button
          variant="outline"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-label={
            loggingOut
              ? "Logging out"
              : "Logout"
          }
          className="shrink-0 gap-2"
        >
          <LogOut className="h-4 w-4" />

          <span className="hidden sm:inline">
            {loggingOut
              ? "Logging out..."
              : "Logout"}
          </span>
        </Button>
      </div>

      <div className="border-t border-gray-100 px-4 py-3 md:hidden">
        <BusinessSelector />
      </div>
    </header>
  );
}