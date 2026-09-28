import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { getDay, type Appointment } from "../../lib/appointments-api";
import { useBusiness } from "../business/BusinessContext";
import { businessClock } from "../today/todayData";
import { AppointmentComposer } from "./AppointmentComposer";
import { Action, DateControls, Notice, s } from "./controls";
import { performAction } from "./requestKeys";
import { lifecycleActions, safeMessage, timeLabel, validDate } from "./state";
import { useResource } from "./useResource";

export function AppointmentsScreen() {
  const { business, userId } = useBusiness();
  const { width, fontScale } = useWindowDimensions();
  const split = width >= 900 && fontScale < 1.3;
  const params = useLocalSearchParams<{ compose?: string }>();
  const [now, setNow] = useState(() => new Date());
  const clock = businessClock(business.timezone, now);
  const [date, setDate] = useState(() => clock?.date || "");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  return <View style={s.page}>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <View><Text accessibilityRole="header" style={s.title}>Appointments</Text><Text style={s.muted}>{business.name} · {business.timezone}</Text></View>
        <Action label="+ New Appointment" disabled={busy} onPress={() => setComposer("new")} />
      </View>
      <DateControls date={date} today={clock.date} onChange={changeDate} disabled={busy} />
      {!validDate(date) && <Notice message="Enter a valid date as YYYY-MM-DD." />}
      <View style={s.row}><TextInput accessibilityLabel="Search this day's appointments" placeholder="Search this day" value={search} onChangeText={setSearch} style={[s.input, { flex: 1, minWidth: 180 }]} />
        <Action label="Refresh day" secondary disabled={busy} onPress={() => { setCommitted(null); day.refresh(); }} /></View>
      {date === clock.date && <Text style={s.muted}>Now · {timeLabel(`${String(Math.floor(clock.minutes / 60)).padStart(2, "0")}:${String(clock.minutes % 60).padStart(2, "0")}`)}</Text>}
      <View style={{ flexDirection: split ? "row" : "column", gap: 16, alignItems: "flex-start" }}>
        <View style={{ flex: split ? 1 : undefined, width: split ? undefined : "100%", minWidth: 0, gap: 10 }}>
          {day.loading && <ActivityIndicator accessibilityLabel="Loading appointments" />}
          {day.error && <Notice message={day.error} />}
          {day.data && !rows.length && <Text style={s.muted}>{search ? "No matching appointments." : "No appointments on this day."}</Text>}
          {rows.map((appointment) => <Pressable accessibilityRole="button" accessibilityState={{ selected: appointment.id === selectedId, disabled: busy }} disabled={busy}
            key={appointment.id} style={[s.section, appointment.id === selectedId && s.selected]}
            onPress={() => { setSelectedId(appointment.id); setCommitted(null); setCancelPrompt(false); setMessage(""); }}>
            <View style={[s.row, { justifyContent: "space-between" }]}><Text style={s.heading}>{timeLabel(appointment.appointment_time)}</Text><Text style={s.muted}>{appointment.status}</Text></View>
            <Text style={s.text}>{appointment.customer_name || "Customer"}</Text>
            <Text style={s.muted}>{appointment.service || "Service"} · {appointment.duration_minutes == null ? "Duration unavailable" : `${appointment.duration_minutes} min`}</Text>
          </Pressable>)}
        </View>
        <View style={[s.section, { width: split ? 290 : "100%" }]}>
          <Text accessibilityRole="header" style={s.heading}>Appointment details</Text>
          {!selected ? <Text style={s.muted}>Select an appointment to see its details and actions.</Text> : <>
            <Text style={s.heading}>{selected.customer_name || "Customer"}</Text><Text style={s.text}>{selected.service || "Service"}</Text>
            <Text style={s.text}>{selected.appointment_date} · {timeLabel(selected.appointment_time)}</Text>
            <Text style={s.text}>{selected.status} · {selected.duration_minutes == null ? "Duration unavailable" : `${selected.duration_minutes} min`}</Text>
            {!!selected.notes && <Text style={s.muted}>{selected.notes}</Text>}
            {(selected.status === "Completed" || selected.status === "Cancelled") && <Text style={s.muted}>This appointment is {selected.status.toLowerCase()}.</Text>}
            {message ? <Notice message={message} /> : null}
            {lifecycleActions(selected.status).filter((status) => status !== "Cancelled").map((status) => <Action key={status}
              label={busy ? "Saving…" : status === "Confirmed" ? "Confirm" : "Complete"} disabled={busy || day.loading || !!day.error}
              onPress={() => void action(status)} />)}
            {["Booked", "Confirmed"].includes(selected.status) && <>
              <Action label="Reschedule" secondary disabled={busy || day.loading || !!day.error || !selected.customer_id || !selected.service_id} onPress={() => setComposer(selected)} />
              {cancelPrompt ? <><Notice message="Cancel this appointment? This releases its time and cannot be undone here." />
                <Action label="Yes, Cancel Appointment" destructive disabled={busy || day.loading || !!day.error} onPress={() => void action("Cancelled")} />
                <Action label="Keep Appointment" secondary disabled={busy} onPress={() => setCancelPrompt(false)} /></>
                : <Action label="Cancel Appointment" secondary disabled={busy || day.loading || !!day.error} onPress={() => setCancelPrompt(true)} />}
            </>}
          </>}
        </View>
      </View>
    </ScrollView>
    {composer && <AppointmentComposer initialDate={validDate(date) ? date : clock.date} today={clock.date}
      appointment={composer === "new" ? undefined : composer} onClose={() => setComposer(null)}
      onSaved={saved} onView={(appointment) => { saved(appointment); setComposer(null); }} />}
  </View>;
}
