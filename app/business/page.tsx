"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Clock3,
  Mail,
  MapPin,
  Phone,
  Save,
  User,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";

type DayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

type DayHours = {
  open: string;
  close: string;
  closed: boolean;
};

type BusinessHours = Record<DayKey, DayHours>;

const defaultBusinessHours: BusinessHours = {
  monday: {
    open: "09:00",
    close: "18:00",
    closed: false,
  },
  tuesday: {
    open: "09:00",
    close: "18:00",
    closed: false,
  },
  wednesday: {
    open: "09:00",
    close: "18:00",
    closed: false,
  },
  thursday: {
    open: "09:00",
    close: "18:00",
    closed: false,
  },
  friday: {
    open: "09:00",
    close: "18:00",
    closed: false,
  },
  saturday: {
    open: "10:00",
    close: "16:00",
    closed: false,
  },
  sunday: {
    open: "",
    close: "",
    closed: true,
  },
};

const days: {
  key: DayKey;
  label: string;
}[] = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
];

function parseBusinessHours(value: string | null): BusinessHours {
  if (!value) {
    return defaultBusinessHours;
  }

  try {
    const parsed = JSON.parse(value);

    const result = {
      ...defaultBusinessHours,
    };

    for (const { key } of days) {
      const day = parsed?.[key];

      if (
        day &&
        typeof day.open === "string" &&
        typeof day.close === "string" &&
        typeof day.closed === "boolean"
      ) {
        result[key] = {
          open: day.open,
          close: day.close,
          closed: day.closed,
        };
      }
    }

    return result;
  } catch {
    return defaultBusinessHours;
  }
}

export default function BusinessPage() {
  const router = useRouter();

  const [profileId, setProfileId] = useState<string | null>(null);

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");

  const [businessHours, setBusinessHours] =
    useState<BusinessHours>(defaultBusinessHours);

  const [loadingPage, setLoadingPage] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadBusinessProfile() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.push("/login");
          return;
        }

        const { data, error } = await supabase
          .from("business_profiles")
          .select(
            "id, business_name, owner_name, phone, email, address, business_hours"
          )
          .eq("user_id", user.id)
          .order("created_at", {
            ascending: false,
          })
          .limit(1)
          .maybeSingle();

        if (error) {
          toast.error(error.message);
          return;
        }

        if (!data) {
          return;
        }

        setProfileId(data.id);
        setBusinessName(data.business_name ?? "");
        setOwnerName(data.owner_name ?? "");
        setPhone(data.phone ?? "");
        setEmail(data.email ?? "");
        setAddress(data.address ?? "");

        setBusinessHours(
          parseBusinessHours(data.business_hours)
        );
      } finally {
        setLoadingPage(false);
      }
    }

    void loadBusinessProfile();
  }, [router]);

  function updateDay(
    day: DayKey,
    field: keyof DayHours,
    value: string | boolean
  ) {
    setBusinessHours((current) => ({
      ...current,
      [day]: {
        ...current[day],
        [field]: value,
      },
    }));
  }

  function toggleClosed(day: DayKey) {
    setBusinessHours((current) => {
      const currentlyClosed = current[day].closed;

      return {
        ...current,
        [day]: {
          open: currentlyClosed
            ? current[day].open || "09:00"
            : "",
          close: currentlyClosed
            ? current[day].close || "18:00"
            : "",
          closed: !currentlyClosed,
        },
      };
    });
  }

  function validateBusinessHours() {
    for (const { key, label } of days) {
      const hours = businessHours[key];

      if (hours.closed) {
        continue;
      }

      if (!hours.open || !hours.close) {
        toast.error(
          `${label} needs both an opening and closing time.`
        );

        return false;
      }

      if (hours.open >= hours.close) {
        toast.error(
          `${label}'s closing time must be later than its opening time.`
        );

        return false;
      }
    }

    return true;
  }

  async function handleSave(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!businessName.trim()) {
      toast.error("Business name is required.");
      return;
    }

    if (!ownerName.trim()) {
      toast.error("Owner name is required.");
      return;
    }

    if (!validateBusinessHours()) {
      return;
    }

    setSaving(true);

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        toast.error("Please log in again.");
        router.push("/login");
        return;
      }

      const profileData = {
        user_id: user.id,
        business_name: businessName.trim(),
        owner_name: ownerName.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        business_hours: JSON.stringify(businessHours),
      };

      if (profileId) {
        const { error } = await supabase
          .from("business_profiles")
          .update(profileData)
          .eq("id", profileId)
          .eq("user_id", user.id);

        if (error) {
          throw error;
        }
      } else {
        const { data, error } = await supabase
          .from("business_profiles")
          .insert(profileData)
          .select("id")
          .single();

        if (error) {
          throw error;
        }

        setProfileId(data.id);
      }

      toast.success(
        "Business profile saved successfully."
      );
    } catch (error) {
      console.error(
        "Business profile save error:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to save business profile."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loadingPage) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-gray-50 px-8 py-10">
          <div className="mx-auto max-w-6xl">
            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <p className="text-gray-500">
                Loading business profile...
              </p>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-gray-50 px-6 py-8 md:px-8 md:py-10">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 border-b border-gray-200 pb-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-green-600">
              AnaAI
            </p>

            <div className="mt-2 flex items-start justify-between gap-6">
              <div>
                <h1 className="text-4xl font-bold tracking-tight text-gray-950">
                  Business Profile
                </h1>

                <p className="mt-3 max-w-2xl text-base leading-7 text-gray-500">
                  Manage your business information and weekly
                  operating hours. AnaAI will use this information
                  when helping customers.
                </p>
              </div>

              <div className="hidden rounded-2xl bg-green-50 p-4 md:block">
                <Building2 className="h-7 w-7 text-green-600" />
              </div>
            </div>
          </div>

          <form
            onSubmit={handleSave}
            className="space-y-6"
          >
            <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
              <div className="mb-6">
                <h2 className="text-xl font-semibold text-gray-950">
                  Business Information
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Basic information customers may need when
                  contacting your business.
                </p>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Business Name
                  </label>

                  <div className="relative">
                    <Building2 className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                    <input
                      value={businessName}
                      onChange={(event) =>
                        setBusinessName(event.target.value)
                      }
                      required
                      placeholder="Beauty Salon"
                      className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Owner Name
                  </label>

                  <div className="relative">
                    <User className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                    <input
                      value={ownerName}
                      onChange={(event) =>
                        setOwnerName(event.target.value)
                      }
                      required
                      placeholder="Owner name"
                      className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Phone Number
                  </label>

                  <div className="relative">
                    <Phone className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                    <input
                      value={phone}
                      onChange={(event) =>
                        setPhone(event.target.value)
                      }
                      placeholder="Business phone number"
                      className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Business Email
                  </label>

                  <div className="relative">
                    <Mail className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                    <input
                      type="email"
                      value={email}
                      onChange={(event) =>
                        setEmail(event.target.value)
                      }
                      placeholder="business@example.com"
                      className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />
                  </div>
                </div>

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Business Address
                  </label>

                  <div className="relative">
                    <MapPin className="absolute left-4 top-4 h-4 w-4 text-gray-400" />

                    <input
                      value={address}
                      onChange={(event) =>
                        setAddress(event.target.value)
                      }
                      placeholder="Business address"
                      className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
              <div className="mb-6 flex items-start gap-3">
                <div className="rounded-xl bg-green-50 p-2.5">
                  <Clock3 className="h-5 w-5 text-green-600" />
                </div>

                <div>
                  <h2 className="text-xl font-semibold text-gray-950">
                    Weekly Business Hours
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Set when your business is open. AnaAI will
                    eventually use these hours when checking
                    appointment availability.
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-gray-200">
                {days.map(({ key, label }, index) => {
                  const hours = businessHours[key];

                  return (
                    <div
                      key={key}
                      className={`grid gap-4 p-4 md:grid-cols-[140px_130px_1fr_1fr] md:items-center ${
                        index !== days.length - 1
                          ? "border-b border-gray-200"
                          : ""
                      }`}
                    >
                      <div>
                        <p className="font-semibold text-gray-900">
                          {label}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          toggleClosed(key)
                        }
                        className={`rounded-full px-3 py-2 text-sm font-semibold transition ${
                          hours.closed
                            ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            : "bg-green-50 text-green-700 hover:bg-green-100"
                        }`}
                      >
                        {hours.closed
                          ? "Closed"
                          : "Open"}
                      </button>

                      <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                          Opens
                        </label>

                        <input
                          type="time"
                          value={hours.open}
                          disabled={hours.closed}
                          onChange={(event) =>
                            updateDay(
                              key,
                              "open",
                              event.target.value
                            )
                          }
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                          Closes
                        </label>

                        <input
                          type="time"
                          value={hours.close}
                          disabled={hours.closed}
                          onChange={(event) =>
                            updateDay(
                              key,
                              "close",
                              event.target.value
                            )
                          }
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 rounded-xl border border-green-100 bg-green-50 p-4">
                <p className="text-sm font-medium text-green-800">
                  Structured hours enabled
                </p>

                <p className="mt-1 text-sm leading-6 text-green-700">
                  These hours are saved in a machine-readable
                  format so AnaAI can use them safely when
                  checking appointment availability.
                </p>
              </div>
            </section>

            <button
              type="submit"
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-3.5 font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-5 w-5" />

              {saving
                ? "Saving..."
                : "Save Business Profile"}
            </button>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}