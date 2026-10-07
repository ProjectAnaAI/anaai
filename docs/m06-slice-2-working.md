# M06 Slice 2 — Authoritative time reads and Who’s Working

Scope: shared ledger reads, `GET /api/management/working`, and native `/working` only. No migration, event changes, management history, corrections, issues workflow, audit UI, reports or exports.

## M05 semantics preserved

`server/time-calculation.ts` remains unchanged and authoritative. Events are ordered by immutable `seq`, not timestamps: M05 serializes writes per business/employee, and database-stamped `occurred_at` may be equal for consecutive events. In particular, clock-out on break atomically appends BREAK_END then CLOCK_OUT at the same timestamp. The final seq determines OFF_CLOCK.

CLOCK_IN opens a shift; BREAK_END returns to WORKING. Paid breaks remain worked time; meal breaks subtract from worked time. Open intervals end at the response's authoritative current time. The M05 current-week read carries in the CLOCK_IN of a shift already open at the week boundary. Day/week totals use `businesses.timezone`, local calendar boundaries (Monday week), and existing DST handling. Overnight shifts remain open; identity Lock, session expiry, logout and deactivation never manufacture clock events.

The original M05 reader, timezone validation and TimeFailure moved from `server/handlers/time-clock.ts` into `server/time-ledger.ts`. `/api/time-clock` and `/api/my-time` now call `employeeLedger` with the same week-start boundary and keep their original calculations and response contracts. There is no new state machine. Future correction-aware effective-event loading belongs in this reader layer, with the existing calculation inputs retained.

## Contract and authority

`GET /api/management/working` accepts no query filters, employee selector or client timezone. Existing bearer/membership resolution runs before `managementAuthority`. Account mode accepts manager/owner. Shared mode additionally verifies the device/PIN session and requires the weaker of account and employee authority to be manager/owner. Partial, invalid, expired or revoked operational credentials fail closed, without falling back to account authority. These are the existing M04/Slice 1 boundaries, unchanged.

Success returns:

- `success`, verified `businessId`, authoritative business `timezone`, and one `snapshotAt`.
- `employees`: `{ employee: { id, name, role, isActive }, state, stateStartedAt, shift, inactiveOpenShift }`.
- `state` is OFF_CLOCK, WORKING, ON_PAID_BREAK or ON_MEAL_BREAK.
- `stateStartedAt` is the latest event timestamp (null for no history).
- `shift` is null off clock, otherwise the existing M05 current shift view: clock-in ID/time, elapsed/worked/paid-break/meal-break milliseconds and current break information.

Active employees, including OFF_CLOCK, are included. Inactive employees are included only when the ledger has an unresolved open shift/break, with `inactiveOpenShift: true`. Open states sort before off-clock states, then by name/ID. No PIN, session, device, credential, hash or identity-generation fields are returned. Existing no-store response handling applies.

## Complete bounded query strategy

1. Read and validate the business timezone.
2. One business-scoped PostgREST employee query uses the existing composite employee-event FK to embed the latest event and latest CLOCK_IN, each ordered by seq descending with its own limit of one. No active-only filter: inactive open shifts cannot disappear.
3. Capture one timestamp, `max(Date.now(), all observed latest occurred_at)`, matching M05's server-clock floor. Every employee duration uses this exact value.
4. For open employees only, fetch events from captured CLOCK_IN seq through captured latest seq. Batch up to 20 employee ranges per request, ordered by seq; page 500 rows at a time. Reconstruct with existing `buildShifts`, `clockState` and `currentShiftView`.

This is one roster/head statement plus batched event pages, not a request per employee. Existing `(business_id, employee_id, seq desc)` indexing supports the heads; closed lifetime history is not transferred or reconstructed. An unusually long open shift still includes its complete history within the limit. Captured upper seq bounds exclude subsequent appends. M05 per-employee serialization plus event immutability prevents a later commit below an already observed employee head. Both ends of each loaded range are checked.

This is a read snapshot of heads observed in one database statement with a single server calculation timestamp; it is not a long-lived multi-statement database transaction or a guarantee that no events occur while the response is in transit. Manual refresh obtains new heads. The subsequent page reads cannot mix new events into captured shifts.

Limits: **200 total stored employees per business**, including inactive OFF_CLOCK employees; **10,000 total events in currently open shifts**. Above either bound, return 503 `WORKING_LIMIT_EXCEEDED`, with no partial roster. Exact counts detect server row caps on the employee query; event pages continue from actual loaded lengths and verify completeness. Other incomplete/error reads fail 503 `TIME_UNAVAILABLE`. Invalid timezone returns `TIME_CONFIGURATION_UNAVAILABLE`. These explicit bounds favor complete operational results over silently truncated or cursor-fragmented snapshots.

## Native destination

The existing Manage group exposes Who’s Working to manager/owner permissions. The direct screen checks authority as well. It uses `operationalRequest`/`apiGet`, preserving bearer/business and shared-device headers and existing identity rejection recovery. Response parsing retains only safe fields and rejects cross-business, malformed and inconsistent responses.

Compact rows show name/role, state/since, server-computed worked/elapsed/break durations, and an amber inactive-open-shift explanation. Dates use the response timezone. Existing WorkspaceHeader, Button, Badge, Feedback and design tokens provide the warm workspace and minimum 44-point interactions; the existing AppShell/rail is reused.

Load on entry, manual refresh, fresh load on return/focus, and the existing resource hook's app-active refresh. No periodic polling or client state reconstruction. Durations stay as of the labelled snapshot. Focus generations avoid reusing cached rows on return. Resource keys include account, business, management role, employee and session expiry; Lock/authority change sets a null key, and focus loss/identity changes abort and ignore in-flight reads. Existing verified identity publication code is untouched. Read errors hide old roster rows and give safe, read-specific messages.

## Tests and remaining runtime checks

`tests/m06-working.test.cjs` requires PGlite (fails rather than skips if missing), runs real M04/M05/Slice 1 migrations, real identity verification and real SQL reads through a small test PostgREST-shape adapter. A separate test uses actual supabase-js to verify the outgoing FK embeddings, alias filters/limits, count preference, business scope and event bounds. This does not substitute for deployed PostgREST execution.

Coverage includes role/credential failures, tenant isolation, safe response fields, four states, same-time ordering, overnight/paid/meal/inactive state, common snapshot durations, lifetime-history exclusion, >500-event pagination, multi-employee batching, concurrent append exclusion, incomplete reads and explicit bounds. Native tests exercise the real resource hook and transport, navigation, direct-route restriction, loading/empty/error, refresh, timezone display, inactive warning, touch convention, account/business/session/employee changes, Lock, logout, focus and rejection recovery. Existing M04/M05/Slice 1/publication-order tests remain regression gates.

Before runtime acceptance, exercise the authenticated endpoint against the deployment's PostgREST schema cache and representative data; verify owner/manager/employee access and inactive open shifts. Smoke-test `/working` on a physical iPad (entry, refresh, return, Lock/unlock, business change and offline/error states). Real multi-connection PostgreSQL concurrency testing remains an M06 gate. No deployment occurred. Slice 1's existing migration is still unapplied live and must eventually be coordinated with its changed Team RPC/API signature.

## Validation at completion

- Slice 2: 17 server/SQL/query tests + 15 native tests passed, no skips.
- Focused M04/M05/M06, native device/identity/Team/time/ShiftGate/working/navigation run: 483 passed, 0 failed, 0 skipped.
- Full `npm test`: 1,771 total; 1,769 passed, 0 failed, 2 pre-existing optional live appointment database tests skipped. All required M05/M06 SQL tests ran with the locally installed PGlite module via `ZUDE_PGLITE_MODULE`; no dependency was installed.
- Root/server `tsc --noEmit --incremental false`: passed. Native `tsc --noEmit`: passed.
- Native `eslint src`: 0 errors, the 2 existing missing-`lock` dependency warnings in EmployeeIdentityContext. Relevant server lint: 0 errors, the existing unused `_next` warning in server/app.ts. Relevant CJS test lint passed with the repository's CommonJS `no-require-imports` exception.
- `git diff --check` and explicit new-file whitespace checks passed. Existing dirty/untracked M05/Slice 1/identity work was preserved; `.claude/` was not accessed or changed.

Slice 2 adds `server/time-ledger.ts`, `server/handlers/working.ts`, native `src/app/working.tsx`, `src/features/working/WorkingScreen.tsx`, `src/lib/working-api.ts`, this document, `tests/m06-working.test.cjs`, `tests/native-working.test.cjs`, and `tests/support/working-fixture.cjs`. It modifies the already-present `server/handlers/time-clock.ts`, `server/app.ts`, native `src/navigation/items.ts`, and `tests/native-ui-foundation.test.cjs`.
