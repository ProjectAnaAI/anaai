# Durable appointment duration snapshot

Covers `202609210007_appointment_duration_snapshot.sql`.

Nothing here applies migrations, and no PostgreSQL binary was available while
this was written, so **the migration has not been compiled**.

## The failure this fixes

A real local Twilio call booking Haircut on 2 October 2026 at 2:30 PM was
refused. `voice_check_appointment_availability` returned
`INVALID_EXISTING_SCHEDULE`, and the cause was not the candidate booking at all.

`appointments` stores `service` (text) and `service_id` (uuid) but **no
duration**, so every interval calculation re-derived the duration from the live
`services` catalogue. `appointments.service_id` is `ON DELETE SET NULL`, so
deleting a service nulls `service_id` on its historical appointments while
leaving the `service` text behind.

Once the service row is gone the duration is unknowable, the shared capacity
helper correctly fails closed, and **every** subsequent booking on that
business/date is blocked — by phone, by dashboard and by AI chat. A deleted
`facial` service (`e5fe29d2-d48d-4730-866a-f96c1cafab8e`) left active
appointments in exactly that state.

Those appointments were never malformed. A later catalogue edit made them
unreadable. Scheduling correctness must not depend on a service row surviving.

## The fix

`appointments.duration_minutes` records the scheduling duration that was
authoritative **when the appointment was scheduled**. It is written inside the
same statement as the appointment by every authoritative path, and read in
preference to the live catalogue for every existing-appointment interval.

Renaming, deactivating, re-timing or deleting a service no longer changes the
interval of an already-scheduled appointment, and no longer makes it impossible
to evaluate.

**Candidate vs existing:** the snapshot is authoritative for *existing*
appointments only. A new booking or reschedule still takes its duration from the
currently valid, active service row — so a genuine duration change applies to
future bookings while leaving history intact.

## Resolution order for an existing active appointment

| | Source | Applies to |
|---|---|---|
| A | `appointments.duration_minutes` | all rows once populated |
| C | the still-resolvable linked service row | legacy rows only |
| D | an **unambiguous** legacy service-name match | legacy rows only |
| E | otherwise `INVALID_EXISTING_SCHEDULE` | fail closed |

"B" from the design note (recovery from historical evidence) is deliberately
absent — see below. A duration is never guessed.

## Backfill

Only where the evidence is authoritative right now: the appointment still links
to a service row, in the same business, with a usable duration. That is the
exact value the scheduling code would have used a moment earlier, so recording
it changes no behaviour — it only makes the value durable.

Deliberately **not** backfilled:

- Rows whose `service_id` is NULL (deleted service).
- Rows resolvable only by the legacy service-**name** fallback. That fallback
  stays a live, ambiguity-safe read; freezing a present-day name match into a
  durable snapshot would promote a guess about history into authoritative data.

## Was the deleted Facial duration recoverable? No.

Searched and ruled out:

- `appointment_actions.request_payload` carries `service_id`, `date`, `time`,
  `notes` — **never a duration** (202609150003, 202609150004).
- `appointment_actions.result` embeds `to_jsonb(v_appointment)`, i.e. the
  appointments row, which had no duration column before this migration.
- There is **no services history/audit table**. The only tables this repo
  creates are `appointment_actions`, `appointment_notifications` and
  `voice_handoff_settings`.
- Onboarding does not seed a default catalogue; services come from the owner's
  own setup payload (`202609180003`, `v_service ->> 'name'`), so no repository
  default exists to appeal to. The string `facial` appears in no migration.

`appointment_actions` proves the historical **service id**; a service id does
not prove a duration. Those snapshots therefore stay NULL and keep failing
closed. **Nothing was invented to make the phone test pass.**

## Remediation for the still-unknowable rows

These rows must be resolved by a human decision, not by code. Find them:

```sql
select a.id, a.appointment_date, a.appointment_time, a.service, a.status
from public.appointments a
where a.duration_minutes is null
  and a.status in ('Booked', 'Confirmed')
order by a.appointment_date, a.appointment_time;
```

Options, in order of preference:

1. **The owner states the duration** that service had, and you set it per row.
2. **Cancel** the appointments if they are stale or no longer real. Cancelled
   and Completed rows never consume capacity and never block anything.
3. **Re-point them** at a current service whose duration is correct, which also
   restores `service_id`.

Until one is applied, any business/date holding such a row stays blocked for
new bookings. That is deliberate: the alternative is double-booking a real
customer.

## Local tests

```
node --test tests/appointment-duration-snapshot.test.cjs
```

28 tests: snapshot precedence, the deleted-service scenario, both legacy
fallbacks, fail-closed behaviour, the backfill rules, peak concurrency,
boundaries, Cancelled/Completed, the security/lock/idempotency contracts of all
four writers, and the privacy-safety of the Voice availability diagnostics.

These do not execute PL/pgSQL. The database acceptance tests below remain the
real gate.

## Required database acceptance tests before release

Everything in `tests/appointment-capacity.README.md` and
`tests/voice-capacity.README.md` still applies. In addition:

- **Compile the migration** against a disposable local database first.
- Confirm the column and constraint:
  `\d public.appointments` shows `duration_minutes integer` (nullable) and
  `appointments_duration_minutes_check`.
- Backfill correctness: before/after counts of
  `select count(*) from appointments where duration_minutes is null` and a spot
  check that each backfilled value equals its linked service's duration.
- Confirm nothing was invented: every row still NULL afterwards must have
  `service_id is null` or an unresolvable/ambiguous name.
- Book via each path (manual create, manual reschedule, Voice, AI chat) and
  assert `duration_minutes` is populated from the service row in the same
  transaction.
- Reschedule onto a **different service** and assert the snapshot is refreshed.
- Change a service's `duration_minutes`, then confirm an existing appointment's
  interval is unchanged and a **new** booking uses the new duration.
- **Reproduce the reported failure and its fix:** create a service, book an
  appointment, delete the service, then confirm `service_id` is NULL, the
  snapshot survives, and availability on that date still returns `AVAILABLE`
  for a non-overlapping slot.
- Confirm a row with a NULL snapshot and a deleted service still yields
  `INVALID_EXISTING_SCHEDULE` — the fail-closed path must not regress.
- Re-run the capacity concurrency tests: with capacity N, N+1 competing
  transactions into one interval, exactly N commit.
- Idempotency: replay a Voice and an AI booking key; the stored receipt returns
  unchanged with `replayed: true` and no duplicate row.

## Deliberately unchanged

- `ON DELETE SET NULL` on `appointments.service_id`. The snapshot, not the
  foreign key, now preserves interval semantics, so there was no demonstrated
  need to change deletion behaviour.
- Calendar behaviour and every appointment read path. The new column is
  nullable and additive; no client type enumerates appointment columns.
- Voice availability (`202609210004`) is not restated — it picks up the new
  resolution order automatically through the helper it already calls.
- Voice rescheduling and cancellation of existing appointments are **still not
  implemented**. This migration does not add them and nothing here should be
  read as claiming otherwise.
