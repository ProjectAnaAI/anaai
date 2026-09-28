# Milestone 02 — native Appointments

Status: **implementation complete; automated validation passed; migration/database and device runtime acceptance still required.** No commit or push. The approved check-only wrapper and native workflow are implemented. No database migration was applied to any environment.

## Starting state and authorization

- Branch `zude-app`, HEAD `76d64a02bd5cf7917666223d7661fde61415be20` (`Migrate ZUDE Today reads through API`). Local tracking ref and read-only live `git ls-remote` both matched; ahead/behind 0/0 at the audited checkpoint.
- Initial unrelated item: `apps/zude-mobile/.claude/`. It was not read, modified, staged, or deleted.
- The initial audit stopped at the requested SQL approval gate. The subsequent approval explicitly authorized a narrow authenticated/check-only wrapper and completion of the original native milestone.
- Root dependencies reused read-only from `/Users/ayutacharya/anaai-local/node_modules`. Root package manifests/lockfile were not changed. No environment files were changed.

## Audit finding resolved

The existing private rescheduling core already supports check-only, tenant checks, phone-less customers and exclusion of the appointment being moved. It was not exposed through a suitable public authenticated RPC. New-booking availability excludes no appointment; the voice management preview imposes phone identity/future-time rules that are inappropriate for the general native workflow. The approved wrapper exposes the existing general core without changing any scheduling algorithm or voice function.

The table below records the audited paths and original gaps; implementation details following it explain how those gaps were closed.

## Existing execution paths traced

| Capability | Actual client → API → database path | Reuse / native gap |
|---|---|---|
| Web day/week/month schedule | `app/appointments/page.tsx` → direct Supabase appointment/customer/service reads; `AppointmentCalendar.tsx` / `lib/appointment-calendar.ts` render calendar choices | Reuse semantics, not desktop components or visual slots as authority |
| Native Today/day reads | `getTodayAppointments()` → `GET /api/appointments?date=...` → verified context → `server/repositories/today.ts` → user-scoped Supabase | Reuse endpoint; inspector/reschedule need IDs/notes beyond current narrow Today projection |
| Customer lookup | Web page/composer → tenant-filtered `customers` | Add bounded authenticated read/search boundary; preserve inactive historical relationships |
| Customer creation | Composer → `saveCustomer()` → direct client Supabase, client duplicate checks | Not currently a reusable backend CRM write path; defer native customer creation under the permitted follow-up rule |
| Services | Web → tenant-filtered active `services`, including duration | Add minimal authenticated catalog read; no service management in this milestone |
| Manual booking | Shared `AppointmentComposer` → page `sendAppointmentUpdate()` → `sendAppointmentMutation()` → `POST /api/appointments` → `schedule_appointment_idempotent_business` → `create_appointment_atomic_business` | Reuse API/RPC mutation authority |
| Rescheduling | Web edit form → same transport → `PATCH /api/appointments` with customer/service/date/time → idempotent wrapper → `reschedule_appointment_atomic_business` → private core with check-only false | Reuse mutation unchanged; general check-only RPC missing |
| Confirm | PATCH with status Confirmed → `confirm_appointment_atomic_business` → lifecycle core | Booked → Confirmed; repeated target state has defined no-op semantics |
| Cancel | PATCH with status Cancelled → `cancel_appointment_atomic_business` → lifecycle core | Booked/Confirmed → Cancelled; compact native confirmation still needed |
| Complete | PATCH with status Completed → `complete_appointment_atomic_business` → lifecycle core | Confirmed → Completed; do not offer completion from Booked |
| Terminal transitions | Latest lifecycle/reschedule cores reject disallowed transitions | Completed/Cancelled cannot normally reschedule or reactivate |
| New-booking availability | `lib/voice-booking.ts` → service client → `voice_check_appointment_availability` → private shared capacity helper | Existing SQL reusable behind authenticated backend, no JS authority |
| Voice reschedule preview | `manageVoiceAppointment()` → service-only `voice_manage_appointment_business` with check-only true → private reschedule core | Correct exclusion, incompatible phone/future-only identity contract for general native use |
| Legacy AI booking | AI handler → idempotent scheduling wrapper with `ai_book` → `book_appointment_atomic_business` | Preserve unchanged |
| Notifications | Verified mutation receipt → claim/send/finish notification helpers and Twilio | Preserve; completion deliberately sends no SMS; never promise delivery in native success UI |

### Source-of-truth details

- `businesses`: canonical timezone and simultaneous appointment capacity.
- `business_profiles.business_hours`: JSON text validated inside scheduling SQL. Existing scheduling uses business-local date/time and same-day opening/closing rules; no new overnight/DST model should be introduced here.
- `appointments`: customer/service references, contact/name snapshots, date/time, status, notes and durable duration snapshot.
- `customers`: business ownership, contact fields, notes and archival flag. Manual SQL validates business-scoped customer identity; web selection prevents new assignment of archived customers and permits keeping existing archived relationships. Do not claim the manual RPC independently implements every UI archival restriction.
- `services`: business ownership, active state and scheduling duration. Candidate booking/reschedule uses the currently validated active service duration.
- Existing intervals prefer `appointments.duration_minutes`; the capacity helper retains carefully defined legacy fallbacks and fails closed when active intervals cannot be resolved.
- Capacity is a peak simultaneous-occupancy sweep, not simply the number of overlapping appointments. Booked/Confirmed consume capacity; Cancelled/Completed do not. Intervals are half-open.
- Creation/rescheduling use advisory business/date locks and row locks, fresh reads, self-exclusion and stale-source-date checks. Several functions require READ COMMITTED.
- `appointment_actions` binds business, idempotency key, canonical request and fingerprint. The wrapper records/replays a verified action outcome. `appointment_notifications` is the existing transactional delivery ledger.
- `createRequestKeyStore()` binds keys to intent and retains uncertain retries. Its sessionStorage/browser crypto adapter should not be copied blindly into native; retain the same idempotency semantics using supported native facilities.
- `resolveBusinessContext()` verifies the bearer user and memberships. The business header remains a requested selection. Native does not receive a service-role key.

## SQL migration / RPC contract

`supabase/migrations/202609280001_authenticated_reschedule_check.sql` adds:

```text
public.check_reschedule_appointment_business(
  p_business_id uuid,
  p_appointment_id uuid,
  p_customer_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time
) -> jsonb
```

- `VOLATILE SECURITY INVOKER`, pinned `search_path = pg_catalog, public`.
- Explicit `auth.uid()` and `is_business_member(p_business_id)` guards. The supplied business is never itself authorization.
- Revoke execution from PUBLIC, anon and service_role; grant only authenticated. Existing RLS remains in force. Do not expose `anaai_private` in PostgREST.
- Exactly one delegation to `anaai_private.reschedule_appointment_core(..., null, true)`. The caller cannot turn off check-only. No duplicated capacity/hours/overlap algorithm and no phone identity requirement.
- Core scopes the appointment/customer/active service to the business, takes its existing ordered date/row locks, rereads the appointment, and excludes only the supplied appointment ID. It returns before UPDATE when check-only is true.
- Success: `{success:true, code:"AVAILABLE", duration_minutes:number}`. Failure: `{success:false, code:<existing core code>}`, including UNAUTHORIZED, FORBIDDEN, APPOINTMENT_NOT_FOUND, INVALID_CUSTOMER, INVALID_SERVICE, TERMINAL_APPOINTMENT, SOURCE_DATE_CHANGED, INVALID_HOURS, CLOSED, OUTSIDE_HOURS, SLOT_CONFLICT and safe internal errors.
- Check-only does not mutate appointments, customers, services, lifecycle, action ledger or notifications. It does acquire transaction locks; it is not a reservation or a lock-free read.
- SQL may check proposed same-tenant references just as the core permits. The native API additionally loads the appointment and preserves its current customer/service when constructing a reschedule check.
- Actual rescheduling still goes through the existing idempotent PATCH mutation and core with check-only false.

Apply manually after the existing migration chain through `202609210008_voice_appointment_management.sql`, first to a disposable local Supabase database. Validate grants/RLS, PostgreSQL compilation and the integration test before applying to the target environment. No historical migration, table/schema definition, voice function or scheduling rule was changed.

## API surface and security

All added endpoints require the current bearer token and verified membership via `resolveBusinessContext`. The `x-anaai-business-id` header only requests a selection. Reads use the member-scoped Supabase client with explicit business filters plus RLS. Unknown/duplicate query parameters are rejected; responses use no-store. Provider errors are not logged or returned.

| Endpoint | Contract |
|---|---|
| `GET /api/appointments/day?date=YYYY-MM-DD` | Scoped ordered day rows, customer/service references, snapshots, date/time/status/duration and notes. Paged internally to avoid the default row cap. Existing Today GET remains unchanged. |
| `GET /api/customers?q=<name>&offset=0` | Active same-business customers, id/name/phone only, 25 rows per page and nextOffset. Name substring search escapes LIKE wildcards. Phone-less customers remain selectable. |
| `GET /api/services` | Active same-business services, id/name/duration. Internally paged. No service writes. |
| `GET /api/appointments/availability?date=...&serviceId=...` | Generic native availability contract backed by the existing SQL new-booking checker. Membership and service scope are verified before creating the existing server-only service client. |
| Same availability endpoint plus `appointmentId=...` | Read/verify target and preserve its current customer/service, then invoke the new wrapper with the authenticated member client. No privileged client or voice phone resolver. |
| Existing `POST /api/appointments` and `PATCH /api/appointments` | Reused booking/reschedule/lifecycle receipt verification, idempotency, tenant authorization and notification behavior. Only additive safe error `code` fields were added. |

Availability enumerates a bounded 15-minute presentation grid, checking **every offered candidate in SQL** (at most 96 checks; 97 when including a non-grid original reschedule time). Four requests at a time, early stop on closed/invalid configuration. The grid is not an availability calculation. No native/JavaScript overlap, hours, capacity, timezone conversion or duration rule is authoritative. Success metadata/duration must match the requested schedule; any unverified check fails closed. Closed and no-availability are distinct data states. No alternate-date slots are fabricated. Actual mutation rechecks under the existing authoritative transaction, so availability is advisory.

Existing CORS is unchanged: explicit configured browser origins, GET/POST/PATCH and existing approved headers, no wildcard or cookie credentials. Native networking does not require an Origin header. Twilio signatures and voice routes remain untouched.

## Native functionality

- Expo Router routes for Today and Appointments within the existing authenticated/business shell. The original Today read/state hook is unchanged. Today New Appointment opens the composer; returning to Today remounts and fetches authoritative data. Business/user changes remount route state.
- Business-local day list/timeline with ordered appointments, previous/next/Today/Tomorrow/date entry, day search, restrained current-time text, refresh, empty/loading/error states. Date arithmetic does not convert business dates through the device timezone.
- 1024×768-class split day list and contextual inspector; smaller screens stack. Inspector shows snapshots/notes/status, Confirm for Booked, Complete for Confirmed, and reschedule/cancel for active states. Terminal states have no normal mutation actions. Cancel requires compact confirmation and uses the destructive action color.
- Single scrollable, keyboard-aware composer: debounced paginated customer name search, customer selection/change, active service choice, Today/Tomorrow/date selection, SQL-approved times, compact review and Book Appointment. No wizard.
- Rescheduling keeps customer/service/notes and changes only date/time. Inactive service or unresolved historical references cannot silently become a different service/customer.
- Success displays customer/service/date/time and Done / View Appointment. No SMS/email promise.
- SLOT_CONFLICT and related schedule conflicts preserve customer/service/date/appointment, clear only time and immediately refresh authoritative alternatives. Closed/no-availability preserve selections.
- Abort/cancellation and key-based stale-result suppression on reads, plus foreground refresh. Unverified/stale availability cannot enable submission. Committed inspector state is shown while refetching, then superseded by the canonical day response; missing appointments cannot retain stale actions.
- Shared authenticated transport now supports POST/PATCH and safe typed errors. Mutation preparation checks the originating account before sending, and checks session identity again after receiving the response.
- Secure UUIDs via Expo Crypto; intent keys persisted with AsyncStorage, keyed by SHA-256 of user/business/canonical native intent. Storage contains only hashes/UUIDs, no customer bodies or credentials. Duplicate in-flight actions coalesce. Uncertain retries reuse the same key across navigation/restarts; success or definite business rejection clears it. An uncertain composer save locks edits and offers Retry Same Request; configuration/storage failures before sending remain distinguishable.

Customer creation and View Customer are intentionally deferred: there is no existing safe backend customer-write boundary or native customer route. Use the existing web customer workspace. No second CRM path was added.

## Necessary dependencies

Announced before installation, then installed with Expo's SDK-compatible installer:

```sh
cd apps/zude-mobile
./node_modules/.bin/expo install expo-router react-native-screens expo-linking expo-constants expo-crypto
```

Added `expo-router ~57.0.23`, `react-native-screens ~4.26.0`, `expo-linking ~57.0.11`, `expo-constants ~57.0.19`, `expo-crypto ~57.0.3`. Router is required by the native AGENTS instructions; Crypto provides secure native idempotency UUIDs. The native package lock necessarily changed. Existing package versions were not upgraded; three nested package locations were deduplicated. No root install, audit fix, or dependency modernization.

Installer emitted an optional `expo-modules-core` / transitive `react-native-worklets` peer-range warning and reported 13 moderate audit findings. No audit remediation was attempted. Web and iOS JS/Hermes bundling passed; compatibility still needs a real native development build/device run. Native modules require a rebuilt development client as appropriate; no generated ios/android project was added.

References consulted before native changes: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [Router installation](https://docs.expo.dev/router/installation/), [Expo Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/). Installed matching Next rewrite documentation was read; no Next route/proxy changes were needed.

## Tests and exact validation

| Check | Final result |
|---|---|
| Complete root suite | **1,175 tests; 1,173 passed; 0 failed; 2 skipped** (13,619.61 ms) |
| Focused API/native/wrapper/Today/CORS suite | **210 tests; 209 passed; 0 failed; 1 skipped** (1,449.24 ms) |
| Native TypeScript | Pass, exit 0 |
| Native ESLint | Pass, exit 0; no warnings/errors |
| Server TypeScript | Pass, exit 0 |
| Relevant backend ESLint | Exit 0; 0 errors, one existing unused `_next` warning in `server/app.ts`; existing missing-root-React detection notice |
| Expo web production export | Pass, 901 modules; final output `/tmp/zude-m02-web-final` |
| Expo iOS JavaScript/Hermes export | Pass, 1,215 modules; output `/tmp/zude-m02-ios`; not an Xcode/device build |
| Diff/scope checks | `git diff --check` passed; historical migrations/voice/root lockfile/environment files unchanged |

Baseline was 1,102 tests / 1,101 pass / 0 fail / 1 skip. **Added 73 tests: 72 pass, one opt-in DB skip.** The original 1,102 tests remain, including the original atomic scheduling DB skip. No existing tests were removed or weakened. The second skip is the new check-wrapper database integration test. No failing tests remain.

Exact commands (from repository root unless a mobile working directory is indicated):

```sh
NODE_PATH=/Users/ayutacharya/anaai-local/node_modules TSX_DISABLE_CACHE=1 node --test --test-reporter=tap 'tests/*.cjs'

NODE_PATH=/Users/ayutacharya/anaai-local/node_modules TSX_DISABLE_CACHE=1 node --test --test-reporter=tap tests/authenticated-reschedule-check.test.cjs tests/authenticated-reschedule-check.integration.cjs tests/native-appointments-api.test.cjs tests/native-appointments-contract.test.cjs tests/native-appointments-state.test.cjs tests/native-api-transport.test.cjs tests/atomic-appointments.test.cjs tests/appointment-lifecycle.test.cjs tests/cors.test.cjs tests/native-today-api.test.cjs tests/native-today-state.test.cjs

# Working directory: apps/zude-mobile
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint . --no-cache
EXPO_NO_DOTENV=1 CI=1 ./node_modules/.bin/expo export --platform web --output-dir /tmp/zude-m02-web-final
EXPO_NO_DOTENV=1 CI=1 ./node_modules/.bin/expo export --platform ios --output-dir /tmp/zude-m02-ios

# Working directory: repository root
/Users/ayutacharya/anaai-local/node_modules/.bin/tsc -p /tmp/zude-m01-tsconfig.json
/Users/ayutacharya/anaai-local/node_modules/.bin/eslint --config /tmp/zude-m01-eslint.config.cjs --no-cache server/app.ts server/handlers/appointment-reads.ts server/handlers/appointments.ts
git diff --check
```

The temporary server tsconfig uses strict/noEmit, ES2022/DOM, CommonJS, node resolution, the worktree `@/*` alias and read-only neighboring node_modules/typeRoots; includes `server/**/*.ts`. Temporary ESLint config imports the matching neighboring Next core-web-vitals and TypeScript configs. These validation adapters do not alter repository dependencies. Loopback binding was permitted for real Express regression tests; no hosted provider calls were used. Tests/logs contain only synthetic fixtures, never real credentials.


New tests:

- `authenticated-reschedule-check.test.cjs`: wrapper auth/grants/search path, fixed check-only delegation, core scoping/exclusion/return-before-write, unchanged actual reschedule and new-booking/voice exclusion semantics. These are SQL source contract checks, not a claim of PostgreSQL execution.
- `authenticated-reschedule-check.integration.cjs`: opt-in local DB checks for authenticated phone-less self-exclusion, conflict with another appointment, foreign/missing targets and service, membership/anonymous rejection, unchanged appointment/customer/service/action/notification snapshots, existing booking/voice conflicts, existing actual reschedule success.
- `native-appointments-api.test.cjs`: real read handlers and business resolver with mocked provider, including auth/tenant/date/query isolation, minimal customer/service fields, SQL-only availability, phone-less reschedule references, closed/conflict/fail-closed and mismatched success metadata.
- `native-appointments-contract.test.cjs`: native response scoping, exact availability request identity, mutation receipt and encoded search.
- `native-appointments-state.test.cjs`: real resource hook, state helpers, request-key logic and composer with deterministic hook/component fixtures. Covers stale/cancelled/foreground requests, errors, date boundaries, lifecycle action visibility, booking success, reschedule preservation, closed/no-availability, conflict recovery and exact uncertain retry.
- `native-api-transport.test.cjs`: added mutation headers/body, safe conflict codes and account-switch-before-send rejection. Existing tests were retained.

### Disposable DB test instructions

No local `psql` or Docker executable was available and no disposable Supabase fixture was provided. The new DB test is deliberately skipped by default. Never point it at hosted or production data.

Prepare a local Supabase with the migration chain applied, a capacity-one business with valid hours, an authenticated member, an active service, a phone-less customer, and two non-overlapping Booked/Confirmed appointments. The target's interval must be valid under the current service duration and have no other overlap. Prepare a second business that the member cannot access, a service and appointment there. Use a fixture small enough for direct snapshot reads.

Set privately (never paste credentials into logs):

```text
ZUDE_RUN_LOCAL_RESCHEDULE_CHECKS=1
ANAAI_LOCAL_SUPABASE_URL=http://127.0.0.1:54321
ANAAI_TEST_ANON_KEY=<local fixture anon key>
ANAAI_TEST_USER_TOKEN=<local member token>
ZUDE_TEST_SERVICE_KEY=<local service credential, test runner only>
ANAAI_TEST_BUSINESS_ID=<member business>
ZUDE_TEST_APPOINTMENT_ID=<phone-less target>
ZUDE_TEST_OTHER_APPOINTMENT_ID=<other active appointment>
ZUDE_TEST_FOREIGN_BUSINESS_ID=<inaccessible business>
ZUDE_TEST_FOREIGN_APPOINTMENT_ID=<foreign appointment>
ZUDE_TEST_FOREIGN_SERVICE_ID=<foreign service>
```

Run `NODE_PATH=/Users/ayutacharya/anaai-local/node_modules node --test tests/authenticated-reschedule-check.integration.cjs`. The test verifies no writes during checks, then deliberately exercises the existing actual same-slot reschedule mutation, which may refresh snapshots. Use a disposable fixture. Run the existing atomic/concurrency acceptance tests too; mocks cannot prove RLS, grants, SQL compilation or lock behavior. The check wrapper must be verified with self-overlap and competing transactions before release.

## Runtime configuration

No configuration file containing credentials was changed. Retain existing server Supabase URL/anon key and `SUPABASE_SECRET_KEY` for the existing server-only new-booking availability checker. This credential must never be included in Expo public variables. Retain existing Twilio settings for existing notification behavior.

Mobile public configuration remains `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` and `EXPO_PUBLIC_ZUDE_API_URL`. Browser development uses API `http://localhost:4000` and Expo `http://localhost:8081`, with server `ZUDE_CORS_ORIGINS=http://localhost:8081`. Production must use explicit HTTPS API/origin configuration; no implicit origin trust. Physical devices need a reachable LAN/HTTPS API hostname rather than the device's localhost. Restart API/Expo after configuration changes. Apply the new migration before testing reschedule availability.

## Manual Expo web acceptance — pending

1. Sign in and verify remembered business, Today data and business timezone. Inspect approved-origin OPTIONS and bearer-authenticated GET/POST/PATCH; unapproved origins have no access grant.
2. Navigate Today ↔ Appointments, including Today New Appointment and browser reload/back. Verify fresh Today data after each mutation and no prior-user/business data after switching accounts.
3. Navigate dates, enter an invalid date, search the day, select all four statuses. Confirm terminal appointments have no normal mutation actions.
4. Search/select a real phone-less customer and active service. Verify loading, retry, empty customers/services, closed date, invalid hours and no availability. Ensure every offered time came from the API.
5. Book from the single composer. Verify stored customer/service, snapshots/date/time/duration, restrained success, Done/View Appointment and no delivery promise.
6. Race two bookings for the last slot. Verify loser retains customer/service/date, clears time and refreshes alternatives. Simulate a lost mutation response; retry the same request and verify one appointment/receipt.
7. Reschedule a phone-less target to a valid same/overlapping-self interval, then to an interval occupied by another appointment at capacity. Confirm only self is excluded and no appointment changes during checks.
8. Confirm; cancel with Keep/Yes confirmation; complete a Confirmed appointment. Verify canonical inspector/Today refresh and terminal action removal. Race another client's lifecycle change and verify safe conflict/reload.
9. Test offline/API error, session expiry, tenant removal, slow old-date responses, foreground resume and business-local midnight. Validate safe errors and no sensitive console/network diagnostics.

## Physical iPad / iPhone acceptance — pending

- Build/run an SDK-compatible development client with the added native modules; resolve any actual native compatibility issue before release.
- Verify 1024×768 iPad landscape day/inspector split, rotation, larger text, single composer height and scrolling. Verify iPhone stacking and no horizontal overflow.
- Check 44pt touch targets, VoiceOver labels, date entry, keyboard-safe customer search and reachable review/save controls.
- Exercise real network/foreground interruptions, uncertain retry, conflict retention, phone-less reschedule and all lifecycle actions.
- Confirm business-local date/time on a device in another timezone and with a device-reachable API address.

No manual authenticated browser acceptance, live database migration, simulator run or physical iPad/iPhone test was performed. Bundle exports are not substitutes for these checks.

## Known limitations / scope review

- Availability is a 15-minute choice grid and can require 96/97 RPC round-trips with bounded concurrency. Measure real latency and load before release. No new bulk SQL algorithm, reservations, rate-limit infrastructure or nearest-date search was introduced.
- Read availability is advisory; concurrent service/appointment changes may conservatively fail and require refresh. The existing mutation remains the final authority.
- Name search supports active customers only; no new customer creation, phone search, customer detail route or service management.
- Legacy placeholder modules remain outside scope. No PIN, devices, time clock, staffing, payroll, POS, payments, web redesign or voice changes.
- No historical migration or capacity/hours/timezone/overlap/lifecycle/duration semantic changes. Root lockfile/environment files untouched. `.claude/` untouched. No commit/push.

## Exact files / final git status

Branch/HEAD remain `zude-app` / `76d64a02bd5cf7917666223d7661fde61415be20`; local tracking ahead/behind remains 0/0. Nothing staged. 11 tracked files modified, 19 new task files untracked, plus the pre-existing untracked `.claude/` directory.

Expanded task-file status (M = modified; ?? = untracked):

```text
 M apps/zude-mobile/app.json
 M apps/zude-mobile/index.ts
 M apps/zude-mobile/package-lock.json
 M apps/zude-mobile/package.json
 M apps/zude-mobile/src/features/today/TodayScreen.tsx
 M apps/zude-mobile/src/lib/api.ts
 M apps/zude-mobile/src/navigation/AppShell.tsx
 M apps/zude-mobile/src/navigation/Sidebar.tsx
 M server/app.ts
 M server/handlers/appointments.ts
 M tests/native-api-transport.test.cjs
?? apps/zude-mobile/src/app/_layout.tsx
?? apps/zude-mobile/src/app/appointments.tsx
?? apps/zude-mobile/src/app/index.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentComposer.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentsScreen.tsx
?? apps/zude-mobile/src/features/appointments/controls.tsx
?? apps/zude-mobile/src/features/appointments/requestKeys.ts
?? apps/zude-mobile/src/features/appointments/state.ts
?? apps/zude-mobile/src/features/appointments/useResource.ts
?? apps/zude-mobile/src/lib/appointments-api.ts
?? apps/zude-mobile/src/navigation/WorkspaceContext.tsx
?? docs/milestone-02-native-appointments.md
?? server/handlers/appointment-reads.ts
?? supabase/migrations/202609280001_authenticated_reschedule_check.sql
?? tests/authenticated-reschedule-check.integration.cjs
?? tests/authenticated-reschedule-check.test.cjs
?? tests/native-appointments-api.test.cjs
?? tests/native-appointments-contract.test.cjs
?? tests/native-appointments-state.test.cjs
?? apps/zude-mobile/.claude/  (pre-existing, untouched)
```

No further product decision is required for the implementation. Deployment still requires the migration and runtime acceptance described above. Stop here before commit/push.
