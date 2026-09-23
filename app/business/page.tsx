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
  Minus,
  Phone,
  Plus,
  Save,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ui/page-header";
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

const minAppointmentCapacity = 1;

const maxAppointmentCapacity = 100;

/*
 * businesses.appointment_capacity is
 * NOT NULL and constrained to 1..100
 * in the database. The UI mirrors that
 * range so malformed state is never
 * persisted silently.
 */
function normalizeAppointmentCapacity(
  value: unknown
): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  if (
    !Number.isInteger(parsed) ||
    parsed < minAppointmentCapacity ||
    parsed > maxAppointmentCapacity
  ) {
    return null;
  }

  return parsed;
}

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
    capacityInput,
    setCapacityInput,
  ] = useState(
    String(minAppointmentCapacity)
  );

  /*
   * Tracks whether the canonical
   * businesses row was read for this
   * page load. Without a confirmed
   * read the save path leaves
   * appointment_capacity untouched
   * instead of overwriting it.
   */
  const [
    capacityLoaded,
    setCapacityLoaded,
  ] = useState(false);

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

  const parsedCapacity =
    normalizeAppointmentCapacity(
      capacityInput
    );

  const capacityStepBase =
    parsedCapacity ??
    minAppointmentCapacity;

  /*
   * Capacity is only editable when the
   * canonical value was actually loaded,
   * so the control never looks saveable
   * while the save path is suppressing
   * the write.
   */
  const capacityControlsDisabled =
    !canEditCanonicalBusiness ||
    !capacityLoaded ||
    saving;

  const canDecrementCapacity =
    capacityStepBase >
    minAppointmentCapacity;

  const canIncrementCapacity =
    capacityStepBase <
    maxAppointmentCapacity;

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

        /*
         * businesses is canonical for
         * appointment_capacity. Read it
         * narrowly for the active
         * business only.
         */
        const {
          data: canonicalBusiness,
          error:
            canonicalBusinessError,
        } = await supabase
          .from("businesses")
          .select(
            "appointment_capacity"
          )
          .eq(
            "id",
            activeBusinessId
          )
          .maybeSingle();

        if (canonicalBusinessError) {
          toast.error(
            "Simultaneous appointment capacity could not be loaded. It will be left unchanged when you save."
          );
        } else if (
          canonicalBusiness
        ) {
          const loadedCapacity =
            normalizeAppointmentCapacity(
              canonicalBusiness.appointment_capacity
            );

          if (
            loadedCapacity === null
          ) {
            /*
             * Show a safe fallback, but
             * leave capacityLoaded false
             * so the save path never
             * persists this placeholder
             * over the canonical value.
             */
            setCapacityInput(
              String(
                minAppointmentCapacity
              )
            );

            toast.error(
              "Saved appointment capacity could not be read safely. Review it before saving."
            );
          } else {
            setCapacityInput(
              String(loadedCapacity)
            );

            setCapacityLoaded(true);
          }
        }

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

  function stepAppointmentCapacity(
    delta: number
  ) {
    setCapacityInput((current) => {
      const base =
        normalizeAppointmentCapacity(
          current
        ) ??
        minAppointmentCapacity;

      const next = Math.min(
        maxAppointmentCapacity,
        Math.max(
          minAppointmentCapacity,
          base + delta
        )
      );

      return String(next);
    });
  }

  function clampCapacityInput() {
    setCapacityInput((current) => {
      const normalized =
        normalizeAppointmentCapacity(
          current
        );

      if (normalized !== null) {
        return String(normalized);
      }

      const numeric = Number(
        current.trim()
      );

      if (
        Number.isFinite(numeric) &&
        numeric >
          maxAppointmentCapacity
      ) {
        return String(
          maxAppointmentCapacity
        );
      }

      return String(
        minAppointmentCapacity
      );
    });
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

    const normalizedCapacity =
      normalizeAppointmentCapacity(
        capacityInput
      );

    if (
      canEditCanonicalBusiness &&
      capacityLoaded &&
      normalizedCapacity === null
    ) {
      toast.error(
        "Simultaneous appointment capacity must be a whole number between 1 and 100."
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
        const canonicalUpdate: {
          name: string;
          timezone: string;
          updated_at: string;
          appointment_capacity?: number;
        } = {
          name: normalizedBusinessName,
          timezone:
            normalizedTimezone,
          updated_at:
            new Date().toISOString(),
        };

        /*
         * Only write appointment_capacity
         * when the canonical value was
         * read successfully, so a failed
         * load never resets it.
         */
        if (
          capacityLoaded &&
          normalizedCapacity !== null
        ) {
          canonicalUpdate.appointment_capacity =
            normalizedCapacity;
        }

        const {
          error:
            businessUpdateError,
        } = await supabase
          .from("businesses")
          .update(canonicalUpdate)
          .eq("id", businessId);

        if (
          businessUpdateError
        ) {
          throw businessUpdateError;
        }

        if (
          canonicalUpdate.appointment_capacity !==
          undefined
        ) {
          setCapacityInput(
            String(
              canonicalUpdate.appointment_capacity
            )
          );
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
        <PageHeader
          eyebrow="Business & availability"
          title={<>Business & availability</>}
          description={
            <>
              Manage your business information, timezone, and weekly operating hours used by
              AnaAI.
            </>
          }
        >
          {canEditProfile && (
            <Button type="submit" disabled={saving} className="shrink-0 gap-2">
              <Save className="size-4" />

              {saving ? "Saving..." : "Save profile"}
            </Button>
          )}
        </PageHeader>

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

        <div className="record-summary">
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

        <nav className="section-nav" aria-label="Business settings sections">
          <a href="#business-details">Business details</a>
          <a href="#business-timezone">Timezone</a>
          <a href="#business-capacity">Capacity</a>
          <a href="#business-hours">Weekly hours</a>
        </nav>
        <fieldset
          disabled={
            !canEditProfile ||
            saving
          }
          className="business-form-sections disabled:opacity-75"
        >
          <section id="business-details" className="configuration-section anaai-surface overflow-hidden">
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

          <section id="business-timezone" className="configuration-section anaai-surface overflow-hidden">
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

          <section id="business-capacity" className="configuration-section anaai-surface overflow-hidden">
            <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                  <Users className="size-5" />
                </div>

                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Appointment capacity
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    AnaAI uses this limit
                    with your business
                    hours when checking
                    availability.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6">
              <label
                htmlFor="appointment-capacity"
                className="block text-sm font-medium text-gray-800"
              >
                Simultaneous appointment
                capacity
              </label>

              <p className="mt-1 max-w-xl text-sm leading-6 text-gray-500">
                Maximum number of
                customers your business
                can serve at the same
                time.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label="Decrease appointment capacity"
                  onClick={() =>
                    stepAppointmentCapacity(
                      -1
                    )
                  }
                  disabled={
                    capacityControlsDisabled ||
                    !canDecrementCapacity
                  }
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white text-gray-700 transition hover:bg-gray-50 focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <Minus className="size-4" />
                </button>

                <input
                  id="appointment-capacity"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-describedby={
                    capacityLoaded
                      ? "appointment-capacity-range"
                      : "appointment-capacity-range appointment-capacity-unavailable"
                  }
                  value={capacityInput}
                  disabled={
                    capacityControlsDisabled
                  }
                  onChange={(event) =>
                    setCapacityInput(
                      event.target.value
                        .replace(
                          /[^0-9]/g,
                          ""
                        )
                        .slice(0, 3)
                    )
                  }
                  onBlur={
                    clampCapacityInput
                  }
                  className="min-h-11 w-20 rounded-xl border border-gray-300 bg-white px-3 text-center text-base font-semibold text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                />

                <button
                  type="button"
                  aria-label="Increase appointment capacity"
                  onClick={() =>
                    stepAppointmentCapacity(
                      1
                    )
                  }
                  disabled={
                    capacityControlsDisabled ||
                    !canIncrementCapacity
                  }
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white text-gray-700 transition hover:bg-gray-50 focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <Plus className="size-4" />
                </button>

                <p className="text-sm text-gray-500">
                  customers at a time
                </p>
              </div>

              <p
                id="appointment-capacity-range"
                className="mt-2 text-xs leading-5 text-gray-500"
              >
                Choose a whole number
                between{" "}
                {minAppointmentCapacity}{" "}
                and{" "}
                {maxAppointmentCapacity}
                .
              </p>

              {!capacityLoaded && (
                <p
                  id="appointment-capacity-unavailable"
                  className="mt-2 text-xs leading-5 text-amber-700"
                >
                  Appointment capacity is
                  unavailable right now.
                  Refresh the page before
                  changing this setting.
                </p>
              )}

              {!canEditCanonicalBusiness && (
                <p className="mt-2 text-xs leading-5 text-gray-500">
                  Only a business owner can
                  change simultaneous
                  appointment capacity. You
                  can see the current value
                  here, but saving the
                  profile will leave it
                  unchanged.
                </p>
              )}
            </div>
          </section>

          <section id="business-hours" className="configuration-section anaai-surface overflow-hidden">
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
