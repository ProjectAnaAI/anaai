"use client";

import {
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  MessageCircle,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ui/page-header";
import AppLayout from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
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

const DEFAULT_RECEPTIONIST_NAME =
  "Ana";

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
const MAX_TRANSFER_INSTRUCTIONS_LENGTH =
  4000;
const MAX_PREVIEW_MESSAGE_LENGTH =
  2000;

export default function AIReceptionistPage() {
  const router = useRouter();

  const [
    settingsId,
    setSettingsId,
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
    receptionistName,
    setReceptionistName,
  ] = useState(
    DEFAULT_RECEPTIONIST_NAME
  );

  const [
    greeting,
    setGreeting,
  ] = useState(DEFAULT_GREETING);

  const [
    tone,
    setTone,
  ] = useState(DEFAULT_TONE);

  const [
    instructions,
    setInstructions,
  ] = useState("");

  const [
    transferInstructions,
    setTransferInstructions,
  ] = useState("");

  const [
    knowledgeItems,
    setKnowledgeItems,
  ] = useState<KnowledgeItem[]>(
    []
  );

  const [
    knowledgeCount,
    setKnowledgeCount,
  ] = useState(0);

  const [
    testMessage,
    setTestMessage,
  ] = useState("");

  const [
    aiReply,
    setAiReply,
  ] = useState("");

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    asking,
    setAsking,
  ] = useState(false);

  const canManageSettings =
    businessRole === "owner" ||
    businessRole === "manager";

  const configurationReady =
    receptionistName.trim().length >
      0 &&
    greeting.trim().length > 0;

  useEffect(() => {
    async function loadPage() {
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

        setUserId(session.user.id);

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

        const context =
          (await response.json()) as CurrentBusinessResponse;

        if (
          !response.ok ||
          !context.success
        ) {
          throw new Error(
            context.success ===
              false
              ? context.error
              : "Unable to resolve your business."
          );
        }

        const activeBusinessId =
          context.business.id;

        setBusinessId(
          activeBusinessId
        );

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
            .from(
              "business_knowledge"
            )
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

        if (
          settingsResult.error
        ) {
          throw new Error(
            settingsResult.error.message
          );
        }

        if (
          knowledgeResult.error
        ) {
          throw new Error(
            knowledgeResult.error.message
          );
        }

        const settings =
          settingsResult.data;

        if (settings) {
          setSettingsId(
            settings.id
          );

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
          knowledgeResult.data ??
          [];

        setKnowledgeItems(items);
        setKnowledgeCount(
          items.length
        );
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
    } =
      await supabase.auth.getSession();

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
        "Business context is unavailable. Please refresh and try again."
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
        if (
          response.status === 401
        ) {
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
        `Business rules must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`
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
        tone: normalizedTone,
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
        const {
          data,
          error,
        } = await supabase
          .from("ai_settings")
          .update(settings)
          .eq(
            "id",
            settingsId
          )
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
        const {
          data,
          error,
        } = await supabase
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
    event:
      React.KeyboardEvent<HTMLTextAreaElement>
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
        <div className="anaai-surface p-8">
          <div className="flex items-center gap-3">
            <div className="size-5 animate-spin rounded-full border-2 border-gray-200 border-t-green-600" />

            <p className="text-sm text-gray-500">
              Loading AI
              receptionist...
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6" data-page="ai">
        <PageHeader
          eyebrow="AnaAI / Receptionist"
          title={<>Receptionist</>}
          description={
            <>
              A welcome in your words. Configure your receptionist and preview answers to
              customer questions.
            </>
          }
        >
          {canManageSettings && (
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !businessId}
              className="shrink-0 gap-2"
            >
              <Save className="size-4" />

              {saving ? "Saving..." : "Save settings"}
            </Button>
          )}
        </PageHeader>

        {businessRole ===
          "staff" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">
              Read-only AI settings
            </p>

            <p className="mt-1 text-sm leading-6 text-amber-800">
              Staff members can view
              the configuration and
              use the preview, but an
              owner or manager must
              change AI settings.
            </p>
          </div>
        )}

        <div className="record-summary">
          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Configuration
              </p>

              <p className="mt-1 text-base font-semibold text-gray-950">
                {configurationReady
                  ? "Configured"
                  : "Needs setup"}
              </p>
            </div>

            <div
              className={`flex size-10 items-center justify-center rounded-xl ${
                configurationReady
                  ? "bg-green-50 text-green-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {configurationReady ? (
                <CheckCircle2 className="size-5" />
              ) : (
                <UserRoundCog className="size-5" />
              )}
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-medium text-gray-500">
                Knowledge entries
              </p>

              <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                {knowledgeCount}
              </p>
            </div>

            <div className="flex size-10 items-center justify-center rounded-xl bg-green-50 text-green-700">
              <BookOpen className="size-5" />
            </div>
          </div>

          <div className="anaai-surface flex items-center justify-between p-5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-500">
                Receptionist
              </p>

              <p className="mt-1 truncate text-base font-semibold text-gray-950">
                {receptionistName ||
                  "Not configured"}
              </p>
            </div>

            <div className="ml-3 flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <Bot className="size-5" />
            </div>
          </div>
        </div>

        <nav className="section-nav" aria-label="Receptionist settings sections">
          <a href="#receptionist-preview">Try an answer</a>
          <a href="#receptionist-identity">Identity & tone</a>
          <a href="#receptionist-greeting">Greeting</a>
          <a href="#receptionist-rules">Business rules</a>
          <a href="#receptionist-handoff">Human handoff</a>
        </nav>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
          <div className="space-y-6">


            <fieldset
              disabled={
                !canManageSettings ||
                saving
              }
              className="space-y-6 disabled:opacity-75"
            >
              <section id="receptionist-identity" className="configuration-section anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="text-base font-semibold text-gray-950">
                    Voice & personality
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Set the identity and
                    communication style
                    of your receptionist.
                  </p>
                </div>

                <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <label
                        htmlFor="receptionist-name"
                        className="text-sm font-medium text-gray-800"
                      >
                        Receptionist name
                      </label>

                      <span className="text-xs text-gray-400">
                        {
                          receptionistName.length
                        }
                        /
                        {MAX_NAME_LENGTH}
                      </span>
                    </div>

                    <input
                      id="receptionist-name"
                      value={
                        receptionistName
                      }
                      maxLength={
                        MAX_NAME_LENGTH
                      }
                      onChange={(event) =>
                        setReceptionistName(
                          event.target
                            .value
                        )
                      }
                      className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-4 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="receptionist-tone"
                      className="mb-2 block text-sm font-medium text-gray-800"
                    >
                      Tone
                    </label>

                    <select
                      id="receptionist-tone"
                      value={tone}
                      onChange={(event) =>
                        setTone(
                          event.target
                            .value
                        )
                      }
                      className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-4 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
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

              <section id="receptionist-greeting" className="configuration-section anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="text-base font-semibold text-gray-950">
                    Call greeting
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    The opening message
                    AnaAI should use when
                    greeting a customer.
                  </p>
                </div>

                <div className="p-5 sm:p-6">
                  <div className="mb-2 flex justify-end">
                    <span className="text-xs text-gray-400">
                      {greeting.length}/
                      {
                        MAX_GREETING_LENGTH
                      }
                    </span>
                  </div>

                  <textarea
                    aria-label="Call greeting"
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
                    className="min-h-28 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm leading-6 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </section>

              <section id="receptionist-rules" className="configuration-section anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="text-base font-semibold text-gray-950">
                    Business rules
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Add business-specific
                    rules for how AnaAI
                    should respond or
                    handle conversations.
                  </p>
                </div>

                <div className="p-5 sm:p-6">
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
                    aria-label="Business rules"
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
                    className="min-h-36 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm leading-6 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </section>

              <section id="receptionist-handoff" className="configuration-section anaai-surface overflow-hidden">
                <div className="border-b border-gray-200 px-5 py-5 sm:px-6">
                  <h2 className="text-base font-semibold text-gray-950">
                    Human handoff
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Describe when AnaAI
                    should stop handling
                    the request and
                    involve a team
                    member.
                  </p>
                </div>

                <div className="p-5 sm:p-6">
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
                    aria-label="Human handoff instructions"
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
                    className="min-h-32 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm leading-6 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
              </section>
            </fieldset>

            {canManageSettings && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() =>
                    void handleSave()
                  }
                  disabled={
                    saving ||
                    !businessId
                  }
                  className="gap-2 sm:min-w-40"
                >
                  <Save className="size-4" />

                  {saving
                    ? "Saving..."
                    : "Save settings"}
                </Button>
              </div>
            )}
          </div>

          <aside className="receptionist-support space-y-6"><section id="receptionist-preview" className="configuration-section anaai-surface overflow-hidden">
              <div className="flex items-start gap-3 border-b border-gray-200 px-5 py-5 sm:px-6">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <MessageCircle className="size-5" />
                </div>

                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Test AnaAI
                  </h2>

                  <p className="mt-1 text-sm leading-6 text-gray-500">
                    Ask a question as if
                    you were a customer
                    contacting your
                    business.
                  </p>
                </div>
              </div>

              <div className="p-5 sm:p-6">
                <div className="mb-2 flex items-center justify-between gap-4">
                  <label
                    htmlFor="ai-preview-message"
                    className="text-sm font-medium text-gray-800"
                  >
                    Customer question
                  </label>

                  <span className="text-xs text-gray-400">
                    {testMessage.length}/
                    {
                      MAX_PREVIEW_MESSAGE_LENGTH
                    }
                  </span>
                </div>

                <textarea
                  id="ai-preview-message"
                  aria-describedby="ai-preview-disclaimer"
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
                  className="min-h-28 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm leading-6 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                />

                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p id="ai-preview-disclaimer" className="text-xs text-gray-500">
                      Preview only. No
                      appointments are
                      created or changed,
                      and no SMS is sent.
                    </p>

                    <p className="mt-1 text-xs text-gray-400">
                      Enter sends. Shift +
                      Enter adds a new
                      line.
                    </p>
                  </div>

                  <Button
                    type="button"
                    onClick={() =>
                      void handleAskAI()
                    }
                    disabled={
                      !businessId ||
                      asking ||
                      !testMessage.trim()
                    }
                    className="shrink-0 gap-2"
                  >
                    <Send className="size-4" />

                    {asking
                      ? "Thinking..."
                      : "Ask AnaAI"}
                  </Button>
                </div>

                {(asking ||
                  aiReply) && (
                  <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 items-center justify-center rounded-xl bg-green-100 text-green-700">
                        <Bot className="size-4" />
                      </div>

                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {receptionistName}
                        </p>

                        {asking && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            Generating
                            preview...
                          </p>
                        )}
                      </div>
                    </div>

                    {!asking &&
                      aiReply && (
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-gray-700">
                          {aiReply}
                        </p>
                      )}
                  </div>
                )}
              </div>
            </section>
            <section className="anaai-surface p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-gray-500">
                    AI configuration
                  </p>

                  <h2 className="mt-1 text-base font-semibold text-gray-950">
                    {configurationReady
                      ? "Configured"
                      : "Needs setup"}
                  </h2>
                </div>

                <div
                  className={`flex size-10 items-center justify-center rounded-xl ${
                    configurationReady
                      ? "bg-green-50 text-green-700"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  <Bot className="size-5" />
                </div>
              </div>

              <div className="mt-5 space-y-3">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-gray-500">
                    Receptionist
                  </span>

                  <span className="max-w-[160px] truncate font-medium text-gray-900">
                    {receptionistName ||
                      "Not set"}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-gray-500">
                    Tone
                  </span>

                  <span className="max-w-[180px] truncate text-right font-medium text-gray-900">
                    {tone}
                  </span>
                </div>
              </div>
            </section>

            <section className="anaai-surface overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-950">
                    Business knowledge
                  </h2>

                  <p className="mt-0.5 text-xs text-gray-500">
                    {knowledgeCount}{" "}
                    {knowledgeCount === 1
                      ? "entry"
                      : "entries"}
                  </p>
                </div>

                <BookOpen className="size-5 text-green-700" />
              </div>

              {knowledgeItems.length ===
              0 ? (
                <div className="p-5">
                  <p className="text-sm leading-6 text-gray-500">
                    No business
                    knowledge has been
                    added yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {knowledgeItems
                    .slice(0, 3)
                    .map((item) => (
                      <div
                        key={item.id}
                        className="px-5 py-4"
                      >
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-green-700">
                          {
                            item.category
                          }
                        </span>

                        <p className="mt-1 line-clamp-2 text-sm font-medium leading-5 text-gray-800">
                          {
                            item.question
                          }
                        </p>
                      </div>
                    ))}
                </div>
              )}

              <div className="border-t border-gray-200 p-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    router.push(
                      "/knowledge"
                    )
                  }
                  className="w-full justify-between"
                >
                  {canManageSettings
                    ? "Manage knowledge"
                    : "View knowledge"}

                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </section>

            <section className="anaai-surface p-5">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <ShieldCheck className="size-4" />
                </div>

                <h2 className="text-sm font-semibold text-gray-950">
                  Your business context
                </h2>
              </div>

              <p className="mt-3 text-sm leading-6 text-gray-500">
                Answers use the settings and knowledge for the business selected in your workspace.
              </p>
            </section>

            <section className="anaai-surface p-5">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
                  <Sparkles className="size-4" />
                </div>

                <h2 className="text-sm font-semibold text-gray-950">
                  Preview mode
                </h2>
              </div>

              <p className="mt-3 text-sm leading-6 text-gray-500">
                Use the preview to
                review how AnaAI answers
                questions before
                adjusting your settings
                or knowledge.
              </p>
            </section>
          </aside>
        </div>
      </div>
    </AppLayout>
  );
}
