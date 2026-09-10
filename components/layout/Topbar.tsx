"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";

export default function Topbar() {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);

    const { error } = await supabase.auth.signOut();

    if (error) {
      alert(error.message);
      setLoggingOut(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div>
        <p className="text-sm font-medium text-gray-500">
          Workspace
        </p>

        <h2 className="text-lg font-semibold text-gray-900">
          AnaAI
        </h2>
      </div>

      <Button
        variant="outline"
        onClick={handleLogout}
        disabled={loggingOut}
        className="gap-2"
      >
        <LogOut className="h-4 w-4" />

        {loggingOut ? "Logging out..." : "Logout"}
      </Button>
    </header>
  );
}