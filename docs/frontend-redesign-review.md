# AnaAI frontend redesign — review checkpoint

Implemented in the working tree for manual review. The production build passes with Webpack; the default Turbopack build encounters an environment permission error. Physical iPad Safari approval remains outstanding. No deployment, commit, push, database write, or migration operation was performed.

## Scope and important findings

All 13 existing page routes were audited and updated: `/`, `/login`, `/signup`, `/onboarding`, `/dashboard`, `/appointments`, `/customers`, `/ai`, `/knowledge`, `/services`, `/business`, `/analytics`, and `/settings`. Added `/calls` as an explicitly unavailable call-history surface, plus branded not-found and unexpected-error presentations.

**This checkout does not contain a call-history page, a persisted call-record query, or a call-record data source exposed to the frontend.** The existing `/ai` route contains configuration and text preview, not call records. Therefore the redesign does not fabricate caller lists, durations, transcripts, recordings, booking attribution, transfer outcomes, or live-call statistics. Calls is labeled “Coming soon.” The public FAQ states the limitation. No call-history backend was created.

There is also no genuine AnaAI video in `public/`. The public site uses an original illustrated walkthrough clearly labeled as an illustration, not a customer recording. It has no pretend play button. `ProductDemo` accepts an owned video source, poster, and WebVTT captions together when footage is available.

The repository was clean at the start of this redesign. Previous Voice and onboarding/capacity checkpoints were already in HEAD. Their migrations remain untouched.

## Product and responsive changes

| Route/surface | Design and preserved functionality | iPad landscape | iPad portrait | Phone |
| --- | --- | --- | --- | --- |
| `/` | Editorial hero, interactive call examples, conversation-to-appointment narrative, illustrated demo, business knowledge and calendar compositions, handoff explanation, original use-case artwork, FAQ, real navigation destinations, AnaAI by ZUDE footer | Full story, two-column hero at larger tablet widths | Hero recomposes above the call demo; sections retain their content | Compact navigation dialog, recomposed product illustrations and use-case rows; no desktop-only content dependency |
| `/login`, `/signup` | New shared auth composition, explicit labels, inline feedback, password visibility, native autofill, loading states; existing password auth retained | Brand/story beside the form | Two-panel composition where width allows | Focused form with AnaAI branding; large inputs and controls |
| `/onboarding` | Branded setup workspace, five-step rail, card with existing fields, persistent footer controls; unchanged draft, validation, capacity, review and provisioning logic | Step rail beside the form | Horizontal step indicator above the form; same mounted draft | Compact step indicator and full-width form; keyboard-sized controls |
| `/dashboard` | Business/date context, four genuine summary metrics, today’s appointments and status, receptionist configuration, business overview, existing shortcuts | Four metrics in one strip; schedule and status alongside one another | Two-column metric grid and stacked operational panels | Two-column metrics; stacked appointment and business sections |
| `/appointments` | Month/Week/Day/List preserved; responsive toolbar, touch navigation, compact month counts where needed, selected-day agenda, explicit status text, collapsed composer that retains fields, accessible cancel/complete confirmations, focused appointment details | Calendar fills the workspace; all existing actions remain available | Month grid uses counts plus the existing selected-day agenda when panel width is narrow; controls wrap deliberately | Compact month plus agenda; Week has intentional local horizontal scrolling, while Day and List remain available; no page-level overflow |
| `/customers` | Search, active/archive/all filters, identity/contact columns, expandable details and history, edit/archive actions preserved; native editor dialog | Dense rows with priority columns; email moves into expanded details below 1200px | Priority columns rather than a wide scrolling table | Existing compact list strategy, expandable full contact/history details; editor becomes a bottom sheet |
| `/calls` | Honest unavailable state, quiet voice-line motif, links to existing receptionist, knowledge and appointment work | Two-panel presentation | Stacked panels | Stacked explanation and useful destinations; no fake records |
| `/ai` | Identity/tone, greeting, business rules and handoff groups; section links; text preview moved beside configuration; existing character limits, save checks and permission rules retained | Configuration and preview/support columns | Configuration and preview stack; section links remain touch accessible | Stacked fields; no prompt-engineering jargon introduced; explicit preview limitations |
| `/knowledge` | “What AnaAI knows,” category/question/answer hierarchy, existing search/filter, readable long answers, native add/edit editor and delete confirmation | Category rail alongside answer content | Question/answer entries remain readable with visible actions | Categories stack above content; editor is a sheet |
| `/services` | Genuine name, duration, optional price, description, status and actions; compact summary strip; native editor; validation and active/inactive behavior preserved | Dense catalog rows that fit the workspace | Smaller fixed metadata columns, flexible service identity | Compact service list with visible actions; full-width editor sheet |
| `/business` | Section navigation for details/timezone/capacity/hours; grouped configuration; exact simultaneous-capacity question/support retained | Timezone and capacity can sit beside one another; profile and weekly hours span the form | Same form recomposes without replacing state | Single-column configuration with numeric capacity input and 44px increment/decrement controls |
| `/analytics` | Four real metrics, existing reporting window and calculations, responsive chart, expandable exact daily counts accessible without hover | Metrics in a strip; trend and overview alongside | Two-column metrics and stacked chart/overview | Chart fits its panel; textual daily breakdown remains available |
| `/settings` | Shared page hierarchy, existing settings destinations and session controls, consistent surfaces | Readable settings rows and session actions | Rows and session controls wrap | Stacked controls; logout remains reachable |
| Error/not-found | Branded fallback pages; retry uses the installed Next 16.3 `retry()` API; existing provider/auth routing retained | Restrained centered message/actions | Same message with wrapping actions | Touch-sized recovery destinations |

Desktop uses the same operational information architecture with a wider content area capped at 1512px. Marketing uses its own 1344px editorial content rhythm. The business sidebar appears at 1024px and above; below that, a native navigation dialog is used. Rotating an open navigation dialog back to landscape closes it and releases the scroll lock.

The business selector keeps its original membership lookup, storage key, selection validation, and keyed subtree remount. Only presentation and loading announcements changed. Long business names were tested; switching businesses cleared the first business’s unsaved preview text in the isolated browser fixture.

## Shared visual and interaction foundation

New shared exports: `Brand`, `VoiceLine`, `AuthFrame`, `PageHeader`, `DialogSurface`, `useConfirmation`, and `FeedbackPage`. Public compositions are split into `MarketingNav`, `CallDemo`, and `ProductDemo`.

Existing Button, Input, and Textarea now use consistent touch sizes, restrained radii, focus styling, and readable input text. Card/Badge implementations remain intact but inherit the shared palette and workspace surface treatment. Navigation uses real links, active-page semantics, grouped destinations, and a near-black background. The Next/Vercel starter favicon was replaced by an original simple AnaAI initial SVG.

Forms retain entered data and the original validation/mutation paths. Native dialogs provide a modal background, browser focus containment, Escape handling, and focus restoration. Editors cannot dismiss through Escape/backdrop while saving. Confirmation requests resolve as cancelled on unmount, including a business switch, and duplicate pending confirmations are rejected. Destructive confirmations use the danger variant. Appointment creation remains an inline complex form inside a disclosure, not an unmounted conditional; calendar creation opens it programmatically. Appointment selection focuses and scrolls to the existing detail/actions surface.

Normal application motion is limited to short state transitions and 200ms surface entry. Public motion communicates the example call’s state: waveform, transcript, stage, sample elapsed time, and result. No animation library, canvas, WebGL, Lottie, external font, stock video, competitor media, or heavy raster asset was added.

## Public demonstration and truthfulness

`CallDemo` has booking, rescheduling, and human-handoff scenarios using explicitly fictional data. It has scenario selection, step selection, restart, pause/play, and an alternative next-step control for reduced motion. It makes no API calls and does not create bookings. Progression pauses while the document is hidden.

Reduced motion stops continuous waveform animation and autoplay, shows a meaningful final example state, permits manual stepping, and removes decorative transition movement. Appointment scrolling also switches from smooth to immediate when reduced motion is requested.

The video-ready component uses native controls, `playsInline`, `preload="none"`, a poster, and captions when media is supplied. Today it renders the finished illustrated poster rather than implying a recording exists. No testimonials, customer logos, usage statistics, certifications, revenue claims, production SMS claims, staff calendars, integration connections, billing subscriptions, or free-trial offer were invented. Empty Pricing/Resources/legal destinations were not added.

Strategic references were reviewed for product education, simple call storytelling, and business hierarchy: [Retell](https://www.retellai.com/use-cases/receptionists), [Equal](https://myequal.ai/), and [RingCentral](https://www.ringcentral.com/ai-receptionist.html). The compositions, copy, CSS, and artwork are original to this implementation.

## Data, actions, and permission audit

| Surface | Existing dependencies/actions preserved |
| --- | --- |
| Auth/provider | Supabase password sign-in/sign-up/sign-out; session handling; `business_members` and `businesses` reads; per-user active-business storage and subtree key. Login adds a duplicate-submit guard and inline failure feedback, not a new authentication method. No OTP or SMS auth. |
| Onboarding | `/api/current-business`, per-user draft storage, profile/hours/timezone/services/receptionist/capacity validation, `/api/onboarding`, and readiness handling. No provisioning payload or logic changes. |
| Dashboard | Current-business context, business profile, appointments, customers, services, AI settings; genuine counts and existing navigation. No unsupported call metrics or booking-source attribution added. |
| Appointments | Current-business context; customers including archived references; services and appointments; existing appointment API, request keys, validation, conflicts and lifecycle actions. Changes are presentation and confirmation/scroll interactions only. |
| Customers | Existing customer and appointment reads, customer mutation helpers, edit/archive/reactivate actions, history ordering and empty/search states. |
| Services | Existing service reads and writes, duration/price validation, activation/deactivation and owner/manager edit permissions; staff remains read-only. |
| Receptionist | AI settings, knowledge context, read-only staff access, save verification, and `/api/ai` text-preview contract. One validation message now says “Business rules” instead of “Custom instructions”; limits and logic are unchanged. |
| Knowledge | Existing knowledge reads, filters, create/update/delete, permission verification and lengths. Only the delete confirmation surface changes. |
| Business | Existing profile, canonical business, timezone, structured weekly hours, capacity load/write guards; manager/owner distinctions and staff read-only behavior preserved. |
| Analytics | Existing 30-day reporting window, actual appointment/customer/service reads and calculations; no new metrics or fabricated trends. |
| Settings | Existing destinations and logout with failure recovery. |
| Calls | No new data dependency or mutation; explicit unavailable state. |

**No files under `app/api/`, `lib/`, or `supabase/` changed.** Database/schema, migrations, RLS, tenant authorization, business-members authorization, API contracts, auth architecture, Voice/Twilio/signatures/encrypted state/handoff, scheduling RPCs, capacity enforcement, conflict detection, duration rules, and appointment lifecycle rules are unchanged. Frontend appointment confirmation and navigation behavior did change as described above. Existing capacity configuration UI remains frontend configuration, not capacity enforcement.

No migration was created or applied during this redesign. The prior onboarding capacity migration was already committed before this work and was not modified. No Supabase configuration or environment file was changed. No commit or push occurred.

## Validation

Commands and outcomes:

- `npx tsc --noEmit --incremental false` — passed.
- `npm run build -- --webpack` — passed, including production compilation, TypeScript, and 23 generated routes/assets.
- `npm run build` — failed because Turbopack’s CSS worker could not bind a local port (`Operation not permitted`). Retrying with elevated execution produced the same environment error. No build configuration was changed; the supported `--webpack` flag was used for production validation.
- `npx eslint app/page.tsx app/login/page.tsx app/signup/page.tsx app/onboarding/page.tsx app/dashboard/page.tsx app/analytics/page.tsx app/business/page.tsx app/ai/page.tsx app/calls/page.tsx app/settings/page.tsx app/layout.tsx app/error.tsx app/not-found.tsx components/brand components/auth components/marketing components/ui components/layout/AppLayout.tsx components/layout/Sidebar.tsx components/layout/Topbar.tsx components/appointments` — passed, no warnings.
- `npx eslint app components` — 5 pre-existing errors and 8 warnings remain. The errors are existing hook-order/immutability findings in Appointments, Customers, Services and Knowledge, plus the existing state-in-effect finding in ActiveBusinessProvider. Committed HEAD was linted in memory with the same ESLint configuration to establish the baseline. Existing API unused-variable warnings are outside this frontend change. No new lint error was introduced.
- `node --test tests/app-shell.test.cjs tests/frontend-redesign.test.cjs tests/onboarding.test.cjs tests/appointment-calendar.test.cjs tests/appointment-lifecycle.test.cjs tests/customer-service-ui.test.cjs tests/customer-history.test.cjs tests/customer-mutations.test.cjs tests/dashboard-operational.test.cjs tests/analytics-reporting.test.cjs tests/production-ux.test.cjs` — 145 passed, 0 failed.
- `node --test --test-reporter=tap tests/*.test.cjs` — 979 tests: 976 passed, 3 failed. Initial HEAD baseline was 971 tests: 968 passed, the same 3 failed. The 8 new frontend checks pass.
- `git diff --check` — passed.
- `git diff -- app/api lib supabase package.json package-lock.json` — empty.
- Legacy JSX search for `cyan`, `bg-gray-900`, `shadow-2xl`, and `backdrop-blur` — no remaining occurrences in app/components TSX after the redesign.
- Reviewed the complete frontend diff and compared component logic statements against HEAD. The identified non-render changes are the UI confirmation hooks, appointment disclosure/focus/reduced-motion scrolling, auth submission feedback, and the business-rules validation copy described above. Next dev’s auto-generated AGENTS.md edit was restored to HEAD.

The three existing full-suite failures are:

1. `tests/appointment-capacity.test.cjs`: “capacity authority stays in the database, never in the browser.”
2. `tests/legacy-ai-capacity.test.cjs`: “23. no capacity authority exists in browser or API code.”
3. `tests/voice-capacity.test.cjs`: “no Voice capacity authority exists in browser or API code.”

All three use source assertions rejecting `appointment_capacity` in the already-existing Business configuration UI. They were left unchanged. The shell tests were updated specifically for CSS-based sidebar sizing and native dialog semantics, while retaining checks for all destinations, active-page semantics, touch sizing, business selection and logout. No scheduling/security test was weakened.

Browser QA used isolated headless Chrome with fictional fixtures, intercepted Supabase/API reads, and blocked mutation requests. It did not use a real signed-in customer account or submit a database/API mutation. Scripts/logs are in `/tmp/anaai-*` for this session:

- `node /tmp/anaai-browser.mjs` — public pages at 1440, 1194, 834 and 390px; auth layouts; no page overflow.
- `node /tmp/anaai-workspace-browser.mjs` and `node /tmp/anaai-extended-qa.mjs` — all 10 operational routes at 390, 834, 1024, 1194 and 1366px, no page-level overflow; all calendar views; composer opens; editor focus trapping and restoration; empty states; staff read-only views; all five onboarding steps and 100-capacity review; rotation retains entered editor text.
- `node /tmp/anaai-final-interactions.mjs` — reduced-motion final state, zero animated waveforms, manual progression, pause stability, public menu and focus restoration. Its first analytics failure probe was still loading; the subsequent corrected guard probe verified the actual error state.
- `node /tmp/anaai-guard-qa.mjs` — analytics error display, real opening of the native cancellation confirmation, safe Escape with zero mutation attempts, manager capacity read-only, and 1/100 increment/decrement boundaries. No runtime exceptions.
- `node /tmp/anaai-business-qa.mjs` — long-name multi-business selection at phone and landscape widths, cleared preview draft after business switch, branded 404, and no runtime exceptions.

Representative captures: `/tmp/anaai-home-desktop.png`, `/tmp/anaai-home-phone.png`, `/tmp/anaai-login-ipad.png`, `/tmp/anaai-final-1194-dashboard.png`, `/tmp/anaai-final-834-appointments.png`, `/tmp/anaai-final-1194-analytics.png`, `/tmp/anaai-final-onboarding.png`, `/tmp/anaai-final-onboarding-hours.png`, and `/tmp/anaai-final-public-demo-phone.png`. These are development/fixture captures, not customer evidence.

## Deliberate limits and unchanged components

No existing page route was omitted. Existing query/mutation helpers, backend APIs, provider identity logic, and scheduling calculations were intentionally retained. Empty unused dashboard component files remain empty; existing `QuickActions` and `StatsCard` source inherits the shared Button/Card/type treatment rather than being unnecessarily rewritten. Existing Card and Badge component contracts remain unchanged. Unused starter SVG files under `public/` are not rendered; no unrelated asset cleanup was performed. The rendered starter favicon was removed.

No staff/resource scheduling, call-history persistence, recording pipeline, automatic website synchronization, production SMS UI, integrations, billing, or OTP flow was implemented. Calls is the only new explicitly future-facing product destination. No fabricated “connected” or “subscribed” state exists.

No application dependency was added or upgraded. Prettier 3.6.2 was used temporarily through npm exec for formatting only; package manifests and lockfiles are unchanged. Native CSS/React, existing Lucide icons, Base UI buttons, and Sonner supply the UI.

Accessibility improvements include semantic links and labels, skip links, visible focus, selected-page/state semantics, native dialog containment, Escape and focus restoration, 44px standard controls, 16px form inputs, password visibility/autocomplete, explicit appointment status text, text alternatives for chart values, loading announcements, pause controls, reduced motion, and no hover-only critical actions. This is not a claim of a completed formal WCAG audit or VoiceOver certification.

## Physical-iPad release checklist

Test on Safari on 13-inch and 11-inch iPad Pro plus a standard iPad; include both orientations, software keyboard, hardware keyboard, and VoiceOver. Chrome viewport emulation does not prove Safari behavior.

- [ ] Open every route; inspect long business/customer/service names, emails, timezone labels, empty/loading/error states, and readonly access. Check no page-level horizontal overflow.
- [ ] Landscape → portrait → landscape with navigation open; ensure one overlay at most, no locked scrolling, and all navigation destinations remain reachable.
- [ ] Open Customer, Service and Knowledge editors; enter text, rotate, invoke/dismiss the software keyboard, scroll to Save/Cancel, use Escape with a keyboard, and verify focus returns to the trigger. Check safe-area spacing and native dialog behavior.
- [ ] Verify password autofill, show/hide controls, invalid credentials, loading/duplicate-submit protection, sign-up verification messaging, and logout. Do not expect OTP.
- [ ] Complete the five onboarding steps in a test environment; reload to restore the draft; test capacity 1, 100, blank, decimal and out-of-range input; confirm review and final provisioning remain correct.
- [ ] On Business, check owner/manager/staff distinctions, long timezone selection, weekly-hours time inputs, capacity boundary controls, load-failure guard, and saved values using a non-production test business.
- [ ] In Month/Week/Day/List, check Today/date movement, business timezone, dense overlapping appointments, duration labels, explicit status, selected-day agenda, and creation from a calendar date/time. Week’s local horizontal scrolling is intentional on phones.
- [ ] Test create, confirm, reschedule, complete and cancel in a staging business. Verify cancellation of a confirmation makes no mutation, duplicate actions remain guarded, conflicts/capacity rejections preserve form values, and no lifecycle action disappeared.
- [ ] Verify archived customers remain visible on existing appointment/history views, cannot be newly assigned where prohibited, and customer/service edit/archive actions retain their previous behavior.
- [ ] Switch between two businesses and sign out/in; confirm no prior business form or preview state remains and all data belongs to the selected business.
- [ ] Check the analytics chart and expanded daily counts with touch and VoiceOver; verify actual dates/counts rather than relying on hover.
- [ ] Exercise marketing scenario selection, pause/restart/steps and FAQ with touch and keyboard. Turn on Reduce Motion: no autoplay/decorative waveform should remain. Check the poster at narrow widths and do not mistake it for playable footage.
- [ ] If genuine video is later supplied, test captions, play/pause, fullscreen and inline playback on Safari using the actual owned media.
- [ ] Confirm Calls remains clearly unavailable until a real data source is implemented; never interpret the public fictional demo as live operational data.

Specific Safari risks to verify: `showModal()`/focus restoration with the software keyboard, `dvh` resizing, container-query month layout, native time/select controls, scroll restoration after modal closure/rotation, and viewport/keyboard interactions with sticky form controls. Current-time/today rendering and appointment duration math retain their existing implementation; no new staff lanes or realtime clock service was introduced.

## Complete changed-file inventory

- `app/ai/page.tsx` — modified
- `app/analytics/page.tsx` — modified
- `app/appointments/page.tsx` — modified
- `app/business/page.tsx` — modified
- `app/calls/page.tsx` — new
- `app/customers/page.tsx` — modified
- `app/dashboard/page.tsx` — modified
- `app/design-system.css` — new
- `app/error.tsx` — new
- `app/favicon.ico` — deleted (starter favicon)
- `app/globals.css` — modified
- `app/icon.svg` — new
- `app/knowledge/page.tsx` — modified
- `app/layout.tsx` — modified
- `app/login/page.tsx` — modified
- `app/marketing.css` — new
- `app/not-found.tsx` — new
- `app/onboarding/page.tsx` — modified
- `app/page.tsx` — modified
- `app/services/page.tsx` — modified
- `app/settings/page.tsx` — modified
- `app/signup/page.tsx` — modified
- `components/appointments/AppointmentCalendar.tsx` — modified
- `components/auth/AuthFrame.tsx` — new
- `components/brand/Brand.tsx` — new
- `components/layout/ActiveBusinessProvider.tsx` — modified
- `components/layout/AppLayout.tsx` — modified
- `components/layout/Sidebar.tsx` — modified
- `components/layout/Topbar.tsx` — modified
- `components/marketing/CallDemo.tsx` — new
- `components/marketing/MarketingNav.tsx` — new
- `components/marketing/ProductDemo.tsx` — new
- `components/ui/button.tsx` — modified
- `components/ui/dialog-surface.tsx` — new
- `components/ui/feedback-page.tsx` — new
- `components/ui/input.tsx` — modified
- `components/ui/page-header.tsx` — new
- `components/ui/textarea.tsx` — modified
- `components/ui/use-confirmation.tsx` — new
- `docs/frontend-redesign-review.md` — new
- `tests/app-shell.test.cjs` — modified
- `tests/frontend-redesign.test.cjs` — new
