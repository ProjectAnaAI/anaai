#!/usr/bin/env bash
# Rebuilds the disposable LOCAL Supabase database from the verified hosted schema
# baseline, then replays only the migrations after the baseline cut.
# Never targets a hosted project: every database command runs through `docker exec`
# into this repository's local Supabase DB container, after the checks below.
# See docs/local-database-baseline.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CUT=202610010001
BASELINE="supabase/baseline/hosted_schema_${CUT}.sql"
MIGRATIONS=supabase/migrations
LOCAL_PORT=54322

die() { echo "local-db-bootstrap: $*" >&2; exit 1; }

# ---- 1. Prove the target is the local, disposable database --------------------
[ -f "$BASELINE" ] || die "missing $BASELINE"
[ -z "${SUPABASE_DB_URL:-}${DATABASE_URL:-}" ] || die "refusing to run with SUPABASE_DB_URL/DATABASE_URL set"
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) die "DOCKER_HOST is not a local socket" ;; esac
docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
case "$docker_endpoint" in unix://*) ;; *) die "docker context is not a local socket" ;; esac

project_id="$(sed -nE 's/^project_id *= *"([^"]+)".*/\1/p' supabase/config.toml | head -1)"
[ -n "$project_id" ] || die "no project_id in supabase/config.toml"
db_port="$(awk '/^\[db\]/{s=1;next} /^\[/{s=0} s && /^port *=/{gsub(/[^0-9]/,"");print;exit}' supabase/config.toml)"
[ "$db_port" = "$LOCAL_PORT" ] || die "[db] port is '$db_port', expected $LOCAL_PORT"
grep -qE '^\[db\.migrations\]' supabase/config.toml || die "no [db.migrations] section"
awk '/^\[db\.migrations\]/{s=1;next} /^\[/{s=0} s && /^enabled *=/{print;exit}' supabase/config.toml | grep -q 'false' \
  || die "[db.migrations] enabled must be false (the CLI cannot replay the delta chain)"

CONTAINER="supabase_db_${project_id}"
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ] \
  || die "$CONTAINER is not running; run 'supabase start' first"
docker inspect -f '{{.Config.Image}}' "$CONTAINER" | grep -qE '(^|/)supabase/postgres:' \
  || die "$CONTAINER is not a supabase/postgres image"
docker port "$CONTAINER" 5432/tcp | grep -qE ":${LOCAL_PORT}\$" \
  || die "$CONTAINER does not publish 5432 on local port $LOCAL_PORT"

psql_as() { local role="$1"; shift; docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$role" -d postgres "$@"; }
echo "Target: local container $CONTAINER (docker $docker_endpoint), host port $LOCAL_PORT"

# ---- 2. Reset only the local database (re-runs local initdb; no migrations) ----
supabase db reset --local --no-seed --yes >/dev/null
public_objects="$(psql_as supabase_admin -Atc "select count(*) from pg_class where relnamespace = 'public'::regnamespace")"
[ "$public_objects" = "0" ] || die "public schema not empty after reset ($public_objects objects)"

# ---- 3. Load the baseline in one transaction ------------------------------------
# The local initdb already created schema public (with the same default ACL hosted
# has), so the dump's single `CREATE SCHEMA public;` line is skipped, exactly as
# `supabase db dump` itself omits it. Nothing else in the dump is altered.
# pg_dump output assumes an empty target: objects are created first, their exact
# hosted GRANT/REVOKEs follow, and hosted's ALTER DEFAULT PRIVILEGES come last.
# Local initdb has already installed those public default privileges (ALL to anon,
# authenticated, service_role), which would silently grant browser roles access the
# hosted ACLs do not have. They are cleared first; the dump reinstalls them at its end.
[ "$(grep -c '^CREATE SCHEMA public;$' "$BASELINE")" = "1" ] || die "unexpected baseline shape"
{
  for owner in postgres supabase_admin; do
    for kind in TABLES SEQUENCES FUNCTIONS; do
      echo "ALTER DEFAULT PRIVILEGES FOR ROLE $owner IN SCHEMA public REVOKE ALL ON $kind FROM postgres, anon, authenticated, service_role;"
    done
  done
  echo "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace) THEN RAISE EXCEPTION 'public default privileges not cleared'; END IF; END \$\$;"
  grep -v '^CREATE SCHEMA public;$' "$BASELINE"
} | psql_as supabase_admin --single-transaction >/dev/null
echo "Loaded $BASELINE"

# Fidelity proof: a fresh schema-only dump of the local result must equal the
# baseline (ignoring the per-dump \restrict key and server-version comment).
normalize() { grep -vE '^\\(un)?restrict |^-- Dumped (from|by) '; }
if ! diff <(normalize < "$BASELINE") \
          <(docker exec "$CONTAINER" pg_dump -U supabase_admin -d postgres --schema-only \
              --schema=public --schema=anaai_private | normalize) >/dev/null; then
  die "local schema does not reproduce $BASELINE (re-dump differs)"
fi
echo "Re-dump of local schema matches the baseline exactly"

# ---- 4. Local migration bookkeeping ---------------------------------------------
psql_as postgres >/dev/null <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key, statements text[], name text);
SQL
record() { psql_as postgres -c "insert into supabase_migrations.schema_migrations (version, name) values ('$1', '$2')" >/dev/null; }

baseline_count=0
replayed=()
for file in $(ls "$MIGRATIONS"/*.sql | sort); do
  base="$(basename "$file" .sql)"; version="${base%%_*}"; name="${base#*_}"
  [[ "$version" =~ ^[0-9]{12}$ ]] || die "unexpected migration filename $base"
  if [[ "$version" < "$CUT" || "$version" == "$CUT" ]]; then
    record "$version" "$name"            # incorporated in the baseline; never replayed
    baseline_count=$((baseline_count + 1))
  else
    # ---- 5. Replay post-cut migrations as postgres (as hosted applies them) ------
    psql_as postgres < "$file" >/dev/null || die "migration $base failed"
    record "$version" "$name"
    replayed+=("$base")
  fi
done
echo "Baseline-recorded migrations (<= $CUT): $baseline_count"
printf 'Replayed: %s\n' "${replayed[@]}"

# ---- 6. Structural verification ------------------------------------------------
psql_as postgres >/dev/null <<'SQL'
do $$
declare
  missing text;
begin
  -- Lasting invariants from pre-cut 202609180002 (carried by the baseline).
  select string_agg(c, ', ') into missing from unnest(array[
    'business_profiles_business_id_unique', 'ai_settings_business_id_unique']) c
  where not exists (select 1 from pg_constraint where conname = c and connamespace = 'public'::regnamespace);
  if missing is not null then raise exception 'missing constraints: %', missing; end if;
  select string_agg(t, ', ') into missing from unnest(array[
    'business_profiles','services','customers','appointments','business_knowledge','ai_settings']) t
  where not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass
                      and a.attname = 'business_id' and a.attnotnull);
  if missing is not null then raise exception 'business_id nullable on: %', missing; end if;

  -- Post-cut M06 objects and immutability triggers.
  select string_agg(t, ', ') into missing from unnest(array[
    'employee_management_actions','employee_time_corrections','employee_time_correction_entries',
    'employee_time_effective_events','employee_time_issue_resolutions']) t
  where to_regclass('public.' || t) is null;
  if missing is not null then raise exception 'missing tables: %', missing; end if;
  select string_agg(f, ', ') into missing from unnest(array[
    'm06_assert_management_actor','m06_correct_employee_time','m06_ledger_read_versions',
    'm06_resolve_time_issue','m06_time_issues_page','m06_audit_page','m06_report_dataset',
    'm06_record_time_export','m05_record_time_event','m05_assert_employee_identity','m04_write_employee']) f
  where not exists (select 1 from pg_proc where proname = f and pronamespace = 'public'::regnamespace);
  if missing is not null then raise exception 'missing functions: %', missing; end if;
  select string_agg(t, ', ') into missing from unnest(array[
    'employee_time_events_no_update','employee_time_events_no_delete','employee_time_events_no_truncate',
    'employee_management_actions_no_update','employee_time_corrections_no_update',
    'employee_time_correction_entries_no_update','employee_time_issue_resolutions_immutable']) t
  where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if missing is not null then raise exception 'missing triggers: %', missing; end if;

  -- 202610060001 employee-generation hardening is the live identity check.
  if not exists (select 1 from pg_proc where proname = 'm05_assert_employee_identity'
                 and pronamespace = 'public'::regnamespace and prosrc like '%employee_generation%') then
    raise exception 'm05_assert_employee_identity lacks 202610060001 generation hardening';
  end if;

  -- RLS on every application table; browser roles have no direct access to M04-M06 tables.
  select string_agg(relname, ', ') into missing from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;
  if missing is not null then raise exception 'RLS disabled on: %', missing; end if;
  select string_agg(relname || '/' || r, ', ') into missing
  from pg_class c cross join unnest(array['anon','authenticated']) r
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (c.relname like 'employee%' or c.relname = 'zude_devices')
    and has_table_privilege(r, c.oid, 'select,insert,update,delete,truncate,references,trigger');
  if missing is not null then raise exception 'browser role table access: %', missing; end if;
  select string_agg(p.oid::regprocedure::text || '/' || r, ', ') into missing
  from pg_proc p cross join unnest(array['anon','authenticated']) r
  where p.pronamespace = 'public'::regnamespace and p.proname ~ '^m0[456]_'
    and has_function_privilege(r, p.oid, 'execute');
  if missing is not null then raise exception 'browser role execute: %', missing; end if;
end $$;
SQL
psql_as postgres -c "notify pgrst, 'reload schema'" >/dev/null
echo "Verification passed; PostgREST schema reload requested."
