import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { getBusinesses, rememberedBusiness, type Business } from "../../lib/today-api";
export type { Business, BusinessRole } from "../../lib/today-api";

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
    const controller = new AbortController();

    async function load() {
      setState({ status: "loading" });

      try {
        const { userId, businesses } = await getBusinesses(controller.signal);
        if (cancelled) return;
        if (businesses.length === 0) {
          setState({ status: "no-membership" });
          return;
        }

        if (businesses.length === 1) {
          await AsyncStorage.setItem(storageKey(userId), businesses[0].id);

          if (cancelled) return;

          setState({
            status: "ready",
            userId,
            businesses,
            business: businesses[0],
          });
          return;
        }

        const storedBusinessId = await AsyncStorage.getItem(storageKey(userId));

        if (cancelled) return;

        const storedBusiness = rememberedBusiness(businesses, storedBusinessId);

        if (storedBusiness) {
          setState({
            status: "ready",
            userId,
            businesses,
            business: storedBusiness,
          });
          return;
        }

        setState({
          status: "selection",
          userId,
          businesses,
        });
      } catch {
        if (cancelled) return;

        setState({
          status: "error",
          message: "Unable to load business access. Please try again.",
        });
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
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
