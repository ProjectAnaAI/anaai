"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { activeBusinessHeaders } from "@/lib/active-business";
import { validateService } from "@/lib/service-validation";
import { supabase } from "@/lib/supabase";

type BusinessRole = "owner" | "manager" | "staff";

type Service = {
  id: string;
  name: string;
  duration_minutes: number | null;
  price: number | null;
  description: string | null;
  is_active: boolean;
};

type CurrentBusinessResponse = {
  success: boolean;
  error?: string;
  business?: {
    id: string;
    name: string;
    timezone: string;
    role: BusinessRole;
  };
};

export default function ServicesPage() {
  const router = useRouter();

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const [businessId, setBusinessId] =
    useState<string | null>(null);

  const [userId, setUserId] =
    useState<string | null>(null);

  const [businessRole, setBusinessRole] =
    useState<BusinessRole | null>(null);

  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] =
    useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] =
    useState("");

  const [editingId, setEditingId] =
    useState<string | null>(null);

  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const [serviceActionId, setServiceActionId] =
    useState<string | null>(null);

  const [feedback, setFeedback] = useState("");

  const saveInFlight = useRef(false);

  const canManageServices =
    businessRole === "owner" ||
    businessRole === "manager";

  useEffect(() => {
    void initializePage();
  }, []);

  async function getAuthenticatedContext() {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (
      sessionError ||
      !session?.access_token ||
      !session.user
    ) {
      return null;
    }

    const response = await fetch(
      "/api/current-business",
      {
        method: "GET",
        headers: {
          ...activeBusinessHeaders(),
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      }
    );

    const data =
      (await response.json()) as CurrentBusinessResponse;

    if (
      !response.ok ||
      !data.success ||
      !data.business
    ) {
      console.error(
        "Could not resolve current business:",
        data.error
      );

      return null;
    }

    return {
      userId: session.user.id,
      businessId: data.business.id,
      role: data.business.role,
    };
  }

  async function initializePage() {
    setLoading(true);

    try {
      const context =
        await getAuthenticatedContext();

      if (!context) {
        router.push("/login");
        return;
      }

      setUserId(context.userId);
      setBusinessId(context.businessId);
      setBusinessRole(context.role);

      await loadServices(context.businessId);
    } finally {
      setLoading(false);
    }
  }

  async function loadServices(
    selectedBusinessId?: string
  ) {
    const activeBusinessId =
      selectedBusinessId ?? businessId;

    if (!activeBusinessId) {
      return;
    }

    const { data, error } = await supabase
      .from("services")
      .select(
        "id, name, duration_minutes, price, description, is_active"
      )
      .eq("business_id", activeBusinessId)
      .order("is_active", {
        ascending: false,
      })
      .order("name", {
        ascending: true,
      });

    if (error) {
      console.error(
        "Could not load services:",
        error
      );

      setFeedback(
        "Unable to load services. Please refresh and try again."
      );

      toast.error(
        "Unable to load services."
      );

      return;
    }

    setServices(data ?? []);
  }

  function resetEditor() {
    setEditingId(null);
    setName("");
    setDurationMinutes("");
    setPrice("");
    setDescription("");
    setActive(true);
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!canManageServices) {
      toast.error(
        "Your business role does not allow service changes."
      );
      return;
    }

    if (!businessId || !userId) {
      toast.error(
        "Business context is not available."
      );
      return;
    }

    if (saveInFlight.current) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setFeedback("");

    try {
      if (
        activeBusinessHeaders()[
          "x-anaai-business-id"
        ] !== businessId
      ) {
        throw new Error(
          "Business context changed. Reload and try again."
        );
      }

      const values = validateService({
        name,
        duration: durationMinutes,
        price,
        description,
        active,
      });

      /*
       * Existing service durations define the time span of
       * appointments already associated with that service.
       *
       * Do not rewrite an existing duration. If a business
       * needs a different duration, create a new service and
       * deactivate the old one.
       */
      const {
        duration_minutes,
        ...editableValues
      } = values;

      let result;

      if (editingId) {
        result = await supabase
          .from("services")
          .update(editableValues)
          .eq("id", editingId)
          .eq("business_id", businessId)
          .select(
            "id, name, duration_minutes, price, description, is_active"
          )
          .single();
      } else {
        result = await supabase
          .from("services")
          .insert({
            ...values,
            business_id: businessId,

            /*
             * Retained for compatibility with the
             * current production schema.
             */
            user_id: userId,
          })
          .select(
            "id, name, duration_minutes, price, description, is_active"
          )
          .single();
      }

      if (result.error || !result.data) {
        throw new Error(
          "Unable to save service. Refresh the list before retrying."
        );
      }

      setServices((current) => {
        const remaining = current.filter(
          (item) =>
            item.id !== result.data.id
        );

        return [
          result.data,
          ...remaining,
        ].sort((first, second) => {
          if (
            first.is_active !==
            second.is_active
          ) {
            return first.is_active
              ? -1
              : 1;
          }

          return first.name.localeCompare(
            second.name
          );
        });
      });

      const message = editingId
        ? "Service updated."
        : "Service created.";

      setFeedback(message);
      toast.success(message);

      resetEditor();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to save service.";

      setFeedback(message);
      toast.error(message);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function editService(service: Service) {
    if (
      !canManageServices ||
      saveInFlight.current ||
      serviceActionId
    ) {
      return;
    }

    setEditingId(service.id);
    setName(service.name);

    setDurationMinutes(
      service.duration_minutes == null
        ? ""
        : String(service.duration_minutes)
    );

    setPrice(
      service.price == null
        ? ""
        : String(service.price)
    );

    setDescription(
      service.description || ""
    );

    setActive(service.is_active);
    setFeedback("");

    document
      .getElementById("service-editor")
      ?.scrollIntoView({
        behavior: "smooth",
      });
  }

  function cancelEdit() {
    if (saveInFlight.current) {
      return;
    }

    resetEditor();
    setFeedback("");
  }

  async function toggleServiceActive(
    service: Service
  ) {
    if (!canManageServices) {
      toast.error(
        "Your business role does not allow service changes."
      );
      return;
    }

    if (!businessId) {
      toast.error(
        "Business context is not available."
      );
      return;
    }

    if (
      saving ||
      saveInFlight.current ||
      serviceActionId
    ) {
      return;
    }

    setServiceActionId(service.id);
    setFeedback("");

    try {
      if (
        activeBusinessHeaders()[
          "x-anaai-business-id"
        ] !== businessId
      ) {
        throw new Error(
          "Business context changed. Reload and try again."
        );
      }

      const nextActive =
        !service.is_active;

      const { data, error } = await supabase
        .from("services")
        .update({
          is_active: nextActive,
        })
        .eq("id", service.id)
        .eq("business_id", businessId)
        .select(
          "id, name, duration_minutes, price, description, is_active"
        )
        .single();

      if (error || !data) {
        throw new Error(
          "Unable to update service status."
        );
      }

      setServices((current) =>
        current
          .map((item) =>
            item.id === data.id
              ? data
              : item
          )
          .sort((first, second) => {
            if (
              first.is_active !==
              second.is_active
            ) {
              return first.is_active
                ? -1
                : 1;
            }

            return first.name.localeCompare(
              second.name
            );
          })
      );

      if (
        editingId === service.id &&
        !nextActive
      ) {
        resetEditor();
      }

      const message = nextActive
        ? "Service activated."
        : "Service deactivated.";

      setFeedback(message);
      toast.success(message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to update service status.";

      setFeedback(message);
      toast.error(message);
    } finally {
      setServiceActionId(null);
    }
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <p className="text-sm font-medium uppercase tracking-wide text-green-600">
            Business setup
          </p>

          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
            Services
          </h1>

          <p className="mt-2 text-gray-500">
            Create and manage the services your
            business offers.
          </p>
        </header>

        {businessRole === "staff" && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-900">
              Read-only services
            </p>

            <p className="mt-1 text-sm text-amber-800">
              Staff members can view services,
              but an owner or manager must make
              changes.
            </p>
          </div>
        )}

        {canManageServices && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>
                {editingId
                  ? "Edit service"
                  : "New service"}
              </CardTitle>
            </CardHeader>

            <CardContent>
              <form
                id="service-editor"
                onSubmit={handleSubmit}
              >
                <fieldset
                  disabled={saving}
                  className="space-y-4"
                >
                  <div className="grid gap-4 md:grid-cols-3">
                    <label className="space-y-2 text-sm font-medium">
                      <span>
                        Service name
                      </span>

                      <Input
                        placeholder="Haircut"
                        value={name}
                        onChange={(event) =>
                          setName(
                            event.target.value
                          )
                        }
                        required
                        maxLength={200}
                      />
                    </label>

                    <label className="space-y-2 text-sm font-medium">
                      <span>
                        Duration in minutes
                      </span>

                      <Input
                        type="number"
                        min="1"
                        max="1440"
                        readOnly={Boolean(
                          editingId
                        )}
                        placeholder="30"
                        value={
                          durationMinutes
                        }
                        onChange={(event) =>
                          setDurationMinutes(
                            event.target.value
                          )
                        }
                        required={!editingId}
                      />
                    </label>

                    <label className="space-y-2 text-sm font-medium">
                      <span>
                        Price
                        <span className="ml-1 font-normal text-gray-400">
                          Optional
                        </span>
                      </span>

                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="45.00"
                        value={price}
                        onChange={(event) =>
                          setPrice(
                            event.target.value
                          )
                        }
                      />
                    </label>
                  </div>

                  {editingId && (
                    <p className="text-sm leading-6 text-gray-500">
                      Duration is read-only for
                      an existing service because
                      appointment intervals may
                      already depend on it. Create
                      a new service if you need a
                      different duration, then
                      deactivate the old service.
                    </p>
                  )}

                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(event) =>
                        setActive(
                          event.target.checked
                        )
                      }
                    />

                    Active service
                  </label>

                  <label className="block space-y-2 text-sm font-medium">
                    <span>
                      Description
                      <span className="ml-1 font-normal text-gray-400">
                        Optional
                      </span>
                    </span>

                    <Textarea
                      placeholder="Describe what is included in this service."
                      value={description}
                      maxLength={2000}
                      onChange={(event) =>
                        setDescription(
                          event.target.value
                        )
                      }
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      disabled={
                        saving ||
                        !businessId ||
                        !userId
                      }
                    >
                      {saving
                        ? "Saving..."
                        : editingId
                          ? "Save changes"
                          : "Save service"}
                    </Button>

                    {editingId && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={cancelEdit}
                        disabled={saving}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </fieldset>

                {feedback && (
                  <p
                    role="status"
                    className="mt-4 text-sm text-gray-600"
                  >
                    {feedback}
                  </p>
                )}
              </form>
            </CardContent>
          </Card>
        )}

        {!canManageServices &&
          feedback && (
            <p
              role="status"
              className="mt-6 text-sm text-gray-600"
            >
              {feedback}
            </p>
          )}

        <section className="mt-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
              Service list
            </h2>

            <p className="mt-1 text-sm text-gray-500">
              Active services can be used for new
              appointments. Deactivated services
              remain in your history.
            </p>
          </div>

          {loading ? (
            <p className="mt-4 text-gray-500">
              Loading services...
            </p>
          ) : services.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="font-medium text-gray-900">
                No services yet
              </p>

              <p className="mt-2 text-sm text-gray-500">
                {canManageServices
                  ? "Create your first service so AnaAI and your team can schedule appointments."
                  : "An owner or manager can add services for this business."}
              </p>
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              {services.map((service) => {
                const actionInProgress =
                  serviceActionId ===
                  service.id;

                return (
                  <div
                    key={service.id}
                    className="border-b border-gray-100 p-5 last:border-b-0"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="text-lg font-semibold text-gray-900">
                            {service.name}
                          </h3>

                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              service.is_active
                                ? "bg-green-50 text-green-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {service.is_active
                              ? "Active"
                              : "Inactive"}
                          </span>
                        </div>

                        <div className="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-2">
                          <p>
                            <span className="font-medium text-gray-900">
                              Duration:
                            </span>{" "}
                            {service.duration_minutes
                              ? `${service.duration_minutes} minutes`
                              : "Not set"}
                          </p>

                          <p>
                            <span className="font-medium text-gray-900">
                              Price:
                            </span>{" "}
                            {service.price !==
                            null
                              ? `$${Number(
                                  service.price
                                ).toFixed(2)}`
                              : "Not set"}
                          </p>
                        </div>

                        {service.description && (
                          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500">
                            {
                              service.description
                            }
                          </p>
                        )}
                      </div>

                      {canManageServices && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={
                              saving ||
                              Boolean(
                                serviceActionId
                              )
                            }
                            onClick={() =>
                              editService(
                                service
                              )
                            }
                          >
                            Edit
                          </Button>

                          <Button
                            variant="outline"
                            disabled={
                              saving ||
                              Boolean(
                                serviceActionId
                              )
                            }
                            onClick={() =>
                              void toggleServiceActive(
                                service
                              )
                            }
                          >
                            {actionInProgress
                              ? "Updating..."
                              : service.is_active
                                ? "Deactivate"
                                : "Activate"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
        </section>
      </div>
    </AppLayout>
  );
}