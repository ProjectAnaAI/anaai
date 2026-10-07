# Local database baseline

`supabase/migrations` cannot build a database from scratch. The first migration (`202609140001`) alters tables such as `appointments`, `businesses` and `customers` that were created by hand in the hosted project and never committed. `202609180002` also deletes specific hosted rows and fails unless a specific production profile exists.

The local database is therefore built from a verified snapshot of the hosted schema (the baseline), plus the migrations written after that snapshot.

## Provenance

| | |
|---|---|
| Baseline file | `supabase/baseline/hosted_schema_202610010001.sql` |
| Source | Hosted project `nfmlptigzaqadpyzfnqa`, schemas `public` and `anaai_private` |
| How it was taken | `pg_dump --schema-only`, run by the operator in a read-only session (PostgreSQL 17.6 server, pg_dump 17.11) |
| Row data | None: zero `COPY`/`INSERT` statements |
| Cut point | `202610010001` (M05 time clock) |

The cut point was verified against hosted using read-only catalog queries:

- **Function bodies match.** The md5 of every function body on hosted was compared with each repository migration, and the latest definitions up to M05 match.
- **M04 and M05 are fully present.** Their constraints, indexes, triggers, row-level security settings and grants all exist.
- **Everything after the cut is absent.** None of the M06 objects exist on hosted, and neither does the `202610060001` generation hardening.

Hosted migration history only records versions up to `202609190003`. Eleven later migrations were applied by hand without history rows, so object checks, not that table, determined the cut.

## Rebuilding the local database

```sh
supabase start                      # local Docker stack only
./scripts/local-db-bootstrap.sh     # destructive for the LOCAL database only
```

`supabase/config.toml` sets `[db.migrations] enabled = false`, so `supabase start` and `supabase db reset` boot an empty database instead of failing on the delta chain.

The script performs these steps in order:

1. **Proves the target is local.** It refuses to run unless all of these hold:
   - Docker is talking to a local socket.
   - `[db] port` is `54322` and migrations are disabled.
   - The container `supabase_db_<project_id>` is running a `supabase/postgres` image and publishes port 5432 on host port 54322.
   - `SUPABASE_DB_URL` and `DATABASE_URL` are unset.

   Every database command goes through `docker exec` into that container. The script never connects to a remote URL.
2. **Resets the local database** with `supabase db reset --local --no-seed`, which reruns local initdb.
3. **Loads the baseline in one transaction**, with two narrowly scoped compatibility steps:
   - **The dump's single `CREATE SCHEMA public;` line is skipped.** Local initdb already created `public` with the same default access-control list (ACL) hosted has. `supabase db dump` omits this line for the same reason.
   - **Local `public` default privileges are cleared before loading.** Local initdb installs `ALTER DEFAULT PRIVILEGES` that grant ALL to `anon`, `authenticated` and `service_role`. A `pg_dump` restore assumes there are none until the end of the file, so without this step every baseline table and function silently gained browser-role access that hosted had explicitly revoked. The dump reinstalls hosted's own default privileges at its end.

   Nothing else in the dump is altered.
4. **Proves fidelity.** It re-dumps the local `public` and `anaai_private` schemas with the same pg_dump, and requires the result to equal the baseline exactly (ignoring the per-dump `\restrict` key and version comments).
5. **Records local migration history.** Versions up to and including `202610010001` are recorded as applied but never replayed. In particular, the `202609180002` production clean-up never runs locally.
6. **Replays post-cut migrations in order, as `postgres`** (the role hosted migrations run as): `202610020001`, `202610050001`, `202610050002`, `202610060001`, `202610060002`, `202610060003`, `202610060004`. Each file is its own transaction.
7. **Runs structural verification**, then reloads the PostgREST schema cache. It checks:
   - the lasting `202609180002` invariants (`business_id NOT NULL` on six tables, one profile per business, AI settings unique per business);
   - all M06 tables, functions and immutability triggers;
   - the generation hardening from `202610060001`;
   - row-level security on every `public` table;
   - no browser-role table or `m04_`/`m05_`/`m06_` function access.

Reruns are deterministic: every run starts from a fresh initdb.

## How `202609180002` is handled

The migration combines a one-time hosted data repair (keep one profile for one business and delete two duplicate/test profiles) with lasting constraints. Locally:

- **The repair never runs.** Its rows are production data, and none exist in a fresh database.
- **The lasting rules come from the baseline.** Steps 4 and 7 verify them.

No production rows are copied, no historical migration is edited, and nothing is guarded or weakened.

## Real PostgreSQL release gate

```sh
ZUDE_PG_MODULE=/path/to/node_modules/pg node --test tests/release/m06-real-postgres.test.cjs
```

`pg` is not a project dependency; install it outside the repository, as with `ZUDE_PGLITE_MODULE`.

The suite is not part of `npm test`, because it needs the local stack:

- **Local-only.** It re-proves the target: the `supabase status` endpoints must be on 127.0.0.1 at ports 54321/54322, and the TCP cluster's system identifier must equal the container's.
- **Real request path.** It uses real local Auth users and the real server handlers against real PostgREST, with independent `pg` connections.
- **Lock-confirmed barriers.** Each barrier is a lock held on its own connection and confirmed through `pg_blocking_pids` (transitively), not a sleep.
- **Synthetic data only.** Credentials come from `supabase status` at runtime and are never printed.

The negative-control test freezes the version tokens and confirms that the same interleaving does yield a mixed revision. That proves the effective-read assertions are sensitive.

## Regenerating the baseline

Only regenerate when the hosted schema legitimately moves past the cut:

1. Run a schema-only dump in a read-only session (`PGOPTIONS='-c default_transaction_read_only=on'`).
2. Re-verify the new cut with read-only catalog fingerprints.
3. Confirm the file has zero `COPY`/`INSERT` statements and run a secret scan.
4. Update `CUT` in the script.

Never use `supabase link`, `db push`, `migration repair` or a dump that includes data.

## Known gap: hosted migration history

Hosted `supabase_migrations.schema_migrations` lacks `202609210001` through `202610010001`. A future `supabase db push` would try to replay them on hosted. Before any CLI-based deployment, the history must be repaired. That is a hosted write, which needs its own explicit approval.
