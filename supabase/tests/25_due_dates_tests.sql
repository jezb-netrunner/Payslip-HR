-- Spec T9 (payroll tax rules spec, 2026-10-25): the client's BIR filing
-- mode and eFPS group, the pending (P6) contribution due days, and due-date
-- overrides with a note, by client admins only.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set da    '''00000000-0000-0000-0000-0000000000e9'''
\set oa    '''00000000-0000-0000-0000-0000000000ea'''

create or replace function pg_temp.expect_error(p_sql text, p_like text default '%') returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected error like % but got: %', p_like, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected an error but statement succeeded: %', p_sql;
end $$;
grant execute on function pg_temp.expect_error(text, text) to authenticated, anon, service_role;

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;

-- fixture: clients DUE and OTHER, each with its admin
insert into auth.users (id, email, raw_app_meta_data) values
  (:da, 'da@due.test', '{"role":"entity_admin"}'),
  (:oa, 'oa@other.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000000e9', 'DUE', 'Due Dates Co', 755),
  ('10000000-0000-0000-0000-0000000000ea', 'OTH', 'Other Co', 755);
insert into entity_admins (profile_id, entity_id) values
  (:da, '10000000-0000-0000-0000-0000000000e9'),
  (:oa, '10000000-0000-0000-0000-0000000000ea');
commit;

\echo '--- 25.1 the filing mode and eFPS group, the contribution due days: none by default'
select pg_temp.check((select filing_mode is null and efps_group is null and sss_due_day is null and philhealth_due_day is null and pagibig_due_day is null
  from entities where id = '10000000-0000-0000-0000-0000000000e9'), 'nothing set');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :da, true);
select pg_temp.expect_error($$update entities set filing_mode = 'efps' where id = '10000000-0000-0000-0000-0000000000e9'$$, '%entities_efps_group_required%');
select pg_temp.expect_error($$update entities set filing_mode = 'online' where id = '10000000-0000-0000-0000-0000000000e9'$$, '%entities_filing_mode_check%');
select pg_temp.expect_error($$update entities set filing_mode = 'efps', efps_group = 'F' where id = '10000000-0000-0000-0000-0000000000e9'$$, '%entities_efps_group_check%');
select pg_temp.expect_error($$update entities set sss_due_day = 0 where id = '10000000-0000-0000-0000-0000000000e9'$$, '%entities_sss_due_day_check%');
select pg_temp.expect_error($$update entities set pagibig_due_day = 32 where id = '10000000-0000-0000-0000-0000000000e9'$$, '%entities_pagibig_due_day_check%');
update entities set filing_mode = 'efps', efps_group = 'A', sss_due_day = 30, pagibig_due_day = 15 where id = '10000000-0000-0000-0000-0000000000e9';
update entities set filing_mode = 'manual_or_ebirforms' where id = '10000000-0000-0000-0000-0000000000e9';
commit;
select pg_temp.check((select filing_mode = 'manual_or_ebirforms' and efps_group = 'A' and sss_due_day = 30 and philhealth_due_day is null
  from entities where id = '10000000-0000-0000-0000-0000000000e9'), 'saved');

\echo '--- 25.2 overrides: with a note, once per obligation and period, annual ones on January 1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :da, true);
insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', '1601c', '2026-10-01', '2026-11-16', 'RMC 95-2026 extension');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', '1601c', '2026-10-01', '2026-11-17', 'again')$$, '%due_date_overrides_once%');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', 'sss', '2026-10-01', '2026-11-30', '   ')$$, '%due_date_overrides_note_check%');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', 'sss', '2026-10-05', '2026-11-30', 'x')$$, '%due_date_overrides_period_check%');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', '1604c', '2026-10-01', '2027-02-01', 'x')$$, '%due_date_overrides_annual%');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', 'alphalist', '2026-01-01', '2027-02-01', 'x')$$, '%due_date_overrides_obligation_check%');
insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', '1604c', '2026-01-01', '2027-02-01', 'Extended by RMC');
update due_date_overrides set due_date = '2026-11-18', note = 'RMC 95-2026, as amended'
  where entity_id = '10000000-0000-0000-0000-0000000000e9' and obligation = '1601c';
commit;
select pg_temp.check((select count(*) = 3 from audit_logs where table_name = 'due_date_overrides' and entity_id = '10000000-0000-0000-0000-0000000000e9'),
  'audit-logged under the client');

\echo '--- 25.3 another client''s admin neither sees nor writes them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
select pg_temp.check((select count(*) = 0 from due_date_overrides), 'not visible');
select pg_temp.expect_error($$insert into due_date_overrides (entity_id, obligation, period, due_date, note)
  values ('10000000-0000-0000-0000-0000000000e9', 'sss', '2026-11-01', '2026-12-30', 'x')$$, '%row-level security%');
update due_date_overrides set note = 'hijack' where entity_id = '10000000-0000-0000-0000-0000000000e9';
commit;
select pg_temp.check((select note = 'RMC 95-2026, as amended' from due_date_overrides where obligation = '1601c'), 'untouched');
begin;
set local role anon;
select pg_temp.expect_error($$select count(*) from due_date_overrides$$, '%permission denied%');
commit;

\echo 'PASSED 25'
