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
    label: "Services",
    href: "/services",
    icon: Scissors,
  },
  {
    label: "AI Receptionist",
    href: "/ai",
    icon: Bot,
  },
  {
    label: "Knowledge",
    href: "/knowledge",
    icon: BookOpen,
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
      <div className="flex min-h-full flex-col">
        <div className="flex items-center justify-between gap-4 px-2">
          <button
            type="button"
            onClick={() =>
              navigate("/dashboard")
            }
            className="flex min-h-11 items-center gap-3 rounded-xl text-left"
            aria-label="Open AnaAI dashboard"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-600 text-lg font-bold text-white shadow-sm">
              A
            </span>

            <span>
              <span className="block text-xl font-bold tracking-tight text-gray-950">
                AnaAI
              </span>

              <span className="block text-[11px] font-medium text-gray-400">
                Answer. Book. Grow.
              </span>
            </span>
          </button>

          {mobile && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={
                onMobileClose
              }
              className="anaai-touch-target flex items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav
          aria-label="Primary navigation"
          className="mt-7 space-y-1"
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
                  className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 text-left text-sm font-medium transition ${
                    isActive
                      ? "bg-green-50 text-green-700"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-950"
                  }`}
                >
                  <Icon
                    className={`h-[18px] w-[18px] shrink-0 ${
                      isActive
                        ? "text-green-600"
                        : "text-gray-400"
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

        <div className="mt-auto px-2 pt-8">
          <div className="border-t border-gray-100 pt-5">
            <p className="text-xs font-medium leading-5 text-gray-400">
              Always Answers.
              <br />
              Always Works.
              <br />
              Always With You.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r border-gray-200 bg-white px-4 py-5 lg:block xl:w-64 xl:px-5">
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
            className="absolute inset-0 bg-gray-950/35 backdrop-blur-[1px]"
          />

          <aside className="relative h-full w-[min(19rem,88vw)] overflow-y-auto border-r border-gray-200 bg-white px-5 py-5 shadow-2xl">
            {navigationContent(
              true
            )}
          </aside>
        </div>
      )}
    </>
  );
}