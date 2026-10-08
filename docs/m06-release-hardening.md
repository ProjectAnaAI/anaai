# M06 release-hardening audit — 2026-10-07

Scope: Team, Who’s Working, Timesheets, Corrections, Reported Issues, Audit, Reports/CSV. No migrations, authority changes, deployment, staging, commits, or hosted writes. Existing Audit/Reports JSX fixes were preserved. The pre-existing untracked `apps/zude-mobile/.claude/` directory is excluded from release changes.

## Findings

| Severity | Finding | Action |
| --- | --- | --- |
| BUG | Audit/Reports pagination originally emitted a literal space under a native View. TypeScript and existing render mocks did not reject this runtime-invalid child. | Preserved the user's fixes; normalized trailing whitespace/newlines and added compiler-based regression coverage across every M06 TSX screen and shared native components. |
| BUG | Reports page 2 could survive an export authorization failure and a subsequent smaller result, hiding valid rows and showing an invalid row range. | Reproduced with 101 rows → page 2 → export 403 → one-row refresh. Added a failing regression, then clamped the rendered page and navigation to the returned row count. |
| IMPROVEMENT | Prior completion-validation documentation still says the real PostgreSQL gate was not run, while the later completion handoff records its 2026-10-06 success. | Preserve historical records; use this dated audit and its explicit rerun results for current release evidence. |

No additional reproducible implementation defect was found in the reviewed M06 calculation, correction, issue, audit, or authority paths. No CSV schema redesign was needed: readable durations already accompany exact milliseconds, and employee-grouped rows intentionally omit local date/week.

## Ledger and historical-data findings

Read-only hosted inspection used the already configured service credential without printing it. Queries were restricted to the named test employees; no export-audit RPC or mutation was invoked. The supplied historical summary is superseded by the current effective ledger:

- **Sherlyn:** original clock-out remains Oct 6, 11:35 PM Los Angeles time. An existing correction revision 1, recorded Oct 7, changes its effective time to **Oct 2, 10:22 PM**. The original Oct 2 meal break remains 6:10–9:55 PM. Oct 3–5 now allocate zero worked time. The subsequent Oct 6, 11:36 PM shift remains open. The original “Forgot to clock out” issue has work date Oct 5 and remains unresolved; do not invent a missing shift merely because the report persists after correction.
- **Brandy:** the Oct 2, 9:53 PM shift closes Oct 6, 11:31 PM, followed by another open shift. There are no corrections. Oct 3–5 each allocate 24 hours because of this stored sequence.

For inclusive Oct 2–6, all four groupings, their summed rows, generated CSV row counts, and protected Timesheet daily allocations agreed exactly: **Brandy 417,336,749 worked ms; Sherlyn 17,747,625 worked ms**. This was a current read-only regeneration, not a comparison with the earlier exported file, which was not provided. Open intervals are clipped to the chosen local date range. Both employees retain open-interval indicators; Sherlyn also has correction-history provenance.

The legitimate repair for the described late clock-out is Timesheets → select the touching shift/day → Correct time → Correct an entry’s time → select the existing clock-out → enter the employee-confirmed business-local date/time → Preview → reason → explicit save. The replacement must remain after the preceding break end and before the following shift. If break times are also wrong, correct those through the same audited workflow. Do not insert a duplicate clock-out. Resolve the reported issue separately, optionally linking the committed correction. Sherlyn's first shift already has such a correction; no second repair was performed.

An isolated synthetic acceptance test recreates the Oct 2→Oct 6 sequence, rejects a duplicate clock-out, previews/commits a replacement, verifies original events remain byte-for-byte unchanged, compares all report groupings/CSV with corrected Timesheet totals, and explicitly resolves the immutable original issue with an idempotent retry.

## Security and calculation review

Reviewed API authority, SQL RPC grants/revalidation, effective-window selection, ledger-version reads, correction operations, issue resolution, audit filtering and export generation. Server authority, tenant predicates, manager target hierarchy, owner semantics, shared-device/PIN authority, employee/device generations, transactional revalidation and service-only RPC boundaries remain unchanged. Original events, corrections, issue history and audit remain immutable. No credentials were added to client code.

Existing suites exercise business-local Monday weeks, 23/25-hour DST days, overnight/cross-week carry-in/out, common snapshots, paid-break inclusion, meal-break exclusion, open intervals, correction-aware clock writes, revisions/watermarks, idempotency and impossible-sequence rejection. Audit target filtering precedes keyset pagination; export serializes the exact refreshed report, then revalidates authority and records metadata atomically. Existing bounds remain 93 local days, bounded employees/events/rows and 2 MiB CSV with formula protection.

The new static JSX guard inspects compiler-emitted native-container children, including aliases, fragments and conditional branches. It distinguishes erased indentation from surviving spaces and permits legitimate Text content. It is regression coverage for literal children; arbitrary runtime-valued children still require functional acceptance.

## Validation

External modules were reused from the existing temporary validation infrastructure, not installed in the repository:

```sh
export ZUDE_PGLITE_MODULE=/private/tmp/claude-501/-Users-ayutacharya-zude-app-worktree/c5667e3d-b5a0-4ed2-bc39-555fdcaf713d/scratchpad/ext/node_modules/@electric-sql/pglite/dist/index.cjs
export ZUDE_PG_MODULE=/private/tmp/claude-501/-Users-ayutacharya-zude-app-worktree/c5667e3d-b5a0-4ed2-bc39-555fdcaf713d/scratchpad/ext/node_modules/pg
npm test
node --test tests/m06-release-hardening.test.cjs
node --test tests/native-management-reports.test.cjs tests/native-m06-jsx.test.cjs
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint server tests/m06*.cjs tests/native-management*.cjs tests/native-timesheet*.cjs tests/native-working.test.cjs tests/native-m06-jsx.test.cjs --rule '@typescript-eslint/no-require-imports: off'
node --test tests/release/m06-real-postgres.test.cjs
# From apps/zude-mobile:
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src
CI=1 ./node_modules/.bin/expo export --platform web --output-dir /tmp/zude-m06-hardening-web-final
# From root:
git diff --check
```

- Full root suite: **1,965 total, 1,963 passed, 0 failed, 2 existing skips, 0 cancelled**; 334,280.696834 ms. Includes M06, security and the new JSX/pagination regressions. Its file list was captured before the new standalone historical-workflow test was added, so that test was run separately: **1/1 passed**. Combined distinct validation: **1,966 total, 1,964 passed, 0 failed, 2 existing skips**.
- Focused Reports/JSX rerun: **19/19 passed**. Pagination regression before the fix: **14 passed, 1 failed**, proving it detects the defect.
- Root/server and final mobile TypeScript: **PASS**, exit 0.
- Scoped server/test lint: **0 errors, 3 existing server warnings**. Mobile lint: **0 errors, 2 existing identity-hook warnings**.
- Final Expo Web production export: **PASS**, exit 0; artifacts remain outside the repository.
- Whitespace check: **PASS**. New regression files also pass Node syntax checks.
- Initial sandboxed full-suite attempt was stopped after local HTTP listeners were denied; the permitted full rerun above passed. No tests were skipped to bypass sandbox restrictions.
- Real PostgreSQL gate: **17/17 passed**, 0 failed/skipped/cancelled; 15,640.345875 ms, with the gate's zero-deadlock assertion passing. The first attempt had **8 passed / 10 failed** including a failed suite hook after Docker stopped and the database connections disappeared. This was an infrastructure failure, not a passed concurrency gate. Docker was recovered and the gate rerun alone.

Temporary logs: `/tmp/zude-m06-hardening-full-permitted.log`, `/tmp/zude-m06-hardening-workflow.log`, `/tmp/zude-m06-hardening-native-regressions.log`, `/tmp/zude-m06-hardening-postgres-final.log`, `/tmp/zude-m06-hardening-web-final.log` and `/tmp/zude-m06-hardening-lint-final.log`.

## Remaining acceptance and release boundaries

No authenticated manual Mac browser acceptance or physical-device acceptance was performed. Mac Expo Web is ready for functional acceptance after the passing export and automated screen/API checks. Complete the existing physical checklist in `m06-completion.md` using a rebuilt native binary and synthetic tenant; native file sharing cannot be accepted from the Mac web export.

Minimum final manual pass: owner/manager/employee PIN hierarchy; Team changes and attribution; clock/break/Working/Timesheet agreement; correction preview/save and next clock action; original issue plus explicit linked resolution; Audit filters/pages; all report groupings and actual CSV download/share; lock/background/identity change while requests are pending. Verify iPad landscape/portrait, keyboard/large text and native share cancellation/cleanup. Review Brandy's historical times and Sherlyn's unresolved issue through authorized correction/resolution workflows with employee-confirmed facts.

Production deployment is not approved or ready for execution from this audit alone. Physical acceptance and the established rollout/migration-history reconciliation remain separate gates. Hosted migrations were not replayed, and the protected local baseline/bootstrap architecture was not changed.
