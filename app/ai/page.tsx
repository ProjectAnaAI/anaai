"use client";

import { useEffect, useState } from "react";
import { Bot, Save, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";
import AppLayout from "@/components/layout/AppLayout";

export default function AIReceptionistPage() {
  const [receptionistName, setReceptionistName] = useState("Ana");
  const [greeting, setGreeting] = useState(
    "Thanks for calling! How can I help you today?"
  );
  const [tone, setTone] = useState("Friendly and professional");
  const [instructions, setInstructions] = useState("");
  const [transferInstructions, setTransferInstructions] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("ai_settings")
        .select(
          "receptionist_name, greeting, tone, custom_instructions, transfer_instructions"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        alert(error.message);
        setLoading(false);
        return;
      }

      if (data) {
        setReceptionistName(data.receptionist_name ?? "Ana");
        setGreeting(
          data.greeting ??
            "Thanks for calling! How can I help you today?"
        );
        setTone(data.tone ?? "Friendly and professional");
        setInstructions(data.custom_instructions ?? "");
        setTransferInstructions(data.transfer_instructions ?? "");
      }

      setLoading(false);
    }

    loadSettings();
  }, []);

  async function handleSave() {
    setSaving(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      alert("Please login first.");
      setSaving(false);
      return;
    }

    const { error } = await supabase.from("ai_settings").upsert(
      {
        user_id: user.id,
        receptionist_name: receptionistName,
        greeting,
        tone,
        custom_instructions: instructions,
        transfer_instructions: transferInstructions,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      }
    );

    setSaving(false);

    if (error) {
      alert(error.message);
      return;
    }

    alert("AI receptionist settings saved successfully!");
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-gray-50 px-8 py-10">
        <div className="mx-auto max-w-6xl">

          {/* Header */}
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
                  Configure how AnaAI speaks with customers, answers questions,
                  and handles incoming calls for your business.
                </p>
              </div>

              <div className="hidden rounded-2xl bg-green-50 p-4 md:block">
                <Bot className="h-7 w-7 text-green-600" />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-8">
              <p className="text-gray-500">Loading AI settings...</p>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[1fr_320px]">

              {/* Main settings */}
              <div className="space-y-6">

                {/* Voice & personality */}
                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <div className="mb-6">
                    <h2 className="text-xl font-semibold text-gray-950">
                      Voice & Personality
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      Set the identity and communication style of your AI
                      receptionist.
                    </p>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Receptionist Name
                      </label>

                      <input
                        value={receptionistName}
                        onChange={(e) =>
                          setReceptionistName(e.target.value)
                        }
                        placeholder="Ana"
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Tone
                      </label>

                      <select
                        value={tone}
                        onChange={(e) => setTone(e.target.value)}
                        className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
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

                {/* Greeting */}
                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <div className="mb-6">
                    <h2 className="text-xl font-semibold text-gray-950">
                      Call Greeting
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      This is how AnaAI will greet customers when answering a
                      call.
                    </p>
                  </div>

                  <textarea
                    value={greeting}
                    onChange={(e) => setGreeting(e.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                {/* Instructions */}
                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <div className="mb-6">
                    <h2 className="text-xl font-semibold text-gray-950">
                      Custom Instructions
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      Give AnaAI additional rules to follow during customer
                      conversations.
                    </p>
                  </div>

                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={6}
                    placeholder="Example: Always confirm the customer's name, phone number, service, date, and time before booking."
                    className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                {/* Human transfer */}
                <section className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
                  <div className="mb-6">
                    <h2 className="text-xl font-semibold text-gray-950">
                      Human Transfer
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                      Define situations where AnaAI should hand the call to a
                      person.
                    </p>
                  </div>

                  <textarea
                    value={transferInstructions}
                    onChange={(e) =>
                      setTransferInstructions(e.target.value)
                    }
                    rows={5}
                    placeholder="Example: Transfer the call if the customer asks for a manager or has a complaint that AnaAI cannot resolve."
                    className="w-full resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 leading-7 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </section>

                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-3.5 font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-5 w-5" />
                  {saving ? "Saving..." : "Save AI Settings"}
                </button>
              </div>

              {/* Right sidebar */}
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
                    Online
                  </div>

                  <p className="mt-4 text-sm leading-6 text-gray-500">
                    Your AI receptionist configuration is connected to your
                    AnaAI account and ready for future call handling.
                  </p>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="rounded-xl bg-green-50 p-2">
                      <Sparkles className="h-5 w-5 text-green-600" />
                    </div>

                    <h2 className="font-semibold text-gray-950">
                      Coming Next
                    </h2>
                  </div>

                  <p className="mt-4 text-sm leading-6 text-gray-500">
                    Business knowledge, FAQs, booking tools, call handling,
                    and phone integration will connect to these settings.
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