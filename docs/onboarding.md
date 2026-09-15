# Secure business onboarding — review before deployment

## Architecture

Previously the active-business provider displayed an error for zero memberships,
preventing a new authenticated owner from reaching a useful page. It now routes
that state to `/onboarding`. Existing memberships retain the existing selector
and dashboard behavior; visiting onboarding with a business redirects to dashboard.
Membership-query errors remain failures, not permission to provision.

The five-step wizard collects business details, weekly hours, one or more services,
receptionist name/greeting, and a review. No business writes occur until Finish.
Incomplete drafts are stored in per-user sessionStorage (contact details included,
no authentication credentials). Closing the tab or disabling storage can lose the
draft. A refresh starts at step one with the saved values; Back retains values.

POST `/api/onboarding` verifies a bearer token using Supabase Auth, then invokes
`public.create_business_for_current_user(p_setup jsonb)` with the same caller JWT.
It accepts setup values only, never an owner/business identifier. The RPC derives
`auth.uid()` and creates business, owner membership, profile, services, and AI
settings in one transaction. Compatibility user_id writes remain.

A namespaced transaction advisory lock serializes provisioning for each user.
READ COMMITTED is required so the post-lock membership check sees the preceding
committed invocation. Any existing membership rejects provisioning. A lost-response retry returns
ALREADY_PROVISIONED; the wizard reloads dashboard membership discovery rather
than creating again. A client latch prevents ordinary double-submit. Only RPC
success reports completion; an existing membership response reconciles by navigation.

## Security boundary and live deployment prerequisites

Migration: `supabase/migrations/202609150001_secure_business_onboarding.sql`.
**Unapplied.** Review the complete file before manual deployment. No live database
schema, policies, helper definitions or triggers were available for verification.
Columns are based on repository readers/writers, not a claim of live equivalence.

SECURITY DEFINER is deliberately limited to first-business bootstrap: an account
with no membership cannot authorize its own initial business/member inserts through
normal membership RLS. The function grants execution to authenticated only, revokes
PUBLIC/anon, uses explicit pg_catalog/public search_path and qualified tables, derives
the owner from auth.uid(), and accepts no tenant identifiers. It changes no policies.
The deployed function must be owned by a trusted non-login/migration role with the
necessary privileges; ensure untrusted roles cannot replace it or its dependencies.
Review inherited/custom role EXECUTE grants if replacing an existing same-signature
function. No service-role client is introduced.

Before deployment confirm:

- All five tables have the referenced columns. Business id has a generated default;
  all omitted required fields have suitable defaults. Check AI settings omitted tone
  and instruction defaults, businesses metadata, role type accepting `owner`, and
  nullable contact/price/description columns. Hours are stored as TEXT JSON.
- Triggers do not introduce unexpected records, skip writes or require extra values.
  Each required INSERT checks RETURNING/FOUND; failures roll back the protected block.
- Membership discovery RLS exposes the new owner's membership and business; all
  business-owned tables use business membership authorization. Bootstrap grants must
  not give users arbitrary direct business/member insertion rights.
- Audit any other provisioning function/trigger: per-login serialization requires
  all competing provisioning entry points to share this protocol or be retired.
- Supabase signup/email confirmation and redirect URLs match the deployment. Email
  verification users can log in after confirmation; immediate sessions go to dashboard
  then onboarding. No existing account is modified by applying this migration.

## Validation boundaries

Node tests exercise draft validation and the authenticated API with mocks. SQL and
routing assertions are source contract checks, not proof of PostgreSQL transactions,
RLS, redirects or browser behavior. Run authenticated integration checks in a test
project before production. No SQL was executed by the implementation.

## Browser/database test plan after reviewed deployment

1. Signed out: open onboarding/dashboard; verify login redirect without a loop.
2. Sign up a test account; exercise both email-confirmation and immediate-session
   configuration. Log in: zero memberships must open onboarding.
3. Fill each wizard step; refresh and use Back; values persist in the same tab and
   no business exists before Finish. Try invalid hours/durations and blank name.
4. Finish with optional contacts and price blank, then with supplied optional values
   in a separate test account. Confirm exactly one business, owner membership,
   profile, initial AI settings and expected services, all correctly scoped.
5. Double-click Finish and submit from two tabs concurrently. Exactly one transaction
   provisions; the other reconciles. Retry after intentionally losing the response.
6. Simulate a service/AI insert failure in a test database: assert no partial business,
   membership, profile or service remains. Retry successfully after restoring it.
7. Dashboard must discover the new business; refresh and revisit onboarding: no loop,
   no repeat provisioning. Book a test slot to verify the shared hours format.
8. Log in to an existing account: original business/data remain unchanged. Attempt
   direct RPC provisioning as that account: reject. As anonymous: reject. Submit
   extra user/business fields: they cannot alter owner or target another business.
9. Confirm another account cannot read or mutate the created tenant under RLS.

Remaining deployment blocker: live schema/ACL/trigger review and authenticated
transaction/concurrency/browser tests. No snapshots, voice setup or staff UI added.
