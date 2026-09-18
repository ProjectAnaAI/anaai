"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BookOpen,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

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
import { supabase } from "@/lib/supabase";

type KnowledgeItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
  created_at: string;
};

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

  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [deletingId, setDeletingId] =
    useState<string | null>(null);

  const [businessId, setBusinessId] =
    useState<string | null>(null);

  const [userId, setUserId] =
    useState<string | null>(null);

  const [businessRole, setBusinessRole] =
    useState<BusinessRole | null>(null);

  const [category, setCategory] =
    useState("General");

  const [question, setQuestion] =
    useState("");

  const [answer, setAnswer] =
    useState("");

  const [editingId, setEditingId] =
    useState<string | null>(null);

  const canManageKnowledge =
    businessRole === "owner" ||
    businessRole === "manager";

  useEffect(() => {
    async function initializePage() {
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

        const activeBusinessId =
          businessPayload.business.id;

        setBusinessId(activeBusinessId);
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
      activeBusinessId ?? businessId;

    if (!targetBusinessId) {
      return;
    }

    const { data, error } = await supabase
      .from("business_knowledge")
      .select(
        "id, category, question, answer, created_at"
      )
      .eq("business_id", targetBusinessId)
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

  async function verifyWriteContext() {
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
      selectedBusinessId !== businessId
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
        const { data, error } =
          await supabase
            .from("business_knowledge")
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
        const { data, error } =
          await supabase
            .from("business_knowledge")
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

    document
      .getElementById(
        "knowledge-editor"
      )
      ?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
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

    const confirmed = window.confirm(
      "Delete this knowledge item? AnaAI will no longer have this answer available."
    );

    if (!confirmed) {
      return;
    }

    setDeletingId(id);

    try {
      await verifyWriteContext();

      const { error } = await supabase
        .from("business_knowledge")
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
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-gray-200 pb-6">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
                AI Training
              </p>

              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
                Business Knowledge
              </h1>

              <p className="mt-2 max-w-2xl text-gray-500">
                Store common questions,
                policies, and business
                information AnaAI can use
                when helping customers.
              </p>
            </div>

            <div className="hidden rounded-2xl bg-green-50 p-4 sm:block">
              <BookOpen className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </header>

        {businessRole === "staff" && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-900">
              Read-only knowledge library
            </p>

            <p className="mt-1 text-sm leading-6 text-amber-800">
              Staff members can view
              business knowledge, but an
              owner or manager must add,
              edit, or remove entries.
            </p>
          </div>
        )}

        <div
          className={`mt-8 grid gap-8 ${
            canManageKnowledge
              ? "lg:grid-cols-[1fr_1.4fr]"
              : ""
          }`}
        >
          {canManageKnowledge && (
            <Card
              id="knowledge-editor"
            >
              <CardHeader>
                <CardTitle>
                  {editingId
                    ? "Edit knowledge"
                    : "Add knowledge"}
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-5">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Category
                  </label>

                  <select
                    value={category}
                    disabled={saving}
                    onChange={(event) =>
                      setCategory(
                        event.target.value
                      )
                    }
                    className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
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
                    <label className="block text-sm font-medium text-gray-700">
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
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <label className="block text-sm font-medium text-gray-700">
                      AnaAI answer
                    </label>

                    <span className="text-xs text-gray-400">
                      {answer.length}/
                      {MAX_ANSWER_LENGTH}
                    </span>
                  </div>

                  <Textarea
                    className="min-h-36"
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

                <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <p className="text-sm font-medium text-blue-900">
                    Keep answers specific
                  </p>

                  <p className="mt-1 text-sm leading-6 text-blue-700">
                    Write the answer exactly
                    as you want your business
                    information represented.
                    Avoid conflicting versions
                    of the same policy.
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    onClick={() =>
                      void handleSave()
                    }
                    disabled={
                      saving ||
                      Boolean(deletingId)
                    }
                    className="gap-2 bg-green-600 text-white hover:bg-green-700"
                  >
                    {editingId ? (
                      <Save className="h-4 w-4" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}

                    {saving
                      ? "Saving..."
                      : editingId
                        ? "Save changes"
                        : "Add knowledge"}
                  </Button>

                  {editingId && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetForm}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  Knowledge library
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  {items.length}{" "}
                  {items.length === 1
                    ? "entry"
                    : "entries"}
                </p>
              </div>
            </div>

            {loading ? (
              <p className="text-gray-500">
                Loading knowledge...
              </p>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
                <BookOpen className="mx-auto h-8 w-8 text-gray-400" />

                <h3 className="mt-4 font-semibold text-gray-900">
                  No knowledge added yet
                </h3>

                <p className="mt-2 text-sm leading-6 text-gray-500">
                  {canManageKnowledge
                    ? "Add FAQs, policies, parking details, pricing guidance, or booking rules AnaAI should know."
                    : "An owner or manager can add business knowledge for AnaAI."}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {items.map((item) => {
                  const deleteInProgress =
                    deletingId === item.id;

                  return (
                    <Card key={item.id}>
                      <CardContent className="p-6">
                        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                              {
                                item.category
                              }
                            </span>

                            <h3 className="mt-4 text-lg font-semibold text-gray-900">
                              {
                                item.question
                              }
                            </h3>

                            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                              {
                                item.answer
                              }
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
                                aria-label="Edit knowledge"
                              >
                                <Pencil className="h-4 w-4" />
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
                                aria-label="Delete knowledge"
                                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              >
                                {deleteInProgress ? (
                                  <span className="text-xs">
                                    ...
                                  </span>
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}