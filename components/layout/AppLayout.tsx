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
    <main className="workspace min-h-screen"><a href="#workspace-content" className="skip-link">Skip to content</a>
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

          <section id="workspace-content" tabIndex={-1} className="workspace-content flex-1">
            <div className="anaai-page">
              {children}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
