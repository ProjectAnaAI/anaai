# M06 Slice 4.1 — Effective ledger read consistency

Scope: existing reads only. No Issues, Audit, Reports, deployment, commit or push.

## Defect and query inventory

Separate PostgREST requests execute separate database statements. A correction rebuilt effective timestamps between pages without changing counts or logical IDs. Proven old/mixed/new totals: 15,060,000 / 15,090,000 / 15,120,000 ms. Boundary checks accepted the mixed result.

- `employeeLedger` (Time Clock/My Time): prior event before week start; optional earlier CLOCK_IN carry-in; all pages from that time or sequence; latest derived from loaded events/prior event.
- `historicalLedger` (Timesheets): timezone; latest head; week resolution and snapshot; prior boundary; optional carry-in CLOCK_IN; requested-week ending boundary; optional closing event beyond week (carry-out); bounded effective pages including provenance.
- `workingLedger` (Who's Working): timezone; one composite-FK roster statement containing latest/CLOCK_IN heads; open-event ranges in batches of 20 employees, pages of 500. Common snapshot captured after heads.
- Existing correction preview/commit `m06_effective_window` runs inside the correction RPC transaction, not an application-side paged read.

All three application readers span requests. Real M05 appends can also split a read and do not change correction revision.

## Architecture decision

Option A, a single dataset RPC, could provide statement-snapshot consistency. It would require moving distinct employee-week, historical carry-in/out and business-wide bounded query shapes into SQL or introducing several larger RPCs, duplicating established safety logic.

Chosen Option B: a small service-only SQL RPC, `m06_ledger_read_versions`, plus reusable `consistentLedgerRead`. Original bounded readers become private attempt functions. Read V1, perform the complete read, read V2, accept only identical tokens. Otherwise discard everything and restart. Two attempts total; repeated change returns HTTP 503 `TIME_LEDGER_CHANGED` with a safe refresh/retry message.

Even an intermediate reader error is checked against V2 so a concurrent rebuild can trigger retry. Stable errors retain their contracts. Missing/invalid RPC results fail closed through existing safe 503 handling. No revision/SQL/credential details are returned. Native refresh/error handling supports recoverable 503 failures; no client loop or native change is needed.

Each token contains highest **committed original event row seq** and highest immutable correction revision, from existing index-backed descending head lookups, never correction counts. Decimal strings preserve bigint precision. No version table, clock-state cache or calculated-hours record is added.

The business vector includes all employee IDs, including inactive/off-clock employees, detecting new shifts and roster additions/removals. Its 201-row cap detects the existing 200-employee bound. Stable reads add two RPCs regardless of employee count; a retry adds two more. Existing event caps and batch sizes remain intact.

## MVCC and projection atomicity

The STABLE SQL token function reads both heads and the entire vector in its calling statement snapshot. READ COMMITTED gives later statements fresh snapshots. See [PostgreSQL function volatility](https://www.postgresql.org/docs/current/xfunc-volatility.html) and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

The protocol requires sequential requests against the authoritative primary or equivalent causal visibility, not independently lagging replicas or cached reads. Any relevant commit between V1 and V2 changes at least one monotonic component. Corrections restoring old values still increment revision. Per-employee advisory locking orders original appends and corrections; supported writers cannot produce ABA. The token uses committed rows, not the identity sequence counter: rollback may leave allocated sequence gaps without changing the token.

Correction history/entries, projection rebuild and audit commit in ONE transaction under the employee lock. Original M05 insertion and effective-projection trigger also commit together. A statement cannot observe half-committed history/projection. No additional projection generation is needed for supported writers. Administrative out-of-band rewrites are outside the API contract.

Equal V1/V2 means no supported effective-ledger mutation committed in the interval; every intervening query describes one interpretation. A later commit after V2 does not invalidate the coherent response. Working validates the whole vector, giving a common stable ledger interval across employees. This does not claim whole-database serializability for independently edited timezone/display metadata.

`snapshotAt` controls open-duration calculation; version identifies events/effective values. Working/historical snapshots are inside each attempt; employee reads now return their attempt snapshot to Time Clock/My Time. Retry rebuilds all data and snapshot. No pages, shifts, days, totals or provenance survive a discarded attempt; calculations consume only accepted data.

## Migration and security

Apply `202610050002_m06_ledger_read_versions.sql` after M05, M06 authority/audit and `202610050001_m06_time_corrections.sql`, before the new API. Ensure PostgREST schema cache exposes the RPC. It is additive/compatible with old code, but old readers remain vulnerable until replaced. No deployment was performed.

The function is SECURITY INVOKER with explicit search path. PUBLIC, anon and authenticated cannot execute it; service_role can. Callers still authorize tenant, operational identity and target first. RLS, immutable history/projection guards, sessions/devices, authority and locks are unchanged. No mutable version state exists for clients to modify.

## Regression and remaining runtime gate

`tests/m06-ledger-consistency.test.cjs` commits real SQL changes between completed read requests in isolated PGlite. Coverage: exact timestamp/count/ID-preserving race; real append; BREAK/VOID/INSERT; two corrections; successful retry/exhaustion; day and shift-derived totals/provenance; Time Clock/My Time; Working common snapshot and constant token query count; tenant/service-only/bigint tokens; rollback; corrected CLOCK_OUT then real CLOCK_IN; safety bounds and fail-closed lookup. Existing wire tests include the RPC; append tests require complete retry.

This is deterministic interleaving with real SQL, **not multi-connection PostgreSQL validation**. Before production acceptance, use independent reader/writer PostgreSQL connections through actual PostgREST; barrier commits between boundaries/pages; run concurrent clock/correction commits; verify rollback, token/projection atomic visibility, retry exhaustion and primary routing. PGlite does not establish those transport/concurrency properties.

## Validation results (2026-10-05)

- Focused consistency/Working/Timesheets: 48 passed, 0 failed/skipped (14 new consistency tests).
- Full root `npm test`, with `ZUDE_PGLITE_MODULE` pointing to the existing isolated PGlite installation: 1,866 tests, 1,864 passed, 0 failed, 2 existing live appointment PostgreSQL skips. Includes M05 SQL/API/calculation; M06 Slices 1–5; Time Clock/My Time/Working/Timesheets/corrections; native identity/ShiftGate and publication-order regressions.
- The final strengthened post-correction rollback assertion was also run separately: 1 passed, 0 failed/skipped.
- Root/server `tsc --noEmit --incremental false`: passed.
- ESLint on the changed server/test files: passed (existing CommonJS test convention allows require imports).
- `git diff --check` plus whitespace checks on untracked Slice 4.1 files: passed.
- Native source was not changed; native TypeScript was not rerun for this slice.

The initial full run exposed only an outdated Slice 4 exact RPC privilege allowlist. It now explicitly includes the read-version RPC; no privilege assertion was removed. Existing dirty/untracked work was retained. No commit, push, deployment or migration application to a live database.
