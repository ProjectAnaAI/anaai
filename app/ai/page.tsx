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

type KnowledgeItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
};

export default function AIReceptionistPage() {
  const router = useRouter();

  const [receptionistName, setReceptionistName] = useState("Ana");
  const [greeting, setGreeting] = useState(
    "Thanks for calling! How can I help you today?"
  );
  const [tone, setTone] = useState("Friendly and professional");
  const [instructions, setInstructions] = useState("");
  const [transferInstructions, setTransferInstructions] = useState("");

  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [knowledgeCount, setKnowledgeCount] = useState(0);

  const [testMessage, setTestMessage] = useState("");
  const [aiReply, setAiReply] = useState("");

  const [businessId, setBusinessId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    async function loadPage() {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          console.error("AnaAI client request diagnostic.");
          toast.error("Unable to read your login session.");
          router.push("/login");
          return;
        }

        if (!session?.user) {
          router.push("/login");
          return;
        }

        const response = await fetch("/api/current-business", {
          headers: { ...activeBusinessHeaders(), Authorization: `Bearer ${session.access_token}` },
        });
        const context = await response.json();

        if (!response.ok || !context.success || !context.business?.id) {
          throw new Error(context.error || "Unable to resolve your business.");
        }

        const activeBusinessId = context.business.id;

        const [settingsResult, knowledgeResult] = await Promise.all([
          supabase
            .from("ai_settings")
            .select(
              "receptionist_name, greeting, tone, custom_instructions, transfer_instructions"
            )
            .eq("business_id", activeBusinessId)
            .maybeSingle(),

          supabase
            .from("business_knowledge")
            .select("id, category, question, answer")
            .eq("business_id", activeBusinessId)
            .order("created_at", {
              ascending: false,
            }),
        ]);

        if (settingsResult.error) throw new Error(settingsResult.error.message);
        if (knowledgeResult.error) throw new Error(knowledgeResult.error.message);

        const settings = settingsResult.data;

        if (settings) {
          setReceptionistName(
            settings.receptionist_name || "Ana"
          );

          setGreeting(
            settings.greeting ||
              "Thanks for calling! How can I help you today?"
          );

          setTone(
            settings.tone ||
              "Friendly and professional"
          );

          setInstructions(
            settings.custom_instructions || ""
          );

          setTransferInstructions(
            settings.transfer_instructions || ""
          );
        }

        const items = knowledgeResult.data ?? [];

        setKnowledgeItems(items);
        setKnowledgeCount(items.length);
        setBusinessId(activeBusinessId);
      } catch (error) {
        setBusinessId(null);
        console.error("AnaAI client request diagnostic.");
        toast.error(error instanceof Error ? error.message : "Unable to load AI settings.");
      } finally {
        setLoading(false);
      }
    }

    loadPage();
  }, [router]);

  async function getValidAccessToken() {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error) {
      console.error("AnaAI client request diagnostic.");
      return null;
    }

    if (session?.access_token) {
      return session.access_token;
    }

    const {
      data: refreshedData,
      error: refreshError,
    } = await supabase.auth.refreshSession();

    if (refreshError) {
      console.error("AnaAI client request diagnostic.");

      return null;
    }

    return refreshedData.session?.access_token ?? null;
  }

  async function handleAskAI() {
    if (loading || !businessId) {
      toast.error("Business context is unavailable. Please reload the page.");
      return;
    }

    const message = testMessage.trim();

    if (!message) {
      toast.warning(
        "Enter a customer question first."
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

      const response = await fetch("/api/ai", {
        method: "POST",
        headers: {
          ...activeBusinessHeaders(),
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "x-anaai-business-id": businessId,
        },
        body: JSON.stringify({
          message,
          mode: "preview",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error("AnaAI client request diagnostic.");

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
      console.error("AnaAI client request diagnostic.");

      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate an AI response.";

      toast.error(message);
    } finally {
      setAsking(false);
    }
  }

  async function handleSave() {
    if (loading || !businessId) {
      toast.error("Business context is unavailable. Please reload the page.");
      return;
    }

    setSaving(true);

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        toast.error(
          "Please log in again."
        );

        router.push("/login");
        return;
      }

      const { data: existingSettings, error: lookupError } = await supabase
        .from("ai_settings")
        .select("id")
        .eq("business_id", businessId)
        .maybeSingle();

      if (lookupError) throw new Error(lookupError.message);

      const settings = {
        receptionist_name: receptionistName.trim() || "Ana",
        greeting: greeting.trim(),
        tone,
        custom_instructions: instructions.trim(),
        transfer_instructions: transferInstructions.trim(),
        updated_at: new Date().toISOString(),
      };

      const { error } = existingSettings
        ? await supabase
            .from("ai_settings")
            .update(settings)
            .eq("id", existingSettings.id)
            .eq("business_id", businessId)
            .select("id")
            .single()
        : await supabase.from("ai_settings").insert({
            ...settings,
            business_id: businessId,
            // Retain user_id for compatibility during the migration.
            user_id: user.id,
          });

      if (error) {
        throw new Error(error.message);
      }

      toast.success(
        "AI receptionist settings saved."
      );
    } catch (error) {
      console.error("AnaAI client request diagnostic.");

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
                  Configure how AnaAI speaks with
                  customers and test responses using
                  your saved business knowledge.
                </p>
              </div>

              <div className="hidden rounded-2xl bg-green-50 p-4 md:block">
                <Bot className="h-7 w-7 text-green-600" />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              <p className="text-gray-500">
                Loading AI receptionist...
              </p>
            </div>
          ) : (
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
                        Ask a question as if you were a
                        customer contacting your
                        business.
                      </p>
                    </div>
                  </div>

                  <div className="mt-6">
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Customer question
                    </label>

                    <textarea
                      aria-description="Preview only: does not book appointments or send SMS."
                      value={testMessage}
                      onChange={(event) =>
                        setTestMessage(
                          event.target.value
                        )
                      }
                      onKeyDown={handleKeyDown}
                      rows={4}
                      placeholder="Example: What time do you close on Saturday?"
                      className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                    />

                    <p className="mt-2 text-xs text-gray-500">Preview only: no appointments are created or changed, and no SMS is sent.</p>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-gray-400">
                        Enter sends. Shift + Enter adds
                        a new line.
                      </p>

                      <button
                        type="button"
                        onClick={() =>
                          void handleAskAI()
                        }
                        disabled={
                          loading || !businessId ||
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
                            {receptionistName}
                          </p>

                          <p className="mt-1 text-sm text-gray-500">
                            Thinking...
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {!asking && aiReply && (
                    <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5">
                      <div className="flex items-center gap-3">
                        <div className="rounded-xl bg-green-100 p-2">
                          <Bot className="h-4 w-4 text-green-700" />
                        </div>

                        <p className="text-sm font-semibold text-gray-900">
                          {receptionistName}
                        </p>
                      </div>

                      <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-gray-700">
                        {aiReply}
                      </p>
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Voice & Personality
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    Set the identity and communication
                    style of your AI receptionist.
                  </p>

                  <div className="mt-6 space-y-6">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Receptionist Name
                      </label>

                      <input
                        value={receptionistName}
                        onChange={(event) =>
                          setReceptionistName(
                            event.target.value
                          )
                        }
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
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
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                      >
                        <option value="Friendly and professional">
                          Friendly and professional
                        </option>

                        <option value="Warm and conversational">
                          Warm and conversational
                        </option>

                        <option value="Professional and concise">
                          Professional and concise
                        </option>
                      </select>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Call Greeting
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    This is how AnaAI should greet
                    customers.
                  </p>

                  <textarea
                    value={greeting}
                    onChange={(event) =>
                      setGreeting(
                        event.target.value
                      )
                    }
                    rows={4}
                    className="mt-6 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Custom Instructions
                  </h2>

                  <textarea
                    value={instructions}
                    onChange={(event) =>
                      setInstructions(
                        event.target.value
                      )
                    }
                    rows={6}
                    placeholder="Add additional rules for AnaAI..."
                    className="mt-6 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <h2 className="text-xl font-semibold text-gray-950">
                    Human Transfer
                  </h2>

                  <textarea
                    value={
                      transferInstructions
                    }
                    onChange={(event) =>
                      setTransferInstructions(
                        event.target.value
                      )
                    }
                    rows={5}
                    placeholder="When should AnaAI transfer to a human?"
                    className="mt-6 w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                <button
                  type="button"
                  onClick={() =>
                    void handleSave()
                  }
                  disabled={saving || loading || !businessId}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-3.5 font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:opacity-50"
                >
                  <Save className="h-5 w-5" />

                  {saving
                    ? "Saving..."
                    : "Save AI Settings"}
                </button>
              </div>

              <div className="space-y-6">
                <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold text-gray-950">
                      AI Status
                    </h2>

                    <div className="rounded-xl bg-green-50 p-2">
                      <Bot className="h-5 w-5 text-green-600" />
                    </div>
                  </div>

                  <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-green-50 px-3 py-1.5 text-sm font-medium text-green-700">
                    <span className="h-2 w-2 rounded-full bg-green-500" />
                    Connected
                  </div>
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

                  <div className="mt-5 space-y-3">
                    {knowledgeItems
                      .slice(0, 3)
                      .map((item) => (
                        <div
                          key={item.id}
                          className="rounded-xl border border-gray-100 bg-gray-50 p-3"
                        >
                          <span className="text-xs font-semibold uppercase tracking-wide text-green-600">
                            {item.category}
                          </span>

                          <p className="mt-1 text-sm font-medium text-gray-800">
                            {item.question}
                          </p>
                        </div>
                      ))}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        "/knowledge"
                      )
                    }
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-green-50 hover:text-green-700"
                  >
                    Manage Business Knowledge
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
                    Your business information is loaded
                    on the server after AnaAI verifies
                    your Supabase login.
                  </p>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}