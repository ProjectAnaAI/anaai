"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Clock3,
  Globe2,
  Mail,
  MapPin,
  Phone,
  Save,
  User,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { activeBusinessHeaders } from "@/lib/active-business";
import {
  businessDayKeys,
  createDefaultBusinessHours,
  parseBusinessHours,
  type BusinessHours,
  type DayHours,
  type DayKey,
  validateBusinessHours,
} from "@/lib/business-hours";
import { supabase } from "@/lib/supabase";

type BusinessRole = "owner" | "manager" | "staff";

type CurrentBusinessResponse =
  | {
      success: true;
      business: {
        id: string;
        name: string;
        timezone: string;
        role: BusinessRole;
      };
    }
  | {
      success: false;
      error: string;
      code?: string;
    };

const days: {
  key: DayKey;
  label: string;
}[] = businessDayKeys.map((key) => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
}));

const timezones = [
  {
    value: "America/Los_Angeles",
    label: "Pacific Time — America/Los_Angeles",
  },
  {
    value: "America/Denver",
    label: "Mountain Time — America/Denver",
  },
  {
    value: "America/Chicago",
    label: "Central Time — America/Chicago",
  },
  {
    value: "America/New_York",
    label: "Eastern Time — America/New_York",
  },
  {
    value: "America/Phoenix",
    label: "Arizona — America/Phoenix",
  },
  {
    value: "America/Anchorage",
    label: "Alaska — America/Anchorage",
  },
  {
    value: "Pacific/Honolulu",
    label: "Hawaii — Pacific/Honolulu",
  },
];

function isValidTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format();

    return true;
  } catch {
    return false;
  }
}

export default function BusinessPage() {
  const router = useRouter();

  const [profileId, setProfileId] = useState<string | null>(null);

  const [businessId, setBusinessId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [businessRole, setBusinessRole] =
    useState<BusinessRole | null>(null);

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");

  const [businessHours, setBusinessHours] =
    useState<BusinessHours>(() => createDefaultBusinessHours());

  const [loadingPage, setLoadingPage] = useState(true);
  const [saving, setSaving] = useState(false);

  const canEditProfile =
    businessRole === "owner" || businessRole === "manager";

  const canEditCanonicalBusiness = businessRole === "owner";

  useEffect(() => {
    async function loadBusinessProfile() {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (
          sessionError ||
          !session?.user ||
          !session.access_token
        ) {
          router.push("/login");
          return;
        }

        const currentUserId = session.user.id;
        const accessToken = session.access_token;

        setUserId(currentUserId);

        const businessResponse = await fetch(
          "/api/current-business",
          {
            method: "GET",
            headers: {
              ...activeBusinessHeaders(),
              Authorization: `Bearer ${accessToken}`,
            },
            cache: "no-store",
          }
        );

        const businessPayload =
          (await businessResponse.json()) as CurrentBusinessResponse;

        if (
          !businessResponse.ok ||
          !businessPayload.success
        ) {
          const message =
            businessPayload.success === false
              ? businessPayload.error
              : "Unable to load your business.";

          toast.error(message);
          return;
        }

        const activeBusinessId = businessPayload.business.id;
        const canonicalTimezone =
          businessPayload.business.timezone ||
          "America/Los_Angeles";

        setBusinessId(activeBusinessId);
        setBusinessRole(businessPayload.business.role);
        setTimezone(canonicalTimezone);

        const { data, error } = await supabase
          .from("business_profiles")
          .select(
            "id, business_name, owner_name, phone, email, address, business_hours"
          )
          .eq("business_id", activeBusinessId)
          .maybeSingle();

        if (error) {
          toast.error(error.message);
          return;
        }

        if (!data) {
          setBusinessName(
            businessPayload.business.name ?? ""
          );

          setBusinessHours(createDefaultBusinessHours());
          return;
        }

        setProfileId(data.id);

        setBusinessName(
          data.business_name ??
            businessPayload.business.name ??
            ""
        );

        setOwnerName(data.owner_name ?? "");
        setPhone(data.phone ?? "");
        setEmail(data.email ?? "");
        setAddress(data.address ?? "");

        const parsedHours = parseBusinessHours(
          data.business_hours
        );

        if (parsedHours) {
          setBusinessHours(parsedHours);
        } else {
          setBusinessHours(createDefaultBusinessHours());

          if (data.business_hours) {
            toast.error(
              "Saved business hours could not be read safely. Review them before saving."
            );
          }
        }
      } catch (error) {
        console.error(
          "Business profile load error:",
          error
        );

        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to load business profile."
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

  async function handleSave(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!canEditProfile) {
      toast.error(
        "Your business role does not allow profile changes."
      );
      return;
    }

    const normalizedBusinessName = businessName.trim();
    const normalizedOwnerName = ownerName.trim();
    const normalizedPhone = phone.trim();
    const normalizedEmail = email.trim();
    const normalizedAddress = address.trim();
    const normalizedTimezone = timezone.trim();

    if (!normalizedBusinessName) {
      toast.error("Business name is required.");
      return;
    }

    if (normalizedBusinessName.length > 200) {
      toast.error(
        "Business name must be 200 characters or fewer."
      );
      return;
    }

    if (
      normalizedPhone &&
      !/^[+\d\s().-]{7,30}$/.test(normalizedPhone)
    ) {
      toast.error("Enter a valid business phone number.");
      return;
    }

    if (
      normalizedEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        normalizedEmail
      )
    ) {
      toast.error("Enter a valid business email address.");
      return;
    }

    if (!isValidTimezone(normalizedTimezone)) {
      toast.error("Choose a valid business timezone.");
      return;
    }

    const hoursValidation =
      validateBusinessHours(businessHours);

    if (!hoursValidation.success) {
      toast.error(hoursValidation.error);
      return;
    }

    if (!businessId || !userId) {
      toast.error(
        "Business context is missing. Please refresh and try again."
      );
      return;
    }

    setSaving(true);

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (
        sessionError ||
        !session?.user ||
        !session.access_token
      ) {
        toast.error("Please log in again.");
        router.push("/login");
        return;
      }

      if (session.user.id !== userId) {
        toast.error(
          "Your session changed. Please refresh and try again."
        );
        return;
      }

      /*
       * businesses is the canonical source for business name and timezone.
       * Current RLS allows only owners to update this record.
       */
      if (canEditCanonicalBusiness) {
        const { error: businessUpdateError } = await supabase
          .from("businesses")
          .update({
            name: normalizedBusinessName,
            timezone: normalizedTimezone,
            updated_at: new Date().toISOString(),
          })
          .eq("id", businessId);

        if (businessUpdateError) {
          throw businessUpdateError;
        }
      }

      const profileData = {
        business_id: businessId,

        /*
         * Keep user_id for compatibility with the current production schema.
         * Tenant authorization is based on business_id + membership/RLS.
         */
        user_id: userId,

        business_name: normalizedBusinessName,
        owner_name: normalizedOwnerName || null,
        phone: normalizedPhone || null,
        email: normalizedEmail || null,
        address: normalizedAddress || null,
        business_hours: JSON.stringify(
          hoursValidation.hours
        ),

        /*
         * businesses.timezone is canonical. Keep the profile copy
         * synchronized for compatibility with existing readers.
         */
        timezone: normalizedTimezone,
      };

      if (profileId) {
        const { error } = await supabase
          .from("business_profiles")
          .update(profileData)
          .eq("id", profileId)
          .eq("business_id", businessId);

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

      setBusinessHours(hoursValidation.hours);

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
                  Manage your business information, timezone,
                  and weekly operating hours. AnaAI uses this
                  information when helping customers.
                </p>
              </div>

              <div className="hidden rounded-2xl bg-green-50 p-4 md:block">
                <Building2 className="h-7 w-7 text-green-600" />
              </div>
            </div>
          </div>

          {businessRole === "staff" && (
            <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">
                Read-only business profile
              </p>

              <p className="mt-1 text-sm leading-6 text-amber-800">
                Staff members can view business information,
                but an owner or manager must make profile or
                hours changes.
              </p>
            </div>
          )}

          {businessRole === "manager" && (
            <div className="mb-6 rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <p className="font-medium text-blue-900">
                Manager access
              </p>

              <p className="mt-1 text-sm leading-6 text-blue-800">
                You can update profile details and business
                hours. Only an owner can change the canonical
                business timezone.
              </p>
            </div>
          )}

          <form
            onSubmit={handleSave}
            className="space-y-6"
          >
            <fieldset
              disabled={!canEditProfile || saving}
              className="space-y-6 disabled:opacity-75"
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
                        maxLength={200}
                        placeholder="Beauty Salon"
                        className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                      />
                    </div>

                    {businessRole === "manager" && (
                      <p className="mt-2 text-xs leading-5 text-gray-500">
                        Managers can update the profile display
                        name. The canonical business name remains
                        owner-controlled.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Owner Name
                      <span className="ml-1 font-normal text-gray-400">
                        Optional
                      </span>
                    </label>

                    <div className="relative">
                      <User className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                      <input
                        value={ownerName}
                        onChange={(event) =>
                          setOwnerName(event.target.value)
                        }
                        placeholder="Owner name"
                        className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
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
                        type="tel"
                        value={phone}
                        onChange={(event) =>
                          setPhone(event.target.value)
                        }
                        placeholder="Business phone number"
                        className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
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
                        className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
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
                        className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                      />
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Business Timezone
                    </label>

                    <div className="relative">
                      <Globe2 className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

                      <select
                        value={timezone}
                        disabled={
                          !canEditCanonicalBusiness || saving
                        }
                        onChange={(event) =>
                          setTimezone(event.target.value)
                        }
                        className="w-full appearance-none rounded-xl border border-gray-300 bg-white py-3 pl-11 pr-4 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                      >
                        {!timezones.some(
                          (option) =>
                            option.value === timezone
                        ) && (
                          <option value={timezone}>
                            {timezone}
                          </option>
                        )}

                        {timezones.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {!canEditCanonicalBusiness && (
                      <p className="mt-2 text-xs leading-5 text-gray-500">
                        Only a business owner can change the
                        timezone used for scheduling.
                      </p>
                    )}
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
                      Set when your business is open. AnaAI uses
                      these hours when checking appointment
                      availability.
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
                          } disabled:cursor-not-allowed disabled:opacity-60`}
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
                            disabled={
                              hours.closed ||
                              !canEditProfile ||
                              saving
                            }
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
                            disabled={
                              hours.closed ||
                              !canEditProfile ||
                              saving
                            }
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
                    These hours use AnaAI&apos;s shared
                    business-hours format so onboarding,
                    scheduling, and business settings can rely
                    on the same data contract.
                  </p>
                </div>
              </section>
            </fieldset>

            {canEditProfile && (
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
            )}
          </form>
        </div>
      </div>
    </AppLayout>
  );
}