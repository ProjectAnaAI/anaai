"use client";

import {
  useState,
} from "react";

import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";

type AppLayoutProps = {
  children: React.ReactNode;
};

export default function AppLayout({
  children,
}: AppLayoutProps) {
  const [
    mobileNavigationOpen,
    setMobileNavigationOpen,
  ] = useState(false);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="flex min-h-screen">
        <Sidebar
          mobileOpen={
            mobileNavigationOpen
          }
          onMobileClose={() =>
            setMobileNavigationOpen(
              false
            )
          }
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            onOpenNavigation={() =>
              setMobileNavigationOpen(
                true
              )
            }
          />

          <section className="flex-1 px-4 py-6 sm:px-6 lg:p-8">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}