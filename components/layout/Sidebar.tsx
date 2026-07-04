"use client";

import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Building2,
  BarChart3,
  Bot,
  Settings,
} from "lucide-react";

const navItems = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "Appointments",
    href: "/appointments",
    icon: CalendarDays,
  },
  {
    label: "Customers",
    href: "/customers",
    icon: Users,
  },
  {
    label: "Business",
    href: "/business",
    icon: Building2,
  },
  {
    label: "Analytics",
    href: "/analytics",
    icon: BarChart3,
  },
  {
    label: "AI Receptionist",
    href: "/ai-receptionist",
    icon: Bot,
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
  },
];

export default function Sidebar() {
  const router = useRouter();

  return (
    <aside className="hidden min-h-screen w-72 border-r border-gray-200 bg-white px-5 py-6 lg:block">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-green-600">
          AnaAI
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          AI receptionist platform
        </p>
      </div>

      <nav className="mt-8 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.href}
              onClick={() => router.push(item.href)}
              className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-gray-700 transition hover:bg-green-50 hover:text-green-700"
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}