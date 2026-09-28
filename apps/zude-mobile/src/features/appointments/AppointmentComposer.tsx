import { dateLabel } from "../../components/datePresentation";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field, Feedback, SplitWorkspace, WorkspaceHeader } from "../../components/workspace";
import { Badge, Icon } from "../../components/ui";
import { theme as t } from "../../theme/tokens";
import { ComposerSection } from "./ComposerSection";
import { AppointmentSummary } from "./AppointmentSummary";
import { getAvailability, getCustomers, getServices, type Appointment, type Customer } from "../../lib/appointments-api";
import { useBusiness } from "../business/BusinessContext";
import { performAction } from "./requestKeys";
import { isSlotConflict, recoverConflict, safeMessage, timeLabel, uncertainAction, validDate } from "./state";
import { useResource } from "./useResource";
import { Action, DateControls, Notice, s } from "./controls";

export function AppointmentComposer({ initialDate, today, appointment, onClose, onSaved, onView, onLockChange }: {
  initialDate: string; today: string; appointment?: Appointment; onClose: () => void;
  onSaved: (appointment: Appointment) => void; onView: (appointment: Appointment) => void; onLockChange?: (locked: boolean) => void;
}) {
  const { business, userId } = useBusiness();
  const insets = useSafeAreaInsets();
  const [serviceEditing, setServiceEditing] = useState(true);
  const [dateEditing, setDateEditing] = useState(false);
  const [timeEditing, setTimeEditing] = useState(false);
  const [selection, setSelection] = useState({ date: initialDate, time: "", serviceId: appointment?.service_id || "" });
  const [customer, setCustomer] = useState<Customer | null>(appointment?.customer_id ? {
    id: appointment.customer_id, full_name: appointment.customer_name || "Customer", phone: null,
  } : null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const locked = busy || pending !== null;
  useEffect(() => { onLockChange?.(locked); return () => onLockChange?.(false); }, [locked, onLockChange]);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState<Appointment | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const scope = `${userId}:${business.id}`;
  const customers = useResource(!customer && !appointment ? `${scope}:customers:${query}:${offset}` : null,
    (signal) => getCustomers(business.id, query, offset, signal));
  const services = useResource(`${scope}:services`, (signal) => getServices(business.id, signal));
  const service = services.data?.find((item) => item.id === selection.serviceId);
  const availability = useResource(selection.serviceId && validDate(selection.date) && !success
    ? `${scope}:availability:${selection.date}:${selection.serviceId}:${appointment?.id || ""}` : null,
    (signal) => getAvailability(business.id, selection.date, selection.serviceId, appointment?.id, signal));
  // A foreground refresh invalidates previously offered times until reverified.
  const selectedTime = availability.data?.slots.includes(selection.time) ? selection.time : "";
  const ready = !!customer && !!service && !!selectedTime && !busy && !success;
  function change(patch: Partial<typeof selection>) { setSelection((previous) => ({ ...previous, ...patch, time: "" })); setMessage(""); }
  async function submit() {
    if ((!ready && !pending) || submitting.current || !customer) return;
    submitting.current = true;
    setBusy(true); setMessage("");
    try {
      const body = pending || {
        ...(appointment ? { appointmentId: appointment.id } : {}),
        customerId: customer.id, serviceId: selection.serviceId, appointmentDate: selection.date,
        appointmentTime: selectedTime, notes: appointment?.notes || null,
      };
      setPending(body);
      const result = await performAction(userId, business.id, body);
      if (!alive.current) return;
      setPending(null); setSuccess(result); onSaved(result);
    } catch (error) {
      if (!alive.current) return;
      if (!uncertainAction(error)) setPending(null);
      setMessage(safeMessage(error));
      if (isSlotConflict(error)) {
        setSelection((previous) => recoverConflict(previous));
        availability.refresh();
      }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const showServices = !appointment && (!service || serviceEditing);
  const footer = <>
    {message ? <Notice message={message} /> : null}
    {pending && !busy && <Notice message="The save outcome is uncertain. Retry this same request before changing selections or closing." />}
    {success ? <Action label="View Appointment" icon="arrow-right" onPress={() => onView(success)} />
      : <Action label={busy ? "Saving…" : pending ? "Retry Same Request" : appointment ? "Save Reschedule" : "Book Appointment"}
        icon="check" busy={busy} disabled={busy || (!ready && !pending)} onPress={() => void submit()} />}
  </>;
  return <KeyboardAvoidingView style={s.page} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={insets.top}>
    <WorkspaceHeader operational title={success ? (appointment ? "Appointment Rescheduled" : "Appointment Booked") : appointment ? "Reschedule Appointment" : "New Appointment"}
      business={business.name} subtitle={dateLabel(success?.appointment_date || selection.date)}
      action={<Action label={success ? "Done" : "Close"} secondary disabled={locked} onPress={onClose} />} />
    <SplitWorkspace footer={footer} rail={<AppointmentSummary
      customer={success?.customer_name || customer?.full_name} service={success?.service || service?.name || appointment?.service || undefined}
      date={success?.appointment_date || selection.date} time={success?.appointment_time || selectedTime}
      duration={success?.duration_minutes ?? service?.duration_minutes} ready={ready && !appointment} />}
      main={success ? <View style={[s.section, { paddingVertical: t.space.xxl }]}>
        <Icon name="check-circle" color={t.colors.emerald} size={36} />
        <Text style={s.title}>{appointment ? "The new time is saved." : "Your booking is saved."}</Text>
        <Text style={s.heading}>{success.customer_name}</Text>
        <Text style={s.text}>{success.service}</Text>
        <Text style={s.text}>{dateLabel(success.appointment_date)} · {timeLabel(success.appointment_time)}</Text>
        <Badge label={success.status} tone={success.status === "Confirmed" ? "success" : "warning"} />
        <Text style={s.muted}>View the appointment to see its details and available actions.</Text>
      </View> : <>
        <ComposerSection number={1} title="Customer" complete={!!customer} value={customer?.full_name}
          trailing={customer && !appointment ? <Action label="Change customer" secondary disabled={locked} onPress={() => setCustomer(null)} /> : undefined}>
          {!customer && <>
            <Field label="Search customers by name" search placeholder="Search by customer name" value={search} editable={!locked} onChangeText={setSearch} />
            {customers.loading && <ActivityIndicator accessibilityLabel="Loading customers" color={t.colors.emerald} />}
            {customers.error && <><Notice message={customers.error} error /><Action label="Retry customers" secondary onPress={customers.refresh} /></>}
            {customers.data?.customers.map((item) => <Pressable accessibilityRole="button" accessibilityLabel={`Select ${item.full_name}`} disabled={locked} key={item.id}
              style={({ pressed }) => [s.option, pressed && s.selected]} onPress={() => setCustomer(item)}>
              <View style={s.row}><Icon name="user" /><Text style={s.heading}>{item.full_name}</Text><Icon name="chevron-right" size={16} /></View>
              <Text style={s.muted}>{item.phone || "No phone number"}</Text>
            </Pressable>)}
            {customers.data?.customers.length === 0 && <Feedback title="No matching customers" detail="Try another name. New customers can be added in the existing web workspace." />}
            <View style={s.row}>
              {offset > 0 && <Action label="Previous customers" secondary onPress={() => setOffset(Math.max(0, offset - 25))} />}
              {customers.data?.nextOffset != null && <Action label="More customers" secondary onPress={() => setOffset(customers.data!.nextOffset!)} />}
            </View>
          </>}
        </ComposerSection>
        <ComposerSection number={2} title="Service" complete={!!service && !showServices}
          value={!showServices ? `${service?.name || appointment?.service || "Service unavailable"} · ${service?.duration_minutes ?? "—"} min` : undefined}
          trailing={service && !appointment && !showServices ? <Action label="Change service" secondary disabled={locked} onPress={() => setServiceEditing(true)} /> : undefined}>
          {!customer ? <Text style={s.muted}>Select a customer to continue.</Text> : <>
            {services.loading && <ActivityIndicator accessibilityLabel="Loading services" color={t.colors.emerald} />}
            {services.error && <><Notice message={services.error} error /><Action label="Retry services" secondary onPress={services.refresh} /></>}
            {showServices && <View style={s.row}>{services.data?.map((item) => <Action key={item.id}
              label={`${item.name} · ${item.duration_minutes} min${item.id === selection.serviceId ? " ✓" : ""}`}
              secondary selected={item.id === selection.serviceId} disabled={locked || !(item.duration_minutes > 0)}
              onPress={() => { change({ serviceId: item.id }); setServiceEditing(false); }} />)}</View>}
            {services.data?.length === 0 && <Text style={s.muted}>No active services. Configure services in the existing web workspace.</Text>}
            {appointment && services.data && !service && <Notice message="This service is no longer active. Review it in the existing web workspace before rescheduling." />}
          </>}
        </ComposerSection>
        <ComposerSection number={3} title="Date" complete={!!service && validDate(selection.date) && !dateEditing}
          value={service && !dateEditing ? `${dateLabel(selection.date)}${selection.date === today ? " · Today" : ""}` : undefined}
          trailing={service && !dateEditing ? <Action label="Change date" secondary disabled={locked} onPress={() => setDateEditing(true)} /> : undefined}>
          {!service ? <Text style={s.muted}>Choose a service first.</Text> : dateEditing && <>
            <DateControls composing date={selection.date} today={today} disabled={locked} onChange={(date) => change({ date })} />
            {!validDate(selection.date) && <Notice message="Enter a valid date as YYYY-MM-DD." error />}
            <Action label="Use this date" secondary disabled={locked || !validDate(selection.date)} onPress={() => setDateEditing(false)} />
          </>}
        </ComposerSection>
        <ComposerSection number={4} title="Available time" complete={!!selectedTime && !timeEditing}
          value={selectedTime && !timeEditing ? timeLabel(selectedTime) : undefined}
          trailing={selectedTime && !timeEditing ? <Action label="Change time" secondary disabled={locked} onPress={() => setTimeEditing(true)} /> : undefined}>
          {!selection.serviceId ? <Text style={s.muted}>Available times will appear after you select a service.</Text> : <>
            {availability.loading && <><ActivityIndicator accessibilityLabel="Checking availability" color={t.colors.emerald} /><Text style={s.muted}>Checking the business schedule…</Text></>}
            {availability.error && <><Notice message={availability.error} error /><Action label="Retry availability" secondary disabled={locked} onPress={() => { change({}); availability.refresh(); }} /></>}
            {availability.data?.code === "CLOSED" && <Notice message="The business is closed on this date. Choose another date." />}
            {availability.data?.code === "NO_AVAILABILITY" && <Notice message="No available times for this service on this date. Choose another date." />}
            {(!selectedTime || timeEditing) && <View style={s.row}>{availability.data?.slots.map((time) => <Action key={time} label={timeLabel(time)} secondary selected={time === selectedTime} disabled={locked}
              onPress={() => { setSelection((previous) => ({ ...previous, time })); setTimeEditing(false); setMessage(""); }} />)}</View>}
          </>}
        </ComposerSection>
      </>} />
  </KeyboardAvoidingView>;
}
