"use client";

import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function Topbar() {
  const router = useRouter();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div>
        <p className="text-sm font-medium text-gray-500">Workspace</p>
        <h2 className="text-lg font-semibold text-gray-900">AnaAI</h2>
      </div>

      <Button variant="outline" onClick={handleLogout}>
        Logout
      </Button>
    </header>
  );
}