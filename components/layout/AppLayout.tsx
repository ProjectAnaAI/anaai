"use client";

import { useState } from "react";

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
    <main className="min-h-screen bg-[#f7f9f8]">
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

          <section className="flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:px-7 xl:px-8 xl:py-7">
            <div className="anaai-page">
              {children}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}