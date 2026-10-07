# M06 Slice 3 — Management Timesheets (read only)

Scope: manager/owner employee → business week → day → original ledger detail. No corrections, mutations, issue resolution, audit UI, reports, exports, payroll, scheduling or voice changes. No migration or dependency is required. No deployment, commit or push occurred.

## Endpoints and authority

- `GET /api/management/timesheets`: server-authorized target directory, including active and inactive employees. No filters. Returns `success`, verified `businessId` and safe employee `{id,name,role,isActive}` records.
- `GET /api/management/timesheets/:employeeId?weekStart=YYYY-MM-DD`: one complete employee/week response. UUID selector required. The only accepted query key is `weekStart`, at most once. Omit it for the current business week; an explicitly empty value is invalid.

Both endpoints use `authorizedMember → managementAuthority`. The detail then performs a business-scoped target lookup and target-role authorization before reading events. Staff and regular employee PINs are forbidden. Managers can read **regular employees only**; directory filtering occurs in the database query. Owners can read employees, managers and existing owner employees, preserving `team.ts`'s existing owner target policy. No owner provisioning/UI is added. Shared-device credentials must verify in full; partial, expired, revoked or generation-mismatched identities never fall back to account authority. Cross-business targets are unavailable.

Success includes employee, business timezone, snapshotAt, week local/UTC boundaries, weekly worked/paid-break/meal-break totals and `hasOpenShift`, seven business-local day views, server-produced previous/current/next week dates, and ordered safe events `{id,shiftId,seq,type,breakType,occurredAt}`. `shiftId` associates each event with its original CLOCK_IN. No device, session, PIN, hash, salt, request ID, source or identity-generation fields are exposed. Existing no-store API behavior applies.

## Week and snapshot contract

`weekStart` must be an actual canonical Monday date, in the business's configured timezone. Non-Mondays and invalid/nonexistent dates are rejected, not normalized. Dates use the four-digit year range 1000–9999; future weeks are rejected with 400 `FUTURE_WEEK`. Invalid weeks return 400 `INVALID_WEEK`; unsupported selectors return 400 `INVALID_REQUEST`. Invalid business timezone retains 503 `TIME_CONFIGURATION_UNAVAILABLE`.

The reader first captures the employee's latest committed event sequence. One `snapshotAt = max(server Date.now(), captured latest occurred_at)` follows Slice 2/M05's clock-floor rule. All weekly/day/open interval calculations use this exact timestamp. The current week is resolved from this snapshot and `businesses.timezone`. Native never decides the canonical week from device-local time.

Closed historical intervals retain their recorded ends. Open intervals extend to the snapshot and are clipped by the existing calculation helpers to each requested day/week. An inactive employee keeps their real ledger, including unresolved open time; deactivation never manufactures a CLOCK_OUT.

## Historical ledger algorithm

`historicalLedger` extends `server/time-ledger.ts`; existing M05 and Slice 2 readers/calculations remain unchanged.

1. Scope every query to the verified business and target employee. Capture latest seq once, then apply this upper bound to every boundary lookup.
2. Find the last event strictly before the requested Monday's UTC boundary, ordered by seq. If it is not CLOCK_OUT, find the last CLOCK_IN at/before that seq. This is the carry-in start, including breaks already running at Monday.
3. Find the last event strictly before next Monday. If no event touches the week and there is no carry-in, return an empty event window.
4. If this last event leaves a shift open at the week end, find its first subsequent CLOCK_OUT within the captured head. Include the full tail through that event. If it is still unresolved, include through the captured latest event. This keeps a historical shift that closes next week honestly **closed**, with its actual closing timestamp and break ends.
5. Load only the relevant sequence window: carry-in CLOCK_IN (or events from Monday onward) through that final seq. Order by seq, page 500 rows, and require exact stable counts. Validate the initial CLOCK_IN and final captured ID, and the carry-in seq where applicable.
6. Feed original events unchanged into M05 `buildShifts`, `windowTotals`, and `dayView`. Only the safe event DTO names/shift association are added for presentation.

M05 serializes per employee, stamps `occurred_at` with `greatest(database clock, latest occurred_at)`, and makes events immutable. Thus a captured seq excludes concurrent appends, and later pages cannot acquire older commits beneath that observed head. Boundary queries use timestamps to locate the window but **seq** to resolve ordering, including equal timestamps. This is a bounded sequence snapshot across statements, not a multi-statement transaction holding database locks.

Carry-in/out events can be outside the requested week because they explain touching shifts. Weekly/day totals remain clipped to business-local windows. Day shift/break detail deliberately preserves M05's full interval start/end and full-break duration semantics; the UI labels full-break durations and contextual events separately from day totals. No lifetime closed history is loaded.

## Bounds and failure behavior

One request returns one employee/week, with no public pagination. The complete reconstructed event window, including carry-in/out, is limited to **10,000 events**. A directory contains at most **200 authorized targets** (including inactive targets). Count overflow returns 503 `TIMESHEET_LIMIT_EXCEEDED`; incomplete/truncated/changed reads fail with a safe 503 `TIME_UNAVAILABLE`. No partial dataset is used to calculate totals. Event pages advance by their actual received length, handling a server page cap below 500 without losing rows.

Existing business/employee seq and timestamp indexes are reused. Reads require a fixed small number of boundary queries plus pages, not per-day or per-shift queries. Long unresolved shifts remain correct within the event limit; there is no arbitrary age cutoff or mutable summary table.

## Native workflow

`/timesheets` is now an implemented manager/owner Manage destination. Direct route access also checks authority. The API wrapper uses existing account/business and operational identity transport, validates employee/business/week and data shapes/order, and explicitly retains safe response fields.

The existing `MasterDetail` provides an iPad employee list/detail layout and an iPhone list/detail Back flow. Employee selection loads the server's current week. Previous/next/current controls use server-returned dates; next week is disabled at the current week. Weekly totals lead to selectable days, day-allocated totals, full shift/break periods and ordered named events. Years and business timezone are visible. Inactive and unresolved-open conditions are explained. No Edit/Fix/Adjust controls exist. Existing RecordRow/Button touch targets and tokens are reused.

Directory/detail errors, empty results, loading and safety limits have explicit safe Feedback states. Resource identity includes account, business, management role, operational employee/session expiry, focus generation, selected employee and week. Changed keys hide previous data immediately and abort/ignore requests. Authority rejection clears selection. Refresh hides old detail until the authorized directory and selected timesheet load again. Returning to the screen loads a fresh directory and clears prior selection. Existing identity publication code is untouched; My Time remains own-employee/current-week-only with no new navigation.

## Test strategy and runtime gates

`tests/m06-timesheets.test.cjs` runs real migrations, identity verification and PostgreSQL reads using the required local PGlite harness. Only account token resolution and the PostgREST-shaped SQL transport are fixtures. A separate real supabase-js transport test verifies exact count preference, safe fields, tenant/employee scope, seq bounds and paging. These tests do not exercise a deployed PostgREST schema cache or true multi-connection PostgreSQL concurrency.

Coverage includes role/target directory restrictions, shared identity rejection, tenant isolation, strict week contract, both DST transitions, same-time seq ordering, paid/meal breaks, multiple and overnight shifts, carry-in and closure after the week, inactive/open time, consistent M05/My Time totals, empty weeks, concurrent append exclusion, >500 events, omitted lifetime history, incomplete pages and explicit limits.

`tests/native-timesheets.test.cjs` exercises the real resource hook and API wrapper with rendered screen trees: navigation/direct-route denial, authorized selection, server-driven weeks/current action, day/event detail, empty/loading/error, no correction controls, stale employee/week requests, Lock/logout/business/account/session/authority changes, rejection recovery, focus and refresh.

Remaining acceptance: authenticated deployed-PostgREST smoke checks and physical iPad/iPhone layout/navigation/identity/error checks; real multi-connection PostgreSQL testing remains the existing M06 gate. The earlier Slice 1 migration remains unapplied live and must be coordinated with its changed Team RPC/API signature at deployment.

## Files in this slice

Added:

- `server/handlers/timesheets.ts`
- `apps/zude-mobile/src/app/timesheets.tsx`
- `apps/zude-mobile/src/features/timesheets/TimesheetsScreen.tsx`
- `apps/zude-mobile/src/lib/timesheets-api.ts`
- `tests/m06-timesheets.test.cjs`
- `tests/native-timesheets.test.cjs`
- `docs/m06-slice-3-timesheets.md`

Modified from the existing dirty checkpoint:

- `server/time-ledger.ts` — bounded historical reader; existing readers retained.
- `server/app.ts` — two GET route registrations.
- `apps/zude-mobile/src/navigation/items.ts` — implemented Timesheets destination.
- `tests/native-ui-foundation.test.cjs` — implemented-route expectations.
- `tests/support/pglite-db.cjs` — exact-count, lte and gt SQL query support.
- `tests/support/working-fixture.cjs` — reusable service/identity request harness; existing Slice 2 behavior retained.

Unrelated M04/M05/Slice 1/Slice 2 and identity work remains untouched. No migration, My Time product, time-calculation, identity-provider, environment, dependency or generated-file changes were made. `.claude/` was not accessed or changed. Nothing was staged.

## Final validation

- New Slice 3 tests: **37 passed** (17 server/SQL/query tests and 20 native tests).
- Focused M04/M05/M06 and native device/identity/Team/time/ShiftGate/navigation regressions: **520 passed, 0 failed, 0 skipped**.
- Final full root `npm test`: **1,808 total; 1,806 passed, 0 failed, 2 pre-existing optional live appointment-database tests skipped**. Required SQL suites actually ran using the existing local PGlite installation through `ZUDE_PGLITE_MODULE`; no dependencies were installed.
- Root/server `tsc --noEmit --incremental false`: passed.
- Native `tsc --noEmit`: passed.
- Native `eslint src`: passed with 0 errors and the 2 existing EmployeeIdentityContext missing-`lock` dependency warnings.
- Relevant server/test ESLint: passed with 0 errors and the existing unused `_next` warning in `server/app.ts`. CJS tests use the existing `@typescript-eslint/no-require-imports` exception.
- `git diff --check` plus explicit whitespace checks on added/previously-untracked files: passed.
- Final worktree still contains earlier dirty/untracked work; no staged changes. Slice 3 is limited to the 13 files listed above. No corrections were started.
