# M06 Slice 5 — Management Correction UI

Native client only. It uses the Slice 4 preview/commit API unchanged. There are no migrations, backend changes or new dependencies, and no deployment, commit or push occurred.

Not in this slice: Reported Issues management, Audit screen, Reports/Export, scheduling, payroll, voice.

## Workflow

Corrections live inside **Management Timesheets**. There is no separate navigation destination, and nothing in My Time, Time Clock or the Clock-In Landing.

1. Choose an employee, a business week and a day.
2. Tap **Correct time** (secondary, under the day's shifts and entries). This opens a correction panel for that day only.
3. Choose what needs correcting. Each action is shown only when it applies to the day:

   | Action | Server operation |
   |---|---|
   | Add missing clock-out (open shift) | INSERT CLOCK_OUT |
   | Add missing break end (shift ends on an open break) | INSERT BREAK_END |
   | Add a missed break (paid or meal) | INSERT BREAK_START + BREAK_END |
   | Add missing clock-in and clock-out | INSERT CLOCK_IN + CLOCK_OUT |
   | Correct an entry's time | REPLACE time; same position and type |
   | Change a break between paid and meal | REPLACE break type on both ends |
   | Remove a mistaken entry (or the whole break / whole shift) | VOID |

   Event-type changes aren't offered, because Slice 4 requires VOID + INSERT for them.
4. Enter the details, then tap **Preview correction**. Nothing is committed without a successful server preview: commit controls only exist on the preview's review screen.
5. **Review** shows the server's authoritative result:
   - the changes in plain language;
   - this week's worked, paid-break and meal-break totals, before → after;
   - open shift before → after, when it changes;
   - every affected day, flagged when more than one day changes (overnight shifts);
   - the employee's resulting state (Off the clock / Working / on a break).

   Removing an entry says the original stays in ZUDE's history and is only left out of calculated time. Nothing is ever described as deleted.
6. Enter a **required reason** (1–500 characters, trimmed, the server contract). It's never prefilled, and whitespace-only reasons are rejected.
7. Tap **Save correction**, then confirm with **Yes, save correction**. The confirmation warns that the correction is recorded with your name and reason, and can only be changed later by another correction.
8. On success, the returned authoritative Timesheet replaces the view (no extra read and no optimistic change), the panel closes, and "Correction saved" is shown. An exact server replay is treated as a success.

## Stale, invalid and uncertain responses

- **`TIME_CORRECTION_STALE`:** shows "Time history changed since this correction was reviewed". The preview and commit intent are discarded and the Timesheet refreshes. The draft is kept, but a new preview, reason and confirmation are required. There is never an automatic re-commit.
- **Invalid corrections:** each server reason maps to guidance:
  - `INVALID_TRANSITION`: an impossible sequence.
  - `OUT_OF_ORDER`: times must stay in order.
  - `FUTURE_EVENT`: the time is in the future.
  - `TARGET_NOT_FOUND` / `TARGET_VOIDED` / `ANCHOR_NOT_FOUND`: refresh and choose again.
  - `INVALID_OPERATION`: that change isn't available for this entry.

  Raw server or database text is never shown. The shared API error now carries a safe `reason` code (A–Z format only) for this.
- **Authority loss** (401/403/employee not found): the panel hands the error to the screen, which clears the selection, shows a safe access message and reloads the directory.
- **Uncertain commit** (network error, 5xx, or an unverifiable response): shows "ZUDE didn't confirm whether this correction was saved". The intent (idempotency key and exact request) is kept, editing and Close are disabled, and **Retry saving** sends the identical request. **Discard and refresh** drops the intent and refreshes, explaining that a saved correction would now appear in the timesheet.

## Idempotency

- One idempotency key per reviewed correction, created when the manager first confirms. Every retry of that intent reuses the same key and request.
- Editing the proposal, choosing a different correction, or getting a new preview discards the intent; the next confirmation creates a new key.
- A submitting guard blocks double taps for both preview and commit.

## Business time zone

- **Entry:** times are typed as business-local date and time (`5:30 PM` or `17:30`) in the Timesheet's authoritative timezone. Each time field shows the zone (for example `America/Los_Angeles (PST)`). The iPad's own timezone is never used.
- **DST:** the client converts a wall time to an exact instant only so it can send one, using the same Intl timezone data the app already uses for display.
  - A time in a spring-forward gap is refused with an explanation.
  - A time that occurs twice at fall-back must be chosen explicitly (for example `1:30 AM PDT` or `1:30 AM PST`).
  - The server preview then shows how the time was understood, and the server validates everything.

## Positioning (anchors)

Operations use the stable logical event ids returned by the Timesheet API, never list indexes:
- **Clock-out or break end:** inserted after the shift's last entry.
- **Breaks:** start after the last entry in that shift at or before the break start; the end follows the start.
- **Missing shift:** after the last entry in the week at or before the clock-in time, or before the next entry.

## Identity and Lock lifecycle

- **What's held:** draft, preview, reason, confirmation and intent live only in panel component state.
- **Remounting:** the panel is keyed by account, business, management role, PIN identity/session, focus, employee, week and day. Any change unmounts it, and all of that state is dropped. This covers Lock, logout, business change, PIN identity or session change, authority change, leaving the screen, and changing employee, week or day.
- **In-flight requests:** previews are aborted on unmount or when the draft changes. A late preview or commit response after unmount is ignored and can't repopulate anything.
- **Unchanged:** `EmployeeIdentityContext` and its verified publication lifecycle.

## Provenance

Management Timesheet entries show a small text badge only when relevant: **Added by correction** (inserted) or **Corrected** (time or break type changed). Normal entries are unchanged. Labels are text, not color alone. Employee My Time is unchanged.

## Visibility versus authority

The **Correct time** control mirrors the server hierarchy: an owner sees it for any target, a manager only for regular employees, and an employee PIN, staff account or locked device gets no Timesheets at all. This is presentation only. The server re-verifies authority on every preview and commit.

## Tests

- **New `tests/native-timesheet-corrections.test.cjs`** (20 tests):
  - client API: transport, headers, idempotency key, reason codes, response validation;
  - business timezone and DST handling;
  - every human action building operations with stable ids;
  - plain-language review, multi-day impact, and that nothing is described as deleted;
  - error guidance;
  - rendered panel flows: preview-before-commit, required reason, confirmation, success/replay, stale, uncertain retry, edit invalidation, double taps, late responses after unmount;
  - screen integration: visibility by role, success replacement, lifecycle removal, provenance badges.
- **Updated `tests/native-timesheets.test.cjs`:** the read-only regression now allows only the deliberate "Correct time" entry point.
- **Mutation check:** 18 deliberate breakages of the safeguards. All but one are caught, and one more needed a corrected mutation to be caught. The survivor removes a redundant preview-clearing call; "Change correction" already clears the preview, so the change isn't observable.

## Physical iPad checklist (to run later, after deployment)

1. Open Timesheets, then choose an employee, week and day with an open shift.
2. Correct time → Add missing clock-out → enter a business-local time → Preview.
3. Check the before/after totals, open-shift change, affected days and resulting state.
4. Enter a reason, Save correction, Yes, save correction. The timesheet should update and show "Added by correction".
5. Refresh Who's Working. The employee should be Off the clock.
6. On the employee's PIN, Time Clock shows Off the clock. Do the next real Clock In; it succeeds.
7. Correct an entry's time; change a break between paid and meal; remove a mistaken break. Each preview, then save.
8. Open a draft, then Lock. Unlock: the draft, preview and reason are gone.
9. Stale scenario: preview a correction, have the employee clock an action on another iPad, then save. Expect the "Time history changed" message and a required new preview.
10. Uncertain scenario: turn on airplane mode after confirming. Expect the "didn't confirm" state. Reconnect and Retry saving: exactly one correction is saved.
11. Fall-back day: enter `1:30 AM` and confirm both choices are offered.
12. Check landscape iPad layout, iPhone stacked layout and large text for the panel and review.

## Remaining limitations

- **Empty week:** adding a shift to a week with no recorded entries isn't available yet, because no anchor exists in the loaded week. The UI explains this. A server-side "place chronologically" insert option would need a SQL function change in a later slice.
- **Text time entry:** times are typed text (date + time); there is no picker yet. This deliberately avoids device-timezone pickers.
- **No correction history view:** the reason and author shown per entry are left to the future Audit screen. Provenance shows only that an entry was corrected.
- **Not yet verified:** physical-device acceptance and deployed-API behavior.
