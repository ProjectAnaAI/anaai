import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { supabase } from "../../lib/supabase";
import type { Appointment } from "../../types/today";
import { useBusiness } from "../business/BusinessContext";
import { businessClock, mapAppointment } from "./todayData";

type Result = {
  key: string;
  status: "loading" | "error" | "success";
  appointments: Appointment[];
};

export function useTodayAppointments() {
  const { business, userId } = useBusiness();
  const [now, setNow] = useState(() => new Date());
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const clock = businessClock(business.timezone, now);
  const date = clock?.date;
  const key = JSON.stringify([userId, business.id, business.timezone, date, revision]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(new Date());
        setRevision((value) => value + 1);
      }
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      setResult({ key, status: "loading", appointments: [] });
      try {
        const { data, error } = await supabase
          .from("appointments")
          .select("id, customer_name, service, appointment_time, status, duration_minutes")
          .eq("business_id", business.id)
          .eq("appointment_date", date!)
          .order("appointment_time", { ascending: true })
          .abortSignal(controller.signal);
        if (error) throw error;
        const appointments = (data ?? []).map(mapAppointment);
        if (!cancelled) setResult({ key, status: "success", appointments });
      } catch (error) {
        if (cancelled) return;
        console.error("ZUDE Today appointments read failed:", error);
        setResult({ key, status: "error", appointments: [] });
      }
    }
    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [business.id, date, key]);

  // Hide previous tenant/day data immediately, before the new effect runs.
  const current = result?.key === key ? result : null;
  return {
    business, clock,
    appointments: current?.appointments ?? [],
    status: !clock ? "error" : current?.status ?? "loading",
    errorMessage: !clock
      ? "The business timezone is unavailable. Please check the business settings."
      : "Unable to load today’s appointments. Please try again.",
    retry: () => { setNow(new Date()); setRevision((value) => value + 1); },
  };
}
