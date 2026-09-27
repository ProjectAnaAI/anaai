import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { supabase } from "../../lib/supabase";

export type BusinessRole = "owner" | "manager" | "staff";

export type Business = {
  id: string;
  name: string;
  timezone: string;
  role: BusinessRole;
};

type BusinessContextValue = {
  userId: string;
  businesses: Business[];
  business: Business;
  selectBusiness: (businessId: string) => Promise<void>;
};

type BusinessState =
  | { status: "loading" }
  | { status: "no-membership" }
  | { status: "selection"; userId: string; businesses: Business[] }
  | {
      status: "ready";
      userId: string;
      businesses: Business[];
      business: Business;
    }
  | { status: "error"; message: string };

const BusinessContext = createContext<BusinessContextValue | null>(null);

function storageKey(userId: string) {
  return `zude:business:${userId}`;
}

function isBusinessRole(role: string): role is BusinessRole {
  return role === "owner" || role === "manager" || role === "staff";
}

export function BusinessProvider({
  children,
  loading,
  noMembership,
  selectBusiness: renderSelection,
  error,
}: {
  children: ReactNode;
  loading: ReactNode;
  noMembership: ReactNode;
  selectBusiness: (
    businesses: Business[],
    onSelect: (businessId: string) => Promise<void>,
  ) => ReactNode;
  error: (message: string) => ReactNode;
}) {
  const [state, setState] = useState<BusinessState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState({ status: "loading" });

      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (cancelled) return;

        if (userError || !user) {
          setState({
            status: "error",
            message: "Your session could not be verified. Please sign in again.",
          });
          return;
        }

        const { data: memberships, error: membershipError } = await supabase
          .from("business_members")
          .select("business_id, role")
          .eq("user_id", user.id);

        if (cancelled) return;

        if (membershipError) {
          throw new Error(membershipError.message);
        }

        const validMemberships = (memberships ?? []).filter(
          (
            membership,
          ): membership is {
            business_id: string;
            role: BusinessRole;
          } =>
            typeof membership.business_id === "string" &&
            typeof membership.role === "string" &&
            isBusinessRole(membership.role),
        );

        if (validMemberships.length === 0) {
          setState({ status: "no-membership" });
          return;
        }

        const membershipByBusiness = new Map(
          validMemberships.map((membership) => [
            membership.business_id,
            membership.role,
          ]),
        );

        const businessIds = [...membershipByBusiness.keys()];

        const { data: businessRows, error: businessError } = await supabase
          .from("businesses")
          .select("id, name, timezone")
          .in("id", businessIds)
          .order("name");

        if (cancelled) return;

        if (businessError) {
          throw new Error(businessError.message);
        }

        const businesses: Business[] = (businessRows ?? [])
          .map((business) => {
            const role = membershipByBusiness.get(business.id);

            if (!role) return null;

            return {
              id: business.id,
              name: business.name,
              timezone: business.timezone,
              role,
            };
          })
          .filter((business): business is Business => business !== null);

        if (businesses.length === 0) {
          setState({
            status: "error",
            message: "No accessible business could be loaded.",
          });
          return;
        }

        if (businesses.length === 1) {
          await AsyncStorage.setItem(storageKey(user.id), businesses[0].id);

          if (cancelled) return;

          setState({
            status: "ready",
            userId: user.id,
            businesses,
            business: businesses[0],
          });
          return;
        }

        const storedBusinessId = await AsyncStorage.getItem(storageKey(user.id));

        if (cancelled) return;

        const storedBusiness = businesses.find(
          (business) => business.id === storedBusinessId,
        );

        if (storedBusiness) {
          setState({
            status: "ready",
            userId: user.id,
            businesses,
            business: storedBusiness,
          });
          return;
        }

        setState({
          status: "selection",
          userId: user.id,
          businesses,
        });
      } catch (loadError) {
        if (cancelled) return;

        console.error("ZUDE business context error:", loadError);

        setState({
          status: "error",
          message: "Unable to load business access. Please try again.",
        });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function selectBusiness(businessId: string) {
    if (state.status !== "ready" && state.status !== "selection") return;

    const business = state.businesses.find(
      (candidate) => candidate.id === businessId,
    );

    if (!business) return;

    await AsyncStorage.setItem(storageKey(state.userId), business.id);

    setState({
      status: "ready",
      userId: state.userId,
      businesses: state.businesses,
      business,
    });
  }

  const value: BusinessContextValue | null =
    state.status === "ready"
      ? {
          userId: state.userId,
          businesses: state.businesses,
          business: state.business,
          selectBusiness,
        }
      : null;

  if (state.status === "loading") return <>{loading}</>;
  if (state.status === "no-membership") return <>{noMembership}</>;

  if (state.status === "selection") {
    return <>{renderSelection(state.businesses, selectBusiness)}</>;
  }

  if (state.status === "error") {
    return <>{error(state.message)}</>;
  }

  if (!value) return <>{loading}</>;

  return (
    <BusinessContext.Provider value={value}>
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusiness() {
  const context = useContext(BusinessContext);

  if (!context) {
    throw new Error("useBusiness must be used inside BusinessProvider.");
  }

  return context;
}
