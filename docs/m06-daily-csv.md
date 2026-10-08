# M06 daily employee CSV — 2026-10-07

This focused product improvement supersedes the grouping-dependent CSV behavior described in the earlier M06 handoff. Existing release-hardening changes remain intact. No deployment, commit, hosted writes, migrations, or SQL changes were performed.

## Architecture and implementation

`ReportsScreen` submits its applied range, optional employee filter and screen grouping through the existing mobile API client. GET retains the existing grouped screen response. POST export calls the same `timeReport` service with daily detail enabled, using the same protected ledger read, one `m06_report_dataset` RPC, effective events, business timezone and common snapshot.

Daily detail is retained from the existing day-group calculation using `buildShifts` and `windowTotals`; no second calculation engine or client event reconstruction exists. The day screen uses those same rows. Ordinary employee/week/team GET requests do not calculate or return additional daily detail. Export returns the grouped report plus its authoritative `dailyRows`; the mobile client's existing whitelist retains the grouped view and shares the server CSV unchanged.

`reportCsv` serializes `dailyRows` independently of screen grouping, and rejects missing/out-of-range dates. The export audit still revalidates the actor and every included employee transactionally before any CSV is returned. Audit metadata now records grouping `day` and the actual daily CSV row count. The on-screen grouping remains employee/day/week/team as selected.

## CSV contract

| Column | Meaning |
| --- | --- |
| Employee | Authorized employee display name; formula prefixes guarded. |
| Date | Allocated business-local calendar date, inclusive within the applied range. |
| Worked | Existing exact `hours:mm:ss.mmm` duration, including paid breaks and excluding meal breaks. |
| Paid Break | Existing paid-break allocation formatted as a duration. |
| Meal Break | Existing meal-break allocation formatted as a duration. |
| Status | `Open` if an authoritative open interval touches that local day; otherwise `Complete`. This does not certify attendance or payroll approval. |
| Correction History | `Yes` / `No`, preserving the existing conservative employee-lifetime correction-history flag. It does not claim that a correction affected that particular day. |
| Timezone | Business timezone governing the allocation. |
| Worked Milliseconds | Exact machine-readable worked allocation. |
| Paid Break Milliseconds | Exact machine-readable paid-break allocation. |
| Meal Break Milliseconds | Exact machine-readable meal-break allocation. |

No database IDs, correction/audit IDs, local-week labels, or other internal fields appear in the CSV. Local-week labels were removed because a week's Monday can precede the requested range. Existing zero-time employee/day rows are retained; they are not invented shifts. CSV cells remain quoted with quote escaping, CRLF records, formula-injection guards and the 2 MiB byte bound.

For September 1 through October 1, each authorized employee has 31 daily records, regardless of screen grouping. The first and last record dates are September 1 and October 1; no August 31 or October 2 record is emitted. Carry-in/out events supply shift context only. Totals are clipped to the local-day windows inside the range, including 23/25-hour DST days.

## Regression coverage

Added eight server/API tests and one mobile API test:

- Every screen grouping exports September 1–October 1 daily rows; both boundaries are present and all dates stay within the range.
- Los Angeles carry-in from August 31 contributes only two September 1 hours; carry-out to October 2 contributes only one October 1 hour.
- Daily row sums equal the grouped authoritative total; one dataset RPC and two version reads establish a single coherent calculation.
- Export audit grouping and row count describe daily detail, while the grouped screen response stays unchanged.
- Corrected cross-midnight totals and existing lifetime correction flags are exported.
- Spring/fall DST daily CSV allocation is 23/25 hours as appropriate.
- Open employees share the same snapshot; formula protection, employee PIN denial, manager hierarchy and foreign-tenant rejection remain enforced.
- Mobile export parsing preserves employee screen grouping and shares the server CSV without reconstruction.

Existing tests additionally verify paid/meal CSV values, correction/read retries, export revalidation races, audit failure, browser-role RPC denial, 93-day/event bounds, escaping and CSV byte/row limits. Serializer limit fixtures now exercise `dailyRows`, the rows actually exported; the same limits remain enforced.

## Validation

External PGlite/pg modules were reused from the existing temporary infrastructure. No project dependency changes:

```sh
export ZUDE_PGLITE_MODULE=/private/tmp/claude-501/-Users-ayutacharya-zude-app-worktree/c5667e3d-b5a0-4ed2-bc39-555fdcaf713d/scratchpad/ext/node_modules/@electric-sql/pglite/dist/index.cjs
export ZUDE_PG_MODULE=/private/tmp/claude-501/-Users-ayutacharya-zude-app-worktree/c5667e3d-b5a0-4ed2-bc39-555fdcaf713d/scratchpad/ext/node_modules/pg
node --test tests/m06-time-reports.test.cjs tests/m06-release-hardening.test.cjs tests/native-management-reports.test.cjs
node --test tests/release/m06-real-postgres.test.cjs
npm test
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint server/time-reports.ts server/handlers/time-reports.ts tests/m06-time-reports.test.cjs tests/native-management-reports.test.cjs --rule '@typescript-eslint/no-require-imports: off'
# In apps/zude-mobile:
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src
CI=1 ./node_modules/.bin/expo export --platform web --output-dir /tmp/zude-csv-web
# In root:
git diff --check
```

- Focused final suite: **46/46 passed**, zero failures/skips/cancellations; 40,358.800042 ms.
- Local real PostgreSQL gate: **17/17 passed**, zero failures/skips/cancellations; 20,160.16875 ms. Zero-deadlock assertion passed. SQL and migration architecture unchanged.
- Full root suite: **1,975 total, 1,973 passed, 0 failed, 2 existing skips, 0 cancelled**; 217,149.464041 ms. All nine new regressions passed; no coverage was removed and no new skips were added.
- Root/server TypeScript and mobile TypeScript: **PASS**.
- Relevant server/test ESLint: **PASS**, zero errors/warnings. Mobile ESLint: **PASS**, zero errors and two existing identity-hook warnings.
- Expo Web export: **PASS**, output only in `/tmp/zude-csv-web`.
- Whitespace: **PASS**.

Logs are in `/tmp/zude-csv-focused-final.log`, `/tmp/zude-csv-postgres.log`, `/tmp/zude-csv-full.log` and `/tmp/zude-csv-web.log`.

**CSV DAILY RANGE REQUIREMENT: PASS.**

## Remaining manual test

Using synthetic data, select an employee-grouped September 1–October 1 report and download CSV. Open it in the intended spreadsheet application: verify separate dated employee rows, boundary allocations, readable durations, Open/Complete status and Correction History meaning. Repeat export after selecting week/team views and confirm daily CSV detail remains the same for closed intervals while the screen grouping is preserved. Verify native sharing on the physical iPad during the existing acceptance pass. No payroll, wages, overtime, taxes, scheduling or pay-period logic was added.
