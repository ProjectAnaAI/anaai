# M06 Manager Operations — completion and release handoff

Scope: M06 only. Native → ZUDE Express API → Supabase/PostgreSQL. The server remains authoritative. No scheduling, payroll, wages/taxes, CRM, booking or voice changes. No deployment, staging, commit or push was performed by this continuation.

## Product behavior

- **Team:** existing Slice 1 account/operational authority, hierarchy, optimistic edits, atomic attributable audit and generation/revocation rules remain in place.
- **Who's Working:** existing business-wide protected effective-ledger read, one common snapshot, bounded roster and explicit completeness errors.
- **Timesheets:** existing business-local weeks, carry-in shifts, server totals and protected reads. The exported `timesheetBody` is reused by issue detail; its calculation is unchanged.
- **Corrections:** existing immutable correction records, operations, derived effective projection, revision/watermark checks, transactional actor/target revalidation, explicit review and exact-intent retry. No second correction engine.
- **Reported Issues (`/time-issues`):** open/resolved/all, keyset pages of 50, iPad list/detail and iPhone list→detail. Original employee note, work date, event linkage and submission remain immutable. Detail shows original event provenance, current corrected/voided reference, current week interpretation and the existing correction panel. Applying a correction never resolves the issue automatically. Resolution needs a meaningful 3–500 character note, explicit confirmation and optional committed correction for the same business/employee. One final resolution; no reopening. The UI offers the 50 most recent corrections. Exact-payload uncertain-response retries reuse the same UUID. Changed payload/key conflict is explicit. Resolution, audit and compatibility status fields commit together. Legacy resolved rows without attributable resolution records are labeled honestly.
- **Audit (`/audit`):** immutable existing management actions; chronological 50-row keyset pages with employee, action/category and up-to-93-local-day filters. Team creation/edit/role change/deactivation/reactivation/PIN reset, correction, issue resolution and export metadata. Role changes are classified from before/after values. Account-only actors are labeled by account ID when no historical name exists. Shared actors use their recorded employee-name snapshot. No invented attribution, PIN material, credential hashes, session/device credentials or tokens.
- **Reports (`/reports`):** inclusive business-local date range (default last 30 days through today, maximum 93 days), optional authorized employee, employee/day/week/team grouping. Worked, paid-break and meal-break durations, open-interval flags and conservative **employee lifetime correction-history** indicators. This flag is not a claim that a correction occurred inside the selected range. Zero-time employees/days are retained. UI pages 100 rows without truncating the report.
- **CSV:** POST creates a fresh coherent report, generates CSV from that exact object, revalidates the actor and every included employee under database locks, then records export metadata before returning data. The native view adopts the returned report. A refresh can therefore change totals between a prior on-screen report and export. All cells are quoted, quotes escaped, dangerous formula prefixes guarded; dates/weeks, millisecond and readable durations, open/correction flags and timezone are included. Maximum 200 employees in the business-wide consistency vector (including when filtering), 10,000 events per employee, 20,000 events overall/rows, and 2 MiB CSV; errors replace silent truncation. One dataset RPC (no per-employee network requests). An export attempt is a fresh audited generation, not an idempotent stored artifact. The audit proves server generation, not that the user saved a file; dismissing/failing the OS share sheet does not remove the audit.

## Authority and lifecycle

| Actor | Management reads | Management writes / export |
|---|---|---|
| Account staff / employee PIN intersection | Forbidden | Forbidden |
| Manager effective role | Current regular-employee targets only | Same target hierarchy, revalidated transactionally |
| Owner effective role | Existing owner scope | Existing owner hierarchy and safeguards |
| Shared device | Existing account/PIN intersection; valid tenant-bound device/session/generations | Same intersection rechecked and locked inside existing authority SQL |

Malformed/partial credentials fail closed. Business membership and selected business are validated at the API. New SQL RPCs are service-only; browsers cannot invoke them as `anon`/`authenticated`. Private report-window/immutability helpers are not service-callable. Original events, corrections, issue submissions/resolutions and management audit remain protected against direct mutation, including accidental future write grants where trigger guards apply. Compatibility issue fields update only to match the atomic resolution record.

Filtering precedes list/audit pagination. Employee-specific export audit follows current target hierarchy; team-wide manager export metadata has no employee list and is visible to managers, whereas team-wide owner export metadata is owner-only. No CSV is stored in audit. Foreign employee/correction references are rejected by scoped validation and composite FKs.

The new screens key their sensitive subtree by account, business, effective role, PIN identity/expiry and focus. Lock, logout, business/identity/role changes, background or blur unmount drafts, abort requests and ignore late completions. Authorization errors during export hide the previous report and refresh authority. No client calculation determines payable or authoritative time; clients format server durations only.

Native sharing uses `expo-file-system ~57.0.7` and `expo-sharing ~57.0.22`, installed with Expo's SDK-compatible installer. Files use a dedicated private cache directory, unique filenames and cleanup after share completion/error; stale crash leftovers older than 24 hours are removed at the next export. OS handoff can outlive app backgrounding and cannot be recalled once shared. Web uses a local Blob and revoked object URL, never a credential-bearing public download URL. Rebuild the native development/release binary for the added native dependency before device acceptance; an OTA-only rollout is insufficient for a binary missing the modules. No incoming sharing extension was enabled.

Official API references: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/), [Sharing](https://docs.expo.dev/versions/v57.0.0/sdk/sharing/).

## Effective-ledger security review

The accepted Slice 4.1 protocol is unchanged: read original watermark + correction revision before and after the complete read, discard the entire changed attempt, retry once with a fresh snapshot, then return safe `503 TIME_LEDGER_CHANGED`. New Reports wraps timezone/range/dataset/calculation in a business vector check and uses a single common snapshot across open intervals. Issue detail wraps provenance/current reference, nested protected Timesheet context and correction references in the employee version check.

Repository search of authoritative table reads was reviewed with the following classifications:

| Location | Classification / protection |
|---|---|
| `server/time-ledger.ts` | All effective event queries stay inside protected employee, historical or business-wide reader attempts. Time Clock/My Time, Working and Timesheets reuse them. |
| `server/handlers/time-issues.ts` | The sole direct raw event read is immutable original-report provenance, tenant/employee scoped. It does not calculate current state. Effective reference and historical context are under the same outer version check. |
| `server/time-reports.ts` and `202610060004_m06_time_reports.sql` | Effective projection only, bounded carry-in/carry-out window selection, existing M05 `buildShifts`/`windowTotals`, protected business read. Private SQL window is a bounded query variant, not another calculation engine. |
| `202610050002_m06_ledger_read_versions.sql` | Raw max sequence is the authoritative original-event watermark, explicitly permitted infrastructure. |
| `202610050001_m06_time_corrections.sql` | Original rows provide immutable replay/provenance/watermark and idempotency checks. Derived projection is seeded/rebuilt under the existing write protocol; real clock state uses the effective head. |
| `202610010001_m05_time_clock.sql` | Historical pre-correction original-only clock implementation is superseded by Slice 4. Original issue event linkage remains provenance. Accepted employee-generation migration hardens the existing identity helper without a new authority path. |
| Native sources | No direct raw/effective table reads. API-only authoritative results. |
| Tests/docs | Synthetic fixtures/assertions and architecture references, not production calculation paths. |

The final automated run covers accepted Team/identity/authority foundations, immutable storage and grants, correction-aware M05 next-action behavior, protected reads, issue resolution and export revalidation. No architecture or security invariant was weakened. Real independent-connection lock behavior is a separate release gate below, not proven by PGlite interleaving tests.

## Migration and deployment plan — do not execute as part of this handoff

Prerequisite: all existing repository migrations through `202609280001_authenticated_reschedule_check.sql` are already accounted for in the target's migration history. Do not replay unrelated scheduling/voice migrations or infer production state from this worktree. Compare recorded migration history and checksums before proceeding.

Exact relevant order (apply only unapplied files):

1. `202609290001_m04_team_device_identity.sql`
2. `202610010001_m05_time_clock.sql`
3. `202610020001_m06_management_authority_audit.sql`
4. `202610050001_m06_time_corrections.sql`
5. `202610050002_m06_ledger_read_versions.sql`
6. `202610060001_m05_employee_generation.sql`
7. `202610060002_m06_issue_resolutions.sql` — new additive resolution store, guards, composite references, atomic resolution and scoped list RPC.
8. `202610060003_m06_audit_history.sql` — new scoped read-only audit RPC.
9. `202610060004_m06_time_reports.sql` — bounded report dataset, safe export audit action/schema and transactional export audit RPC.
10. Reload PostgREST schema cache (`NOTIFY pgrst, 'reload schema';`) through the authorized deployment process; verify new RPC signatures/permissions.
11. Deploy the coordinated Express API after all database prerequisites succeed.
12. Smoke the API, then distribute the rebuilt native binary with `/time-issues`, `/audit`, `/reports`.

Pre-deploy: review this dirty worktree as a cohesive M04/M05/M06 release; reconcile actual migration history; complete isolated real-Postgres gate; obtain a recoverable database backup under the normal release procedure; check existing resolved issues/orphan constraints and audit snapshots in an isolated copy; measure projection/backfill and constraint lock time at representative size; rehearse migration order and cache reload. Do not use production credentials for development tests.

Compatibility: additive issue/report records and new audit action types require consumers to tolerate new actions. Existing accepted Team, clock, correction and employee issue-submission paths are retained. All migrations must precede new API routes/native UI. Do not run a pre-correction API after the correction migration: it could interpret raw-only time incorrectly. During rollback, preserve at least the accepted correction-aware, Slice 4.1-protected API baseline and leave additive database history intact. Never drop correction, audit or resolution history to roll back UI. Prefer forward fixes; stop writes and follow incident/backup recovery procedures if a data-integrity issue occurs. No rollback SQL is executed here.

Post-deployment smoke (disposable tenant, owner/manager/employee identities):

- GET `/api/management/working`, existing Timesheet directory/detail and employee My Time; compare corrected state/totals.
- GET `/api/management/time-issues`, GET `/:issueId`, POST `/:issueId/resolve` with idempotency key; verify one resolution/audit on retry, immutable original and manager target exclusions.
- GET `/api/management/audit` with employee/category/date/cursor; check actor snapshots, role-change classification and authority before pagination.
- GET `/api/management/time-reports`; POST `/export`; compare returned report with parsed CSV and equivalent Timesheet window; inspect audit metadata, not CSV storage.
- Exercise missing/partial/revoked shared credentials, demotion/promotion and foreign tenant/target IDs; ensure safe denial and no writes/data release.
- Expo web preflight with configured explicit origin and native requests without Origin; preserve existing CORS/auth/Twilio boundaries.

## Real PostgreSQL release gate — PASSED (local, 2026-10-06)

Executed against a disposable local Supabase stack: PostgreSQL 17.11, real PostgREST and real local Auth. The database was built from the verified hosted schema baseline (cut `202610010001`) plus the seven post-cut migrations; see [local-database-baseline.md](local-database-baseline.md).

- Suite: `tests/release/m06-real-postgres.test.cjs`, with real server handlers and independent `pg` connections.
- Barriers: locks held on separate connections and observed through `pg_blocking_pids`, not sleeps.
- Result: **17/17 passed** on two final runs, with zero deadlocks. An earlier 16-test version, before the export race was added, also passed four consecutive runs, including one after a from-scratch rebuild.
- No product code or SQL change was needed.

| # | Race | Outcome observed |
|---|---|---|
| 1 | Correction vs correction | 5 overlapping commits on one base: 1 committed, 4 `TIME_CORRECTION_STALE`. Same key and payload gives one commit plus an exact replay; same key with a different payload gives `TIME_REQUEST_CONFLICT`. No extra rows. |
| 2 | Correction vs real clock action | Serialized by the shared employee lock in both orders. Correction-first: both commit and the clock-out is valid. Clock-first: the correction is `STALE` with no audit. Exactly one original is appended. |
| 3–6 | Correction vs Timesheet / My Time / Who's Working / Reports | A correction committed between PostgREST requests gives a retry to the coherent new state. A change on both attempts gives `TIME_LEDGER_CHANGED` after exactly two attempts. Never mixed. |
| 7 | Real clock action vs Reports | Same contract with real CLOCK_OUT and break actions through the API. |
| 8 | Management mutation vs actor demotion | Account-role demotion first: correction refused with 403 and nothing written. Correction first: the demotion waits, and the audit shows the manager role. Shared-device: a Team write by a demoted employee is refused; in the reverse order both commit with ordered audits. |
| 9 | Correction / resolution / Team write vs target promotion | All three are refused with the hierarchy re-checked under lock. Only the promotion is audited, and the owner can still act. |
| 9b | Report export vs actor demotion | 403, no CSV and no export audit. After restore, exactly one audit. |
| 10–12 | Session revocation, device revocation, device PIN generation, employee generation (generation-only bump and audited Team write) | `IDENTITY_UNAUTHORIZED`, with no clock event, correction or audit. A fresh PIN session works again. |
| 13 | Duplicate issue resolution | 6 overlapping requests: one resolution and one audit; same-key replays or `ISSUE_ALREADY_RESOLVED`. The same key on two issues gives one success and one `TIME_REQUEST_CONFLICT`, and the loser leaves no audit. |
| 14 | Correction-linked resolution | Linking an uncommitted correction is refused safely. Foreign-employee and foreign-tenant links are refused. Competing links produce exactly one resolution. A resolution and a new correction commit independently. |
| — | Security | Cross-tenant selection, target and device are refused. Manager→manager targets are refused. Browser roles are denied on all protected tables and service RPCs. Originals reject UPDATE, DELETE and TRUNCATE. |

After every race the suite checks these invariants:

- the effective projection equals the fold of immutable history;
- every correction has entries and exactly one audit;
- issue status matches its resolution, and every resolution has exactly one audit.

A negative control proves the read assertions are sensitive. With the version tokens neutralised at the transport layer, the same Who's Working interleaving does return a mixed revision. A correction that renumbers the projection is additionally caught by Working's own seq bounds and fails closed.

## Physical acceptance — NOT executed

Primary: physical **iPad Air 13-inch**, landscape and supported portrait. Secondary: physical **iPhone** with list→detail/back navigation. Use a rebuilt binary, synthetic tenant, owner/manager/employee and shared-device identities.

- [ ] Identity: account login, device enrollment, PIN unlock/lock, switch employee/business, expiry, revoke device/session, demote/promote and generation change; no account/PIN authority amplification.
- [ ] Team: create/edit/deactivate/reactivate/reset PIN within hierarchy; stale edit rejection and audit attribution.
- [ ] Working: states, active breaks, correct names/roles and one common snapshot; no partial totals hidden as complete.
- [ ] Timesheets: local week/date boundaries, overnight/carry-in, paid/meal break, open and corrected records, inactive employees where permitted.
- [ ] Corrections: insert/replace/void using existing review, meaningful reason, pending intent/retry, stale revision, unauthorized target and original history preservation.
- [ ] Critical lifecycle: raw CLOCK_IN → manager correction CLOCK_OUT → Time Clock/My Time/Working/Timesheets/Reports all OFF_CLOCK/closed → next real employee CLOCK_IN succeeds.
- [ ] Issues: original employee submission, corrected/voided context, correction without automatic resolution, explicit resolution note/review, optional correction link, lost-response retry and read-only final resolution.
- [ ] Audit: chronology, filters/pages, account vs shared actor attribution, corrections/issues/exports and no PIN/device/session material.
- [ ] Reports: all groupings/employee filters, local range errors, same-window Timesheet agreement, refreshed snapshot on export, full CSV count, quoted names/formula guards and safe size-limit errors.
- [ ] Share: Save to Files and another intended share target; cancel sheet, unavailable target and background handoff; private file cleanup and correct CSV content. A canceled share still has a generation audit.
- [ ] Privacy/stale requests: while each management request/mutation is pending, lock/background/logout/change business/PIN/role; old content/drafts disappear, late responses never populate the new identity, canceled export never opens a new share sheet.
- [ ] Concurrency smoke: correct/clock from a second device during refresh/export; display coherent old/new totals or refreshable TIME_LEDGER_CHANGED, never mixed totals.
- [ ] Layout: iPad master/detail, iPhone navigation, landscape, supported portrait, large text, readable error messages, touch targets, scroll performance for large reports, keyboard avoidance and forms/confirmation without clipped controls.

## Validation and scope record

See the final validation record and exact continuation file manifest in `m06-completion-validation.md`. Required SQL suites ran using an external temporary PGlite module, not a project dependency. The accepted M05 employee-generation and M06 Slice 1–5 foundations were preserved except narrow integration exports/test expectations required by new behavior. Existing unrelated dirty/untracked work, especially `apps/zude-mobile/.claude/`, is outside this continuation. Nothing was staged.

Known product limits: one final issue resolution, no reopen/escalation; recent-50 correction picker; bounded reports rather than asynchronous large exports; conservative lifetime correction indicator; exact millisecond calculation displayed using existing duration formatting; no payroll; export audit records generation rather than delivery; native share handoff cannot retract an already shared file. Deployment and physical-device acceptance remain separate uncompleted release gates; the real multi-connection PostgreSQL gate passed locally (above).
