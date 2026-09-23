"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  LayoutDashboard,
  Phone,
  Scissors,
  Settings,
  Users,
  X,
} from "lucide-react";
import { Brand } from "@/components/brand/Brand";
import { DialogSurface } from "@/components/ui/dialog-surface";

const groups = [
  {
    label: "Workspace",
    items: [
      { label: "Home", href: "/dashboard", icon: LayoutDashboard },
      { label: "Appointments", href: "/appointments", icon: CalendarDays },
      { label: "Customers", href: "/customers", icon: Users },
      { label: "Calls", href: "/calls", icon: Phone },
    ],
  },
  {
    label: "AnaAI",
    items: [
      { label: "Receptionist", href: "/ai", icon: Bot },
      { label: "Knowledge", href: "/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Business",
    items: [
      { label: "Services", href: "/services", icon: Scissors },
      { label: "Business & availability", href: "/business", icon: Building2 },
      { label: "Analytics", href: "/analytics", icon: BarChart3 },
    ],
  },
];

export default function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname();
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const close = () => {
      if (media.matches) onMobileClose();
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, [onMobileClose]);
  function content(mobile = false) {
    return (
      <div className="sidebar-content">
        <div className="sidebar-brand">
          <Link
            href="/dashboard"
            aria-label="Open AnaAI dashboard"
            onClick={onMobileClose}
          >
            <Brand inverse />
          </Link>
          {mobile && (
            <button
              className="nav-close"
              aria-label="Close navigation"
              onClick={onMobileClose}
            >
              <X size={20} />
            </button>
          )}
        </div>
        <nav aria-label="Primary navigation">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={onMobileClose}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  <Icon size={18} strokeWidth={1.7} />
                  <span>{label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            href="/settings"
            onClick={onMobileClose}
            aria-current={pathname === "/settings" ? "page" : undefined}
          >
            <Settings size={18} />
            Settings
          </Link>
          <span>Your front desk, in focus.</span>
        </div>
      </div>
    );
  }
  return (
    <>
      <aside className="workspace-sidebar">{content()}</aside>
      {mobileOpen && (
        <DialogSurface
          aria-label="Navigation menu"
          className="navigation-dialog"
          onClose={onMobileClose}
        >
          {content(true)}
        </DialogSurface>
      )}
    </>
  );
}
