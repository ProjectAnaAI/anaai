# ZUDE final pixel correction

A. Previous mismatch: the preceding pass used the earlier black-canvas reference. The latest light target supersedes it. This pass changes presentation only and preserves the existing uncommitted functional work.

B. Corrections: warm #FAF9F7 timeline and application workspace, warm neutral text/borders, light contextual rail, white appointment cards, black NOW pill with white dot/time plus black rule and terminal dot, black outline/left marker only for actual current or selected appointments. Future appointments no longer receive automatic selected-looking emphasis. Past status badges use neutral treatment; muted text remains contrast-tested. The orange CTA now has white text/icons as requested. Its white-on-orange contrast is approximately 2.9:1, a reference-fidelity tradeoff; it is not claimed to meet normal-text WCAG AA.

C. Canonical logo: `apps/zude-mobile/assets/brand/zu-logo.png`, rendered directly by React Native Image in shared Brand. No recreation, cropping, tinting, invented square, or typeset substitute. SHA-256 of both original and copied asset: `fb51e36576a4ef57afad6d8e9e39d616b295782819db136059d9a21d1b0d450b`.

D. Today: real business/date, appointment search, real current clock, chronological appointments, true current/selected treatment, and real nearest upcoming nonterminal appointment. New Appointment and row navigation retain existing routes.

E. Appointments: same warm canvas, rows, badges, and NOW treatment. Inspector and composer inherit matching neutral tokens. No booking or lifecycle logic edited.

F. Missing data: no business-open/hours, employee/shift/avatar, operational inbox, activity, or availability examples were invented. Availability retains service-selection guidance. No POS module added. Synthetic customer data exists only in the isolated browser test fixture, not application implementation.

G. Preservation: no native API, scheduling, auth, tenant/security, stale-request, or idempotency implementation edited. Browser fixtures exercised customer/service/date/time selection, booking conflict/retry, confirm, reschedule, complete, cancel, and unrelated-appointment preservation. Live database mutations and physical-device testing were not performed.

H. Responsive: 1024×768, 1366×1024, 768×1024, 390×844, and 1440×900 checked across Today/Appointments/composer; 41 captures, zero horizontal overflows and zero undersized targets in the existing 43px-tolerance check for nominal 44pt controls. Keyboard-height proxy also retained. Browser evidence does not substitute for physical iPad/iPhone acceptance.

I. Files changed in THIS correction (earlier uncommitted changes are preserved separately in git status):
- apps/zude-mobile/assets/brand/zu-logo.png (new, exact copy)
- apps/zude-mobile/src/components/workspace.tsx
- apps/zude-mobile/src/theme/tokens.ts
- apps/zude-mobile/src/features/today/TodayScreen.tsx
- apps/zude-mobile/src/features/today/Schedule.tsx
- apps/zude-mobile/src/features/appointments/AppointmentsScreen.tsx
- tests/native-ui-foundation.test.cjs
- tests/visual/native-ui-check.mjs
- docs/native-final-pixel-correction.md (this report)

J. Dependencies: none added/changed.

K. Backend/database: none. No SQL, migrations, RPC, RLS, schema, Express, scheduling, auth/security changes. No commit/push/reset/stash/clean. apps/zude-mobile/.claude/ remains untouched/untracked.

L. Validation (final sources):
- Focused native tests: 43/43 pass, zero skipped/failures, 464.430416 ms.
- Complete root suite: 1196 tests, 1194 pass, zero failures, 2 existing database-environment skips, 8225.025167 ms. No destructive database tests forced.
- Native TypeScript: `tsc --noEmit --incremental false`, exit 0.
- Native ESLint: `eslint . --no-cache`, exit 0.
- Server TypeScript: installed compiler with `/tmp/zude-m01-tsconfig.json`, exit 0.
- Expo web and iOS export: exit 0; `/tmp/zude-final-pixel`. Exact logo bundled on both platforms.
- Browser acceptance: PASS, 41 captures, 96 intercepted synthetic fixture requests, no external API requests. Added assertions for warm canvas, loaded PNG, actual-current outline, and no automatic future selection. Existing booking/lifecycle checks retained.
- Test script syntax and `git diff --check`: exit 0.
- Logs: `/tmp/zude-final-tests.tap`, `/tmp/zude-final-focused.tap`, `/tmp/zude-final-export.log`, `/tmp/zude-final-visual.json`.

M. Primary visual comparison against the inline approved target:

| Property | Final 1024×768 implementation |
| --- | --- |
| Main background | Warm light #FAF9F7, no longer black |
| Navigation | 64pt near-black, direct PNG, light Today tile |
| Header | 68pt; real business/date left, search center, CTA right |
| Main/right split | 680pt / 280pt after navigation |
| Main padding | 24pt horizontal, 12pt before 44pt heading |
| Rows | 60pt minimum, 12pt gap, 10pt radius, 1pt warm border |
| First row | y=132; tracks the target's compact header/heading rhythm |
| Time column | 76pt; 14pt bold time, 12pt duration |
| Customer/service | 15pt semibold / 12pt secondary |
| Status | Compact 10pt, centered right, followed by chevron |
| NOW | Black compact pill, white label/dot, 2pt rule, 8pt terminal dot; position follows actual clock |
| Search | 260pt wide, x=420; readable 44pt minimum field |
| CTA | Top-right x=819, y=10, approximately 181×46pt; white-on-orange |
| Right rail | Warm light; real Up Next plus truthful availability guidance |

Inspected the final screenshot directly against the visible inline reference. Text/customer lengths and real schedule determine content positions; missing fake modules deliberately leave open space. Screenshot: `/tmp/zude-ui-captures/1024-today.png`.

The exact target image was provided inline without a local file path. Requested its path; no answer received at report time. `/tmp/zude-ui-captures/final-comparison.html` embeds the implementation and provides a local target-image selector; the target pane is explicitly pending. This is NOT a completed two-image side-by-side or a claim of final visual acceptance. The old conflicting dark image was not substituted. Remaining: obtain the exact light target file, populate/inspect the side-by-side, and user/physical-device visual acceptance.

N. Full cumulative git status --short:

```
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
?? apps/zude-mobile/assets/brand/
?? apps/zude-mobile/src/components/datePresentation.ts
?? apps/zude-mobile/src/components/workspace.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentInspector.tsx
?? apps/zude-mobile/src/features/appointments/AppointmentSummary.tsx
?? apps/zude-mobile/src/features/appointments/ComposerSection.tsx
?? apps/zude-mobile/src/features/today/presentation.ts
?? apps/zude-mobile/src/navigation/items.ts
?? apps/zude-mobile/src/theme/layout.ts
?? docs/native-final-pixel-correction.md
?? docs/native-ipad-recovery.md
?? docs/native-product-correction.md
?? docs/native-today-reference.md
?? docs/native-ui-foundation.md
?? tests/native-ui-foundation.test.cjs
?? tests/visual/
```

O. Full cumulative git diff --stat (untracked files are excluded by git):

```
 apps/zude-mobile/src/app/index.tsx                 |   4 +-
 apps/zude-mobile/src/components/PreviewDialog.tsx  |  49 ----
 apps/zude-mobile/src/components/ui.tsx             |  63 ++++-
 apps/zude-mobile/src/data/demoToday.ts             |  48 ----
 .../features/appointments/AppointmentComposer.tsx  | 165 +++++++-----
 .../features/appointments/AppointmentsScreen.tsx   |  93 +++----
 .../src/features/appointments/controls.tsx         |  63 ++---
 apps/zude-mobile/src/features/auth/AuthGate.tsx    |   5 +-
 apps/zude-mobile/src/features/auth/LoginScreen.tsx | 285 +++-----------------
 .../src/features/business/BusinessGate.tsx         |   5 +-
 .../src/features/today/AppointmentList.tsx         | 190 ++-----------
 apps/zude-mobile/src/features/today/Schedule.tsx   | 182 +++++--------
 .../zude-mobile/src/features/today/TodayScreen.tsx | 294 +++------------------
 apps/zude-mobile/src/navigation/AppShell.tsx       | 187 +++----------
 apps/zude-mobile/src/navigation/Sidebar.tsx        | 206 ++++-----------
 .../src/navigation/WorkspaceContext.tsx            |   5 +-
 apps/zude-mobile/src/theme/tokens.ts               |  46 +++-
 apps/zude-mobile/src/types/today.ts                |   9 -
 tests/native-appointments-state.test.cjs           |  10 +-
 19 files changed, 522 insertions(+), 1387 deletions(-)
```
