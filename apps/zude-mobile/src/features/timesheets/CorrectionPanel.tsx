import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Button, styles as ui } from "../../components/ui";
import { LabeledField, recordStyles as rs } from "../../components/records";
import { PaneTitle } from "../../components/workspace";
import { ZudeApiError } from "../../lib/api";
import { commitTimeCorrection, previewTimeCorrection, type CorrectionCommit, type CorrectionOperation, type CorrectionPreview, type LedgerEvent, type Timesheet } from "../../lib/timesheets-api";
import type { TimeDay } from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { formatDay } from "../time/state";
import { Notice } from "../appointments/controls";
import { authorityLost, breakPair, buildOperations, commitUncertain, correctionMessage, describeOperations, eventLabel, previewChanges, resolveTime, shiftEvents, stateLabel, timeProblem, when, zoneName, type Draft, type TimeField } from "./correction";

export const REASON_MAX = 500; // server contract (m06_correct_employee_time)
type Action = "add-clock-out" | "add-break-end" | "add-break" | "add-shift" | "correct-time" | "change-break-type" | "remove";
type Phase = "choose" | "edit" | "review" | "uncertain";
type Previewed = { result: CorrectionPreview; operations: CorrectionOperation[]; fingerprint: string };
type Intent = { key: string; request: CorrectionCommit };

// Corrections are deliberate: choose → enter details → server preview →
// review the authoritative before/after → required reason → explicit confirm
// → commit. Nothing changes until the server confirms, and the panel is
// remounted (all draft, preview, reason and retry state dropped) whenever the
// account, business, PIN identity, role, employee, week or day changes.
export function CorrectionPanel({ businessId, userId, sheet, day, onCommitted, onStale, onAuthorityLost, onClose }: {
  businessId: string; userId: string; sheet: Timesheet; day: TimeDay;
  onCommitted: (timesheet: Timesheet, replayed: boolean) => void; onStale: () => void; onAuthorityLost: (error: unknown) => void; onClose: () => void;
}) {
  const tz = sheet.timezone;
  const [phase, setPhase] = useState<Phase>("choose");
  const [action, setAction] = useState<Action | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Previewed | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  // One commit intent (idempotency key + exact request) per reviewed correction.
  const [intent, setIntent] = useState<Intent | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; previewRequest.current?.abort(); }; }, []);
  // A changed proposal makes any in-flight preview irrelevant.
  useEffect(() => () => previewRequest.current?.abort(), [draft]);

  const dayShiftIds = new Set(day.shifts.map(s => s.id));
  const dayEvents = sheet.events.filter(e => dayShiftIds.has(e.shiftId));
  const lastOf = (shiftId: string) => shiftEvents(sheet, shiftId).at(-1);
  const missingOut = day.shifts.filter(s => { const last = lastOf(s.id); return !!last && last.type !== "CLOCK_OUT" && last.type !== "BREAK_START"; });
  const openBreak = day.shifts.filter(s => lastOf(s.id)?.type === "BREAK_START");
  const field = (time = ""): TimeField => ({ date: day.date, time });
  const actions: { action: Action; label: string; enabled: boolean }[] = [
    { action: "add-clock-out", label: "Add missing clock-out", enabled: missingOut.length > 0 },
    { action: "add-break-end", label: "Add missing break end", enabled: openBreak.length > 0 },
    { action: "add-break", label: "Add a missed break", enabled: day.shifts.length > 0 },
    { action: "add-shift", label: "Add missing clock-in and clock-out", enabled: true },
    { action: "correct-time", label: "Correct an entry’s time", enabled: dayEvents.length > 0 },
    { action: "change-break-type", label: "Change a break between paid and meal", enabled: dayEvents.some(e => e.type === "BREAK_START") },
    { action: "remove", label: "Remove a mistaken entry", enabled: dayEvents.length > 0 },
  ];
  // Any change to the proposal discards the preview and its commit intent.
  function setDraft(next: Draft | null) {
    setDraftState(next); setPreview(null); setConfirming(false); setIntent(null); setMessage(null);
    if (phase === "review") setPhase("edit");
  }
  function start(next: Action) {
    setAction(next); setPhase("edit");
    const first = (list: { id: string }[]) => list[0]?.id ?? "";
    setDraft(next === "add-clock-out" ? { kind: next, shiftId: first(missingOut), at: field() }
      : next === "add-break-end" ? { kind: next, shiftId: first(openBreak), at: field() }
      : next === "add-break" ? { kind: next, shiftId: first(day.shifts), breakType: "PAID", start: field(), end: field() }
      : next === "add-shift" ? { kind: next, clockIn: field(), clockOut: field() }
      : next === "correct-time" ? { kind: next, eventId: "", at: field() }
      : next === "change-break-type" ? { kind: next, eventId: "", to: "MEAL" }
      : { kind: "remove", eventIds: [] });
  }
  async function runPreview() {
    if (!draft || submitting.current) return;
    const built = buildOperations(draft, sheet);
    if (!built.ok) { setMessage({ text: built.message, error: true }); return; }
    submitting.current = true; setBusy(true); setMessage(null);
    const controller = new AbortController(); previewRequest.current = controller;
    try {
      const result = await previewTimeCorrection(businessId, sheet.employee.id, { operations: built.operations, weekStart: sheet.week.startDate }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setPreview({ result, operations: built.operations, fingerprint: JSON.stringify(built.operations) });
      setReason(""); setConfirming(false); setIntent(null); setPhase("review");
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      if (authorityLost(error)) { onAuthorityLost(error); return; }
      setMessage({ text: correctionMessage(error), error: true });
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!preview || submitting.current) return;
    const trimmed = reason.trim();
    let current = intent;
    if (!current) {
      if (!trimmed || trimmed.length > REASON_MAX) { setMessage({ text: "Enter a reason for this correction.", error: true }); return; }
      current = { key: randomUUID(), request: { operations: preview.operations, reason: trimmed, expectedRevision: preview.result.basedOnRevision,
        expectedWatermark: preview.result.basedOnWatermark, weekStart: sheet.week.startDate } };
      setIntent(current);
    }
    // Exactly the same key and request on every retry of this intent.
    submitting.current = true; setBusy(true); setMessage(null);
    try {
      const receipt = await commitTimeCorrection(businessId, sheet.employee.id, userId, current.request, current.key);
      if (!alive.current) return;
      setIntent(null);
      onCommitted(receipt.timesheet, receipt.replayed);
    } catch (error) {
      if (!alive.current) return;
      setConfirming(false);
      if (commitUncertain(error)) { setPhase("uncertain"); return; }
      setIntent(null); setPreview(null);
      if (authorityLost(error)) { onAuthorityLost(error); return; }
      if (error instanceof ZudeApiError && error.code === "TIME_CORRECTION_STALE") onStale();
      setPhase("edit"); setMessage({ text: correctionMessage(error), error: true });
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function discardUncertain() {
    setIntent(null); setPreview(null); setReason(""); setConfirming(false); setPhase("edit");
    setMessage({ text: "If the correction was saved, it now appears in the refreshed timesheet. Check before trying again." });
    onStale();
  }

  const timeInput = (label: string, value: TimeField, change: (next: TimeField) => void) => {
    const resolved = resolveTime(value, tz);
    return <View style={s.time}>
      <View style={ui.row}>
        <View style={ui.grow}><LabeledField label={`${label} date`} value={value.date} onChangeText={date => change({ ...value, date, choice: undefined })} placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} maxLength={10} editable={!busy} /></View>
        <View style={ui.grow}><LabeledField label={`${label} time`} value={value.time} onChangeText={time => change({ ...value, time, choice: undefined })} placeholder="5:30 PM" autoCapitalize="none" autoCorrect={false} maxLength={8} editable={!busy}
          hint={`Business time · ${tz}${resolved.ok ? ` (${zoneName(Date.parse(resolved.iso), tz)})` : ""}`} /></View>
      </View>
      {!resolved.ok && resolved.problem === "ambiguous" ? <><Text style={s.attention}>{timeProblem(resolved, tz)}</Text>
        <View style={rs.actions}>{resolved.options.map(o => <Button key={o.iso} label={o.label} secondary onPress={() => change({ ...value, choice: o.iso })} />)}</View></>
        : !resolved.ok && resolved.problem !== "missing" ? <Text style={s.attention}>{timeProblem(resolved, tz)}</Text> : null}
    </View>;
  };
  const eventChoice = (events: LedgerEvent[], selected: string, choose: (event: LedgerEvent) => void) => <View style={rs.actions}>
    {events.map(e => <Button key={e.id} label={`${eventLabel(e)} · ${when(e.occurredAt, tz)}`} secondary selected={selected === e.id} disabled={busy} onPress={() => choose(e)} />)}
  </View>;
  const shiftChoice = (shifts: TimeDay["shifts"], selected: string, choose: (id: string) => void) => shifts.length > 1 ? <View style={rs.actions}>
    {shifts.map(sh => <Button key={sh.id} label={`Shift from ${when(sh.clockInAt, tz)}`} secondary selected={selected === sh.id} disabled={busy} onPress={() => choose(sh.id)} />)}
  </View> : null;

  function editor() {
    if (!draft) return null;
    switch (draft.kind) {
      case "add-clock-out": return <>{shiftChoice(missingOut, draft.shiftId, shiftId => setDraft({ ...draft, shiftId }))}{timeInput("Clock-out", draft.at, at => setDraft({ ...draft, at }))}</>;
      case "add-break-end": return <>{shiftChoice(openBreak, draft.shiftId, shiftId => setDraft({ ...draft, shiftId }))}{timeInput("Break end", draft.at, at => setDraft({ ...draft, at }))}</>;
      case "add-break": return <>{shiftChoice(day.shifts, draft.shiftId, shiftId => setDraft({ ...draft, shiftId }))}
        <View style={rs.actions}>{(["PAID", "MEAL"] as const).map(type => <Button key={type} label={type === "PAID" ? "Paid break" : "Meal break"} secondary selected={draft.breakType === type} disabled={busy} onPress={() => setDraft({ ...draft, breakType: type })} />)}</View>
        {timeInput("Break start", draft.start, start => setDraft({ ...draft, start }))}{timeInput("Break end", draft.end, end => setDraft({ ...draft, end }))}</>;
      case "add-shift": return <>{timeInput("Clock-in", draft.clockIn, clockIn => setDraft({ ...draft, clockIn }))}{timeInput("Clock-out", draft.clockOut, clockOut => setDraft({ ...draft, clockOut }))}</>;
      case "correct-time": {
        const chosen = sheet.events.find(e => e.id === draft.eventId);
        return <><Text style={ui.body}>Which entry has the wrong time?</Text>
          {eventChoice(dayEvents, draft.eventId, e => setDraft({ ...draft, eventId: e.id, at: field() }))}
          {chosen && <><Text style={ui.meta}>Recorded: {when(chosen.occurredAt, tz)}</Text>{timeInput("Correct", draft.at, at => setDraft({ ...draft, at }))}</>}</>;
      }
      case "change-break-type": {
        const chosen = sheet.events.find(e => e.id === draft.eventId);
        return <><Text style={ui.body}>Which break?</Text>
          {eventChoice(dayEvents.filter(e => e.type === "BREAK_START"), draft.eventId, e => setDraft({ ...draft, eventId: e.id, to: e.breakType === "PAID" ? "MEAL" : "PAID" }))}
          {chosen && <Text style={ui.body}>Change this {chosen.breakType === "PAID" ? "paid" : "meal"} break to a {draft.to === "PAID" ? "paid" : "meal"} break (start and end).</Text>}</>;
      }
      case "remove": {
        const chosen = sheet.events.find(e => e.id === draft.eventIds[0]);
        const pair = chosen ? breakPair(sheet, chosen) : null;
        const shift = chosen?.type === "CLOCK_IN" ? shiftEvents(sheet, chosen.shiftId) : [];
        return <><Text style={ui.body}>Which entry was recorded by mistake?</Text>
          {eventChoice(dayEvents, draft.eventIds[0] ?? "", e => setDraft({ ...draft, eventIds: [e.id] }))}
          {pair?.start && pair.end && draft.eventIds.length === 1 && <Button label="Remove the whole break instead" secondary disabled={busy}
            onPress={() => setDraft({ ...draft, eventIds: [pair.start!.id, pair.end!.id] })} />}
          {shift.length > 1 && draft.eventIds.length === 1 && <Button label="Remove the whole shift instead" secondary disabled={busy}
            onPress={() => setDraft({ ...draft, eventIds: shift.map(e => e.id) })} />}
          {!!chosen && <Text style={ui.meta}>The original entry stays in ZUDE’s time history. Removing it only leaves it out of calculated time, and the change is recorded with your reason.</Text>}</>;
      }
    }
  }
  function review() {
    if (!preview) return null;
    const changes = previewChanges(sheet, preview.result.timesheet);
    const removing = preview.operations.some(op => op.op === "VOID");
    return <View style={s.review}>
      <PaneTitle title="Review correction" detail={`${sheet.employee.name} · business time ${tz}`} />
      <Text style={ui.strong}>What changes</Text>
      {describeOperations(preview.operations, sheet).map((line, i) => <Text key={i} style={ui.body}>• {line}</Text>)}
      {removing && <Text style={ui.meta}>Removed entries are not deleted. The original record stays in ZUDE’s history; it is left out of calculated time.</Text>}
      <Text style={ui.strong}>This week</Text>
      {changes.totals.map(row => <Text key={row.label} style={ui.body}>{row.label}: {row.before} → {row.after}{row.changed ? "  (changed)" : ""}</Text>)}
      {changes.openBefore !== changes.openAfter && <Text style={ui.body}>Open shift: {changes.openBefore ? "yes" : "no"} → {changes.openAfter ? "yes" : "no"}</Text>}
      {changes.days.length > 0 && <><Text style={ui.strong}>Days affected</Text>
        {changes.days.map(d => <Text key={d.date} style={ui.body}>{formatDay(d.date)}: {d.before} → {d.after} worked{d.shiftsBefore !== d.shiftsAfter ? ` · shifts ${d.shiftsBefore} → ${d.shiftsAfter}` : ""}</Text>)}
        {changes.days.length > 1 && <Text style={s.attention}>This correction changes more than one day.</Text>}</>}
      <Text style={ui.body}>After this correction, {sheet.employee.name} will be: {stateLabel(preview.result.resultingState)}</Text>
      <LabeledField label="Reason for this correction" value={reason} onChangeText={value => { setReason(value); setConfirming(false); }} maxLength={REASON_MAX} multiline editable={!busy}
        placeholder="For example: Employee forgot to clock out" hint={`Required · recorded with your name · ${reason.trim().length}/${REASON_MAX}`} />
      {confirming ? <View style={s.confirm}>
        <Text style={ui.strong}>Save this correction to {sheet.employee.name}’s time history?</Text>
        <Text style={ui.meta}>It is recorded with your name and reason. It can only be changed later by another correction.</Text>
        <View style={rs.actions}>
          <Button label="Yes, save correction" busy={busy} disabled={busy} onPress={() => void save()} />
          <Button label="Keep reviewing" secondary disabled={busy} onPress={() => setConfirming(false)} />
        </View>
      </View> : <View style={rs.actions}>
        <Button label="Save correction" disabled={busy || !reason.trim()} onPress={() => { if (reason.trim()) setConfirming(true); else setMessage({ text: "Enter a reason for this correction.", error: true }); }} />
        <Button label="Change correction" secondary disabled={busy} onPress={() => { setPreview(null); setIntent(null); setPhase("edit"); }} />
      </View>}
    </View>;
  }
  return <View style={s.panel} accessibilityLabel="Correct time">
    <PaneTitle title="Correct time" detail={`${formatDay(day.date)} · business time ${tz}`} action={<Button label="Close" secondary disabled={busy || phase === "uncertain"} onPress={onClose} />} />
    {!!message && <Notice message={message.text} error={message.error} />}
    {phase === "uncertain" ? <View style={s.confirm}>
      <Text style={ui.strong}>ZUDE didn’t confirm whether this correction was saved.</Text>
      <Text style={ui.meta}>Retrying sends exactly the same correction, so it can’t be saved twice.</Text>
      <View style={rs.actions}>
        <Button label="Retry saving" busy={busy} disabled={busy} onPress={() => void save()} />
        <Button label="Discard and refresh" secondary disabled={busy} onPress={discardUncertain} />
      </View>
    </View> : phase === "choose" ? <>
      <Text style={ui.body}>What needs correcting? Changes are previewed before anything is saved.</Text>
      <View style={rs.actions}>{actions.map(a => <Button key={a.action} label={a.label} secondary disabled={!a.enabled} onPress={() => start(a.action)} />)}</View>
    </> : phase === "review" ? review() : <>
      <Text style={ui.strong}>{actions.find(a => a.action === action)?.label}</Text>
      {editor()}
      <View style={rs.actions}>
        <Button label="Preview correction" busy={busy} disabled={busy || !draft} onPress={() => void runPreview()} />
        <Button label="Choose a different correction" secondary disabled={busy} onPress={() => { setDraft(null); setAction(null); setPhase("choose"); }} />
      </View>
    </>}
  </View>;
}
const s = StyleSheet.create({
  panel: { gap: t.space.md, paddingVertical: t.space.lg, paddingHorizontal: t.space.md, borderWidth: t.border, borderColor: t.colors.border, borderRadius: t.radius.md, backgroundColor: t.colors.surface },
  time: { gap: t.space.xs },
  review: { gap: t.space.sm },
  confirm: { gap: t.space.sm, padding: t.space.md, borderRadius: t.radius.sm, backgroundColor: t.colors.amberSoft },
  attention: { color: t.colors.amber, fontSize: t.font.body },
});
