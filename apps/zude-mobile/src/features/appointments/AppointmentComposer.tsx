import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getAvailability, getCustomers, getServices, type Appointment, type Customer } from "../../lib/appointments-api";
import { useBusiness } from "../business/BusinessContext";
import { performAction } from "./requestKeys";
import { isSlotConflict, recoverConflict, safeMessage, timeLabel, uncertainAction, validDate } from "./state";
import { useResource } from "./useResource";
import { Action, DateControls, Notice, s } from "./controls";

export function AppointmentComposer({ initialDate, today, appointment, onClose, onSaved, onView }: {
  initialDate: string; today: string; appointment?: Appointment; onClose: () => void;
  onSaved: (appointment: Appointment) => void; onView: (appointment: Appointment) => void;
}) {
  const { business, userId } = useBusiness();
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
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!locked) onClose(); }}>
    <SafeAreaView style={s.page}>
      <KeyboardAvoidingView style={s.page} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.content, { width: "100%", maxWidth: 920, alignSelf: "center" }]}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text accessibilityRole="header" style={s.title}>{success ? (appointment ? "Appointment Rescheduled" : "Appointment Booked") : appointment ? "Reschedule Appointment" : "New Appointment"}</Text>
            <Action label={success ? "Done" : "Close"} secondary disabled={locked} onPress={onClose} />
          </View>
          <Text style={s.muted}>{business.name} · {business.timezone}</Text>
          {success ? <View style={s.section}>
            <Text style={s.heading}>{success.customer_name}</Text><Text style={s.text}>{success.service}</Text>
            <Text style={s.text}>{success.appointment_date} · {timeLabel(success.appointment_time)}</Text>
            <Action label="View Appointment" onPress={() => onView(success)} />
          </View> : <>
            <View style={s.section}>
              <Text style={s.heading}>Customer</Text>
              {customer ? <View style={s.row}><Text style={s.text}>{customer.full_name}</Text>
                {!appointment && <Action label="Change customer" secondary disabled={locked} onPress={() => setCustomer(null)} />}</View>
                : <>
                  <TextInput accessibilityLabel="Search customers by name" placeholder="Search customers by name" value={search} editable={!locked} onChangeText={setSearch} style={s.input} />
                  {customers.loading && <ActivityIndicator accessibilityLabel="Loading customers" />}
                  {customers.error && <><Notice message={customers.error} /><Action label="Retry customers" secondary onPress={customers.refresh} /></>}
                  {customers.data?.customers.map((item) => <Pressable accessibilityRole="button" disabled={locked} key={item.id} style={s.option} onPress={() => setCustomer(item)}>
                    <Text style={s.text}>{item.full_name}</Text><Text style={s.muted}>{item.phone || "No phone number"}</Text>
                  </Pressable>)}
                  {customers.data?.customers.length === 0 && <Text style={s.muted}>No matching customers. Add customers in the existing web workspace.</Text>}
                  <View style={s.row}>
                    {offset > 0 && <Action label="Previous customers" secondary onPress={() => setOffset(Math.max(0, offset - 25))} />}
                    {customers.data?.nextOffset != null && <Action label="More customers" secondary onPress={() => setOffset(customers.data!.nextOffset!)} />}
                  </View>
                </>}
            </View>
            <View style={s.section}>
              <Text style={s.heading}>Service</Text>
              {services.loading && <ActivityIndicator accessibilityLabel="Loading services" />}
              {services.error && <><Notice message={services.error} /><Action label="Retry services" secondary onPress={services.refresh} /></>}
              {appointment ? <Text style={s.text}>{appointment.service} · {service?.duration_minutes ?? "—"} min</Text>
                : <View style={s.row}>{services.data?.map((item) => <Action key={item.id}
                  label={`${item.name} · ${item.duration_minutes} min${item.id === selection.serviceId ? " ✓" : ""}`}
                  secondary={item.id !== selection.serviceId} disabled={locked || !(item.duration_minutes > 0)}
                  onPress={() => change({ serviceId: item.id })} />)}</View>}
              {services.data?.length === 0 && <Text style={s.muted}>No active services. Configure services in the existing web workspace.</Text>}
              {appointment && services.data && !service && <Notice message="This service is no longer active. Review it in the existing web workspace before rescheduling." />}
            </View>
            <View style={s.section}>
              <Text style={s.heading}>Date & available time</Text>
              <DateControls date={selection.date} today={today} disabled={locked} onChange={(date) => change({ date })} />
              {!validDate(selection.date) && <Notice message="Enter a valid date as YYYY-MM-DD." />}
              {!selection.serviceId && <Text style={s.muted}>Select a service to check available times.</Text>}
              {availability.loading && <><ActivityIndicator accessibilityLabel="Checking availability" /><Text style={s.muted}>Checking the business schedule…</Text></>}
              {availability.error && <><Notice message={availability.error} /><Action label="Retry availability" secondary disabled={locked} onPress={() => { change({}); availability.refresh(); }} /></>}
              {availability.data?.code === "CLOSED" && <Notice message="The business is closed on this date. Choose another date." />}
              {availability.data?.code === "NO_AVAILABILITY" && <Notice message="No available times for this service on this date. Choose another date." />}
              <View style={s.row}>{availability.data?.slots.map((time) => <Action key={time} label={timeLabel(time)} secondary={time !== selectedTime} disabled={locked}
                onPress={() => { setSelection((previous) => ({ ...previous, time })); setMessage(""); }} />)}</View>
              {availability.data && <Text style={s.muted}>Availability is checked live. The time is secured only when the appointment is saved.</Text>}
            </View>
            <View style={s.section}>
              <Text style={s.heading}>Review</Text>
              <Text style={s.text}>{customer?.full_name || "Select a customer"} · {service?.name || "Select a service"}</Text>
              <Text style={s.text}>{selection.date} · {selectedTime ? timeLabel(selectedTime) : "Select an available time"}{service ? ` · ${service.duration_minutes} min` : ""}</Text>
              {message ? <Notice message={message} /> : null}
              {pending && !busy && <Notice message="The save outcome is uncertain. Retry this same request before changing selections or closing." />}
              <Action label={busy ? "Saving…" : pending ? "Retry Same Request" : appointment ? "Save Reschedule" : "Book Appointment"} disabled={busy || (!ready && !pending)} onPress={() => void submit()} />
            </View>
          </>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
