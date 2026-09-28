> Historical first-pass report. The current product discovery, corrections and final validation are recorded in [native-product-correction.md](native-product-correction.md).

# ZUDE native UI foundation

## Audit before implementation

Starting checkpoint: branch `zude-app`, HEAD `e9ba4395ce39db5a8138adb379b53d0dac895a06`. Only existing untracked `apps/zude-mobile/.claude/`; excluded from work.

Mismatch inventory:

- 218pt desktop sidebar consumes too much of the primary 1024×768 canvas. All future destinations appear interactive and open previews.
- Shell renders demo employee initials/name and a fabricated Clocked in badge. Generic context is mixed with demo messaging.
- Today makes Up Next and disconnected placeholders primary, relegating the actual day timeline to a narrow rail. Appointment selection still opens a misleading future-feature preview.
- Day list rows are individually boxed, with weak status hierarchy and no meaningful in-list NOW divider. Header/date/search controls consume excessive vertical space.
- Composer is a large modal with every section expanded; summary and CTA scroll out of view. Service/date lack compact completed rows. Styles and buttons duplicate the general UI primitives.
- Tokens lack destructive/focus/status/surface semantics and a shared responsive layout policy. Login/business entry use separate visual implementations.
- Real contracts provide no employee shifts, operating status, prices, inbox or activity feed. Today availability would require service selection and up to 96 RPC checks; automatic querying for decoration is inappropriate.

Preserved execution paths:

- AuthGate restores/subscribes to Supabase Auth; LoginScreen uses the existing password sign-in. BusinessProvider calls GET /businesses and only remembers a choice within fresh authorized memberships, keyed by user.
- Today uses useTodayAppointments → today-api → bearer API GET /appointments with business-local date, abort and stale identity protection.
- Appointments uses useResource → getDay/customer search/services/availability in appointments-api → the existing Express endpoints. No direct native domain Supabase reads.
- POST/PATCH use performAction's durable hashed intent/UUID key, apiMutate's account identity checks, the existing authenticated business resolver, idempotent scheduling/lifecycle RPCs and verified receipts.
- Booking/reschedule preserve authoritative SQL availability, conflict time invalidation, exact uncertain retries and canonical refetch. Confirm/cancel/complete remain constrained by lifecycleActions and backend guards.
- Router Slot is keyed by user/business. Navigation replaces Today/Appointments; Today remounts/refetches after operations. Resources abort obsolete requests and refresh on foreground.

Design direction: 80pt persistent rail where space permits; shared header; flexible primary pane and contextual rail; one progressive composer with persistent summary/action on landscape tablets; stacked phone composition with reachable footer. No backend, database, security-model or API contract changes are planned or necessary.

## B. Design system

Shared semantic colors, spacing, typography, borders, radii, 44pt controls, focus/pressed/disabled states and responsive layout policy replace per-screen presentation. Brand, Field, WorkspaceHeader, PaneTitle, SplitWorkspace, Feedback and DetailLine complement the existing Button/IconButton/Badge primitives. Composer sections, summary and appointment inspector are small feature components. No new framework or dependencies.

## C. App shell

80pt dark rail with orange ZU identity; only Today and Appointments navigate. Typed navigation descriptors retain Operations/My Work/Manage/Ana AI/System and future role filtering without exposing fake modules or granting authorization. Narrow screens use a drawer. Busy or uncertain composer saves lock shell navigation. User/business keyed routing remains intact.

## D. Today

Real chronological appointments now dominate the workspace, with prominent times, duration, status, past/current/selection treatment and meaningful NOW placement. Local search filters loaded data. Up Next uses the nearest real upcoming nonterminal appointment. Selection opens the actual appointment inspector. New Appointment opens the existing booking workflow. No fake employee, clock-in, business-open, operational inbox or activity content remains. Availability guidance requires choosing a service in the composer; Today performs no decorative availability fan-out.

## E. Appointments

Shared header, date navigation, local search, timeline and contextual inspector replace boxed cards and modal detail presentation. Confirm/reschedule/cancel/complete retain lifecycle guards; terminal appointments have no invalid actions. Cancellation requires confirmation. Loading, retry and empty-day states remain explicit. Closed/no-availability information appears only when returned by the availability contract.

## F. New appointment

One inline progressive workspace covers initial/customer search/customer selected/service selected/date/authoritative time/ready/success/conflict/no-availability states. Completed choices collapse with Change controls. Landscape summary and CTA remain in the contextual rail; stacked layouts have a docked action. Customer creation and unsupported prices are omitted. Booking success reports the actual returned status rather than promising a lifecycle confirmation or notification. Conflict retains customer/service/date and invalidates stale time through the existing recovery path. Uncertain retries preserve the exact pending request and disable editing/closing/navigation. Rescheduling uses the same workspace with its existing restricted fields.

## G. Responsiveness and visual review

Reviewed exported Expo web in isolated headless Chrome using synthetic API fixtures, never production records. Captures are in `/tmp/zude-ui-captures/`.

| Viewport | Composition |
| --- | --- |
| 1024×768 | 80pt rail, dominant timeline/composer, 280pt context with reachable footer |
| 1366×1024 | Expanded main pane, 320pt context |
| 768×1024 | Persistent rail, stacked workspace/inspector |
| 390×844 | Drawer, compact header/search/action row, selected inspector first, stacked composer |
| 1440×900 | Wide workspace and contextual rail |
| 1024×480 | Reduced-height focused-input check; scrollable form and docked action |

Visual review corrected phone title wrapping and brought the selected inspector to the top on stacked layouts. The automated matrix checks page width, visible button targets and runtime errors, and captures Today, inspector, initial/time/ready composer, conflict, success, confirm/reschedule/complete/cancel, closed/no-availability/empty/error states. Pure tests also cover text-scale layout fallbacks. This is browser acceptance, not a physical iPad/VoiceOver/OS keyboard test. Actual device keyboard, Dynamic Type and live authenticated persistence remain runtime acceptance tasks.

## H. Functional preservation

| Flow | Result |
| --- | --- |
| Login | Preserved; password sign-in implementation unchanged; presentation refreshed |
| Business selection/context/remembered choice | Preserved; provider and membership API unchanged |
| Today reads | Preserved; existing hook/API unchanged |
| Appointment reads | Preserved; existing API/resource handling retained |
| Booking | Preserved; original submit/performAction path |
| Confirmation | Preserved; existing guarded mutation |
| Rescheduling | Preserved; original submit and authoritative exclusion behavior |
| Cancellation | Preserved; existing guarded mutation and explicit confirmation |
| Completion | Preserved; terminal guard retained |
| Authoritative availability | Preserved; only API-provided slots selectable |
| Idempotency | Preserved; requestKeys and exact uncertain retry logic unchanged |
| Stale requests | Preserved; useResource, abort/identity checks and alive guards retained |

Existing regression tests cover the above contracts. The fixture browser additionally exercises booking, conflict, confirmation, rescheduling, completion and cancellation through the rendered app. It does not replace live-backend/device acceptance.

## I. Exact files changed

Paths below are relative to the repository root. M = modified, A = new/untracked, D = deleted.

Foundation and shell:

- M `apps/zude-mobile/src/theme/tokens.ts`
- A `apps/zude-mobile/src/theme/layout.ts`
- M `apps/zude-mobile/src/components/ui.tsx`
- A `apps/zude-mobile/src/components/workspace.tsx`
- M `apps/zude-mobile/src/navigation/AppShell.tsx`
- M `apps/zude-mobile/src/navigation/Sidebar.tsx`
- M `apps/zude-mobile/src/navigation/WorkspaceContext.tsx`
- A `apps/zude-mobile/src/navigation/items.ts`
- M `apps/zude-mobile/src/app/index.tsx`

Today and removal of demo presentation:

- M `apps/zude-mobile/src/features/today/TodayScreen.tsx`
- M `apps/zude-mobile/src/features/today/Schedule.tsx`
- M `apps/zude-mobile/src/features/today/AppointmentList.tsx`
- A `apps/zude-mobile/src/features/today/presentation.ts`
- M `apps/zude-mobile/src/types/today.ts`
- D `apps/zude-mobile/src/components/PreviewDialog.tsx`
- D `apps/zude-mobile/src/data/demoToday.ts`

Appointments:

- M `apps/zude-mobile/src/features/appointments/AppointmentsScreen.tsx`
- M `apps/zude-mobile/src/features/appointments/AppointmentComposer.tsx`
- M `apps/zude-mobile/src/features/appointments/controls.tsx`
- A `apps/zude-mobile/src/features/appointments/AppointmentInspector.tsx`
- A `apps/zude-mobile/src/features/appointments/AppointmentSummary.tsx`
- A `apps/zude-mobile/src/features/appointments/ComposerSection.tsx`

Entry presentation:

- M `apps/zude-mobile/src/features/auth/AuthGate.tsx`
- M `apps/zude-mobile/src/features/auth/LoginScreen.tsx`
- M `apps/zude-mobile/src/features/business/BusinessGate.tsx`

Tests and documentation:

- M `tests/native-appointments-state.test.cjs` — adapts component mocks/traversal and explicit Change date interaction; retains existing test assertions.
- A `tests/native-ui-foundation.test.cjs` — 16 focused responsive/navigation/timing/status tests.
- A `tests/visual/native-ui-browser.mjs` — isolated local fixture host/browser.
- A `tests/visual/native-ui-check.mjs` — rendered workflow and viewport acceptance.
- A `docs/native-ui-foundation.md` — audit and final report.

## J. Dependencies

None. Package manifests, lockfiles and Expo app configuration unchanged. Existing Expo tooling and installed Chrome were used. Root tests/server TypeScript use the available dependency installation at `/Users/ayutacharya/anaai-local/node_modules`; no installation or audit fix was performed.

## K. Validation

- Complete root suite: **1,191 tests; 1,189 passed; 0 failed; 2 skipped**, 25,336.047042ms. Baseline was 1,173 passes plus 2 skips; 16 new tests pass.
- Skips: local PostgreSQL concurrent creation/self-excluding reschedule; local DB authenticated check-only exclusion/other conflict/phone-less/tenant isolation/no writes/unchanged mutations. Environment-dependent DB tests were not forced.
- Native TypeScript: `tsc --noEmit --incremental false` — exit 0.
- Native ESLint: `eslint . --no-cache` — exit 0.
- Server TypeScript: existing strict temporary server config `/tmp/zude-m01-tsconfig.json` — exit 0.
- Expo final export: `expo export --platform all --output-dir /tmp/zude-ui-foundation-final` — exit 0; web, iOS Hermes and Android bundles generated. Synthetic fixture environment passed only to the command; no environment files changed. Earlier individual web and iOS exports also passed.
- Browser acceptance: **25 captures passed**, **67 intercepted fixture requests**, no external API requests or runtime exceptions; all captures had zero page overflow, zero offscreen overflow elements and zero visible button targets below the 43px test tolerance for 44pt controls.
- `git diff --check` — exit 0.
- No destructive DB fixtures or production API calls were used for visual tests.

Repeat browser acceptance after exporting with fixture hosts `https://zude-ui.supabase.co` and `https://zude-ui.test`: run `ZUDE_UI_EXPORT_DIR=/tmp/zude-ui-foundation-final node tests/visual/native-ui-browser.mjs`, then `node tests/visual/native-ui-check.mjs`. Stop the host afterward. The runner intercepts fixture requests and blocks other remote hosts.

## L. Backend/database and scope review

**NONE:** SQL, migrations, RPCs, schema, RLS, server API contracts, tenant authorization and scheduling/lifecycle security are unchanged. Mobile API clients, BusinessContext, requestKeys, state helpers and useResource remain unchanged. No future feature functionality was implemented. Final diff reviewed for scope; no commit or push. `apps/zude-mobile/.claude/` remains untouched and untracked.

## M. Git status

Final status and tracked diff statistics follow. Git diff statistics exclude new untracked files listed above.

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
?? apps/zude-mobile/src/components/workspace.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentInspector.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentSummary.tsx
?? apps/zude-mobile/src/features/appointments/ComposerSection.tsx
?? apps/zude-mobile/src/features/today/presentation.ts
?? apps/zude-mobile/src/navigation/items.ts
?? apps/zude-mobile/src/theme/layout.ts
?? docs/native-ui-foundation.md
?? tests/native-ui-foundation.test.cjs
?? tests/visual/
```

```text
$ git diff --stat
 apps/zude-mobile/src/app/index.tsx                 |   4 +-
 apps/zude-mobile/src/components/PreviewDialog.tsx  |  49 ----
 apps/zude-mobile/src/components/ui.tsx             |  50 +++-
 apps/zude-mobile/src/data/demoToday.ts             |  48 ----
 .../features/appointments/AppointmentComposer.tsx  | 164 ++++++------
 .../features/appointments/AppointmentsScreen.tsx   |  92 +++----
 .../src/features/appointments/controls.tsx         |  62 ++---
 apps/zude-mobile/src/features/auth/AuthGate.tsx    |   5 +-
 apps/zude-mobile/src/features/auth/LoginScreen.tsx | 285 +++-----------------
 .../src/features/business/BusinessGate.tsx         |   5 +-
 .../src/features/today/AppointmentList.tsx         | 184 ++-----------
 apps/zude-mobile/src/features/today/Schedule.tsx   | 169 ++++--------
 .../zude-mobile/src/features/today/TodayScreen.tsx | 288 +++------------------
 apps/zude-mobile/src/navigation/AppShell.tsx       | 184 +++----------
 apps/zude-mobile/src/navigation/Sidebar.tsx        | 193 +++-----------
 .../src/navigation/WorkspaceContext.tsx            |   5 +-
 apps/zude-mobile/src/theme/tokens.ts               |  28 +-
 apps/zude-mobile/src/types/today.ts                |   9 -
 tests/native-appointments-state.test.cjs           |   9 +-
 19 files changed, 446 insertions(+), 1387 deletions(-)
```
