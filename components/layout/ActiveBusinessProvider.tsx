"use client";

import { Fragment, createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { setActiveBusinessId } from "@/lib/active-business";

type Business = { id: string; name: string };
type Selection = {
  businesses: Business[];
  businessId: string | null;
  selectBusiness: (id: string) => void;
};
const BusinessSelectionContext = createContext<Selection | null>(null);

export function BusinessSelector() {
  const selection = useContext(BusinessSelectionContext);
  if (!selection || selection.businesses.length < 2) return null;

  return (
    <label className="text-sm text-gray-600">
      Business
      <select
        aria-label="Active business"
        className="ml-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-gray-900"
        value={selection.businessId || ""}
        onChange={(event) => selection.selectBusiness(event.target.value)}
      >
        <option value="" disabled>Select a business</option>
        {selection.businesses.map((business) => (
          <option key={business.id} value={business.id}>{business.name}</option>
        ))}
      </select>
    </label>
  );
}

export default function ActiveBusinessProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isOnboarding = pathname === "/onboarding";
  const isPublic = ["/", "/login", "/signup"].includes(pathname);
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<{
    userId: string;
    businesses: Business[];
    businessId: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setActiveBusinessId(null);
    setState(null);
    setError(null);
    if (isPublic || userId === undefined) return;
    if (!userId) {
      router.replace("/login");
      return;
    }
    const currentUserId = userId;

    async function loadBusinesses() {
      try {
        const { data: memberships, error: membershipError } = await supabase
          .from("business_members")
          .select("business_id, role")
          .eq("user_id", currentUserId);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? [])
          .filter((membership) => ["owner", "manager", "staff"].includes(membership.role))
          .map((membership) => membership.business_id);
        if (!memberships?.length) {
          if (cancelled) return;
          setState({ userId: currentUserId, businesses: [], businessId: null });
          if (!isOnboarding) router.replace("/onboarding");
          return;
        }
        if (!ids.length) throw new Error("Business access is unavailable.");

        const { data, error: businessError } = await supabase
          .from("businesses").select("id, name").in("id", ids).order("name");
        if (businessError) throw new Error(businessError.message);
        const businesses = data ?? [];
        if (!businesses.length) throw new Error("No accessible business was found.");
        let stored: string | null = null;
        try { stored = sessionStorage.getItem(`anaai:business:${currentUserId}`); } catch {}
        const businessId = businesses.length === 1 ? businesses[0].id
          : businesses.find((business) => business.id === stored)?.id ?? null;
        if (cancelled) return;
        setActiveBusinessId(businessId);
        setState({ userId: currentUserId, businesses, businessId });
        if (isOnboarding) router.replace("/dashboard");
      } catch {
        if (!cancelled) setError("Unable to load business access. Please reload to try again.");
      }
    }
    void loadBusinesses();
    return () => { cancelled = true; };
  }, [userId, isPublic, isOnboarding, router]);

  if (isPublic) return <>{children}</>;
  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!state || state.userId !== userId) return <main className="p-8">Loading business...</main>;

  if (!state.businesses.length) return isOnboarding ? <Fragment key={state.userId}>{children}</Fragment> : <main className="p-8">Opening setup...</main>;
  if (isOnboarding) return <main className="p-8">Opening dashboard...</main>;

  function selectBusiness(id: string) {
    if (!state || !state.businesses.some((business) => business.id === id)) return;
    try { sessionStorage.setItem(`anaai:business:${state.userId}`, id); } catch {}
    setActiveBusinessId(id);
    setState({ ...state, businessId: id });
  }

  return (
    <BusinessSelectionContext.Provider value={{ ...state, selectBusiness }}>
      {state.businessId ? (
        <Fragment key={`${state.userId}:${state.businessId}`}>{children}</Fragment>
      ) : (
        <main className="p-8"><BusinessSelector /></main>
      )}
    </BusinessSelectionContext.Provider>
  );
}
