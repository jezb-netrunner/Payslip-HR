-- Schema fingerprint of the public schema: one md5 per object kind. Run it
-- on the live project (Supabase SQL editor / MCP execute_sql) and on a local
-- replica built by run.sh (database phr_test); matching hashes mean the live
-- database has exactly the tested tables, columns, constraints, indexes,
-- policies, functions, grants and triggers. Function bodies are compared
-- without carriage returns (text pasted into the SQL editor from Windows
-- arrives with CRLF line endings, which change nothing).
with
t as (select string_agg(c.relname || ':' || c.relrowsecurity, ',' order by c.relname) s, count(*) n
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
col as (select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ';' order by table_name, column_name) s, count(*) n
      from information_schema.columns where table_schema = 'public'),
con as (select string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), ';' order by conrelid::regclass::text, conname) s, count(*) n
      from pg_constraint where connamespace = 'public'::regnamespace),
idx as (select string_agg(pg_get_indexdef(indexrelid), ';' order by indexrelid::regclass::text) s, count(*) n
      from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace = 'public'::regnamespace),
pol as (select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ';' order by tablename, policyname) s, count(*) n
      from pg_policies where schemaname = 'public'),
fn as (select string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || '):' || prosecdef || ':' || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\r', '')), ';' order by proname, pg_get_function_identity_arguments(oid)) s, count(*) n
      from pg_proc where pronamespace = 'public'::regnamespace),
fg as (select string_agg(proname || ':' || has_function_privilege('anon', oid, 'execute') || ':' || has_function_privilege('authenticated', oid, 'execute'), ';' order by proname, pg_get_function_identity_arguments(oid)) s
      from pg_proc where pronamespace = 'public'::regnamespace),
tg as (select string_agg(tgrelid::regclass::text || ':' || tgname || ':' || pg_get_triggerdef(oid), ';' order by tgrelid::regclass::text, tgname) s, count(*) n
      from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace))
select 'tables' k, t.n, md5(t.s) from t union all
select 'columns', col.n, md5(col.s) from col union all
select 'constraints', con.n, md5(con.s) from con union all
select 'indexes', idx.n, md5(idx.s) from idx union all
select 'policies', pol.n, md5(pol.s) from pol union all
select 'functions', fn.n, md5(fn.s) from fn union all
select 'fn_grants', null, md5(fg.s) from fg union all
select 'triggers', tg.n, md5(tg.s) from tg;
