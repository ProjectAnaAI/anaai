# Native M03 — Customers + Services

Native Customers and Services workspaces for the ZUDE iPad app (1024×768 landscape primary, iPhone secondary). They are thin clients over the existing web product's rules. This milestone adds no new data model, no scheduling change and no migration.

## A. Audit — existing capability map

### Web Customers (`app/customers/page.tsx`, `lib/customer-mutations.ts`, `lib/customer-insights.ts`)

| Capability | Existing behavior (source of truth) |
| --- | --- |
| Fields | `customers`: `id, full_name, phone, email, notes, is_active` (plus `business_id`, `user_id` compatibility owner, `created_at`) |
| List | All customers for the business, sorted active first, then `full_name` (`sortCustomers`) |
| Filter | `active` / `archived` / `all` |
| Search | Case-insensitive substring over `full_name + phone + email` |
| Create | `saveCustomer` → `validateCustomer` + business-wide duplicate-phone scan (paged, **includes archived**) → insert with `business_id`, `user_id`, `is_active: true` |
| Edit | Same `saveCustomer` path, scoped `.eq("id").eq("business_id")`, current record excluded from the duplicate scan |
| Validation | Name required, ≤200 chars. Phone optional; when present `^[+\d\s().-]+$` with 7–15 digits. Email optional, ≤254 chars, simple `x@y.z`. Notes optional, trimmed |
| Notes | `customers.notes`: authoritative, free text, edited with the customer |
| Archive | Deactivation only (`is_active=false`), with confirmation; history is preserved; reactivation is allowed. **No deletion** (migration `202609190002`) |
| History | Read-only appointments linked by `customer_id`, newest-first; `summarizeCustomerHistory` gives nearest upcoming (Booked/Confirmed at/after business "now"), last past, completed/cancelled counts |
| Booking eligibility | Only active customers can be booked (`findCustomerMatches`, and the appointment RPC's `INVALID_CUSTOMER`) |
| Roles | No role restriction; any business member |

### Web Services (`app/services/page.tsx`, `lib/service-validation.ts`)

| Capability | Existing behavior |
| --- | --- |
| Fields | `services`: `id, name, duration_minutes, price, description, is_active` (+ `business_id`, `user_id`) |
| List | All services, active first, then name |
| Create | `validateService` → insert with `business_id`, `user_id` |
| Edit | Name, price, description and active can change. **Duration is immutable after creation** ("create a new service and deactivate the old one") |
| Validation | Name required, ≤200 chars. Duration an integer from 1 to 1440 (nullable in the form). Price optional and non-negative. Description optional (UI max 2000) |
| Active | Activate/deactivate toggle. **No deletion** (deleting services historically broke capacity checks; see `202609210007`) |
| Roles | Create, edit and toggle are **owner/manager only** (`canManageServices`); staff can read |
| Not supported | Categories, staff assignment, colors, commissions, inventory, resources |

### Database / RLS / RPC

- `customers.business_id`, `services.business_id` and `appointments.business_id` are `NOT NULL` (`202609180002`).
- `customers.is_active` has index `(business_id, is_active, created_at desc)` (`202609190002`).
- RLS policies for `customers` and `services` predate the repository migrations. The web writes directly with the member's JWT client, so RLS is the existing tenant boundary. The API keeps using the member's JWT client (never the service role) for these tables, so RLS remains defense in depth.
- Appointments consume services through `service_id`. Candidate duration comes from the **live active** service row, and existing appointments use the `appointments.duration_minutes` snapshot (`202609210007`). Changing a service's name, price, description or active flag never changes existing intervals. Duration stays locked in the web, and native keeps that lock.
- Capacity is business-wide, and there is no staff model. Services UI does not touch scheduling.

### Express server (`server/`)

- Pattern: Web `Request → Response` handlers wrapped by `webHandler`; `bearerToken` → `resolveBusinessContext` (verifies the JWT, loads memberships and validates `x-anaai-business-id` **against memberships**) → member RLS client; `readJson`/`readFailure` with `Cache-Control: no-store`; strict query-parameter allow-lists; `isUuid` identifier checks.
- Existing coverage before M03:
  - `GET /api/customers?q&offset` returns only active customers, as `id, full_name, phone`. It exists for the M02 composer picker.
  - `GET /api/services` returns only active services, as `id, name, duration_minutes`. It also exists for the M02 composer.
  - Neither endpoint supports archived or inactive records, email/notes/price, detail views, history or any mutation.
- CORS already allows `GET, POST, PATCH` and `Content-Type`.

### Native (`apps/zude-mobile/src`)

- Navigation: `Customers` and `Services` exist in `navigation/items.ts` as `EXISTING_WEB_CAPABILITY` (dimmed and not routable).
- Reusable: `AppShell`, `Sidebar`, `WorkspaceContext`, `WorkspaceHeader` (operational), `SplitWorkspace`, `PaneTitle`, `Feedback`, `Field`, `Button`/`IconButton`/`Badge`, `Notice`, `useResource` (abortable and foreground-refreshing), `safeMessage`, `timeLabel`, `dateLabel`, and the `workspaceLayout` responsive policy.
- API client: `apiGet` with `businessId` header, session-change detection and sanitized errors. `apiMutate` is hard-wired to `/api/appointments`.
- Composer: `AppointmentComposer` already accepts a selected `Customer` internally, but has no prop for preselecting one.

## B. API gaps and additions

All handlers are in `server/handlers/customers.ts` and `server/handlers/services.ts`. They use the same `resolveBusinessContext` and member-RLS client pattern. Business context comes only from verified membership. `business_id` in a body is rejected as an unknown field, and every query is `.eq("business_id", context.businessId)`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/customers/directory?q&status&offset` | CRM list: web search/filter/sort semantics, 50 per page, active/archived counts |
| `GET /api/customers/:id` | Detail (including notes) + appointment history + web `summarizeCustomerHistory` summary |
| `POST /api/customers` | Create (shared validation + duplicate-phone scan) |
| `PATCH /api/customers/:id` | Edit fields **or** archive/reactivate (`{ isActive }`) |
| `GET /api/services/catalog` | All services, including inactive, with price and description |
| `POST /api/services` | Create (owner/manager) |
| `PATCH /api/services/:id` | Edit name/price/description/active (owner/manager). Duration is rejected (`DURATION_LOCKED`) |

The existing `GET /api/customers` and `GET /api/services` composer contracts are unchanged.

## C. Logic reused, not rebuilt

- `lib/customer-validation.ts` (extracted verbatim from `customer-mutations.ts`, which re-exports it): `validateCustomer`, `normalizeCustomerPhone`, and the paged duplicate-phone scan `customerPhoneTaken`, now shared by web and API.
- `lib/service-validation.ts` `validateService`, unchanged.
- `lib/customer-insights.ts` `summarizeCustomerHistory`, `businessNowKey` and `compareAppointmentsNewestFirst`, used by the API for upcoming and last-visit classification in the business timezone.
- `lib/business-context.ts` `resolveBusinessContext` and the role from membership.
- Appointment creation from a customer goes through the **existing M02 composer**, `performAction` and `POST /api/appointments` (atomic RPC). There is no second booking path.

## D. Native implementation

- `features/customers/`: master/detail. The list is on the left (search, Active/Archived filter, New Customer). Detail/editor is on the right (contact, notes, upcoming appointment, history, Edit, Archive/Reactivate with confirmation, New Appointment). Phone and stacked layouts show the list or the detail with a Back button.
- `features/services/`: compact table (name · duration · price · state) and an inspector/editor. Duration is read-only after creation and uses the web's explanation. Staff see read-only records.
- New Appointment from a customer: `WorkspaceContext.startAppointment(customer)` stores a business-scoped handoff and routes to `/appointments?compose=new`. `AppointmentsScreen` consumes it and passes `initialCustomer` to the existing composer. Archived customers cannot start a booking.
- Navigation: `Customers` and `Services` become `AVAILABLE_NATIVE` with routes `/customers` and `/services`.

## E. Decisions made during implementation

- **Service creation preserves the existing web validation semantics.** Duration is optional at creation; when supplied it must be a whole number from 1 to 1440 minutes. Duration remains immutable after creation. A service without a duration remains visible but is not bookable by the appointment scheduling system.
- **Description is limited to 2000 characters**, matching the web form's `maxLength`. Customer notes have no limit beyond the 1 MB body limit, because the web has none.
- **Service changes are limited to owners and managers** (`ROLE_FORBIDDEN`), following the web `canManageServices` rule. Any member can manage customers, as on the web.
- **Error messages come from typed codes**, such as `DUPLICATE_PHONE`, `CUSTOMER_PHONE_INVALID` and `DURATION_LOCKED`. The native transport never shows server text.
- **Customer and service writes have no idempotency contract.** The UI allows one submit at a time and never retries automatically.

## F. Validation

- Full root suite: `NODE_PATH=/Users/ayutacharya/anaai-local/node_modules TSX_DISABLE_CACHE=1 node --test 'tests/*.cjs'` gave 1308 tests: 1306 pass, 0 fail, 2 skipped. The skips are existing local-PostgreSQL integration tests.
- New suites:
  - `tests/native-customers-services-api.test.cjs` (81): authentication, forged business header, cross-tenant IDs, validation, duplicate phone, role, duration lock, no deletion.
  - `tests/native-customers-services-state.test.cjs`: clients through the real transport, presentation state, handoff, navigation.
- TypeScript:
  - Native: `apps/zude-mobile/node_modules/.bin/tsc --noEmit` exits 0.
  - Server and shared libs: strict temporary tsconfig (M01/M02 pattern) exits 0.
- Lint:
  - Native: `eslint .` exits 0.
  - Changed server/lib files: Next config, 0 errors, 0 new warnings.
- Expo `export --platform web` and `--platform ios` both exit 0, using synthetic fixture hosts only.
- Browser acceptance: `tests/visual/native-ui-check.mjs` passes against the exported web build. It covers:
  - Today and Appointments regression, plus Customers and Services at 1024×768: list, search, no-match, archived, create, duplicate phone, edit, archive prompt, New Appointment → preselected composer, empty, error/retry, service edit with locked duration, deactivate/activate, create.
  - Customers and Services at 1366×1024, 768×1024 and 390×844.
  - No page overflow, no touch target under 44pt, no runtime errors, no external requests.
- This was browser acceptance only. It did not include a physical iPad.

## G. Limitations / follow-ups

- Duplicate-phone detection is a read-then-write check, as in the web. A database uniqueness constraint needs a separate schema decision. Existing data may already contain duplicates.
- Customer history loads every linked appointment (paged by 500), matching the web. Very large histories may need server pagination later.
- The web has a separate `created_at` field, but it is not shown because the web does not show it either.
- Physical iPad validation (touch, keyboard, VoiceOver) remains pending.
