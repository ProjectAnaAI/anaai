"use client";

import {
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Clock3,
  Globe2,
  Mail,
  MapPin,
  Phone,
  Save,
  ShieldCheck,
  User,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
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

type BusinessRole =
  | "owner"
  | "manager"
  | "staff";

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
}[] = businessDayKeys.map(
  (key) => ({
    key,
    label:
      key.charAt(0).toUpperCase() +
      key.slice(1),
  })
);

const timezones = [
  {
    value: "America/Los_Angeles",
    label:
      "Pacific Time — America/Los_Angeles",
  },
  {
    value: "America/Denver",
    label:
      "Mountain Time — America/Denver",
  },
  {
    value: "America/Chicago",
    label:
      "Central Time — America/Chicago",
  },
  {
    value: "America/New_York",
    label:
      "Eastern Time — America/New_York",
  },
  {
    value: "America/Phoenix",
    label:
      "Arizona — America/Phoenix",
  },
  {
    value: "America/Anchorage",
    label:
      "Alaska — America/Anchorage",
  },
  {
    value: "Pacific/Honolulu",
    label:
      "Hawaii — Pacific/Honolulu",
  },
];

function isValidTimezone(
  value: string
) {
  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: value,
      }
    ).format();

    return true;
  } catch {
    return false;
  }
}

function formatRole(
  role: BusinessRole | null
) {
  if (!role) {
    return "Unknown";
  }

  return (
    role.charAt(0).toUpperCase() +
    role.slice(1)
  );
}

export default function BusinessPage() {
  const router = useRouter();

  const [
    profileId,
    setProfileId,
  ] = useState<string | null>(null);

  const [
    businessId,
    setBusinessId,
  ] = useState<string | null>(null);

  const [
    userId,
    setUserId,
  ] = useState<string | null>(null);

  const [
    businessRole,
    setBusinessRole,
  ] =
    useState<BusinessRole | null>(
      null
    );

  const [
    businessName,
    setBusinessName,
  ] = useState("");

  const [
    ownerName,
    setOwnerName,
  ] = useState("");

  const [phone, setPhone] =
    useState("");

  const [email, setEmail] =
    useState("");

  const [address, setAddress] =
    useState("");

  const [
    timezone,
    setTimezone,
  ] = useState(
    "America/Los_Angeles"
  );

  const [
    businessHours,
    setBusinessHours,
  ] = useState<BusinessHours>(
    () =>
      createDefaultBusinessHours()
  );

  const [
    loadingPage,
    setLoadingPage,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const canEditProfile =
    businessRole === "owner" ||
    businessRole === "manager";

  const canEditCanonicalBusiness =
    businessRole === "owner";

  const openDays =
    businessDayKeys.filter(
      (day) =>
        !businessHours[day].closed
    ).length;

  useEffect(() => {
    async function loadBusinessProfile() {
      try {
        const {
          data: { session },
          error: sessionError,
        } =
          await supabase.auth.getSession();

        if (
          sessionError ||
          !session?.user ||
          !session.access_token
        ) {
          router.push("/login");
          return;
        }

        const currentUserId =
          session.user.id;

        const accessToken =
          session.access_token;

        setUserId(currentUserId);

        const businessResponse =
          await fetch(
            "/api/current-business",
            {
              method: "GET",
              headers: {
                ...activeBusinessHeaders(),
                Authorization:
                  `Bearer ${accessToken}`,
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
            businessPayload.success ===
            false
              ? businessPayload.error
              : "Unable to load your business.";

          toast.error(message);
          return;
        }

        const activeBusinessId =
          businessPayload.business.id;

        const canonicalTimezone =
          businessPayload.business
            .timezone ||
          "America/Los_Angeles";

        setBusinessId(
          activeBusinessId
        );

        setBusinessRole(
          businessPayload.business.role
        );

        setTimezone(
          canonicalTimezone
        );

        const {
          data,
          error,
        } = await supabase
          .from("business_profiles")
          .select(
            "id, business_name, owner_name, phone, email, address, business_hours"
          )
          .eq(
            "business_id",
            activeBusinessId
          )
          .maybeSingle();

        if (error) {
          toast.error(
            error.message
          );
          return;
        }

        if (!data) {
          setBusinessName(
            businessPayload.business
              .name ?? ""
          );

          setBusinessHours(
            createDefaultBusinessHours()
          );

          return;
        }

        setProfileId(data.id);

        setBusinessName(
          data.business_name ??
            businessPayload.business
              .name ??
            ""
        );

        setOwnerName(
          data.owner_name ?? ""
        );

        setPhone(
          data.phone ?? ""
        );

        setEmail(
          data.email ?? ""
        );

        setAddress(
          data.address ?? ""
        );

        const parsedHours =
          parseBusinessHours(
            data.business_hours
          );

        if (parsedHours) {
          setBusinessHours(
            parsedHours
          );
        } else {
          setBusinessHours(
            createDefaultBusinessHours()
          );

          if (
            data.business_hours
          ) {
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
    setBusinessHours(
      (current) => ({
        ...current,
        [day]: {
          ...current[day],
          [field]: value,
        },
      })
    );
  }

  function toggleClosed(
    day: DayKey
  ) {
    setBusinessHours(
      (current) => {
        const currentlyClosed =
          current[day].closed;

        return {
          ...current,
          [day]: {
            open: currentlyClosed
              ? current[day]
                  .open || "09:00"
              : "",
            close: currentlyClosed
              ? current[day]
                  .close || "18:00"
              : "",
            closed:
              !currentlyClosed,
          },
        };
      }
    );
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

    const normalizedBusinessName =
      businessName.trim();

    const normalizedOwnerName =
      ownerName.trim();

    const normalizedPhone =
      phone.trim();

    const normalizedEmail =
      email.trim();

    const normalizedAddress =
      address.trim();

    const normalizedTimezone =
      timezone.trim();

    if (
      !normalizedBusinessName
    ) {
      toast.error(
        "Business name is required."
      );
      return;
    }

    if (
      normalizedBusinessName.length >
      200
    ) {
      toast.error(
        "Business name must be 200 characters or fewer."
      );
      return;
    }

    if (
      normalizedPhone &&
      !/^[+\d\s().-]{7,30}$/.test(
        normalizedPhone
      )
    ) {
      toast.error(
        "Enter a valid business phone number."
      );
      return;
    }

    if (
      normalizedEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        normalizedEmail
      )
    ) {
      toast.error(
        "Enter a valid business email address."
      );
      return;
    }

    if (
      !isValidTimezone(
        normalizedTimezone
      )
    ) {
      toast.error(
        "Choose a valid business timezone."
      );
      return;
    }

    const hoursValidation =
      validateBusinessHours(
        businessHours
      );

    if (
      !hoursValidation.success
    ) {
      toast.error(
        hoursValidation.error
      );
      return;
    }

    if (
      !businessId ||
      !userId
    ) {
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
      } =
        await supabase.auth.getSession();

      if (
        sessionError ||
        !session?.user ||
        !session.access_token
      ) {
        toast.error(
          "Please log in again."
        );

        router.push("/login");
        return;
      }

      if (
        session.user.id !==
        userId
      ) {
        toast.error(
          "Your session changed. Please refresh and try again."
        );
        return;
      }

      /*
       * businesses is the canonical
       * source for business name and
       * timezone. Current RLS allows
       * only owners to update this
       * record.
       */
      if (
        canEditCanonicalBusiness
      ) {
        const {
          error:
            businessUpdateError,
        } = await supabase
          .from("businesses")
          .update({
            name: normalizedBusinessName,
            timezone:
              normalizedTimezone,
            updated_at:
              new Date().toISOString(),
          })
          .eq("id", businessId);

        if (
          businessUpdateError
        ) {
          throw businessUpdateError;
        }
      }

      const profileData = {
        business_id: businessId,

        /*
         * Keep user_id for
         * compatibility with the
         * current production schema.
         * Tenant authorization is
         * based on business_id +
         * membership/RLS.
         */
        user_id: userId,

        business_name:
          normalizedBusinessName,

        owner_name:
          normalizedOwnerName ||
          null,

        phone:
          normalizedPhone || null,

        email:
          normalizedEmail || null,

        address:
          normalizedAddress || null,

        business_hours:
          JSON.stringify(
            hoursValidation.hours
          ),

        /*
         * businesses.timezone is
         * canonical. Keep the profile
         * copy synchronized for
         * compatibility with existing
         * readers.
         */
        timezone:
          normalizedTimezone,
      };

      if (profileId) {
        const { error } =
          await supabase
            .from(
              "business_profiles"
            )
            .update(profileData)
            .eq(
              "id",
              profileId
            )
            .eq(
              "business_id",
              businessId
            );

        if (error) {
          throw error;
        }
      } else {
        const {
          data,
          error,
        } = await supabase
          .from(
            "business_profiles"
          )
          .insert(profileData)
          .select("id")
          .single();

        if (error) {
          throw error;
        }

        setProfileId(data.id);
      }

      setBusinessHours(
        hoursValidation.hours
      );

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
        <div className="anaai-surface p-8">
          <div className="flex items-center gap-3">
            <div className="size-5 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

            <p className="text-sm text-gray-500">
              Loading business
              profile...
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <form
        onSubmit={handleSave}
        className="space-y-6"
      >
        <header className="flex flex-col gap-5 border-b border-gray-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
              Business setup
            </p>

            <h1 className="anaai-page-title mt-2">
              Business Profile
            </h1>

            <p className="anaai-page-description mt-2 max-w-2xl">
              Manage your business
              information, timezone,
              and weekly operating
              hours used by AnaAI.
            </p>
          </div>

          {canEditProfile && (
            <Button
              type="submit"
              disabled={saving}
              className="shrink-0 gap-2"
            >
              <Save className="size-4" />

              {saving
                ? "Saving..."
                : "Save profile"}
            </Button>
          )}
        </header>

        {businessRole ===
          "staff" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">
              Read-only business
              profile
            </p>

            <p className="mt-1 text-sm leading-6 text-amber-800">
              Staff members can view
              business information,
              but an owner or manager
              must make profile or
              hours changes.
            </p>
          </div>
        )}

        {businessRole ===
          "manager" && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-sm font-semibold text-blue-900">
              Manager access
            </p>

            <p className="mt-1 text-sm leading-6 text-blue-800">
              You can update profile
              details and business
              hours. Only an owner can
              change the canonical
              business name and
              timezone.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="anaai-surface flex items-center justify-between p-5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-500">
                Business
              </p>

              <p className="mt-1 truncate text-base font-semibold text-gray-950">
                {businessName ||
                  "Not configured"}
              </p>
            </div>

            <div className="ml-3 flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
              <Building2 className="size-5" />
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Open days
              </p>

              <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                {openDays}
                <span className="ml-1 text-sm font-medium text-gray-400">
                  / 7
                </span>
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <Clock3 className="size-5" />
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Your access
              </p>

              <p className="mt-1 text-base font-semibold text-gray-950">
                {formatRole(
                  businessRole
                )}
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <ShieldCheck className="size-5" />
            </div>
          </div>
        </div>

        <fieldset
          disabled={
            !canEditProfile ||
            saving
          }
          className="space-y-6 disabled:opacity-75"
        >
          <section className="anaai-surface overflow-hidden">
            <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <Building2 className="size-5" />
                </div>

                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Business information
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Contact and location
                    details customers may
                    need when interacting
                    with your business.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-5 p-5 md:grid-cols-2 sm:p-6">
              <div>
                <label
                  htmlFor="business-name"
                  className="mb-2 block text-sm font-medium text-gray-800"
                >
                  Business name
                </label>

                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <input
                    id="business-name"
                    value={businessName}
                    onChange={(event) =>
                      setBusinessName(
                        event.target.value
                      )
                    }
                    required
                    maxLength={200}
                    placeholder="Beauty Salon"
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>

                {businessRole ===
                  "manager" && (
                  <p className="mt-2 text-xs leading-5 text-gray-500">
                    Managers can update
                    the profile display
                    name. The canonical
                    business name remains
                    owner-controlled.
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="owner-name"
                  className="mb-2 block text-sm font-medium text-gray-800"
                >
                  Owner name
                  <span className="ml-1 font-normal text-gray-400">
                    Optional
                  </span>
                </label>

                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <input
                    id="owner-name"
                    value={ownerName}
                    onChange={(event) =>
                      setOwnerName(
                        event.target.value
                      )
                    }
                    placeholder="Owner name"
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="business-phone"
                  className="mb-2 block text-sm font-medium text-gray-800"
                >
                  Phone number
                </label>

                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <input
                    id="business-phone"
                    type="tel"
                    value={phone}
                    onChange={(event) =>
                      setPhone(
                        event.target.value
                      )
                    }
                    placeholder="Business phone number"
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="business-email"
                  className="mb-2 block text-sm font-medium text-gray-800"
                >
                  Business email
                </label>

                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <input
                    id="business-email"
                    type="email"
                    value={email}
                    onChange={(event) =>
                      setEmail(
                        event.target.value
                      )
                    }
                    placeholder="business@example.com"
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </div>

              <div className="md:col-span-2">
                <label
                  htmlFor="business-address"
                  className="mb-2 block text-sm font-medium text-gray-800"
                >
                  Business address
                </label>

                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <input
                    id="business-address"
                    value={address}
                    onChange={(event) =>
                      setAddress(
                        event.target.value
                      )
                    }
                    placeholder="Business address"
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="anaai-surface overflow-hidden">
            <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                  <Globe2 className="size-5" />
                </div>

                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Scheduling timezone
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    AnaAI uses this
                    timezone when
                    interpreting business
                    hours and appointment
                    dates.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6">
              <label
                htmlFor="business-timezone"
                className="mb-2 block text-sm font-medium text-gray-800"
              >
                Business timezone
              </label>

              <div className="relative">
                <Globe2 className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                <select
                  id="business-timezone"
                  value={timezone}
                  disabled={
                    !canEditCanonicalBusiness ||
                    saving
                  }
                  onChange={(event) =>
                    setTimezone(
                      event.target.value
                    )
                  }
                  className="min-h-11 w-full appearance-none rounded-xl border border-gray-300 bg-white pl-10 pr-4 text-sm text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                >
                  {!timezones.some(
                    (option) =>
                      option.value ===
                      timezone
                  ) && (
                    <option
                      value={timezone}
                    >
                      {timezone}
                    </option>
                  )}

                  {timezones.map(
                    (option) => (
                      <option
                        key={
                          option.value
                        }
                        value={
                          option.value
                        }
                      >
                        {
                          option.label
                        }
                      </option>
                    )
                  )}
                </select>
              </div>

              {!canEditCanonicalBusiness && (
                <p className="mt-2 text-xs leading-5 text-gray-500">
                  Only a business owner
                  can change the
                  timezone used for
                  scheduling.
                </p>
              )}
            </div>
          </section>

          <section className="anaai-surface overflow-hidden">
            <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <Clock3 className="size-5" />
                </div>

                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Weekly business
                    hours
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Set when your
                    business is open.
                    AnaAI uses these
                    hours when checking
                    appointment
                    availability.
                  </p>
                </div>
              </div>
            </div>

            <div className="divide-y divide-gray-100">
              {days.map(
                ({ key, label }) => {
                  const hours =
                    businessHours[key];

                  return (
                    <div
                      key={key}
                      className="grid gap-4 px-5 py-4 sm:px-6 md:grid-cols-[120px_110px_minmax(0,1fr)_minmax(0,1fr)] md:items-end"
                    >
                      <div className="flex min-h-11 items-center">
                        <p className="text-sm font-semibold text-gray-900">
                          {label}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          toggleClosed(
                            key
                          )
                        }
                        className={`min-h-11 rounded-xl px-3 text-sm font-semibold transition ${
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
                        <label
                          htmlFor={`${key}-open`}
                          className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500"
                        >
                          Opens
                        </label>

                        <input
                          id={`${key}-open`}
                          type="time"
                          value={
                            hours.open
                          }
                          disabled={
                            hours.closed ||
                            !canEditProfile ||
                            saving
                          }
                          onChange={(
                            event
                          ) =>
                            updateDay(
                              key,
                              "open",
                              event
                                .target
                                .value
                            )
                          }
                          className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`${key}-close`}
                          className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500"
                        >
                          Closes
                        </label>

                        <input
                          id={`${key}-close`}
                          type="time"
                          value={
                            hours.close
                          }
                          disabled={
                            hours.closed ||
                            !canEditProfile ||
                            saving
                          }
                          onChange={(
                            event
                          ) =>
                            updateDay(
                              key,
                              "close",
                              event
                                .target
                                .value
                            )
                          }
                          className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </div>
                    </div>
                  );
                }
              )}
            </div>

            <div className="border-t border-gray-200 bg-green-50/50 px-5 py-4 sm:px-6">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-green-700" />

                <div>
                  <p className="text-sm font-semibold text-green-900">
                    Shared scheduling
                    hours
                  </p>

                  <p className="mt-1 text-sm leading-6 text-green-800">
                    These hours use the
                    same structured
                    business-hours data
                    used by onboarding
                    and appointment
                    scheduling.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </fieldset>

        {canEditProfile && (
          <div className="flex justify-end border-t border-gray-200 pt-5">
            <Button
              type="submit"
              disabled={saving}
              className="gap-2 sm:min-w-40"
            >
              <Save className="size-4" />

              {saving
                ? "Saving..."
                : "Save profile"}
            </Button>
          </div>
        )}
      </form>
    </AppLayout>
  );
}