"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import {
  isOnboardingDraft,
  newOnboardingDraft,
  onboardingDays,
  validateOnboarding,
} from "@/lib/onboarding";
import {
  validateBusinessHours,
} from "@/lib/business-hours";
import { supabase } from "@/lib/supabase";

const steps = [
  "Business",
  "Hours",
  "Services",
  "Receptionist",
  "Review",
];

const inputStyle =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100";

type CurrentBusinessResponse =
  | {
      success: true;
      business: {
        id: string;
        name: string;
        timezone: string;
        role: "owner" | "manager" | "staff";
      };
    }
  | {
      success: false;
      error: string;
      code?: string;
    };

type OnboardingResponse =
  | {
      success: true;
    }
  | {
      success: false;
      code?: string;
      error?: string;
    };

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export default function OnboardingPage() {
  const [draft, setDraft] = useState(newOnboardingDraft);

  const [storageKey, setStorageKey] = useState("");

  const [step, setStep] = useState(0);

  const [busy, setBusy] = useState(false);

  const [checkingAccount, setCheckingAccount] =
    useState(true);

  const [completed, setCompleted] =
    useState(false);

  const [error, setError] = useState("");

  const submitting = useRef(false);

  const capacityIsValid =
    Number.isInteger(draft.appointment_capacity) &&
    draft.appointment_capacity >= 1 &&
    draft.appointment_capacity <= 100;

  useEffect(() => {
    let cancelled = false;

    async function initializeOnboarding() {
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
          if (!cancelled) {
            setError(
              "Please log in again to continue setup."
            );
          }

          return;
        }

        /*
         * If this login already belongs to a business,
         * onboarding is finished. This also covers users who
         * refresh or revisit /onboarding after provisioning.
         */
        const businessResponse = await fetch(
          "/api/current-business",
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        const businessPayload =
          (await businessResponse.json()) as CurrentBusinessResponse;

        if (
          businessResponse.ok &&
          businessPayload.success
        ) {
          window.location.replace(
            "/dashboard"
          );

          return;
        }

        if (cancelled) {
          return;
        }

        const key =
          `anaai:onboarding:${session.user.id}`;

        try {
          const saved =
            sessionStorage.getItem(key);

          if (saved) {
            const parsed =
              JSON.parse(saved);

            const restored = {
              ...newOnboardingDraft(),
              ...parsed,
            };

            /*
             * Older saved drafts may predate fields such as
             * timezone or appointment capacity. Merge them with today's defaults first.
             */
            if (
              isOnboardingDraft(restored)
            ) {
              setDraft(restored);
            }
          }
        } catch {
          // Session storage is optional.
        }

        setStorageKey(key);
      } catch (failure) {
        if (!cancelled) {
          console.error(
            "Onboarding initialization error:",
            failure
          );

          setError(
            "Unable to restore your setup session. Please reload or log in again."
          );
        }
      } finally {
        if (!cancelled) {
          setCheckingAccount(false);
        }
      }
    }

    void initializeOnboarding();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageKey || completed) {
      return;
    }

    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(draft)
      );
    } catch {
      // Keep the in-memory draft if storage is unavailable.
    }
  }, [
    draft,
    storageKey,
    completed,
  ]);

  function updateDraftField(
    key:
      | "name"
      | "phone"
      | "email"
      | "address"
      | "receptionist"
      | "greeting",
    value: string
  ) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function field(
    key:
      | "name"
      | "phone"
      | "email"
      | "address"
      | "receptionist"
      | "greeting",
    label: string,
    type = "text"
  ) {
    return (
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-slate-700">
          {label}
        </span>

        <input
          className={inputStyle}
          type={type}
          value={draft[key]}
          required
          disabled={busy}
          onChange={(event) =>
            updateDraftField(
              key,
              event.target.value
            )
          }
        />
      </label>
    );
  }

  function validateBusinessStep() {
    if (!draft.name.trim()) {
      throw new Error(
        "Enter your business name."
      );
    }

    if (draft.name.trim().length > 200) {
      throw new Error(
        "Business name must be 200 characters or fewer."
      );
    }

    if (!draft.phone.trim()) {
      throw new Error(
        "Enter your business phone number."
      );
    }

    if (
      !/^[+\d\s().-]{7,30}$/.test(
        draft.phone.trim()
      )
    ) {
      throw new Error(
        "Enter a valid business phone number."
      );
    }

    if (!draft.email.trim()) {
      throw new Error(
        "Enter your business email address."
      );
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        draft.email.trim()
      )
    ) {
      throw new Error(
        "Enter a valid business email address."
      );
    }

    if (!draft.address.trim()) {
      throw new Error(
        "Enter your business address."
      );
    }

    try {
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone: draft.timezone,
        }
      ).format();
    } catch {
      throw new Error(
        "Choose a valid business timezone."
      );
    }
  }

  function validateHoursStep() {
    if (!capacityIsValid) {
      throw new Error(
        "Choose a whole number between 1 and 100 for appointment capacity."
      );
    }

    const result =
      validateBusinessHours(
        draft.hours
      );

    if (!result.success) {
      throw new Error(
        result.error
      );
    }

    setDraft((current) => ({
      ...current,
      hours: result.hours,
    }));
  }

  function validateServicesStep() {
    if (
      draft.services.length < 1
    ) {
      throw new Error(
        "Add at least one service."
      );
    }

    if (
      draft.services.length > 50
    ) {
      throw new Error(
        "You can add up to 50 services during setup."
      );
    }

    for (
      let index = 0;
      index < draft.services.length;
      index += 1
    ) {
      const service =
        draft.services[index];

      const displayNumber =
        index + 1;

      if (!service.name.trim()) {
        throw new Error(
          `Enter a name for service ${displayNumber}.`
        );
      }

      if (
        service.name.trim().length >
        200
      ) {
        throw new Error(
          `Service ${displayNumber} name must be 200 characters or fewer.`
        );
      }

      if (
        !/^\d+$/.test(
          service.duration.trim()
        )
      ) {
        throw new Error(
          `Enter a valid duration for service ${displayNumber}.`
        );
      }

      const duration =
        Number(service.duration);

      if (
        duration < 1 ||
        duration > 1440
      ) {
        throw new Error(
          `Service ${displayNumber} duration must be between 1 and 1440 minutes.`
        );
      }

      if (
        service.price.trim() &&
        !/^\d+(\.\d{1,2})?$/.test(
          service.price.trim()
        )
      ) {
        throw new Error(
          `Enter a valid price for service ${displayNumber}.`
        );
      }

      if (
        service.description.length >
        2000
      ) {
        throw new Error(
          `Service ${displayNumber} description must be 2000 characters or fewer.`
        );
      }
    }
  }

  function validateReceptionistStep() {
    if (
      !draft.receptionist.trim()
    ) {
      throw new Error(
        "Enter a receptionist name."
      );
    }

    if (!draft.greeting.trim()) {
      throw new Error(
        "Enter a greeting."
      );
    }
  }

  function next() {
    if (busy) {
      return;
    }

    setError("");

    try {
      if (step === 0) {
        validateBusinessStep();
      }

      if (step === 1) {
        validateHoursStep();
      }

      if (step === 2) {
        validateServicesStep();
      }

      if (step === 3) {
        validateReceptionistStep();
      }

      setStep((current) =>
        Math.min(
          current + 1,
          steps.length - 1
        )
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Check your setup details."
      );
    }
  }

  async function waitForBusinessReadiness(
    accessToken: string
  ) {
    /*
     * Provisioning completes inside the onboarding RPC before
     * the API returns. This short retry loop protects the UX
     * from a transient membership-discovery/read delay.
     */
    for (
      let attempt = 0;
      attempt < 4;
      attempt += 1
    ) {
      try {
        const response = await fetch(
          "/api/current-business",
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${accessToken}`,
            },
            cache: "no-store",
          }
        );

        const payload =
          (await response.json()) as CurrentBusinessResponse;

        if (
          response.ok &&
          payload.success &&
          payload.business.id
        ) {
          return true;
        }
      } catch {
        // Retry briefly before navigating.
      }

      if (attempt < 3) {
        await sleep(250);
      }
    }

    return false;
  }

  async function finish() {
    if (submitting.current) {
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError("");

    let provisioningSucceeded =
      false;

    try {
      let validatedDraft;

      try {
        validatedDraft =
          validateOnboarding(draft);
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Check your setup details."
        );

        return;
      }

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (
        sessionError ||
        !session?.user ||
        !session.access_token ||
        storageKey !==
          `anaai:onboarding:${session.user.id}`
      ) {
        setError(
          "Please log in again to finish setup."
        );

        return;
      }

      const response = await fetch(
        "/api/onboarding",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(
            validatedDraft
          ),
        }
      );

      const result =
        (await response.json()) as OnboardingResponse;

      const newlyProvisioned =
        response.ok &&
        result.success === true;

      const alreadyProvisioned =
        response.status === 409 &&
        result.success === false &&
        result.code ===
          "ALREADY_PROVISIONED";

      if (
        !newlyProvisioned &&
        !alreadyProvisioned
      ) {
        const message =
          result.success === false &&
          result.error
            ? result.error
            : "Unable to finish setup. Check your details and try again.";

        throw new Error(message);
      }

      provisioningSucceeded = true;
      setCompleted(true);

      try {
        sessionStorage.removeItem(
          storageKey
        );
      } catch {
        // Session storage is optional.
      }

      /*
       * Confirm that authenticated business discovery sees the
       * committed membership before opening the application.
       *
       * If this check is temporarily unavailable, setup has
       * still succeeded. Dashboard loading remains the fallback.
       */
      await waitForBusinessReadiness(
        session.access_token
      );

      window.location.replace(
        "/dashboard"
      );
    } catch (failure) {
      console.error(
        "Onboarding completion error:",
        failure
      );

      if (provisioningSucceeded) {
        /*
         * Never tell the owner their setup failed after the
         * database transaction has already succeeded.
         */
        setCompleted(true);

        window.location.replace(
          "/dashboard"
        );

        return;
      }

      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to finish setup. Check your details and try again."
      );
    } finally {
      submitting.current = false;

      if (!provisioningSucceeded) {
        setBusy(false);
      }
    }
  }

  if (
    checkingAccount ||
    !storageKey
  ) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? (
            <div className="space-y-4">
              <p
                role="alert"
                className="text-sm text-red-600"
              >
                {error}
              </p>

              <a
                href="/login"
                className="inline-flex rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white"
              >
                Log in
              </a>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Checking your business setup...
            </p>
          )}
        </div>
      </main>
    );
  }

  if (completed) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-2xl rounded-xl border border-emerald-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-xl text-emerald-700">
            ✓
          </div>

          <h1 className="mt-5 text-2xl font-semibold text-slate-900">
            Your business is ready
          </h1>

          <p className="mt-2 text-sm leading-6 text-slate-500">
            Your profile, hours,
            services, and AI
            receptionist settings have
            been created. Opening your
            dashboard now.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-2xl space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600">
            AnaAI setup
          </p>

          <h1 className="mt-2 text-2xl font-semibold text-slate-900">
            Set up your business
          </h1>

          <p className="mt-1 text-sm text-slate-500">
            Step {step + 1} of{" "}
            {steps.length} ·{" "}
            {steps[step]}
          </p>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all"
              style={{
                width: `${
                  ((step + 1) /
                    steps.length) *
                  100
                }%`,
              }}
            />
          </div>
        </div>

        <fieldset
          disabled={busy}
          className="space-y-4"
        >
          {step === 0 && (
            <>
              {field(
                "name",
                "Business name *"
              )}

              {field(
                "phone",
                "Phone *",
                "tel"
              )}

              {field(
                "email",
                "Email *",
                "email"
              )}

              {field(
                "address",
                "Address *"
              )}

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Business timezone *
                </span>

                <select
                  className={inputStyle}
                  value={draft.timezone}
                  onChange={(event) =>
                    setDraft(
                      (current) => ({
                        ...current,
                        timezone:
                          event.target
                            .value,
                      })
                    )
                  }
                >
                  <option value="America/Los_Angeles">
                    Pacific Time —
                    America/Los_Angeles
                  </option>

                  <option value="America/Denver">
                    Mountain Time —
                    America/Denver
                  </option>

                  <option value="America/Chicago">
                    Central Time —
                    America/Chicago
                  </option>

                  <option value="America/New_York">
                    Eastern Time —
                    America/New_York
                  </option>

                  <option value="America/Phoenix">
                    Arizona —
                    America/Phoenix
                  </option>

                  <option value="America/Anchorage">
                    Alaska —
                    America/Anchorage
                  </option>

                  <option value="Pacific/Honolulu">
                    Hawaii —
                    Pacific/Honolulu
                  </option>
                </select>
              </label>
            </>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div className="min-w-0 rounded-lg border border-slate-200 p-4">
                <label
                  htmlFor="appointment-capacity"
                  className="block text-sm font-medium text-slate-800"
                >
                  How many customers can you usually serve at the same time?
                </label>
                <p id="appointment-capacity-help" className="mt-1 text-sm leading-6 text-slate-500">
                  This sets how many appointments can overlap at your business.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label="Decrease appointment capacity"
                    disabled={busy || !capacityIsValid || draft.appointment_capacity <= 1}
                    onClick={() => setDraft((current) => ({
                      ...current,
                      appointment_capacity: Number.isInteger(current.appointment_capacity) &&
                        current.appointment_capacity > 1 && current.appointment_capacity <= 100
                        ? current.appointment_capacity - 1 : current.appointment_capacity,
                    }))}
                    className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <Minus className="size-4" aria-hidden="true" />
                  </button>
                  <input
                    id="appointment-capacity"
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    min={1}
                    max={100}
                    step={1}
                    required
                    disabled={busy}
                    aria-invalid={!capacityIsValid}
                    aria-describedby="appointment-capacity-help appointment-capacity-range"
                    value={Number.isFinite(draft.appointment_capacity) ? draft.appointment_capacity : ""}
                    onChange={(event) => {
                      // Keep invalid/empty input invalid; never clamp a submitted value.
                      const capacity = event.currentTarget.valueAsNumber;
                      setDraft((current) => ({ ...current, appointment_capacity: capacity }));
                    }}
                    className="min-h-11 w-20 min-w-0 rounded-xl border border-slate-300 bg-white px-2 text-center text-base font-semibold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100"
                  />
                  <button
                    type="button"
                    aria-label="Increase appointment capacity"
                    disabled={busy || !capacityIsValid || draft.appointment_capacity >= 100}
                    onClick={() => setDraft((current) => ({
                      ...current,
                      appointment_capacity: Number.isInteger(current.appointment_capacity) &&
                        current.appointment_capacity >= 1 && current.appointment_capacity < 100
                        ? current.appointment_capacity + 1 : current.appointment_capacity,
                    }))}
                    className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <p id="appointment-capacity-range" className="mt-2 text-xs leading-5 text-slate-500">
                  Choose a whole number between 1 and 100.
                </p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Weekly hours
                </p>

                <p className="mt-1 text-sm leading-6 text-slate-500">
                  AnaAI uses these
                  hours when checking
                  whether appointments
                  fit within your
                  business day.
                </p>
              </div>

              {onboardingDays.map(
                (day) => {
                  const hours =
                    draft.hours[day];

                  return (
                    <div
                      key={day}
                      className="rounded-lg border border-slate-200 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="font-medium capitalize text-slate-900">
                          {day}
                        </span>

                        <label className="flex items-center gap-2 text-sm text-slate-600">
                          <input
                            type="checkbox"
                            checked={
                              hours.closed
                            }
                            onChange={(
                              event
                            ) =>
                              setDraft(
                                (
                                  current
                                ) => ({
                                  ...current,
                                  hours: {
                                    ...current.hours,
                                    [day]:
                                      {
                                        ...current
                                          .hours[
                                          day
                                        ],
                                        closed:
                                          event
                                            .target
                                            .checked,
                                      },
                                  },
                                })
                              )
                            }
                          />

                          Closed
                        </label>
                      </div>

                      {!hours.closed && (
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              "open",
                              "close",
                            ] as const
                          ).map(
                            (key) => (
                              <label
                                key={
                                  key
                                }
                                className="block space-y-1.5"
                              >
                                <span className="text-sm font-medium capitalize text-slate-700">
                                  {
                                    key
                                  }
                                </span>

                                <input
                                  className={
                                    inputStyle
                                  }
                                  type="time"
                                  value={
                                    hours[
                                      key
                                    ]
                                  }
                                  onChange={(
                                    event
                                  ) =>
                                    setDraft(
                                      (
                                        current
                                      ) => ({
                                        ...current,
                                        hours:
                                          {
                                            ...current.hours,
                                            [day]:
                                              {
                                                ...current
                                                  .hours[
                                                  day
                                                ],
                                                [key]:
                                                  event
                                                    .target
                                                    .value,
                                              },
                                          },
                                      })
                                    )
                                  }
                                />
                              </label>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                }
              )}
            </div>
          )}

          {step === 2 && (
            <>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Services customers can book
                </p>

                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Add at least one
                  service. You can
                  manage more services
                  later from the
                  Services page.
                </p>
              </div>

              {draft.services.map(
                (service, index) => (
                  <div
                    key={index}
                    className="space-y-3 rounded-lg border border-slate-200 p-4"
                  >
                    <p className="text-sm font-semibold text-slate-800">
                      Service{" "}
                      {index + 1}
                    </p>

                    {(
                      [
                        "name",
                        "duration",
                        "price",
                        "description",
                      ] as const
                    ).map((key) => {
                      const labels = {
                        name: "Service name *",
                        duration:
                          "Duration in minutes *",
                        price:
                          "Price (optional)",
                        description:
                          "Description (optional)",
                      };

                      return (
                        <label
                          className="block space-y-1.5"
                          key={key}
                        >
                          <span className="text-sm font-medium text-slate-700">
                            {
                              labels[
                                key
                              ]
                            }
                          </span>

                          <input
                            className={
                              inputStyle
                            }
                            value={
                              service[
                                key
                              ]
                            }
                            type={
                              key ===
                                "duration" ||
                              key ===
                                "price"
                                ? "number"
                                : "text"
                            }
                            min={
                              key ===
                              "duration"
                                ? 1
                                : 0
                            }
                            max={
                              key ===
                              "duration"
                                ? 1440
                                : undefined
                            }
                            step={
                              key ===
                              "price"
                                ? "0.01"
                                : "1"
                            }
                            onChange={(
                              event
                            ) =>
                              setDraft(
                                (
                                  current
                                ) => ({
                                  ...current,
                                  services:
                                    current.services.map(
                                      (
                                        currentService,
                                        currentIndex
                                      ) =>
                                        currentIndex ===
                                        index
                                          ? {
                                              ...currentService,
                                              [key]:
                                                event
                                                  .target
                                                  .value,
                                            }
                                          : currentService
                                    ),
                                })
                              )
                            }
                          />
                        </label>
                      );
                    })}

                    {draft.services
                      .length > 1 && (
                      <button
                        type="button"
                        className="text-sm font-medium text-red-600 hover:text-red-700"
                        onClick={() =>
                          setDraft(
                            (
                              current
                            ) => ({
                              ...current,
                              services:
                                current.services.filter(
                                  (
                                    _,
                                    currentIndex
                                  ) =>
                                    currentIndex !==
                                    index
                                ),
                            })
                          )
                        }
                      >
                        Remove service
                      </button>
                    )}
                  </div>
                )
              )}

              <button
                type="button"
                disabled={
                  draft.services
                    .length >= 50
                }
                className="text-sm font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() =>
                  setDraft(
                    (current) => ({
                      ...current,
                      services: [
                        ...current.services,
                        {
                          name: "",
                          duration:
                            "30",
                          price: "",
                          description:
                            "",
                        },
                      ],
                    })
                  )
                }
              >
                + Add service
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Your AI receptionist
                </p>

                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Choose the name
                  customers hear and
                  the greeting AnaAI
                  should use.
                </p>
              </div>

              {field(
                "receptionist",
                "Receptionist name *"
              )}

              {field(
                "greeting",
                "Greeting *"
              )}
            </>
          )}

          {step === 4 && (
            <div className="space-y-5">
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Business
                </p>

                <p className="mt-2 font-semibold text-slate-900">
                  {draft.name ||
                    "Business name required"}
                </p>

                <div className="mt-2 space-y-1 text-sm text-slate-600">
                  <p>
                    {draft.phone ||
                      "Phone required"}
                  </p>

                  <p>
                    {draft.email ||
                      "Email required"}
                  </p>

                  <p>
                    {draft.address ||
                      "Address required"}
                  </p>

                  <p>
                    {
                      draft.timezone
                    }
                  </p>
                  <p>
                    Simultaneous capacity: {draft.appointment_capacity}{" "}
                    {draft.appointment_capacity === 1 ? "customer" : "customers"} at a time.
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Services
                </p>

                <p className="mt-2 text-sm text-slate-600">
                  {
                    draft.services
                      .length
                  }{" "}
                  {draft.services
                    .length === 1
                    ? "service"
                    : "services"}
                </p>

                <ul className="mt-3 space-y-2">
                  {draft.services.map(
                    (
                      service,
                      index
                    ) => (
                      <li
                        key={
                          index
                        }
                        className="text-sm text-slate-700"
                      >
                        <span className="font-medium">
                          {service.name ||
                            "Service name required"}
                        </span>{" "}
                        ·{" "}
                        {
                          service.duration
                        }{" "}
                        minutes
                        {service.price &&
                          ` · $${service.price}`}
                      </li>
                    )
                  )}
                </ul>
              </div>

              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  AI receptionist
                </p>

                <p className="mt-2 font-medium text-slate-900">
                  {
                    draft.receptionist
                  }
                </p>

                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {draft.greeting}
                </p>
              </div>

              <p className="text-sm leading-6 text-slate-500">
                Your business is
                created only when you
                finish setup. Use Back
                to review your
                business hours,
                services, or other
                details before
                continuing.
              </p>
            </div>
          )}
        </fieldset>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p
              role="alert"
              className="text-sm text-red-700"
            >
              {error}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-slate-200 pt-5">
          <button
            type="button"
            disabled={
              busy ||
              step === 0
            }
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              setStep((current) =>
                Math.max(
                  current - 1,
                  0
                )
              );

              setError("");
            }}
          >
            Back
          </button>

          {step <
          steps.length - 1 ? (
            <button
              type="button"
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={next}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() =>
                void finish()
              }
            >
              {busy
                ? "Finishing setup..."
                : "Finish onboarding"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
