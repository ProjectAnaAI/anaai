# WORKFORCE-01A database integration review

Branch `zude-app`, base HEAD `45ac0ee`. No hosted migration, deployment, commit, or production records changed.

## Isolation and tested environment

`tests/support/pglite-db.cjs` constructs `new lib.PGlite({ parsers: ... })` with no connection URL or persistent data directory. Each test receives an independent in-memory PostgreSQL database, bootstrapped with synthetic Supabase roles/tables and synthetic accounts, device credentials, PIN sessions and events. Fixture teardown closes the database. No hosted credentials or environment files are used. The ordered M04/M05/M06 migration sequence and WF01 migration are executed only in these disposable databases.

Actual PostgreSQL functions, permission grants, ledger calculations and audit transactions were tested. Supabase account authentication and PostgREST transport use the existing local fixture adapters. A hosted Supabase/Auth/PostgREST deployment and physical iPad are not validated by these tests.

## Migration review

`202610080001_wf01_workforce_visibility.sql` installed successfully, including all three WF01 functions and the replaced export function. Return types and RPC argument names worked through the server handlers.

All four functions use SECURITY DEFINER and an empty search_path. Application relations/functions are schema-qualified; PostgreSQL built-ins resolve through pg_catalog. The target helper is private, including from service_role; dataset/directory/export functions are service-role only, with anon/authenticated execution denied by actual PostgreSQL ACL checks.

The private target helper revalidates business membership and shared-device actor/session/device identity through `m06_assert_management_actor`. Owner authority sees all roles. Manager authority sees employees plus its own verified manager-role identity in shared-device mode. Account-only managers receive no self-access. A manager account with an owner PIN remains manager-limited and cannot expose owner records. Target IDs do not substitute for actor identity. Business scoping and export cardinality checks remain intact.

Historical/inactive target records remain available to authorized active actors. Dataset/employee/event/export bounds remain unchanged. Export revalidation detects actor/account/session/device/target changes and returns no CSV or partial audit on denial. No time-record write permission or employee-management policy changed. No SQL implementation defect was found in this validation.

## Results

- Existing reporting + REPORTS-01 + WF01 tests: 45 passed.
- New database integration + roster + calculation tests: 41 passed (13 new end-to-end WF01A cases).
- Native Reports/Today/Attention/Time Clock/gate: 116 passed.
- Full npm suite: 2,095 passed, 1 failed, 2 skipped (2,098 tests).
- Sole failure: existing `original production logo bytes stay unchanged` hash baseline; untouched.
- Root/mobile TypeScript: passed. Mobile ESLint: passed. Server ESLint: no errors; existing unused `_next` warning in server/app.ts.
- git diff --check: passed.

New end-to-end cases cover installed RPC grants, manager self-hours, owner/private-target visibility, account/PIN restrictions, spoofing/cross-business denial, user revocation, summary/detail reconciliation and audits, export races, working/break/closed historical states, both DST transitions and overnight carry-in.

## Recovery of the original 26 failures

Each failure was **A: missing test database migration**, caused by **B: fixture schema mismatch**: the harness ended at M06 while the API called WF01. Including WF01 in the in-memory migration sequence recovered every case without relaxing its security assertion. The explicit missing-migration test opts out and continues to verify fail-closed behavior. Prior API RPC-hook updates remain preserved. No C (SQL defect), D (API contract defect), E (authorization defect), or F (expectation change) was required to recover these failures.

| Original failed test | Classification | Result |
|---|---|---|
| Reports manager authority, target hierarchy and tenant binding | A / B | Passed |
| Reports owner authority, target hierarchy and tenant binding | A / B | Passed |
| Reports normal paid/meal shifts agree with Timesheets and CSV from the SAME result | A / B | Passed |
| Reports overnight carry-in/out clips local boundaries after loading carry-in | A / B | Passed |
| Reports spring DST clips local boundaries after loading carry-in | A / B | Passed |
| Reports fall DST clips local boundaries after loading carry-in | A / B | Passed |
| Reports week crossover groupings and team totals use the same M05 calculation | A / B | Passed |
| Reports correction crossing date boundary is interpreted BEFORE clipping | A / B | Passed |
| Report retry discards old dataset after a real correction, including CSV | A / B | Passed |
| Report retries real CLOCK_OUT append and retains one common snapshot for open intervals | A / B | Passed |
| Open reports use one snapshot for all employees and constant RPC count | A / B | Passed |
| Export actor demotion after generation prevents CSV release | A / B | Passed |
| Export target promotion after generation prevents CSV release | A / B | Passed |
| Export session revoke after generation prevents CSV release | A / B | Passed |
| Export device revoke after generation prevents CSV release | A / B | Passed |
| Report range validation, 93-day bound, browser RPC permissions and no silent event truncation | A / B | Passed |
| CSV escapes commas/quotes/newlines and guards formula prefixes; bounds fail explicitly | A / B | Passed |
| Export audit history scopes employee and team metadata without storing CSV | A / B | Passed |
| Daily CSV employee screen: inclusive business-local range, carry-in/out and daily export audit | A / B | Passed |
| Daily CSV day screen: inclusive business-local range, carry-in/out and daily export audit | A / B | Passed |
| Daily CSV week screen: inclusive business-local range, carry-in/out and daily export audit | A / B | Passed |
| Daily CSV team screen: inclusive business-local range, carry-in/out and daily export audit | A / B | Passed |
| Daily CSV reflects corrections with existing lifetime history semantics | A / B | Passed |
| Daily CSV preserves spring DST allocation | A / B | Passed |
| Daily CSV preserves fall DST allocation | A / B | Passed |
| Daily CSV open employees share one snapshot, preserve breaks, formula protection and authorization | A / B | Passed |

## Controlled rollout and recovery

Ready for a controlled staging database rollout and environment-specific smoke testing, not a claim of production deployment or physical acceptance.

1. Review/retain a database backup and the migration/application versions; confirm the deployed M06 prerequisites and function ownership/grants.
2. Apply the forward-only migration in an explicitly approved staging environment; verify signatures, ACLs and schema-cache discovery.
3. Exercise actual Supabase Auth/PostgREST and owner/manager/employee PIN sessions, CSV sharing and audits there.
4. Deploy the matching API before releasing the matching mobile client. Keep existing legacy RPCs/CSV formats for compatibility.
5. Perform physical iPad acceptance and separately review the intentional branding/hash-baseline mismatch before production approval.

On failure, stop the new release and restore the previous API/client first. Retain additive RPCs while any client still depends on them. Do not erase audit rows or time records. Use a reviewed forward recovery migration for database changes; avoid dropping live RPCs or restoring a database backup over newer operational records. `CREATE OR REPLACE` preserves the export function signature/grants, and the migration is transactional; do not blindly reapply its non-idempotent CREATE statements.
