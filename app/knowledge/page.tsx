"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookOpen, Plus, Save, Trash2, Pencil } from "lucide-react";

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
import { supabase } from "@/lib/supabase";

type KnowledgeItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
  created_at: string;
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

export default function KnowledgePage() {
  const router = useRouter();

  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [category, setCategory] = useState("General");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    loadKnowledge();
  }, []);

  async function getCurrentUser() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return null;
    }

    return user;
  }

  async function loadKnowledge() {
    const user = await getCurrentUser();

    if (!user) return;

    const { data, error } = await supabase
      .from("business_knowledge")
      .select("id, category, question, answer, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      toast.error(error.message);
    } else {
      setItems(data || []);
    }

    setLoading(false);
  }

  function resetForm() {
    setCategory("General");
    setQuestion("");
    setAnswer("");
    setEditingId(null);
  }

  async function handleSave() {
    const user = await getCurrentUser();

    if (!user) return;

    if (!question.trim()) {
      toast.warning("Please enter a question.");
      return;
    }

    if (!answer.trim()) {
      toast.warning("Please enter an answer.");
      return;
    }

    setSaving(true);

    if (editingId) {
      const { error } = await supabase
        .from("business_knowledge")
        .update({
          category,
          question: question.trim(),
          answer: answer.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingId)
        .eq("user_id", user.id);

      setSaving(false);

      if (error) {
        toast.error(error.message);
        return;
      }

      toast.success("Knowledge updated.");
    } else {
      const { error } = await supabase
        .from("business_knowledge")
        .insert({
          user_id: user.id,
          category,
          question: question.trim(),
          answer: answer.trim(),
        });

      setSaving(false);

      if (error) {
        toast.error(error.message);
        return;
      }

      toast.success("Knowledge added.");
    }

    resetForm();
    loadKnowledge();
  }

  function handleEdit(item: KnowledgeItem) {
    setEditingId(item.id);
    setCategory(item.category);
    setQuestion(item.question);
    setAnswer(item.answer);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  async function handleDelete(id: string) {
    const user = await getCurrentUser();

    if (!user) return;

    const confirmed = window.confirm(
      "Are you sure you want to delete this knowledge item?"
    );

    if (!confirmed) return;

    const { error } = await supabase
      .from("business_knowledge")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success("Knowledge deleted.");

    if (editingId === id) {
      resetForm();
    }

    loadKnowledge();
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
                Add answers AnaAI can eventually use when customers ask about
                your business.
              </p>
            </div>

            <div className="hidden rounded-2xl bg-green-50 p-4 sm:block">
              <BookOpen className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </header>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.4fr]">
          <Card>
            <CardHeader>
              <CardTitle>
                {editingId ? "Edit knowledge" : "Add knowledge"}
              </CardTitle>
            </CardHeader>

            <CardContent className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Category
                </label>

                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                >
                  {categories.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Customer question
                </label>

                <Input
                  placeholder="Example: What time do you close on Saturday?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  AnaAI answer
                </label>

                <Textarea
                  className="min-h-32"
                  placeholder="Example: We close at 6 PM on Saturdays."
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
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
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  Knowledge library
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  {items.length} {items.length === 1 ? "entry" : "entries"}
                </p>
              </div>
            </div>

            {loading ? (
              <p className="text-gray-500">Loading knowledge...</p>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
                <BookOpen className="mx-auto h-8 w-8 text-gray-400" />

                <h3 className="mt-4 font-semibold text-gray-900">
                  No knowledge added yet
                </h3>

                <p className="mt-2 text-sm text-gray-500">
                  Add your first FAQ, policy, business hour, or booking rule.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {items.map((item) => (
                  <Card key={item.id}>
                    <CardContent className="p-6">
                      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                            {item.category}
                          </span>

                          <h3 className="mt-4 text-lg font-semibold text-gray-900">
                            {item.question}
                          </h3>

                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                            {item.answer}
                          </p>
                        </div>

                        <div className="flex shrink-0 gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => handleEdit(item)}
                            aria-label="Edit knowledge"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>

                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => handleDelete(item.id)}
                            aria-label="Delete knowledge"
                            className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}