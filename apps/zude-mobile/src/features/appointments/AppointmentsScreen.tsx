import { dateLabel } from "../../components/datePresentation";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { IconButton } from "../../components/ui";
import { Feedback, Field, PaneTitle, SplitWorkspace, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { useWorkspace } from "../../navigation/WorkspaceContext";
import { Schedule } from "../today/Schedule";
import { AppointmentInspector } from "./AppointmentInspector";
import { router, useLocalSearchParams } from "expo-router";
import { getDay, type Appointment } from "../../lib/appointments-api";
import { useBusiness } from "../business/BusinessContext";
import { businessClock, mapAppointment } from "../today/todayData";
import { AppointmentComposer } from "./AppointmentComposer";
import { Action, DateControls, Notice, s } from "./controls";
import { performAction } from "./requestKeys";
import { safeMessage, validDate } from "./state";
import { useResource } from "./useResource";

export function AppointmentsScreen() {
  const { business, userId } = useBusiness();
  const { setNavigationLocked } = useWorkspace();
  const params = useLocalSearchParams<{ compose?: string; date?: string; appointment?: string }>();
  const [now, setNow] = useState(() => new Date());
  const clock = businessClock(business.timezone, now);
  const [date, setDate] = useState(() => params.date && validDate(params.date) ? params.date : clock?.date || "");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(params.appointment || null);
  const [composer, setComposer] = useState<"new" | Appointment | null>(params.compose === "new" ? "new" : null);
  const [busy, setBusy] = useState(false);
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const [message, setMessage] = useState("");
  const [committed, setCommitted] = useState<Appointment | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (params.compose === "new") router.setParams({ compose: undefined });
  }, [params.compose]);
  const day = useResource(validDate(date) ? `${userId}:${business.id}:${date}` : null,
    (signal) => getDay(business.id, date, signal));
  const selected = day.data?.find((a) => a.id === selectedId) || (day.loading && committed?.id === selectedId && committed.appointment_date === date ? committed : null);
  function changeDate(next: string) { setDate(next); setSelectedId(null); setCommitted(null); setMessage(""); setCancelPrompt(false); }
  function saved(appointment: Appointment) {
    setCommitted(appointment); setSelectedId(appointment.id); setDate(appointment.appointment_date); setCancelPrompt(false);
    day.refresh();
  }
  async function action(status: "Confirmed" | "Cancelled" | "Completed") {
    if (!selected || submitting.current) return;
    submitting.current = true; setBusy(true); setMessage("");
    try {
      const result = await performAction(userId, business.id, { appointmentId: selected.id, status });
      if (alive.current) saved(result);
    } catch (error) {
      if (alive.current) { setMessage(safeMessage(error)); day.refresh(); }
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  if (!clock) return <View style={s.content}><Notice message="The business timezone is unavailable. Review business settings." /></View>;
  const rows = day.data?.filter((a) => `${a.customer_name || ""} ${a.service || ""}`.toLowerCase().includes(search.toLowerCase())) || [];
  if (composer) return <AppointmentComposer initialDate={validDate(date) ? date : clock.date} today={clock.date}
    appointment={composer === "new" ? undefined : composer} onClose={() => setComposer(null)}
    onLockChange={setNavigationLocked} onSaved={saved} onView={(appointment) => { saved(appointment); setComposer(null); }} />;
  return <View style={ws.page}>
    <WorkspaceHeader operational title="Appointments" business={business.name} subtitle={dateLabel(date)}
      search={<Field label="Search this day's appointments" search placeholder="Search this day" value={search} onChangeText={setSearch} />}
      action={<Action brand label="New Appointment" icon="plus-circle" disabled={busy} onPress={() => setComposer("new")} />} />
    <View style={ws.toolbar}>
      <DateControls date={date} today={clock.date} onChange={changeDate} disabled={busy} />
      {!validDate(date) && <Notice message="Enter a valid date as YYYY-MM-DD." error />}
    </View>
    <SplitWorkspace operational focusRailOnStack={selected?.id} main={<>
      <PaneTitle title="Day timeline" detail={day.data ? `${day.data.length} appointments` : "Your schedule"}
        action={<IconButton label="Refresh day" icon="refresh-cw" disabled={busy} onPress={() => { setCommitted(null); day.refresh(); }} />} />
      {day.loading && <Feedback kind="loading" title="Loading appointments" />}
      {day.error && <Feedback kind="error" title="Appointments unavailable" detail={day.error} retry={day.refresh} />}
      {day.data && <>
        <Schedule operational appointments={rows.map(mapAppointment)} now={date === clock.date ? clock.minutes : null} status="success"
          selectedId={selectedId} disabled={busy} onSelect={(appointment) => { setSelectedId(appointment.id); setCommitted(null); setCancelPrompt(false); setMessage(""); }} />
        {!rows.length && <Feedback title={search ? "No matching appointments" : "No appointments on this day"} detail={search ? "Try another customer or service name." : "Create an appointment when you’re ready."} />}
      </>}
    </>} rail={<AppointmentInspector appointment={selected} busy={busy} stale={day.loading || !!day.error} message={message}
      cancelPrompt={cancelPrompt} onCancelPrompt={setCancelPrompt} onAction={(status) => void action(status)}
      onReschedule={() => { if (selected) setComposer(selected); }} />} />
  </View>;
}
