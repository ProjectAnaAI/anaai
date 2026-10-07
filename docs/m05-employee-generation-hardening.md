# M05 transactional employee-generation hardening

The server already rejected an employee identity when `Date.parse(employee.updated_at) > Date.parse(session.created_at)`. The shared SQL assertion omitted employee generation. Isolated PGlite demonstrated HTTP rejection while the service-only issue/clock RPCs still accepted the same stale generation. This was a **transactional validation gap**, not a demonstrated public API exploit. Team's separate session revocation is not a substitute for this check.

## Forward migration and contract

Apply `202610060001_m05_employee_generation.sql` after `202610050002_m06_ledger_read_versions.sql` in the existing ordered migration chain. No historical migration is edited; no API/interface or data conversion is required. Existing API workers inherit the check after migration commit. No new RPC or PostgREST signature is introduced. No deployment was performed.

The replacement `m05_assert_employee_identity(uuid,uuid,uuid,uuid)` retains SECURITY DEFINER, empty search path, revoked direct execution privileges, and employee → device → session row-lock order. It captures the current employee's `updated_at` under the existing FOR SHARE lock and requires:

`date_trunc('milliseconds', session.created_at) >= date_trunc('milliseconds', employee.updated_at)`

This deliberately matches JavaScript Date.parse precision. Equality is valid. A PostgreSQL microsecond advance within the same millisecond is indistinguishable to the existing server and is accepted here too; crossing the millisecond boundary is rejected. This does not silently introduce a stricter employee timestamp rule. Existing exact PostgreSQL device-generation equality remains unchanged, as do expiry, revocation, active status and business/employee/device binding. HTTP credential/token verification remains unchanged.

The employee lock prevents a generation writer from committing between this check and the protected write's commit. A change committed before the assertion is observed and rejected. The session lock and device lock preserve their existing guarantees. Invalid identities raise only SQLSTATE 42501 / `Employee identity unavailable`; existing handlers map this to safe HTTP 401 `IDENTITY_UNAUTHORIZED`.

## Callers and security review

Both employee-authenticated M05 SECURITY DEFINER RPCs call the assertion before writes or replay handling:

- `m05_record_time_event`, including its Slice 4 correction-aware replacement: protects all real clock actions, originals and effective projection inserts.
- `m05_report_time_issue`: protects employee issue submission.

The original M05 clock definition also calls it. No other M05 employee-authenticated SQL write RPC bypassing this assertion was found. M05 immutable/delete trigger functions enforce storage rules, not independent identity-bearing write entry points. M06 projection helpers are internal maintenance paths; correction writes use the separate management assertion.

Slice 1's `m06_assert_management_actor` already rejects `employee.updated_at > session.created_at`, using PostgreSQL's full timestamp precision. It therefore has no missing-generation gap (and is stricter within a millisecond). It remains unchanged. No management authority expansion is included.

## Tests and remaining validation

`tests/m05-employee-generation.test.cjs` permanently recreates the discovered case without explicitly revoking the session. It covers direct RPC rejection and an HTTP-to-SQL interleaving for issue submission and CLOCK_IN, asserting zero issue/original/effective rows. It also covers valid older/equal generations, sub-millisecond parity with HTTP, newer milliseconds, independent device generation, expiry/revocation, inactive employees, tenant and identity binding, valid idempotent replays, changed issue payload conflicts, rejected stale replays and reuse of a rejected request key after renewing identity.

The M05 SQL fixture previously created employees newer than its synthetic nine-hour-old sessions. It now creates the initial employee generation ten hours earlier, making its valid identities truthful under the hardened contract; rejection assertions were not removed. The shared SQL bootstrap applies the new forward migration to both M05-only and full M06 fixtures. Existing correction lifecycle and Slice 4.1 consistency suites exercise the replacement assertion too.

PGlite validates SQL and deterministic request interleaving, not real multi-connection lock behavior. The remaining pre-release PostgreSQL gate must verify concurrent employee-generation update versus issue/clock writes, lock retention, rollback and unchanged management/device checks through actual PostgREST. No live database or physical-device validation is claimed.

## Validation (2026-10-06)

- New generation regressions plus M05 SQL: 32 passed, 0 failed, 0 skipped (16 new generation cases).
- Full root `npm test` with required PGlite SQL suites enabled: 1,882 total, 1,880 passed, 0 failed, 2 pre-existing opt-in live appointment PostgreSQL skips. Includes M04/device/session/Team, M05 API/calculation/issues, M06 Slices 1–5 and 4.1, correction-aware clock lifecycle, Time Clock/My Time/Working/Timesheets, ShiftGate, native identity and publication-order regressions.
- Root/server `tsc --noEmit --incremental false`: passed.
- Relevant ESLint (CommonJS test require-import convention): passed.
- `git diff --check` and whitespace checks for all five changed/untracked files: passed.
- No native/shared types changed; native TypeScript was not rerun.
- No deployment, commit, push, staging, or M06 Phase A resumption.
