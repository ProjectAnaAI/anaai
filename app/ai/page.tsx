"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  Bot,
  MessageCircle,
  Save,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import AppLayout from "@/components/layout/AppLayout";
import { activeBusinessHeaders } from "@/lib/active-business";
import { supabase } from "@/lib/supabase";

type BusinessRole =
  | "owner"
  | "manager"
  | "staff";

type KnowledgeItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
};

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

const DEFAULT_RECEPTIONIST_NAME = "Ana";

const DEFAULT_GREETING =
  "Thanks for calling! How can I help you today?";

const DEFAULT_TONE =
  "Friendly and professional";

const toneOptions = [
  "Friendly and professional",
  "Warm and conversational",
  "Professional and concise",
];

const MAX_NAME_LENGTH = 100;
const MAX_GREETING_LENGTH = 1000;
const MAX_INSTRUCTIONS_LENGTH = 4000;
const MAX_TRANSFER_INSTRUCTIONS_LENGTH = 4000;
const MAX_PREVIEW_MESSAGE_LENGTH = 2000;

export default function AIReceptionistPage() {
  const router = useRouter();

  const [settingsId, setSettingsId] =
    useState<string | null>(null);

  const [businessId, setBusinessId] =
    useState<string | null>(null);

  const [userId, setUserId] =
    useState<string | null>(null);

  const [businessRole, setBusinessRole] =
    useState<BusinessRole | null>(null);

  const [receptionistName, setReceptionistName] =
    useState(DEFAULT_RECEPTIONIST_NAME);

  const [greeting, setGreeting] =
    useState(DEFAULT_GREETING);

  const [tone, setTone] =
    useState(DEFAULT_TONE);

  const [instructions, setInstructions] =
    useState("");

  const [
    transferInstructions,
    setTransferInstructions,
  ] = useState("");

  const [
    knowledgeItems,
    setKnowledgeItems,
  ] = useState<KnowledgeItem[]>([]);

  const [knowledgeCount, setKnowledgeCount] =
    useState(0);

  const [testMessage, setTestMessage] =
    useState("");

  const [aiReply, setAiReply] =
    useState("");

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [asking, setAsking] =
    useState(false);

  const canManageSettings =
    businessRole === "owner" ||
    businessRole === "manager";

  useEffect(() => {
    async function loadPage() {
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

        setUserId(session.user.id);

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

        const context =
          (await response.json()) as CurrentBusinessResponse;

        if (
          !response.ok ||
          !context.success
        ) {
          throw new Error(
            context.success === false
              ? context.error
              : "Unable to resolve your business."
          );
        }

        const activeBusinessId =
          context.business.id;

        setBusinessId(activeBusinessId);
        setBusinessRole(
          context.business.role
        );

        const [
          settingsResult,
          knowledgeResult,
        ] = await Promise.all([
          supabase
            .from("ai_settings")
            .select(
              "id, receptionist_name, greeting, tone, custom_instructions, transfer_instructions"
            )
            .eq(
              "business_id",
              activeBusinessId
            )
            .maybeSingle(),

          supabase
            .from("business_knowledge")
            .select(
              "id, category, question, answer"
            )
            .eq(
              "business_id",
              activeBusinessId
            )
            .order("created_at", {
              ascending: false,
            }),
        ]);

        if (settingsResult.error) {
          throw new Error(
            settingsResult.error.message
          );
        }

        if (knowledgeResult.error) {
          throw new Error(
            knowledgeResult.error.message
          );
        }

        const settings =
          settingsResult.data;

        if (settings) {
          setSettingsId(settings.id);

          setReceptionistName(
            settings.receptionist_name ||
              DEFAULT_RECEPTIONIST_NAME
          );

          setGreeting(
            settings.greeting ||
              DEFAULT_GREETING
          );

          setTone(
            settings.tone ||
              DEFAULT_TONE
          );

          setInstructions(
            settings.custom_instructions ||
              ""
          );

          setTransferInstructions(
            settings.transfer_instructions ||
              ""
          );
        }

        const items =
          knowledgeResult.data ?? [];

        setKnowledgeItems(items);
        setKnowledgeCount(items.length);
      } catch (error) {
        setBusinessId(null);

        console.error(
          "AI settings load error:",
          error
        );

        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to load AI settings."
        );
      } finally {
        setLoading(false);
      }
    }

    void loadPage();
  }, [router]);

  async function getValidAccessToken() {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (
      !error &&
      session?.access_token
    ) {
      return session.access_token;
    }

    const {
      data: refreshedData,
      error: refreshError,
    } =
      await supabase.auth.refreshSession();

    if (refreshError) {
      return null;
    }

    return (
      refreshedData.session
        ?.access_token ?? null
    );
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
        "Business context is unavailable. Please refresh and try again."
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

    return session;
  }

  async function handleAskAI() {
    if (
      loading ||
      !businessId
    ) {
      toast.error(
        "Business context is unavailable. Please reload the page."
      );
      return;
    }

    const message =
      testMessage.trim();

    if (!message) {
      toast.warning(
        "Enter a customer question first."
      );
      return;
    }

    if (
      message.length >
      MAX_PREVIEW_MESSAGE_LENGTH
    ) {
      toast.warning(
        `Preview questions must be ${MAX_PREVIEW_MESSAGE_LENGTH} characters or fewer.`
      );
      return;
    }

    setAsking(true);
    setAiReply("");

    try {
      const accessToken =
        await getValidAccessToken();

      if (!accessToken) {
        toast.error(
          "Your login session has expired. Please log in again."
        );

        router.push("/login");
        return;
      }

      const response = await fetch(
        "/api/ai",
        {
          method: "POST",
          headers: {
            ...activeBusinessHeaders(),
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${accessToken}`,
            "x-anaai-business-id":
              businessId,
          },
          body: JSON.stringify({
            message,
            mode: "preview",
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          toast.error(
            data.error ||
              "Your login session could not be verified."
          );

          return;
        }

        throw new Error(
          data.error ||
            "Unable to generate an AI response."
        );
      }

      setAiReply(
        data.reply ||
          "AnaAI did not return a response."
      );
    } catch (error) {
      console.error(
        "AI preview error:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to generate an AI response."
      );
    } finally {
      setAsking(false);
    }
  }

  async function handleSave() {
    if (!canManageSettings) {
      toast.error(
        "Your business role does not allow AI settings changes."
      );
      return;
    }

    if (
      loading ||
      !businessId ||
      !userId
    ) {
      toast.error(
        "Business context is unavailable. Please reload the page."
      );
      return;
    }

    const normalizedName =
      receptionistName.trim();

    const normalizedGreeting =
      greeting.trim();

    const normalizedTone =
      tone.trim();

    const normalizedInstructions =
      instructions.trim();

    const normalizedTransferInstructions =
      transferInstructions.trim();

    if (!normalizedName) {
      toast.warning(
        "Receptionist name is required."
      );
      return;
    }

    if (
      normalizedName.length >
      MAX_NAME_LENGTH
    ) {
      toast.warning(
        `Receptionist name must be ${MAX_NAME_LENGTH} characters or fewer.`
      );
      return;
    }

    if (!normalizedGreeting) {
      toast.warning(
        "Call greeting is required."
      );
      return;
    }

    if (
      normalizedGreeting.length >
      MAX_GREETING_LENGTH
    ) {
      toast.warning(
        `Greeting must be ${MAX_GREETING_LENGTH} characters or fewer.`
      );
      return;
    }

    if (
      !toneOptions.includes(
        normalizedTone
      )
    ) {
      toast.warning(
        "Select a valid receptionist tone."
      );
      return;
    }

    if (
      normalizedInstructions.length >
      MAX_INSTRUCTIONS_LENGTH
    ) {
      toast.warning(
        `Custom instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`
      );
      return;
    }

    if (
      normalizedTransferInstructions.length >
      MAX_TRANSFER_INSTRUCTIONS_LENGTH
    ) {
      toast.warning(
        `Transfer instructions must be ${MAX_TRANSFER_INSTRUCTIONS_LENGTH} characters or fewer.`
      );
      return;
    }

    setSaving(true);

    try {
      const session =
        await verifyWriteContext();

      const settings = {
        receptionist_name:
          normalizedName,
        greeting:
          normalizedGreeting,
        tone:
          normalizedTone,
        custom_instructions:
          normalizedInstructions ||
          null,
        transfer_instructions:
          normalizedTransferInstructions ||
          null,
        updated_at:
          new Date().toISOString(),
      };

      if (settingsId) {
        const { data, error } =
          await supabase
            .from("ai_settings")
            .update(settings)
            .eq("id", settingsId)
            .eq(
              "business_id",
              businessId
            )
            .select("id")
            .single();

        if (error || !data) {
          throw new Error(
            "Unable to update AI settings."
          );
        }
      } else {
        const { data, error } =
          await supabase
            .from("ai_settings")
            .insert({
              ...settings,
              business_id:
                businessId,

              /*
               * Retained for compatibility
               * with the current schema.
               */
              user_id:
                session.user.id,
            })
            .select("id")
            .single();

        if (error || !data) {
          throw new Error(
            "Unable to create AI settings."
          );
        }

        setSettingsId(data.id);
      }

      setReceptionistName(
        normalizedName
      );

      setGreeting(
        normalizedGreeting
      );

      setTone(normalizedTone);

      setInstructions(
        normalizedInstructions
      );

      setTransferInstructions(
        normalizedTransferInstructions
      );

      toast.success(
        "AI receptionist settings saved."
      );
    } catch (error) {
      console.error(
        "AI settings save error:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to save AI settings."
      );
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!asking) {
        void handleAskAI();
      }
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-gray-50 px-6 py-8 md:px-8 md:py-10">
          <div className="mx-auto max-w-6xl">
            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <p className="text-gray-500">
                Loading AI receptionist...
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
                  AI Receptionist
                </h1>

                <p className="mt-3 max-w-2xl text-base leading-7 text-gray-500">
                  Configure how AnaAI
                  communicates with customers
                  and test responses using your
                  saved business information.
                </p>
              </div>

              <div className="hidden rounded-2xl bg-green-50 p-4 md:block">
                <Bot className="h-7 w-7 text-green-600" />
              </div>
            </div>
          </div>

          {businessRole === "staff" && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">
                Read-only AI settings
              </p>

              <p className="mt-1 text-sm leading-6 text-amber-800">
                Staff members can view the
                receptionist configuration and
                test the preview, but an owner or
                manager must change AI settings.
              </p>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="space-y-6">
              <section className="rounded-2xl border border-green-200 bg-white p-7 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-green-50 p-2.5">
                    <MessageCircle className="h-5 w-5 text-green-600" />
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold text-gray-950">
                      Test AnaAI
                    </h2>

                    <p className="mt-1 text-sm leading-6 text-gray-500">
                      Ask a question as if you
                      were a customer contacting
                      your business.
                    </p>
                  </div>
                </div>

                <div className="mt-6">
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <label className="block text-sm font-medium text-gray-700">
                      Customer question
                    </label>

                    <span className="text-xs text-gray-400">
                      {
                        testMessage.length
                      }
                      /
                      {
                        MAX_PREVIEW_MESSAGE_LENGTH
                      }
                    </span>
                  </div>

                  <textarea
                    aria-description="Preview only: does not book appointments or send SMS."
                    value={testMessage}
                    onChange={(event) =>
                      setTestMessage(
                        event.target.value
                      )
                    }
                    onKeyDown={
                      handleKeyDown
                    }
                    rows={4}
                    maxLength={
                      MAX_PREVIEW_MESSAGE_LENGTH
                    }
                    disabled={asking}
                    placeholder="Example: What time do you close on Saturday?"
                    className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />

                  <p className="mt-2 text-xs text-gray-500">
                    Preview only: no
                    appointments are created or
                    changed, and no SMS is sent.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-gray-400">
                      Enter sends. Shift +
                      Enter adds a new line.
                    </p>

                    <button
                      type="button"
                      onClick={() =>
                        void handleAskAI()
                      }
                      disabled={
                        !businessId ||
                        asking ||
                        !testMessage.trim()
                      }
                      className="flex items-center gap-2 rounded-xl bg-green-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />

                      {asking
                        ? "AnaAI is thinking..."
                        : "Ask AnaAI"}
                    </button>
                  </div>
                </div>

                {asking && (
                  <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5">
                    <div className="flex items-center gap-3">
                      <div className="rounded-xl bg-green-100 p-2">
                        <Bot className="h-4 w-4 text-green-700" />
                      </div>

                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {
                            receptionistName
                          }
                        </p>

                        <p className="mt-1 text-sm text-gray-500">
                          Thinking...
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!asking &&
                  aiReply && (
                    <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5">
                      <div className="flex items-center gap-3">
                        <div className="rounded-xl bg-green-100 p-2">
                          <Bot className="h-4 w-4 text-green-700" />
                        </div>

                        <p className="text-sm font-semibold text-gray-900">
                          {
                            receptionistName
                          }
                        </p>
                      </div>

                      <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-gray-700">
                        {aiReply}
                      </p>
                    </div>
                  )}
              </section>

              <fieldset
                disabled={
                  !canManageSettings ||
                  saving
                }
                className="space-y-6 disabled:opacity-75"
              >
                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Voice & Personality
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Set the identity and
                    communication style of your
                    AI receptionist.
                  </p>

                  <div className="mt-6 space-y-6">
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-4">
                        <label className="block text-sm font-medium text-gray-700">
                          Receptionist Name
                        </label>

                        <span className="text-xs text-gray-400">
                          {
                            receptionistName.length
                          }
                          /
                          {
                            MAX_NAME_LENGTH
                          }
                        </span>
                      </div>

                      <input
                        value={
                          receptionistName
                        }
                        maxLength={
                          MAX_NAME_LENGTH
                        }
                        onChange={(event) =>
                          setReceptionistName(
                            event.target.value
                          )
                        }
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Tone
                      </label>

                      <select
                        value={tone}
                        onChange={(event) =>
                          setTone(
                            event.target.value
                          )
                        }
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                      >
                        {toneOptions.map(
                          (option) => (
                            <option
                              key={option}
                              value={option}
                            >
                              {option}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Call Greeting
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    The opening message AnaAI
                    should use when greeting a
                    customer.
                  </p>

                  <div className="mt-6">
                    <div className="mb-2 flex justify-end">
                      <span className="text-xs text-gray-400">
                        {greeting.length}/
                        {
                          MAX_GREETING_LENGTH
                        }
                      </span>
                    </div>

                    <textarea
                      value={greeting}
                      maxLength={
                        MAX_GREETING_LENGTH
                      }
                      onChange={(event) =>
                        setGreeting(
                          event.target.value
                        )
                      }
                      rows={4}
                      className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                    />
                  </div>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Custom Instructions
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Add business-specific rules
                    about how AnaAI should
                    respond or handle
                    conversations.
                  </p>

                  <div className="mt-6">
                    <div className="mb-2 flex justify-end">
                      <span className="text-xs text-gray-400">
                        {
                          instructions.length
                        }
                        /
                        {
                          MAX_INSTRUCTIONS_LENGTH
                        }
                      </span>
                    </div>

                    <textarea
                      value={instructions}
                      maxLength={
                        MAX_INSTRUCTIONS_LENGTH
                      }
                      onChange={(event) =>
                        setInstructions(
                          event.target.value
                        )
                      }
                      rows={6}
                      placeholder="Example: Never promise a discount unless it appears in Business Knowledge."
                      className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                    />
                  </div>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Human Transfer
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Describe when AnaAI should
                    stop handling the request
                    and involve a team member.
                  </p>

                  <div className="mt-6">
                    <div className="mb-2 flex justify-end">
                      <span className="text-xs text-gray-400">
                        {
                          transferInstructions.length
                        }
                        /
                        {
                          MAX_TRANSFER_INSTRUCTIONS_LENGTH
                        }
                      </span>
                    </div>

                    <textarea
                      value={
                        transferInstructions
                      }
                      maxLength={
                        MAX_TRANSFER_INSTRUCTIONS_LENGTH
                      }
                      onChange={(event) =>
                        setTransferInstructions(
                          event.target.value
                        )
                      }
                      rows={5}
                      placeholder="Example: Transfer when a customer explicitly asks for a team member or has a complaint that AnaAI cannot resolve."
                      className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                    />
                  </div>
                </section>
              </fieldset>

              {canManageSettings && (
                <button
                  type="button"
                  onClick={() =>
                    void handleSave()
                  }
                  disabled={
                    saving ||
                    !businessId
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-3.5 font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-5 w-5" />

                  {saving
                    ? "Saving..."
                    : "Save AI Settings"}
                </button>
              )}
            </div>

            <div className="space-y-6">
              <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-gray-950">
                    Configuration
                  </h2>

                  <div className="rounded-xl bg-green-50 p-2">
                    <Bot className="h-5 w-5 text-green-600" />
                  </div>
                </div>

                <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-green-50 px-3 py-1.5 text-sm font-medium text-green-700">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  Preview ready
                </div>

                <p className="mt-3 text-sm leading-6 text-gray-500">
                  Your authenticated business
                  context is loaded and available
                  for the AI preview.
                </p>
              </section>

              <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-gray-950">
                      Business Knowledge
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      {knowledgeCount}{" "}
                      {knowledgeCount === 1
                        ? "entry"
                        : "entries"}
                    </p>
                  </div>

                  <div className="rounded-xl bg-green-50 p-2">
                    <BookOpen className="h-5 w-5 text-green-600" />
                  </div>
                </div>

                {knowledgeItems.length ===
                0 ? (
                  <div className="mt-5 rounded-xl border border-dashed border-gray-200 p-4">
                    <p className="text-sm text-gray-500">
                      No business knowledge has
                      been added yet.
                    </p>
                  </div>
                ) : (
                  <div className="mt-5 space-y-3">
                    {knowledgeItems
                      .slice(0, 3)
                      .map((item) => (
                        <div
                          key={item.id}
                          className="rounded-xl border border-gray-100 bg-gray-50 p-3"
                        >
                          <span className="text-xs font-semibold uppercase tracking-wide text-green-600">
                            {
                              item.category
                            }
                          </span>

                          <p className="mt-1 text-sm font-medium text-gray-800">
                            {
                              item.question
                            }
                          </p>
                        </div>
                      ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      "/knowledge"
                    )
                  }
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-green-50 hover:text-green-700"
                >
                  {canManageSettings
                    ? "Manage Business Knowledge"
                    : "View Business Knowledge"}

                  <ArrowRight className="h-4 w-4" />
                </button>
              </section>

              <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-green-50 p-2">
                    <Sparkles className="h-5 w-5 text-green-600" />
                  </div>

                  <h2 className="font-semibold text-gray-950">
                    Secure Context
                  </h2>
                </div>

                <p className="mt-4 text-sm leading-6 text-gray-500">
                  AnaAI resolves the current
                  business from your authenticated
                  membership before loading
                  settings, knowledge, or preview
                  context.
                </p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}