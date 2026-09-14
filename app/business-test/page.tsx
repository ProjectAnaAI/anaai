"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type BusinessTestResult = {
  success: boolean;
  error?: string;
  membershipCount?: number;
  businessCount?: number;
  memberships?: Array<{
    business_id: string;
    role: string;
  }>;
  businesses?: Array<{
    id: string;
    name: string;
    timezone: string;
  }>;
};

export default function BusinessTestPage() {
  const [result, setResult] = useState<BusinessTestResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function runTest() {
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError || !session?.access_token) {
          setResult({
            success: false,
            error: "No authenticated AnaAI session found.",
          });
          return;
        }

        const response = await fetch("/api/business-test", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        const data = (await response.json()) as BusinessTestResult;

        setResult(data);
      } catch (error) {
        console.error("Business test page error:", error);

        setResult({
          success: false,
          error: "Unexpected test error.",
        });
      } finally {
        setLoading(false);
      }
    }

    runTest();
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold text-gray-950">
            AnaAI Business RLS Test
          </h1>

          <p className="mt-2 text-sm text-gray-600">
            Temporary page for verifying authenticated multi-business access.
          </p>

          {loading && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-5 text-sm text-gray-700">
              Testing business membership...
            </div>
          )}

          {!loading && result && (
            <div className="mt-8">
              <div
                className={`rounded-xl border p-5 ${
                  result.success
                    ? "border-green-200 bg-green-50"
                    : "border-red-200 bg-red-50"
                }`}
              >
                <div className="font-medium text-gray-950">
                  {result.success ? "RLS test passed" : "RLS test failed"}
                </div>

                {result.error && (
                  <div className="mt-2 text-sm text-red-700">
                    {result.error}
                  </div>
                )}
              </div>

              {result.success && (
                <div className="mt-6 space-y-4">
                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="text-sm text-gray-500">
                      Membership count
                    </div>
                    <div className="mt-1 text-xl font-semibold text-gray-950">
                      {result.membershipCount ?? 0}
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="text-sm text-gray-500">
                      Business count
                    </div>
                    <div className="mt-1 text-xl font-semibold text-gray-950">
                      {result.businessCount ?? 0}
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="text-sm font-medium text-gray-950">
                      Memberships
                    </div>

                    <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-50 p-4 text-xs text-gray-700">
                      {JSON.stringify(result.memberships ?? [], null, 2)}
                    </pre>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="text-sm font-medium text-gray-950">
                      Businesses
                    </div>

                    <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-50 p-4 text-xs text-gray-700">
                      {JSON.stringify(result.businesses ?? [], null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}