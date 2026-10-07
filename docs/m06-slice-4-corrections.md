# M06 Slice 4 — Immutable Time Correction Foundation

Scope: correction data model, one effective-ledger interpretation shared by every authoritative read and by M05 clock writes, and backend preview/commit endpoints.

Not in this slice: correction UI, Reported Issues management, Audit UI, reports or exports. Native code is unchanged.

The forward migration is `202610050001_m06_time_corrections.sql`. It has **not** been applied anywhere live. No deployment, commit or push occurred. The Slice 1 migration is also still unapplied live, and Slice 4 depends on it.

No "Slice-0 audit" document exists in this repository, so the model below was designed from the actual M05/Slice 1–3 code.

## 1. Model

**Immutable history**
- **`employee_time_events`:** M05 originals. Unchanged: never updated or deleted, and still written only by `m05_record_time_event`.
- **`employee_time_corrections`:** one row per committed batch.
  - Fields: business, employee, per-employee `revision` (1, 2, 3 …), the `base_watermark` (max original seq it was validated against), `request_id`, a SHA-256 `request_hash` of the canonical payload, a required trimmed `reason` (1–500 characters), and a database timestamp.
- **`employee_time_correction_entries`:** ordered operations (1–20 per batch).
  - Fields: `operation`, `target_event_id`, `after_event_id` / `at_start`, `event_type`, `break_type`, `occurred_at`. A check constraint enforces each operation's shape.

**Operations**
- **INSERT:** splices a new logical event immediately after an anchor event, or at the start. Its logical id is the entry id. It creates no `employee_time_events` row.
- **REPLACE:** changes `occurred_at` and (for break events only) `break_type` of one live logical event. Its position and event type never change; a different event type is VOID + INSERT. This is the smallest safe capability: changing type would require re-validating the meaning of both ends of shifts and breaks.
- **VOID:** removes one live logical event from the interpretation. Its slot stays as an anchor. VOID is final: a voided event can't be replaced or voided again.
- **Reversal is always another append-only revision:**
  - VOID an inserted event.
  - REPLACE with the previous values.
  - Re-INSERT after a voided slot to restore it.

**Derived projection: `employee_time_effective_events`**
- The live result of the fold. Columns: `id` (logical id), `seq` (effective order), `event_type`, `break_type`, `occurred_at`, plus provenance (`origin` original/inserted, `replaced`, `correction_id`, `correction_revision`).
- It isn't history and is never edited directly. Exactly two definer paths write it:
  - The `AFTER INSERT` trigger on originals appends each new real event at the end, under the M05 employee lock, with `seq = greatest(original seq, max + 1)`.
  - A correction commit replaces the employee's rows from the fold.
- **Write protection:**
  - Privileges: service_role has SELECT only.
  - A row guard refuses writes unless the transaction is marked as the maintenance writer for that business:employee, even if privileges are granted later.
  - TRUNCATE always fails.
  - Deleting the whole business still cascades.
- **Backfill:** the migration copies every existing original with the same id and seq. Without corrections, the projection is identical to the original ledger (tested, including the backfill).

**Why originals stay immutable.** A correction never edits or deletes an original. The M05 UPDATE/TRUNCATE/DELETE guards are unchanged and re-tested. An original's effective values can only change through a REPLACE or VOID entry, and the original row always remains to show what was actually recorded.

## 2. Identity and order

- **Logical id:** the original's `employee_time_events.id`, or the INSERT entry's id. Operations target logical ids, never timestamps, indexes or display order. Timesheet event ids are these logical ids.
- **Order** comes from the fold, not from numeric positions:
  1. Start from the originals in M05 `seq` order.
  2. Replay every entry in `(revision, ordinal)` order.
  3. Each INSERT is spliced directly after its stored anchor.
- **Anchors:** the API accepts `after`, `before` (resolved and stored as "after the predecessor slot", voided slots included, or the start), `atStart`, or `afterRef` (an earlier insert in the same batch, by client `ref`).
- **Effects:**
  - Same-timestamp originals keep their seq order.
  - Several inserts at one instant are deterministic.
  - Replacements keep their position; voids don't reorder anything.
  - Later corrections can target inserted events.
  - Later real originals always land last, because corrections only anchor to events that already exist.
- **Why not numeric positions:** decimal or float positions have precision, overflow and rebalancing problems. The fold has none, needs no rebalancing, and is reproducible from history.
- **Projection `seq`:** equals the original seq until a correction rebuilds that employee (then 1..n), so the existing integer-seq readers work unchanged.

## 3. Revision and watermark

- **Values:** an employee's revision is `max(revision)` (0 if none). The watermark is the max original `seq` for that employee (0 if none). Preview returns both (`basedOnRevision`, `basedOnWatermark`).
- **Commit checks:** a commit must send both, and they are compared under the lock. A mismatch returns `409 TIME_CORRECTION_STALE`, including when a real clock action happened after the preview.

## 4. Transaction and concurrency

`m06_correct_employee_time` runs entirely in one transaction:

1. Validate input; take M05's per-employee advisory lock (`zude:m05:time:<business>:<employee>`). Corrections and real clock actions for the same employee are therefore fully serialized.
2. Re-verify the actor with Slice 1's `m06_assert_management_actor` (membership and expected role; in shared mode the PIN employee, device and session, including generation, revocation and expiry). These row locks are held to commit.
3. Lock the target employee row (`FOR SHARE`) and apply the hierarchy.
4. Check request-key replay or conflict.
5. Compare the expected revision and watermark.
6. Fold the current history, validate it, apply and resolve the proposed operations, then validate the result.
7. Insert the batch and entries, rebuild the projection, and insert one audit row.

Any failure rolls back everything.

**Lock order:** time lock → actor rows → target row. Team writes take the tenant lock → actor rows → target `FOR UPDATE` and never take the time lock, so there is no lock cycle.

**Preview** runs the same function with `p_commit = false`. It applies the projection inside a subtransaction, reads the week window, and rolls the subtransaction back. Nothing persists, and a preview never authorizes a commit.

## 5. Validation (shared with M05)

**One transition rule.** `m06_time_next_state(state, event, breakType)` is the single M05 state machine:
- OFF → CLOCK_IN → WORKING
- WORKING → BREAK_START PAID/MEAL → on break
- On break → matching BREAK_END → WORKING
- WORKING → CLOCK_OUT → OFF

**Whole-ledger validation.** `m06_time_validate` walks the entire effective ledger with this rule. Every event must also be at or after its predecessor and not later than the database `clock_timestamp()` (no tolerance).

This rejects:
- CLOCK_OUT while off, and duplicate CLOCK_IN.
- BREAK_END while not on a break; nested or mismatched breaks.
- Decreasing time, or a REPLACE that moves an event past a neighbor.
- Future events.
- Overlapping shifts: a shift inside a shift fails the transition rule; a shift overlapping in time fails ordering.

**Failure responses.**
- Rejections return `422 TIME_CORRECTION_INVALID`, with a fixed `reason` code (`INVALID_TRANSITION`, `OUT_OF_ORDER`, `FUTURE_EVENT`, `TARGET_NOT_FOUND`, `TARGET_VOIDED`, `ANCHOR_NOT_FOUND`, `INVALID_OPERATION`) and the logical `eventId`. No other data is returned.
- Malformed input returns `400 INVALID_REQUEST`.
- Timestamps must include `Z` or an offset and be on or after 2000-01-01.

## 6. M05 clock writes consume the corrected state

`m05_record_time_event` is replaced in place (same signature and grants). It keeps:
- identity assertion, lock and request-id replay;
- database timestamping (`greatest(clock, latest effective time)`);
- clock-out-on-break writing BREAK_END then CLOCK_OUT at one instant.

Two things change:
- The current state comes from the latest **effective** event.
- Each event to be written is checked with `m06_time_next_state`.

A real action still writes immutable `employee_time_events` rows only; corrections never turn into real events. So after a manager inserts a historical CLOCK_OUT for a raw open shift, the employee's next CLOCK_IN is accepted.

## 7. Reads

`server/time-ledger.ts` now reads `employee_time_effective_events` for every authoritative path:
- `employeeLedger`: Time Clock and My Time.
- `workingLedger`: Who's Working, using the projection's composite employee FK for the embedded heads.
- `historicalLedger`: Timesheets.

Calculation helpers, response contracts and limits are unchanged. Timesheet events gain management-only provenance: `origin`, `corrected`, `correctionRevision`. Employee endpoints expose no provenance, and My Time stays self-only and current-week-only. `resolveWeek` was extracted unchanged so Timesheets and previews share the week contract. `m06_effective_window` implements Slice 3's carry-in/carry-out window over the projection for previews; a test proves a preview equals the committed Timesheet.

**Read consistency correction (Slice 4.1).** Count and first/last-ID checks do **not** prevent mixed interpretations. A correction between pages preserved logical IDs and counts while changing timestamps: old worked time 15,060,000 ms, mixed HTTP 200 response 15,090,000 ms, new worked time 15,120,000 ms. Shared readers now validate original-event watermark and correction revision before/after the entire attempt, retry once from scratch, then return safe `503 TIME_LEDGER_CHANGED`. See [Slice 4.1](m06-slice-4-1-ledger-consistency.md) for the migration, MVCC argument, tests and remaining real multi-connection PostgreSQL validation.

## 8. API (backend only)

- `POST /api/management/timesheets/:employeeId/corrections/preview`
  - Body: `{ operations, weekStart? }`.
  - Returns the Timesheet response shape computed from the corrected ledger, plus `preview: true` and `correction: { basedOnRevision, basedOnWatermark, resultingState }`.
  - Inserted events in a preview carry **provisional** ids; their permanent logical id is assigned at commit.
- `POST /api/management/timesheets/:employeeId/corrections`
  - Requires a UUID `Idempotency-Key`.
  - Body: `{ operations, reason, expectedRevision, expectedWatermark, weekStart? }`.
  - Returns `201` with the fresh authoritative Timesheet and `correction: { id, revision, watermark, replayed }`. An exact replay returns `200` with `replayed: true`.

Operations:

```
{ op: "INSERT", type, breakType?, occurredAt, after | before | afterRef | atStart, ref? }
{ op: "REPLACE", target, occurredAt, breakType? }
{ op: "VOID", target }
```

**Errors**
- 400 `INVALID_REQUEST`, `INVALID_WEEK`, `FUTURE_WEEK`.
- 401 `IDENTITY_UNAUTHORIZED`.
- 403 `ROLE_FORBIDDEN` / `EMPLOYEE_FORBIDDEN`.
- 404 `EMPLOYEE_NOT_FOUND`.
- 409 `TIME_CORRECTION_STALE` (with the current revision and watermark) and `TIME_REQUEST_CONFLICT`.
- 422 `TIME_CORRECTION_INVALID`.
- 503 `TIME_UNAVAILABLE`.

No generic client RPC exists; clients have no table or function access.

## 9. Authority

HTTP runs `authorizedMember → managementAuthority`, then a target lookup, then the hierarchy pre-check. SQL then re-enforces all of it transactionally:
- An employee PIN or staff account is forbidden.
- A manager (account or shared PIN) corrects regular employees only.
- An owner corrects employee, manager and owner employees (the same policy as Team and Timesheets). This includes the owner's own employee record, which is audited.
- Actor demotion, PIN demotion, session or device revocation, and target promotion between the HTTP check and commit all fail without writing anything (tested by mutating the database between the two).

## 10. Audit and idempotency

**Audit.** Each committed correction writes exactly one `employee_management_actions` row with action `time.corrected`. It records:
- business, subject employee, and account user;
- authority mode and roles, plus shared-device employee/device/session IDs when applicable;
- actor name snapshot and database time;
- the required `reason` and the `correction_id` (composite FK);
- before and after summaries: revision, watermark, state, event count, and operation count.

The Slice 1 audit constraints were extended in the forward migration; the Team rows' snapshot rules are unchanged. Credentials, tokens, PIN hashes and salts are never stored, which is tested by scanning stored rows and column names. Provenance can be rebuilt as untouched originals + corrections + entries → fold, and tests assert the fold equals the projection after every change.

**Idempotency.**
- The key is scoped per business + employee. The hash covers operations, reason, expected revision and expected watermark.
- Replay is checked before the stale check, so a retry after a committed-but-lost response replays the original instead of reporting stale. It still re-verifies authority first.
- The same key with a different payload returns `TIME_REQUEST_CONFLICT`.

## 11. Tests and verification

- **`tests/m06-time-corrections.test.cjs`:** 24 tests covering items 1–66 of the brief, grouped by area. It requires PGlite and fails rather than skipping without it.
- **Fixture changes:**
  - `tests/support/pglite-db.cjs` applies the Slice 4 migration and passes the SQL error detail through.
  - `tests/support/working-fixture.cjs` intercepts only the Who's Working query shapes and exposes a test-session helper.
  - Slice 2/3 wire tests now assert the effective table.
- **Mutation check:** 22 deliberate breakages of the Slice 4 rules (raw-ledger M05 validation, raw readers, each validation rule, stale/watermark/idempotency checks, trigger append, splice direction, preview rollback, audit, hierarchy, actor/target re-verification, order/position/void semantics, provenance) are all caught.

**Requires real multi-connection PostgreSQL before deployment.** PGlite runs one connection, so these were verified only for serialized outcomes and lock placement:
- Two corrections with the same expected revision: exactly one commits.
- A correction racing a real clock action for the same employee: exactly one succeeds, and the ledger stays valid.
- A correction racing a Team change to the target/actor, or session/device revocation: no deadlock, all-or-nothing commit.
- A Timesheet / Who's Working read racing a correction commit: either the old or the new interpretation, or a safe 503, never a mix.

Also confirm `employee_time_effective_events` is in the deployed PostgREST schema cache; Who's Working depends on its FK embedding.

## 12. Deployment notes

- Apply after the Slice 1 migration, with the Slice 4 API.
- The backfill copies existing originals. Afterwards, check that the counts and ids match `employee_time_events` (the identity query is in the tests).
- The new `m05_record_time_event` reads the projection, so old API workers stay compatible. New API workers require the migration, because readers query the new table.
