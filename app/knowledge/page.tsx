"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  CircleHelp,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { activeBusinessHeaders } from "@/lib/active-business";
import { supabase } from "@/lib/supabase";

type KnowledgeItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
  created_at: string;
};

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

const categories = [
  "General",
  "Hours",
  "Services",
  "Pricing",
  "Policies",
  "Parking",
  "Booking",
  "Other",
];

const MAX_QUESTION_LENGTH = 500;
const MAX_ANSWER_LENGTH = 4000;

export default function KnowledgePage() {
  const router = useRouter();

  const [
    items,
    setItems,
  ] = useState<KnowledgeItem[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    deletingId,
    setDeletingId,
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
    category,
    setCategory,
  ] = useState("General");

  const [
    question,
    setQuestion,
  ] = useState("");

  const [
    answer,
    setAnswer,
  ] = useState("");

  const [
    editingId,
    setEditingId,
  ] = useState<string | null>(null);

  const [
    editorOpen,
    setEditorOpen,
  ] = useState(false);

  const [
    searchQuery,
    setSearchQuery,
  ] = useState("");

  const [
    categoryFilter,
    setCategoryFilter,
  ] = useState("All");

  const canManageKnowledge =
    businessRole === "owner" ||
    businessRole === "manager";

  const filteredItems = useMemo(() => {
    const normalizedSearch =
      searchQuery.trim().toLowerCase();

    return items.filter((item) => {
      const matchesCategory =
        categoryFilter === "All" ||
        item.category === categoryFilter;

      if (!matchesCategory) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      return (
        item.question
          .toLowerCase()
          .includes(normalizedSearch) ||
        item.answer
          .toLowerCase()
          .includes(normalizedSearch) ||
        item.category
          .toLowerCase()
          .includes(normalizedSearch)
      );
    });
  }, [
    items,
    searchQuery,
    categoryFilter,
  ]);

  const usedCategoryCount = useMemo(
    () =>
      new Set(
        items.map(
          (item) => item.category
        )
      ).size,
    [items]
  );

  useEffect(() => {
    async function initializePage() {
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

        setBusinessId(
          activeBusinessId
        );

        setBusinessRole(
          businessPayload.business.role
        );

        await loadKnowledge(
          activeBusinessId
        );
      } catch (error) {
        console.error(
          "Business knowledge initialization error:",
          error
        );

        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to load business knowledge."
        );
      } finally {
        setLoading(false);
      }
    }

    void initializePage();
  }, [router]);

  async function loadKnowledge(
    activeBusinessId?: string
  ) {
    const targetBusinessId =
      activeBusinessId ??
      businessId;

    if (!targetBusinessId) {
      return;
    }

    const { data, error } =
      await supabase
        .from(
          "business_knowledge"
        )
        .select(
          "id, category, question, answer, created_at"
        )
        .eq(
          "business_id",
          targetBusinessId
        )
        .order("created_at", {
          ascending: false,
        });

    if (error) {
      console.error(
        "Business knowledge load error:",
        error
      );

      toast.error(
        "Unable to load business knowledge."
      );

      return;
    }

    setItems(data || []);
  }

  function resetForm() {
    setCategory("General");
    setQuestion("");
    setAnswer("");
    setEditingId(null);
  }

  function openNewKnowledge() {
    if (
      !canManageKnowledge ||
      saving ||
      deletingId
    ) {
      return;
    }

    resetForm();
    setEditorOpen(true);
  }

  function closeEditor() {
    if (saving) {
      return;
    }

    resetForm();
    setEditorOpen(false);
  }

  async function verifyWriteContext() {
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

      throw new Error(
        "Please log in again."
      );
    }

    if (
      !userId ||
      session.user.id !== userId
    ) {
      throw new Error(
        "Your session changed. Please refresh and try again."
      );
    }

    if (!businessId) {
      throw new Error(
        "Business context is missing. Please refresh and try again."
      );
    }

    const selectedBusinessId =
      activeBusinessHeaders()[
        "x-anaai-business-id"
      ];

    if (
      selectedBusinessId &&
      selectedBusinessId !==
        businessId
    ) {
      throw new Error(
        "Business context changed. Please refresh and try again."
      );
    }

    return {
      session,
      businessId,
    };
  }

  async function handleSave() {
    if (!canManageKnowledge) {
      toast.error(
        "Your business role does not allow knowledge changes."
      );
      return;
    }

    const normalizedCategory =
      category.trim();

    const normalizedQuestion =
      question.trim();

    const normalizedAnswer =
      answer.trim();

    if (!businessId || !userId) {
      toast.error(
        "Business context is missing. Please refresh and try again."
      );
      return;
    }

    if (
      !categories.includes(
        normalizedCategory
      )
    ) {
      toast.warning(
        "Please select a valid category."
      );
      return;
    }

    if (!normalizedQuestion) {
      toast.warning(
        "Please enter a customer question."
      );
      return;
    }

    if (
      normalizedQuestion.length >
      MAX_QUESTION_LENGTH
    ) {
      toast.warning(
        `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`
      );
      return;
    }

    if (!normalizedAnswer) {
      toast.warning(
        "Please enter AnaAI's answer."
      );
      return;
    }

    if (
      normalizedAnswer.length >
      MAX_ANSWER_LENGTH
    ) {
      toast.warning(
        `Answer must be ${MAX_ANSWER_LENGTH} characters or fewer.`
      );
      return;
    }

    setSaving(true);

    try {
      await verifyWriteContext();

      if (editingId) {
        const {
          data,
          error,
        } = await supabase
          .from(
            "business_knowledge"
          )
          .update({
            category:
              normalizedCategory,
            question:
              normalizedQuestion,
            answer:
              normalizedAnswer,
            updated_at:
              new Date().toISOString(),
          })
          .eq("id", editingId)
          .eq(
            "business_id",
            businessId
          )
          .select(
            "id, category, question, answer, created_at"
          )
          .single();

        if (error || !data) {
          throw new Error(
            "Unable to update knowledge. Refresh and try again."
          );
        }

        setItems((current) =>
          current.map((item) =>
            item.id === data.id
              ? data
              : item
          )
        );

        toast.success(
          "Knowledge updated."
        );
      } else {
        const {
          data,
          error,
        } = await supabase
          .from(
            "business_knowledge"
          )
          .insert({
            business_id:
              businessId,

            /*
             * Retained for compatibility
             * with the current schema.
             * Tenant authorization is
             * business/member based.
             */
            user_id: userId,

            category:
              normalizedCategory,
            question:
              normalizedQuestion,
            answer:
              normalizedAnswer,
          })
          .select(
            "id, category, question, answer, created_at"
          )
          .single();

        if (error || !data) {
          throw new Error(
            "Unable to add knowledge. Refresh and try again."
          );
        }

        setItems((current) => [
          data,
          ...current,
        ]);

        toast.success(
          "Knowledge added."
        );
      }

      resetForm();
      setEditorOpen(false);
    } catch (error) {
      console.error(
        "Business knowledge save error:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to save business knowledge."
      );
    } finally {
      setSaving(false);
    }
  }

  function handleEdit(
    item: KnowledgeItem
  ) {
    if (
      !canManageKnowledge ||
      saving ||
      deletingId
    ) {
      return;
    }

    setEditingId(item.id);
    setCategory(item.category);
    setQuestion(item.question);
    setAnswer(item.answer);
    setEditorOpen(true);
  }

  async function handleDelete(
    id: string
  ) {
    if (!canManageKnowledge) {
      toast.error(
        "Your business role does not allow knowledge changes."
      );
      return;
    }

    if (!businessId) {
      toast.error(
        "Business context is missing. Please refresh and try again."
      );
      return;
    }

    if (
      saving ||
      deletingId
    ) {
      return;
    }

    const confirmed =
      window.confirm(
        "Delete this knowledge item? AnaAI will no longer have this answer available."
      );

    if (!confirmed) {
      return;
    }

    setDeletingId(id);

    try {
      await verifyWriteContext();

      const { error } =
        await supabase
          .from(
            "business_knowledge"
          )
          .delete()
          .eq("id", id)
          .eq(
            "business_id",
            businessId
          );

      if (error) {
        throw new Error(
          "Unable to delete knowledge."
        );
      }

      setItems((current) =>
        current.filter(
          (item) =>
            item.id !== id
        )
      );

      if (editingId === id) {
        resetForm();
        setEditorOpen(false);
      }

      toast.success(
        "Knowledge deleted."
      );
    } catch (error) {
      console.error(
        "Business knowledge delete error:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to delete business knowledge."
      );
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-5 border-b border-gray-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
              AI training
            </p>

            <h1 className="anaai-page-title mt-2">
              Business Knowledge
            </h1>

            <p className="anaai-page-description mt-2 max-w-2xl">
              Manage the questions,
              policies, and business
              information AnaAI can use
              when helping customers.
            </p>
          </div>

          {canManageKnowledge && (
            <Button
              type="button"
              onClick={
                openNewKnowledge
              }
              disabled={
                saving ||
                Boolean(deletingId)
              }
              className="shrink-0 gap-2"
            >
              <Plus className="size-4" />
              Add knowledge
            </Button>
          )}
        </header>

        {businessRole ===
          "staff" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">
              Read-only knowledge
              library
            </p>

            <p className="mt-1 text-sm leading-6 text-amber-800">
              Staff members can view
              business knowledge, but
              an owner or manager must
              add, edit, or remove
              entries.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Knowledge entries
              </p>

              <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                {items.length}
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-green-50 text-green-700">
              <BookOpen className="size-5" />
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Categories used
              </p>

              <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                {usedCategoryCount}
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <CircleHelp className="size-5" />
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Access
              </p>

              <p className="mt-1 text-base font-semibold text-gray-950">
                {canManageKnowledge
                  ? "Manage"
                  : "View only"}
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <BookOpen className="size-5" />
            </div>
          </div>
        </div>

        <section className="anaai-surface overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-5 sm:px-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-950">
                  Knowledge library
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  Review the information
                  available to AnaAI.
                </p>
              </div>

              <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                <div className="relative min-w-0 sm:min-w-[260px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />

                  <Input
                    value={searchQuery}
                    onChange={(event) =>
                      setSearchQuery(
                        event.target.value
                      )
                    }
                    placeholder="Search knowledge"
                    aria-label="Search knowledge"
                    className="pl-9"
                  />
                </div>

                <select
                  value={
                    categoryFilter
                  }
                  onChange={(event) =>
                    setCategoryFilter(
                      event.target.value
                    )
                  }
                  aria-label="Filter knowledge by category"
                  className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-800 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
                >
                  <option value="All">
                    All categories
                  </option>

                  {categories.map(
                    (item) => (
                      <option
                        key={item}
                        value={item}
                      >
                        {item}
                      </option>
                    )
                  )}
                </select>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="px-6 py-14 text-center">
              <div className="mx-auto size-5 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

              <p className="mt-3 text-sm text-gray-500">
                Loading knowledge...
              </p>
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-green-50 text-green-700">
                <BookOpen className="size-5" />
              </div>

              <h3 className="mt-4 font-semibold text-gray-950">
                No knowledge added yet
              </h3>

              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-500">
                {canManageKnowledge
                  ? "Add FAQs, policies, parking details, pricing guidance, or booking rules AnaAI should know."
                  : "An owner or manager can add business knowledge for AnaAI."}
              </p>

              {canManageKnowledge && (
                <Button
                  type="button"
                  onClick={
                    openNewKnowledge
                  }
                  className="mt-5 gap-2"
                >
                  <Plus className="size-4" />
                  Add knowledge
                </Button>
              )}
            </div>
          ) : filteredItems.length ===
            0 ? (
            <div className="px-6 py-14 text-center">
              <Search className="mx-auto size-7 text-gray-400" />

              <h3 className="mt-3 font-semibold text-gray-950">
                No matching entries
              </h3>

              <p className="mt-1 text-sm text-gray-500">
                Try another search or
                category.
              </p>

              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setSearchQuery("");
                  setCategoryFilter(
                    "All"
                  );
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredItems.map(
                (item) => {
                  const deleteInProgress =
                    deletingId ===
                    item.id;

                  return (
                    <article
                      key={item.id}
                      className="px-4 py-5 sm:px-5"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-green-700">
                              {
                                item.category
                              }
                            </span>
                          </div>

                          <h3 className="mt-3 text-sm font-semibold leading-6 text-gray-950 sm:text-base">
                            {
                              item.question
                            }
                          </h3>

                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                            {item.answer}
                          </p>
                        </div>

                        {canManageKnowledge && (
                          <div className="flex shrink-0 gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              disabled={
                                saving ||
                                Boolean(
                                  deletingId
                                )
                              }
                              onClick={() =>
                                handleEdit(
                                  item
                                )
                              }
                              aria-label={`Edit ${item.question}`}
                            >
                              <Pencil className="size-4" />
                            </Button>

                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              disabled={
                                saving ||
                                Boolean(
                                  deletingId
                                )
                              }
                              onClick={() =>
                                void handleDelete(
                                  item.id
                                )
                              }
                              aria-label={`Delete ${item.question}`}
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                            >
                              {deleteInProgress ? (
                                <span className="size-4 animate-spin rounded-full border-2 border-red-100 border-t-red-600" />
                              ) : (
                                <Trash2 className="size-4" />
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                }
              )}
            </div>
          )}
        </section>
      </div>

      {editorOpen &&
        canManageKnowledge && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/25 p-0 backdrop-blur-[1px] sm:items-center sm:p-6"
            role="presentation"
            onMouseDown={(
              event
            ) => {
              if (
                event.target ===
                  event.currentTarget &&
                !saving
              ) {
                closeEditor();
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="knowledge-editor-title"
              className="max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-gray-200 bg-white shadow-2xl sm:max-w-2xl sm:rounded-2xl"
            >
              <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-5 sm:px-6">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-green-600">
                    AI training
                  </p>

                  <h2
                    id="knowledge-editor-title"
                    className="mt-1 text-xl font-semibold tracking-tight text-gray-950"
                  >
                    {editingId
                      ? "Edit knowledge"
                      : "Add knowledge"}
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Store a clear
                    customer question
                    and the business
                    information AnaAI
                    should use to answer
                    it.
                  </p>
                </div>

                <button
                  type="button"
                  aria-label="Close knowledge editor"
                  disabled={saving}
                  onClick={
                    closeEditor
                  }
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
                >
                  <X className="size-5" />
                </button>
              </div>

              <div className="space-y-5 p-5 sm:p-6">
                <div>
                  <label
                    htmlFor="knowledge-category"
                    className="mb-2 block text-sm font-medium text-gray-800"
                  >
                    Category
                  </label>

                  <select
                    id="knowledge-category"
                    value={category}
                    disabled={saving}
                    onChange={(event) =>
                      setCategory(
                        event.target.value
                      )
                    }
                    className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-4 text-sm text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  >
                    {categories.map(
                      (item) => (
                        <option
                          key={item}
                          value={item}
                        >
                          {item}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <label
                      htmlFor="knowledge-question"
                      className="text-sm font-medium text-gray-800"
                    >
                      Customer question
                    </label>

                    <span className="text-xs text-gray-400">
                      {question.length}/
                      {
                        MAX_QUESTION_LENGTH
                      }
                    </span>
                  </div>

                  <Input
                    id="knowledge-question"
                    placeholder="Example: What is your cancellation policy?"
                    value={question}
                    disabled={saving}
                    maxLength={
                      MAX_QUESTION_LENGTH
                    }
                    onChange={(event) =>
                      setQuestion(
                        event.target.value
                      )
                    }
                    autoFocus
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <label
                      htmlFor="knowledge-answer"
                      className="text-sm font-medium text-gray-800"
                    >
                      AnaAI answer
                    </label>

                    <span className="text-xs text-gray-400">
                      {answer.length}/
                      {MAX_ANSWER_LENGTH}
                    </span>
                  </div>

                  <Textarea
                    id="knowledge-answer"
                    className="min-h-40"
                    placeholder="Example: Please give us at least 24 hours notice to cancel or reschedule your appointment."
                    value={answer}
                    disabled={saving}
                    maxLength={
                      MAX_ANSWER_LENGTH
                    }
                    onChange={(event) =>
                      setAnswer(
                        event.target.value
                      )
                    }
                  />
                </div>

                <div className="rounded-xl border border-green-100 bg-green-50/70 px-4 py-3">
                  <p className="text-sm font-semibold text-green-900">
                    Keep the answer
                    specific
                  </p>

                  <p className="mt-1 text-sm leading-6 text-green-800">
                    Write the business
                    information exactly
                    as it should be
                    represented. Avoid
                    conflicting versions
                    of the same policy.
                  </p>
                </div>
              </div>

              <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-gray-200 bg-white px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={
                    closeEditor
                  }
                  disabled={saving}
                >
                  Cancel
                </Button>

                <Button
                  type="button"
                  onClick={() =>
                    void handleSave()
                  }
                  disabled={
                    saving ||
                    Boolean(deletingId)
                  }
                  className="gap-2"
                >
                  {saving ? (
                    <>
                      <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Saving...
                    </>
                  ) : editingId ? (
                    <>
                      <Pencil className="size-4" />
                      Save changes
                    </>
                  ) : (
                    <>
                      <Plus className="size-4" />
                      Add knowledge
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
    </AppLayout>
  );
}