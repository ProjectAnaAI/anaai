"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Clock3,
  DollarSign,
  Pencil,
  Plus,
  Scissors,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DialogSurface } from "@/components/ui/dialog-surface";
import { PageHeader } from "@/components/ui/page-header";
import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { activeBusinessHeaders } from "@/lib/active-business";
import { validateService } from "@/lib/service-validation";
import { supabase } from "@/lib/supabase";

type BusinessRole =
  | "owner"
  | "manager"
  | "staff";

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

function formatDuration(
  duration: number | null
) {
  if (duration == null) {
    return "Not set";
  }

  if (duration === 60) {
    return "1 hour";
  }

  if (
    duration > 60 &&
    duration % 60 === 0
  ) {
    return `${duration / 60} hours`;
  }

  return `${duration} min`;
}

function formatPrice(
  price: number | null
) {
  if (price == null) {
    return "Not set";
  }

  return `$${Number(price).toFixed(2)}`;
}

export default function ServicesPage() {
  const router = useRouter();

  const [
    services,
    setServices,
  ] = useState<Service[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

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
    name,
    setName,
  ] = useState("");

  const [
    durationMinutes,
    setDurationMinutes,
  ] = useState("");

  const [
    price,
    setPrice,
  ] = useState("");

  const [
    description,
    setDescription,
  ] = useState("");

  const [
    editingId,
    setEditingId,
  ] = useState<string | null>(null);

  const [
    active,
    setActive,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    serviceActionId,
    setServiceActionId,
  ] = useState<string | null>(
    null
  );

  const [
    feedback,
    setFeedback,
  ] = useState("");

  const [
    editorOpen,
    setEditorOpen,
  ] = useState(false);

  const saveInFlight =
    useRef(false);

  const canManageServices =
    businessRole === "owner" ||
    businessRole === "manager";

  const activeCount = useMemo(
    () =>
      services.filter(
        (service) =>
          service.is_active
      ).length,
    [services]
  );

  const inactiveCount =
    services.length - activeCount;

  useEffect(() => {
    void initializePage();
  }, []);

  async function getAuthenticatedContext() {
    const {
      data: { session },
      error: sessionError,
    } =
      await supabase.auth.getSession();

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
          Authorization:
            `Bearer ${session.access_token}`,
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
      businessId:
        data.business.id,
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
      setBusinessId(
        context.businessId
      );
      setBusinessRole(
        context.role
      );

      await loadServices(
        context.businessId
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadServices(
    selectedBusinessId?: string
  ) {
    const activeBusinessId =
      selectedBusinessId ??
      businessId;

    if (!activeBusinessId) {
      return;
    }

    const { data, error } =
      await supabase
        .from("services")
        .select(
          "id, name, duration_minutes, price, description, is_active"
        )
        .eq(
          "business_id",
          activeBusinessId
        )
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

  function openNewService() {
    if (
      !canManageServices ||
      saveInFlight.current ||
      serviceActionId
    ) {
      return;
    }

    resetEditor();
    setFeedback("");
    setEditorOpen(true);
  }

  function closeEditor() {
    if (saveInFlight.current) {
      return;
    }

    resetEditor();
    setFeedback("");
    setEditorOpen(false);
  }

  async function handleSubmit(
    event:
      React.FormEvent<HTMLFormElement>
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

      const values =
        validateService({
          name,
          duration:
            durationMinutes,
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
          .update(
            editableValues
          )
          .eq(
            "id",
            editingId
          )
          .eq(
            "business_id",
            businessId
          )
          .select(
            "id, name, duration_minutes, price, description, is_active"
          )
          .single();
      } else {
        result = await supabase
          .from("services")
          .insert({
            ...values,
            business_id:
              businessId,

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

      if (
        result.error ||
        !result.data
      ) {
        throw new Error(
          "Unable to save service. Refresh the list before retrying."
        );
      }

      setServices((current) => {
        const remaining =
          current.filter(
            (item) =>
              item.id !==
              result.data.id
          );

        return [
          result.data,
          ...remaining,
        ].sort(
          (first, second) => {
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
          }
        );
      });

      const message = editingId
        ? "Service updated."
        : "Service created.";

      setFeedback(message);
      toast.success(message);

      resetEditor();
      setEditorOpen(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to save service.";

      setFeedback(message);
      toast.error(message);
    } finally {
      saveInFlight.current =
        false;
      setSaving(false);
    }
  }

  function editService(
    service: Service
  ) {
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
      service.duration_minutes ==
        null
        ? ""
        : String(
            service.duration_minutes
          )
    );

    setPrice(
      service.price == null
        ? ""
        : String(service.price)
    );

    setDescription(
      service.description || ""
    );

    setActive(
      service.is_active
    );
    setFeedback("");
    setEditorOpen(true);
  }

  function cancelEdit() {
    closeEditor();
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

    setServiceActionId(
      service.id
    );
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

      const { data, error } =
        await supabase
          .from("services")
          .update({
            is_active:
              nextActive,
          })
          .eq(
            "id",
            service.id
          )
          .eq(
            "business_id",
            businessId
          )
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
          .sort(
            (first, second) => {
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
            }
          )
      );

      if (
        editingId ===
          service.id &&
        !nextActive
      ) {
        resetEditor();
        setEditorOpen(false);
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
      setServiceActionId(
        null
      );
    }
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-page="services">
        <PageHeader
          eyebrow="Your service menu"
          title={<>Services</>}
          description={<>Manage the services customers can book with your business.</>}
        >
          {canManageServices && (
            <Button
              type="button"
              onClick={openNewService}
              disabled={saving || Boolean(serviceActionId)}
              className="shrink-0 gap-2"
            >
              <Plus className="size-4" />
              Add service
            </Button>
          )}
        </PageHeader>

        {businessRole ===
          "staff" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">
              Read-only services
            </p>

            <p className="mt-1 text-sm leading-6 text-amber-800">
              Staff members can view
              services, but an owner or
              manager must make changes.
            </p>
          </div>
        )}

        {feedback &&
          !editorOpen && (
            <div
              role="status"
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm"
            >
              {feedback}
            </div>
          )}

        <div className="record-summary">
          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Total services
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {services.length}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                <Scissors className="size-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Active services
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {activeCount}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <Check className="size-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-gray-500">
                  Inactive
                </p>

                <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                  {inactiveCount}
                </p>
              </div>

              <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
                <X className="size-5" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden border-gray-200 shadow-none">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-5 sm:px-5 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-950">
                  Service catalog
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Active services are
                  available for new
                  appointments.
                </p>
              </div>

              <span className="w-fit rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                {services.length}{" "}
                {services.length === 1
                  ? "service"
                  : "services"}
              </span>
            </div>

            {loading ? (
              <div className="px-6 py-12 text-center">
                <div className="mx-auto size-5 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

                <p className="mt-3 text-sm text-gray-500">
                  Loading services...
                </p>
              </div>
            ) : services.length ===
              0 ? (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <Scissors className="size-5" />
                </div>

                <p className="mt-4 font-semibold text-gray-950">
                  No services yet
                </p>

                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-gray-500">
                  {canManageServices
                    ? "Create your first service so appointments can be scheduled with the correct duration."
                    : "An owner or manager can add services for this business."}
                </p>

                {canManageServices && (
                  <Button
                    type="button"
                    onClick={
                      openNewService
                    }
                    className="mt-5 gap-2"
                  >
                    <Plus className="size-4" />
                    Add service
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="hidden md:block">
                  <div
                    className={`grid gap-4 border-b border-gray-200 bg-gray-50/70 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 ${
                      canManageServices
                        ? "service-row"
                        : "service-row-readonly"
                    }`}
                  >
                    <span>
                      Service
                    </span>

                    <span>
                      Duration
                    </span>

                    <span>
                      Price
                    </span>

                    <span>
                      Status
                    </span>

                    {canManageServices && (
                      <span className="text-right">
                        Actions
                      </span>
                    )}
                  </div>

                  {services.map(
                    (service) => {
                      const actionInProgress =
                        serviceActionId ===
                        service.id;

                      return (
                        <div
                          key={
                            service.id
                          }
                          className={`grid min-h-[78px] items-center gap-4 border-b border-gray-100 px-5 py-3 last:border-b-0 ${
                            canManageServices
                              ? "service-row"
                              : "service-row-readonly"
                          }`}
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <div
                              className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${
                                service.is_active
                                  ? "bg-green-50 text-green-700"
                                  : "bg-gray-100 text-gray-500"
                              }`}
                            >
                              <Scissors className="size-4" />
                            </div>

                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-gray-950">
                                {
                                  service.name
                                }
                              </p>

                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                                {service.description ||
                                  "No description"}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 text-sm text-gray-700">
                            <Clock3 className="size-4 shrink-0 text-gray-400" />

                            <span>
                              {formatDuration(
                                service.duration_minutes
                              )}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 text-sm text-gray-700">
                            <DollarSign className="size-4 shrink-0 text-gray-400" />

                            <span>
                              {service.price ==
                              null
                                ? "Not set"
                                : Number(
                                    service.price
                                  ).toFixed(
                                    2
                                  )}
                            </span>
                          </div>

                          <span
                            className={`w-fit rounded-full px-2.5 py-1 text-xs font-medium ${
                              service.is_active
                                ? "bg-green-50 text-green-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {service.is_active
                              ? "Active"
                              : "Inactive"}
                          </span>

                          {canManageServices && (
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                aria-label={`Edit ${service.name}`}
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
                                className="flex size-11 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                              >
                                <Pencil className="size-4" />
                              </button>

                              <button
                                type="button"
                                aria-label={`${
                                  service.is_active
                                    ? "Deactivate"
                                    : "Activate"
                                } ${service.name}`}
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
                                className={`flex size-11 items-center justify-center rounded-xl transition disabled:opacity-50 ${
                                  service.is_active
                                    ? "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                                    : "text-green-700 hover:bg-green-50"
                                }`}
                              >
                                {actionInProgress ? (
                                  <div className="size-4 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />
                                ) : service.is_active ? (
                                  <X className="size-4" />
                                ) : (
                                  <Check className="size-4" />
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>

                <div className="divide-y divide-gray-100 md:hidden">
                  {services.map(
                    (service) => {
                      const actionInProgress =
                        serviceActionId ===
                        service.id;

                      return (
                        <div
                          key={
                            service.id
                          }
                          className="p-4"
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                                service.is_active
                                  ? "bg-green-50 text-green-700"
                                  : "bg-gray-100 text-gray-500"
                              }`}
                            >
                              <Scissors className="size-4" />
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-gray-950">
                                  {
                                    service.name
                                  }
                                </h3>

                                <span
                                  className={`rounded-full px-2 py-1 text-[11px] font-medium ${
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

                              {service.description && (
                                <p className="mt-1 text-sm leading-6 text-gray-500">
                                  {
                                    service.description
                                  }
                                </p>
                              )}

                              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-600">
                                <span className="flex items-center gap-1.5">
                                  <Clock3 className="size-4 text-gray-400" />

                                  {formatDuration(
                                    service.duration_minutes
                                  )}
                                </span>

                                <span className="flex items-center gap-1.5">
                                  <DollarSign className="size-4 text-gray-400" />

                                  {service.price ==
                                  null
                                    ? "Not set"
                                    : Number(
                                        service.price
                                      ).toFixed(
                                        2
                                      )}
                                </span>
                              </div>
                            </div>
                          </div>

                          {canManageServices && (
                            <div className="mt-4 grid grid-cols-2 gap-2">
                              <Button
                                type="button"
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
                                className="gap-2"
                              >
                                <Pencil className="size-4" />
                                Edit
                              </Button>

                              <Button
                                type="button"
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
                      );
                    }
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {editorOpen &&
        canManageServices && (
          <DialogSurface
          aria-labelledby="service-editor-title"
          onClose={() => {
            if (!saving) closeEditor();
          }}
        >
              <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-5 sm:px-6">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
                    Service catalog
                  </p>

                  <h2
                    id="service-editor-title"
                    className="mt-1 text-xl font-semibold tracking-tight text-gray-950"
                  >
                    {editingId
                      ? "Edit service"
                      : "Add service"}
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    {editingId
                      ? "Update service details and availability."
                      : "Create a service customers can book."}
                  </p>
                </div>

                <button
                  type="button"
                  aria-label="Close service editor"
                  disabled={saving}
                  onClick={
                    closeEditor
                  }
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
                >
                  <X className="size-5" />
                </button>
              </div>

              <form
                id="service-editor"
                onSubmit={
                  handleSubmit
                }
              >
                <fieldset
                  disabled={saving}
                  className="space-y-5 p-5 sm:p-6"
                >
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-gray-800">
                      Service name
                    </span>

                    <Input
                      placeholder="Haircut"
                      value={name}
                      onChange={(
                        event
                      ) =>
                        setName(
                          event.target
                            .value
                        )
                      }
                      required
                      maxLength={200}
                      autoFocus
                    />
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-gray-800">
                        Duration
                      </span>

                      <div className="relative">
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
                          onChange={(
                            event
                          ) =>
                            setDurationMinutes(
                              event
                                .target
                                .value
                            )
                          }
                          required={
                            !editingId
                          }
                          className="pr-16"
                        />

                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                          min
                        </span>
                      </div>
                    </label>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-gray-800">
                        Price{" "}
                        <span className="font-normal text-gray-400">
                          Optional
                        </span>
                      </span>

                      <div className="relative">
                        <DollarSign className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="45.00"
                          value={price}
                          onChange={(
                            event
                          ) =>
                            setPrice(
                              event
                                .target
                                .value
                            )
                          }
                          className="pl-9"
                        />
                      </div>
                    </label>
                  </div>

                  {editingId && (
                    <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="text-sm leading-6 text-gray-600">
                        Duration cannot
                        be changed for
                        an existing
                        service because
                        appointments may
                        already depend
                        on it. Create a
                        new service with
                        the new duration,
                        then deactivate
                        this one.
                      </p>
                    </div>
                  )}

                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-gray-800">
                      Description{" "}
                      <span className="font-normal text-gray-400">
                        Optional
                      </span>
                    </span>

                    <Textarea
                      placeholder="Describe what is included in this service."
                      value={
                        description
                      }
                      maxLength={2000}
                      onChange={(
                        event
                      ) =>
                        setDescription(
                          event.target
                            .value
                        )
                      }
                      className="min-h-28"
                    />
                  </label>

                  <label className="flex min-h-14 cursor-pointer items-center justify-between gap-4 rounded-xl border border-gray-200 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        Active service
                      </p>

                      <p className="mt-0.5 text-xs leading-5 text-gray-500">
                        Active services
                        can be selected
                        for new
                        appointments.
                      </p>
                    </div>

                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(
                        event
                      ) =>
                        setActive(
                          event.target
                            .checked
                        )
                      }
                      className="size-5 shrink-0 accent-green-600"
                    />
                  </label>

                  {feedback && (
                    <p
                      role="status"
                      className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700"
                    >
                      {feedback}
                    </p>
                  )}
                </fieldset>

                <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-gray-200 bg-white px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={
                      editingId
                        ? cancelEdit
                        : closeEditor
                    }
                  >
                    Cancel
                  </Button>

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
                        : "Add service"}
                  </Button>
                </div>
              </form>
            </DialogSurface>

        )}
    </AppLayout>
  );
}
