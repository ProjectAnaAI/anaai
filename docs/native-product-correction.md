# ZUDE product discovery and native correction

## Discovery checkpoint (before implementation)

Branch `zude-app`; HEAD `e9ba4395ce39db5a8138adb379b53d0dac895a06`. Existing uncommitted UI work preserved. `.claude/` excluded from reads and edits. No reset, stash, clean, commit or push.

## A. Existing web inventory / capability map

All paths relative to repository root. Web client reads/writes use the signed-in Supabase client and business-scoped RLS unless an Express endpoint is noted. `components/layout/ActiveBusinessProvider.tsx` resolves memberships and remembered selection; screens verify `/api/current-business`. Native must keep its API boundary rather than copy direct domain-table access.

| Capability / actual implementation | Backend/data authority and shared logic | Native now | Long-term placement / remaining work |
| --- | --- | --- | --- |
| Home — `app/dashboard/page.tsx`, `components/dashboard/` | `business_profiles`, `appointments`, `customers`, `services`, `ai_settings`; appointment mutations through `lib/appointment-api.ts` | Today appointment slice only, not all web metrics | Both; native Today remains operational, analytics stays separate |
| Appointments — `app/appointments/page.tsx`, `components/appointments/AppointmentCalendar.tsx`, `AppointmentComposer.tsx` | Tenant-scoped customer/service/appointment reads; POST/PATCH `/api/appointments`; `lib/appointment-calendar.ts`, `appointment-api.ts`, `appointment-request-key.ts`; SQL scheduling/lifecycle RPCs | Day timeline, booking, confirm/reschedule/cancel/complete, real availability | Both / Operations; retain web month/week/day/list, do not rebuild SQL for native |
| Customers — `app/customers/page.tsx` | `customers` contact/email/notes/is_active, history joined by `appointments.customer_id`; `lib/customer-mutations.ts` validation, paginated duplicate-phone checks and writes; `lib/customer-insights.ts` history summaries | Active customer name search for booking only | Both / Operations; M03 profile/history/edit/archive native presentation and safe API coverage |
| Calls — `app/calls/page.tsx` | Explicit unavailable page; no history/transcript/recording query or exposed history data source | None | AnaAI / Phase 2; existing route is not a working call-history capability |
| Receptionist — `app/ai/page.tsx` | `ai_settings`, `business_knowledge`; text preview POST `/api/ai` → `server/handlers/ai.ts`; existing voice pipeline separate | None | Both / AnaAI Voice Assistant, native Phase 2 |
| Knowledge — `app/knowledge/page.tsx` | `business_knowledge` category/question/answer CRUD with context verification | None | Both / AnaAI, native Phase 2 |
| Services — `app/services/page.tsx` | `services` name/duration/price/description/is_active; `lib/service-validation.ts`; scoped writes | Active name/duration reads for booking; API intentionally excludes price | Both / Operations; M03 catalog management via safe API using existing model/validation |
| Business & Availability — `app/business/page.tsx` | Canonical `businesses.name/timezone/appointment_capacity`, `business_profiles` contact/hours; `lib/business-hours.ts`; role-aware editing and RLS | Business name/timezone context and authoritative appointment availability only | Both / Business; future native settings must reuse canonical hours/capacity rules |
| Analytics — `app/analytics/page.tsx` | Scoped appointments/customers/services; `lib/analytics.ts` reporting windows/status totals/daily/service counts | None | Both / Manage; real appointment metrics, no invented voice/revenue attribution |
| Settings — `app/settings/page.tsx` | Links to business/receptionist/account, Supabase signOut; not a billing/ownership backend | No settings screen | Both / Business; preserve distinction between account sign-out and future device Lock |
| Authentication — `app/login/page.tsx`, `app/signup/page.tsx` | Supabase Auth password sign-in/sign-up; provider session subscription | Password sign-in/session restoration | Both; no auth redesign |
| Onboarding/setup — `app/onboarding/page.tsx`, `lib/onboarding.ts` | Draft/validation → POST `/api/onboarding` → `create_business_for_current_user`; business/membership/profile/services/receptionist provisioning | Truthful web-setup guidance | Web now; any later native setup reuses provisioning, not parallel tables |

## B. Shared backend / reuse map

- `server/app.ts` hosts the existing Express API. `lib/business-context.ts` verifies token with Supabase Auth, business membership and canonical business. Requested business header is a selection hint, never authorization. Native `src/lib/api.ts` retains bearer, business and identity checks.
- `server/handlers/appointments.ts` sends booking/rescheduling to `schedule_appointment_idempotent_business`, lifecycle actions to `confirm_appointment_atomic_business`, `cancel_appointment_atomic_business`, `complete_appointment_atomic_business`. Receipts/fingerprints/notification claims remain in `lib/appointment-actions.ts`, `appointment_actions` and `appointment_notifications`.
- `supabase/migrations/202609210002_appointment_capacity_checker.sql` owns interval/capacity checks; `202609210003_capacity_based_manual_scheduling.sql` owns atomic creation/rescheduling; `202609280001_authenticated_reschedule_check.sql` provides the authenticated check-only wrapper. Capacity is business-wide, never employee assigned.
- `server/handlers/appointment-reads.ts` exposes day/customer/service reads under verified membership/RLS. Availability checks each candidate through SQL, with bounded concurrency and verified result shapes. This booking-read API is not a full CRM/service-management API.
- Reuse customer validation, archived identity/phone checking, notes/contact model and history summaries for M03. `customer-mutations.ts` currently imports a web Supabase client: reuse rules via an audited API extraction in M03, not by importing that transport into native. Client duplicate detection is not cross-session database uniqueness.
- Reuse service validation and nullable price/description/active state. Do not add price to native booking display without a contract that returns it.
- Reuse business-hours validation, canonical timezone/capacity and analytics reporting helpers. JS display helpers do not become scheduling authority.
- Preserve voice: `server/handlers/voice.ts` verifies Twilio signatures; `lib/voice-handler.ts`, `voice-booking.ts`, `voice-appointment-management.ts`, voice state/slots/config, `business_phone_numbers` and `voice_handoff_settings` already implement routing and receptionist behavior. Native Phase 2 integrates this system; call history still needs an authoritative source.
- RLS/tenant invariants in `202609180002_harden_business_tenant_invariants.sql` and existing business membership remain authoritative. No speculative employee/timekeeping model is created.

## C. Committed native audit

`e9ba439` already provides AuthGate/LoginScreen; BusinessContext with authorized remembered selection; Today hook; appointments API/day/customers/services/availability; durable `requestKeys`; lifecycle helpers; `useResource` abort/identity/foreground handling; real booking and lifecycle mutation paths. The accepted runtime workflow persists to the same Supabase system. This correction preserves those paths.

## D. Uncommitted foundation audit and correction plan

Retain tokens, accessible controls, shared WorkspaceHeader/SplitWorkspace, inline composer sections/summary, real Today timeline, inspector, guarded mutations and responsive stacking. Correct: generic square ZU logo, only-two-destination shell, incomplete IA/state model, raw dates/timezone prominence, table column headings, weak time/customer hierarchy, undifferentiated inspector fields/actions and oversized sparse context. No web feature is removed or replaced.

## E. Brand/reference audit

**Exact R5 asset is not present in repository.** Searched asset/design/brand filenames, SVGs and R5/monogram/Figma references; inspected native icon/splash assets (starter assets), web Brand (historical AnaAI by ZUDE) and app icon (historical A). None is approved R5. No substitute monogram will be drawn. Brand will accept an approved mark and use plain product-name text while missing. Native launcher/splash assets are not claimed as R5.

ZUDE is the platform; AnaAI is its receptionist/voice intelligence feature. No approved Figma URL or reference image is present in the supplied brief/repository. Requested its location while proceeding from the explicit composition and hierarchy requirements. Reference fidelity and final visual approval remain human review, not an automated screenshot claim.

## F. Final navigation

| Group | Items / capability state |
| --- | --- |
| Operations | Today, Appointments — AVAILABLE_NATIVE; Customers, Services — EXISTING_WEB_CAPABILITY |
| My Work | Time Clock, My Time — PLANNED_NATIVE |
| Manage | Team, Timesheets, Corrections, Reports — ROLE_RESTRICTED and not built; Analytics — EXISTING_WEB_CAPABILITY; group shown for current owner/manager memberships |
| Ana AI | Voice Assistant, Calls, Knowledge — PHASE_2; receptionist and knowledge web routes exist, call history does not |
| Business | Business & Availability, Settings — EXISTING_WEB_CAPABILITY |
| System | Lock — PLANNED_NATIVE, not account sign-out or clock-out |

The persistent 100pt rail shows Operations plus secondary group controls and a disabled future Lock. Secondary controls open the full scrollable catalog at the selected group. Expanded navigation includes all permitted items with Web/Later/Phase 2 metadata and an explanation. Disabled destinations never navigate; no fake screens or external web launch/session transfer was added. Only AVAILABLE_NATIVE can carry a native route in the discriminated type. Web-route metadata is inventory, not an executable capability.

Current `staff` membership maps to employee-like presentation only; future business-scoped employee/PIN identity remains separate. No frontend role filter grants authorization. Owner-only ownership/billing/deletion/transfer/critical-security functionality is not pretended to exist.

## G. Today

Real chronological timeline, larger tabular time, stronger customer type, quiet service/duration metadata, current-row green treatment, receding past rows and meaningful NOW divider. Removed table column headings and prominent timezone metadata. Compact header has real business identity, readable business-local date, local search and New Appointment. Context rail narrowed to 260pt at the primary target and emphasizes real Up Next. Find a time remains truthful service-selection guidance. No invented open/shift/inbox/activity/voice/price data; no additional availability requests.

## H. Appointments

Same operational timeline/header with previous/Today/next and readable date button. Explicit date entry retains ISO format only where users are entering that format; all display dates use a shared timezone-stable presentation helper. Date state and API payloads remain ISO. Reads, filters, stale-resource protection and mutation handlers are retained. Selected inspector moves first in stacked layouts. Empty, loading and retry states remain meaningful.

## I. Inspector

Status → prominent customer → service/duration → large time/readable date → operational action → Reschedule → separated red-text cancellation. Confirm/Complete still use lifecycleActions; cancelled/completed are terminal. Cancellation prompt, stale/busy disabling and missing-reference reschedule guard are retained. Notes render only when present.

## J. New Appointment

All nine states retained: initial, customer search, customer selected, service/date selection, authoritative available times, ready, success, conflict and no availability. Completed selections collapse with touch-safe Change controls. Date choice is Today/Tomorrow/Choose Date; selected date and summary are human readable. Landscape summary and green booking action remain persistent; narrow layouts stack and dock the action. Success shows real returned status and supports Done/View Appointment without notification promises. Conflict keeps customer/service/date and clears stale time; closed/no availability preserve selections. Exact uncertain retry, durable idempotency keys, identity guards, authoritative slots and rescheduling restrictions are unchanged.

## K. Responsive behavior

| Size | Result / composition |
| --- | --- |
| 1024×768 | Persistent 100pt dark rail, 664pt main pane, 260pt context; compact header, time-centric rows and reachable booking CTA |
| 1366×1024 | Persistent rail, broader main pane and 320pt context |
| 768×1024 | Persistent rail, stacked content and selected inspector first |
| 390×844 | Navigation drawer, separate title/control rows when needed, stacked composer and docked CTA |
| 1440×900 | Wide main workspace/context split |
| 1024×480 | Reduced-height focused-field check; scrollable composer with docked action |

Font-scale fallbacks preserve stacking/drawer behavior. Safe-area and KeyboardAvoidingView paths retained. Browser sizing is not a physical iPad keyboard, VoiceOver or Dynamic Type validation.

## L. Future readiness

Customers/Services can reuse shared split panes, forms, list/inspector and loading/empty/error patterns over the existing model. Typed capabilities accommodate PIN employee context, Time Clock/My Time, team/timesheets/corrections/reports and Analytics without inventing routes or tables now. The future employee scope remains current-workweek-only; manager/owner history/team scope belongs to later authorization, not this catalog. AnaAI holds the existing receptionist/knowledge/voice integration for Phase 2. Lock stays separate from account logout and clock-out. No employee cards, staff assignment, provider calendars or staff scheduling were added.

## M. Functional preservation

| Existing flow | Preserved |
| --- | --- |
| Login/session | Yes; existing AuthGate and password auth behavior |
| Business/remembered context | Yes; authorized membership provider and user-scoped selection |
| Today reads | Yes; existing hook/API/business clock |
| Appointment reads | Yes; existing getDay/useResource |
| Customer search | Yes; existing real active-customer API/pagination |
| Services | Yes; existing active-service API |
| Availability | Yes; SQL-approved starts only |
| Booking | Yes; original performAction/submit path |
| Confirm | Yes; original lifecycle API/guards |
| Reschedule | Yes; original authority, references and request intent |
| Cancel | Yes; confirmation and lifecycle API |
| Complete | Yes; terminal semantics unchanged |
| Idempotency | Yes; durable keys, fingerprints and uncertain retry retained |
| Stale request protection | Yes; abort, account/business identity, alive guards and foreground refresh retained |

These statements are supported by diff review and regression tests; fixture browser checks exercise rendered workflows. They do not claim a new live Supabase persistence acceptance run.

## N. Backend/database freeze

**NONE changed:** Express API/contracts, SQL, schema, migrations, RPCs, RLS, authentication, tenant authorization, scheduling authority, lifecycle semantics, Twilio signature/voice behavior or database data. Existing web product code is unchanged. Native domain API clients/BusinessContext/state/requestKeys/useResource remain unchanged. No service credentials added to native or logs.

## O. Complete cumulative file inventory (relative to e9ba439)

This includes retained prior uncommitted work, not just this correction. M = modified; A = new/untracked; D = deleted.

Foundation/shell:

- M `apps/zude-mobile/src/app/index.tsx`
- M `apps/zude-mobile/src/components/ui.tsx`
- A `apps/zude-mobile/src/components/workspace.tsx`
- A `apps/zude-mobile/src/components/datePresentation.ts`
- M `apps/zude-mobile/src/theme/tokens.ts`
- A `apps/zude-mobile/src/theme/layout.ts`
- M `apps/zude-mobile/src/navigation/AppShell.tsx`
- M `apps/zude-mobile/src/navigation/Sidebar.tsx`
- M `apps/zude-mobile/src/navigation/WorkspaceContext.tsx`
- A `apps/zude-mobile/src/navigation/items.ts`

Today/demo cleanup retained:

- M `apps/zude-mobile/src/features/today/TodayScreen.tsx`
- M `apps/zude-mobile/src/features/today/Schedule.tsx`
- M `apps/zude-mobile/src/features/today/AppointmentList.tsx`
- A `apps/zude-mobile/src/features/today/presentation.ts`
- M `apps/zude-mobile/src/types/today.ts`
- D `apps/zude-mobile/src/components/PreviewDialog.tsx`
- D `apps/zude-mobile/src/data/demoToday.ts`

Appointment presentation:

- M `apps/zude-mobile/src/features/appointments/AppointmentsScreen.tsx`
- M `apps/zude-mobile/src/features/appointments/AppointmentComposer.tsx`
- M `apps/zude-mobile/src/features/appointments/controls.tsx`
- A `apps/zude-mobile/src/features/appointments/AppointmentInspector.tsx`
- A `apps/zude-mobile/src/features/appointments/AppointmentSummary.tsx`
- A `apps/zude-mobile/src/features/appointments/ComposerSection.tsx`

Entry presentation retained:

- M `apps/zude-mobile/src/features/auth/AuthGate.tsx`
- M `apps/zude-mobile/src/features/auth/LoginScreen.tsx`
- M `apps/zude-mobile/src/features/business/BusinessGate.tsx`

Tests/reports:

- M `tests/native-appointments-state.test.cjs`
- A `tests/native-ui-foundation.test.cjs`
- A `tests/visual/native-ui-browser.mjs`
- A `tests/visual/native-ui-check.mjs`
- A `docs/native-ui-foundation.md` (historical prior-pass report; superseded here)
- A `docs/native-product-correction.md` (this report)

## P. Dependencies

None. Package manifests/locks and Expo configuration unchanged; no install, audit fix, new backend or Supabase migration. Used existing Expo SDK 57 tools, existing Chrome and neighboring installed root test/TypeScript dependencies. SDK guidance reviewed at https://docs.expo.dev/versions/v57.0.0/ and https://docs.expo.dev/llms.txt before native API edits.

## Q. Validation

Final results recorded below after rendered review. Automated captures support inspection; they are **not final visual approval**. Exact R5 and approved reference comparison remain pending, as does manual physical-device acceptance.

| Check | Final result |
| --- | --- |
| Focused native state/UI tests | 41 passed, 0 failed, 0 skipped |
| Complete root suite | 1,194 tests: **1,192 passed, 0 failed, 2 skipped**; 8,194.89975ms |
| Native TypeScript | `tsc --noEmit --incremental false` — exit 0 |
| Native ESLint | `eslint . --no-cache` — exit 0 |
| Server TypeScript | Strict server config `/tmp/zude-m01-tsconfig.json` — exit 0 |
| Expo web | Final all-platform export — passed, 906 modules |
| Expo iOS | Hermes export — passed, 1,221 modules |
| Expo Android | Hermes export — passed, 1,355 modules |
| Browser matrix | **32 captures**, 77 intercepted fixture requests; no external API requests or runtime exceptions |
| Layout checks | Every capture: zero horizontal page overflow, zero offscreen overflow elements, zero visible button targets under 43px tolerance for 44pt target |
| Diff/syntax | `git diff --check`, visual-runner JS syntax checks — exit 0 |

The two unchanged skips are local PostgreSQL concurrent creation/self-excluding reschedule and local DB authenticated check-only exclusion/conflicts/phone-less/tenant isolation/no writes/unchanged mutations. No destructive/live DB fixture run was forced. Compared with e9ba439, 19 focused UI tests are added (16 prior-foundation tests plus 3 correction tests). Existing tests remain; navigation expectations were updated to assert the explicit capability model while still proving only real native routes can navigate.

Browser fixtures exercise booking conflict, successful booking, confirmation, rescheduling, completion and cancellation. Explicit final record assertions prove the created appointment was rescheduled/completed and the intended original appointment cancelled, without mutating the unrelated confirmed record. Selector ambiguity between Confirm and Confirmed was corrected in the harness.

Captures reviewed include Today, Appointments, navigation catalog, inspector, initial/customer-selected/service-selected/date-selection/date-selected/time/ready composer, success, conflict, closed/no availability, loading, error and empty day, plus the larger-iPad/portrait/iPhone/web matrix. Files are in `/tmp/zude-ui-captures/`; representative previews:

- [Today](/tmp/zude-ui-captures/1024-today.png)
- [Confirmed inspector](/tmp/zude-ui-captures/1024-confirmed.png)
- [Ready composer](/tmp/zude-ui-captures/1024-composer-ready.png)

Reproduction:

```sh
# From apps/zude-mobile; synthetic values only, no .env edits.
EXPO_NO_DOTENV=1 EXPO_PUBLIC_SUPABASE_URL=https://zude-ui.supabase.co EXPO_PUBLIC_SUPABASE_ANON_KEY=synthetic-ui-fixture EXPO_PUBLIC_ZUDE_API_URL=https://zude-ui.test CI=1 ./node_modules/.bin/expo export --platform all --output-dir /tmp/zude-ui-product-correction
# From repository root, in separate processes:
ZUDE_UI_EXPORT_DIR=/tmp/zude-ui-product-correction node tests/visual/native-ui-browser.mjs
node tests/visual/native-ui-check.mjs
```

Test host/isolated Chrome shut down after review. Export is not an installed-device build. Remaining manual review: supply exact R5 and approved Figma/reference for fidelity comparison; review 9.7-inch physical iPad including keyboard, VoiceOver and Dynamic Type; repeat real authenticated persistence acceptance against the intended development API. No final visual approval is claimed.

## R. Git

Branch remains `zude-app`; HEAD remains `e9ba4395ce39db5a8138adb379b53d0dac895a06`. No commit/push/stage/reset/stash/clean. `apps/zude-mobile/.claude/` remains untouched and untracked. Tracked diff statistics exclude the new untracked source/tests/reports listed above.

```text
$ git status --short
 M apps/zude-mobile/src/app/index.tsx
 D apps/zude-mobile/src/components/PreviewDialog.tsx
 M apps/zude-mobile/src/components/ui.tsx
 D apps/zude-mobile/src/data/demoToday.ts
 M apps/zude-mobile/src/features/appointments/AppointmentComposer.tsx
 M apps/zude-mobile/src/features/appointments/AppointmentsScreen.tsx
 M apps/zude-mobile/src/features/appointments/controls.tsx
 M apps/zude-mobile/src/features/auth/AuthGate.tsx
 M apps/zude-mobile/src/features/auth/LoginScreen.tsx
 M apps/zude-mobile/src/features/business/BusinessGate.tsx
 M apps/zude-mobile/src/features/today/AppointmentList.tsx
 M apps/zude-mobile/src/features/today/Schedule.tsx
 M apps/zude-mobile/src/features/today/TodayScreen.tsx
 M apps/zude-mobile/src/navigation/AppShell.tsx
 M apps/zude-mobile/src/navigation/Sidebar.tsx
 M apps/zude-mobile/src/navigation/WorkspaceContext.tsx
 M apps/zude-mobile/src/theme/tokens.ts
 M apps/zude-mobile/src/types/today.ts
 M tests/native-appointments-state.test.cjs
?? apps/zude-mobile/.claude/
?? apps/zude-mobile/src/components/datePresentation.ts
?? apps/zude-mobile/src/components/workspace.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentInspector.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentSummary.tsx
?? apps/zude-mobile/src/features/appointments/ComposerSection.tsx
?? apps/zude-mobile/src/features/today/presentation.ts
?? apps/zude-mobile/src/navigation/items.ts
?? apps/zude-mobile/src/theme/layout.ts
?? docs/native-product-correction.md
?? docs/native-ui-foundation.md
?? tests/native-ui-foundation.test.cjs
?? tests/visual/
```

```text
$ git diff --stat
 apps/zude-mobile/src/app/index.tsx                 |   4 +-
 apps/zude-mobile/src/components/PreviewDialog.tsx  |  49 ----
 apps/zude-mobile/src/components/ui.tsx             |  51 +++-
 apps/zude-mobile/src/data/demoToday.ts             |  48 ----
 .../features/appointments/AppointmentComposer.tsx  | 165 ++++++------
 .../features/appointments/AppointmentsScreen.tsx   |  93 +++----
 .../src/features/appointments/controls.tsx         |  63 ++---
 apps/zude-mobile/src/features/auth/AuthGate.tsx    |   5 +-
 apps/zude-mobile/src/features/auth/LoginScreen.tsx | 285 +++-----------------
 .../src/features/business/BusinessGate.tsx         |   5 +-
 .../src/features/today/AppointmentList.tsx         | 184 ++-----------
 apps/zude-mobile/src/features/today/Schedule.tsx   | 167 ++++--------
 .../zude-mobile/src/features/today/TodayScreen.tsx | 288 +++------------------
 apps/zude-mobile/src/navigation/AppShell.tsx       | 187 +++----------
 apps/zude-mobile/src/navigation/Sidebar.tsx        | 210 +++++----------
 .../src/navigation/WorkspaceContext.tsx            |   5 +-
 apps/zude-mobile/src/theme/tokens.ts               |  30 ++-
 apps/zude-mobile/src/types/today.ts                |   9 -
 tests/native-appointments-state.test.cjs           |  10 +-
 19 files changed, 471 insertions(+), 1387 deletions(-)
```
