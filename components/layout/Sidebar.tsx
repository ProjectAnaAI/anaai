"use client";

import {
  usePathname,
  useRouter,
} from "next/navigation";
import {
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  LayoutDashboard,
  Scissors,
  Settings,
  Users,
  X,
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
    label: "Services",
    href: "/services",
    icon: Scissors,
  },
  {
    label: "Analytics",
    href: "/analytics",
    icon: BarChart3,
  },
  {
    label: "Business Knowledge",
    href: "/knowledge",
    icon: BookOpen,
  },
  {
    label: "AI Receptionist",
    href: "/ai",
    icon: Bot,
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
  },
];

type SidebarProps = {
  mobileOpen: boolean;
  onMobileClose: () => void;
};

export default function Sidebar({
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();

  function navigate(
    href: string
  ) {
    onMobileClose();
    router.push(href);
  }

  function navigationContent(
    mobile = false
  ) {
    return (
      <>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-green-600">
              AnaAI
            </h1>

            <p className="mt-1 text-sm text-gray-500">
              AI receptionist
              platform
            </p>
          </div>

          {mobile && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={
                onMobileClose
              }
              className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav
          aria-label="Primary navigation"
          className="mt-8 space-y-1"
        >
          {navItems.map(
            (item) => {
              const Icon =
                item.icon;

              const isActive =
                pathname ===
                  item.href ||
                (item.href !==
                  "/dashboard" &&
                  pathname.startsWith(
                    `${item.href}/`
                  ));

              return (
                <button
                  key={item.href}
                  type="button"
                  aria-current={
                    isActive
                      ? "page"
                      : undefined
                  }
                  onClick={() =>
                    navigate(
                      item.href
                    )
                  }
                  className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium transition ${
                    isActive
                      ? "bg-green-50 text-green-700"
                      : "text-gray-700 hover:bg-green-50 hover:text-green-700"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive
                        ? "text-green-600"
                        : ""
                    }`}
                  />

                  <span>
                    {item.label}
                  </span>
                </button>
              );
            }
          )}
        </nav>
      </>
    );
  }

  return (
    <>
      <aside className="hidden min-h-screen w-72 shrink-0 border-r border-gray-200 bg-white px-5 py-6 lg:block">
        {navigationContent()}
      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={
              onMobileClose
            }
            className="absolute inset-0 bg-black/30"
          />

          <aside className="relative h-full w-[min(18rem,85vw)] overflow-y-auto border-r border-gray-200 bg-white px-5 py-6 shadow-xl">
            {navigationContent(
              true
            )}
          </aside>
        </div>
      )}
    </>
  );
}