# M06 Slice 1 — Authority and Audit Foundation

Scope: verified management actor attribution, transactional Team authority, and
immutable Team mutation history. No management time queries, correction tables,
issue resolution, exports, or new native screens are implemented.

## Deployment status and boundary

The new forward migration is `202610020001_m06_management_authority_audit.sql`.
It has **not** been applied to a live database. No configured administrative
PostgreSQL connection or schema MCP was available during this implementation;
only public native Supabase configuration was present. Repository migrations
are the schema source used here. Historical M04/M05 migrations are unchanged.

Deploy the migration and Team API together in a controlled maintenance window:
the migration removes the six-argument `m04_write_employee` overload and exposes
only the new eleven-argument version. Old API workers will fail closed after the
migration; new workers fail closed before it. Do not leave mixed workers serving
Team changes. Validate live schema/grants and function ownership before applying.
The migration must run as the trusted migration owner, not an application role.

## Authority

`managementAuthority` retains account user ID, account/effective role, mode, and
operational employee/device/session **IDs only**. It never retains the opaque
credentials or verification material. Existing HTTP target/proposed-role checks
remain. Account setup mode is preserved; partial shared headers still fail closed.

The RPC uses the existing M04 tenant advisory lock before row locks. Its internal
`m06_assert_management_actor` locks and verifies current business membership and
its expected role. Shared-device mode additionally locks employee, device, and
session rows; checks activation, employee generation, device generation,
revocation, expiry, and all tenant/employee/device/session bindings; and computes
the weaker current account/employee role. These row locks survive to commit.

The target is read FOR UPDATE. A manager may only target an employee-role row and
may only assign employee role. Current target role is checked before optimistic
version validation. Owners retain existing owner-role provisioning behavior;
there are no native owner-provisioning changes. Permissions remain role-derived.

Employee updates retain PIN snapshot serialization, required fresh PIN on
reactivation, session revocation, and monotonic employee `updated_at`. Database
timestamps and actor attribution are derived internally. No client role claim is
accepted. The service-only RPC assumes credential cryptography has been verified
by the API; IDs are not a replacement authentication mechanism for clients.

SQLSTATE 28000 maps to the existing 401 IDENTITY_UNAUTHORIZED recovery code, not a
permanent device rejection. 42501 maps to ROLE_FORBIDDEN; 40001 to TEAM_CHANGED;
22023 to INVALID_REQUEST. SQL/provider text is never returned.

## Immutable audit

`employee_management_actions` stores one row per successful Team mutation:

- business and subject employee;
- account ID; shared actor employee/device/session IDs when applicable;
- actor display-name snapshot, authority mode, account and effective roles;
- action, PIN-reset boolean, database recording timestamp;
- before/after snapshots containing only display name, role, and active status.

Actions are employee.created, employee.updated, employee.deactivated,
employee.reactivated, employee.pin_reset. Compound name/role changes appear in
one before/after pair. Reactivation with a fresh PIN is marked pin_reset=true.
No PIN values, hashes, salts, tokens, credentials, or bearer values enter audit.
No user-entered reason is added to existing Team contracts in this slice.
No pre-M06 history is fabricated.

Audit insertion and the employee/session writes share one transaction. Any
failure rolls everything back. Team still has no request-key idempotency contract:
a stale RPC write replay fails version validation without another audit row.
A newly authorized repeated successful mutation is a new action, not a replay.
PIN-duplicate create rejection also creates no history.

RLS is enabled without client policies. Clients cannot read/write audit tables
or call the RPC. service_role can SELECT audit and employees but cannot directly
write them; the controlled definer RPC owns employee/audit changes. Internal
helper functions have no PUBLIC/client/service_role EXECUTE grant. All definers
have an empty search_path. There is no legacy writable RPC overload.

Audit UPDATE and TRUNCATE always fail; DELETE fails while the business exists,
including if future direct privileges are granted. Whole-business deletion
retains tenant cascade behavior. Composite FKs bind subject/actor/device to the
same business. Historical account/session IDs intentionally have no mutable
ON DELETE SET NULL reference, so deletion of an auth account/session cannot erase
attribution. Employee/device deletion with history is restricted; deactivation
and revocation remain the normal lifecycle.

## Verification

The required `tests/m06-management-authority.test.cjs` fails rather than silently
skips when PGlite is missing. Set `ZUDE_PGLITE_MODULE` to an existing PGlite module;
no project dependency was added. `tests/support/pglite-db.cjs` now applies M06 by
default, so existing M05 SQL/API tests exercise the upgraded schema too.

```sh
ZUDE_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.cjs node --test tests/m06-management-authority.test.cjs tests/m05-time-clock-sql.test.cjs tests/m05-time-clock-api.test.cjs
ZUDE_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.cjs npm test
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint server/operational-authority.ts server/handlers/team.ts
./node_modules/.bin/eslint tests/m06-management-authority.test.cjs tests/support/pglite-db.cjs --rule '@typescript-eslint/no-require-imports: off'
git diff --check
```

For reproducing the original security gap only, `ZUDE_TEST_M04_BASELINE=1` uses
M04/M05 without M06 and the old RPC signature. The employee-PIN and revoked-session
write tests fail against that baseline (the old RPC accepts them).

PGlite tests exercise real SQL, grants, triggers, rollback, and changes deliberately
made after HTTP checks/before RPC entry. They do **not** establish concurrent
multi-connection lock behavior. Before deployment, validate membership/employee
role changes, session/device revocation, PIN turnover, and target promotion while
writes are waiting in independent real PostgreSQL transactions. Check deadlock
handling and all-or-nothing audit/employee/session commits.

After deployment, smoke-test shared-iPad manager versus owner Team operations,
PIN reset/deactivation lock behavior, and account setup mode. The native identity
publication lifecycle and all M05 clock/ShiftGate behavior were left unchanged.

### Local validation results

- Baseline reproduction: both selected security regressions failed against the
  old RPC because it accepted the write.
- Final root suite with PGlite configured: 1,739 tests; 1,737 passed, 0 failed,
  2 skipped (pre-existing live-PostgreSQL appointment integration tests only).
- All 33 new M06 tests executed successfully in that run. All required M05
  SQL/API tests executed against the migration chain including M06.
- Separate existing Team/shared-device/native identity/time regression run:
  267 passed, 0 failed, 0 skipped.
- Root/server TypeScript (`--noEmit --incremental false`): passed.
- Relevant server lint: passed. CommonJS test/support lint: passed with the
  repository's incompatible no-require-imports rule disabled for that command.
- Diff whitespace check: passed. No native files changed in this slice, so
  native TypeScript was not rerun.
- Initial sandboxed full suite could not bind Express loopback sockets. The
  final complete run used approved loopback access and passed as recorded above.
