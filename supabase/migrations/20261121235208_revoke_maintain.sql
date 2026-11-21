-- Revoke PostgreSQL 17's MAINTAIN privilege from the API roles (follow-up
-- to request_limits_and_privileges).
--
-- MAINTAIN (new in PostgreSQL 17) lets a role run VACUUM, ANALYZE, CLUSTER,
-- REINDEX, REFRESH MATERIALIZED VIEW and LOCK TABLE on a table. The Supabase
-- default grants it to authenticated on every table postgres creates (live:
-- 39 of the 44 public tables, and the default for later ones). The API
-- never issues those commands, but like TRUNCATE the grant is a standing
-- risk that row-level security does not cover: a LOCK TABLE would block
-- payroll for everyone.
--
-- PostgreSQL 16 (the local replica) has no MAINTAIN, so the statements run
-- only on 17 or later and the migration still replays there. CI and live
-- run 17.

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from authenticated, anon';
    execute 'alter default privileges for role postgres in schema public revoke maintain on tables from authenticated';
  end if;
end
$$;
