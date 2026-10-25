-- Spec T6 (payroll tax rules spec, 2026-10-25): PhilHealth's NG share by
-- month. A waiver has a start month; a solo parent's SPIC expiry, a PWD's
-- PhilHealth status. Five document slots per employee, private to the
-- admins of the employee's client.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set pa    '''00000000-0000-0000-0000-000000000221'''
\set pb    '''00000000-0000-0000-0000-000000000222'''

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

\echo '--- 22.1 the waiver by month'
insert into auth.users (id, email, raw_app_meta_data) values
  (:pa, 'pa@phil.test', '{"role":"entity_admin"}'),
  (:pb, 'pb@other.test', '{"role":"entity_admin"}');
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-000000000221', 'PHA', 'Phil A', 755),
  ('10000000-0000-0000-0000-000000000222', 'PHB', 'Phil B', 755);
insert into entity_admins (profile_id, entity_id) values
  (:pa, '10000000-0000-0000-0000-000000000221'),
  (:pb, '10000000-0000-0000-0000-000000000222');
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-000000000221', '10000000-0000-0000-0000-000000000221', 'P-001', 'Pia', 'Waiver', '2025-01-06', 'monthly', 30000, 'monthly');
select pg_temp.check(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees'
  and column_name in ('philhealth_ee_waiver_from', 'philhealth_ee_waiver_until')), 'the date range is gone');
update employees set philhealth_ee_waiver = 'solo_parent', philhealth_waiver_start_month = '2026-10-01', philhealth_spic_expiry = '2027-03-15'
  where id = '20000000-0000-0000-0000-000000000221';
select pg_temp.expect_error($$update employees set philhealth_waiver_start_month = '2026-10-15' where id = '20000000-0000-0000-0000-000000000221'$$,
  '%employees_philhealth_waiver%');
select pg_temp.expect_error($$update employees set philhealth_pwd_status = 'confirmed' where id = '20000000-0000-0000-0000-000000000221'$$,
  '%employees_philhealth_waiver%');
update employees set philhealth_ee_waiver = 'pwd', philhealth_spic_expiry = null, philhealth_pwd_status = 'for_verification'
  where id = '20000000-0000-0000-0000-000000000221';
select pg_temp.expect_error($$update employees set philhealth_pwd_status = null where id = '20000000-0000-0000-0000-000000000221'$$,
  '%employees_philhealth_waiver%');
select pg_temp.expect_error($$update employees set philhealth_spic_expiry = '2027-01-01' where id = '20000000-0000-0000-0000-000000000221'$$,
  '%employees_philhealth_waiver%');
select pg_temp.expect_error($$update employees set philhealth_pwd_status = 'pending' where id = '20000000-0000-0000-0000-000000000221'$$,
  '%employees_philhealth_pwd_status_check%');

\echo '--- 22.2 document slots: the employee''s client''s admins only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :pa, true);
insert into storage.objects (bucket_id, name) values ('employee-documents', '20000000-0000-0000-0000-000000000221/pmrf/pmrf.pdf');
insert into employee_documents (employee_id, slot, file_path, file_name)
  values ('20000000-0000-0000-0000-000000000221', 'pmrf', '20000000-0000-0000-0000-000000000221/pmrf/pmrf.pdf', 'pmrf.pdf');
select pg_temp.check((select count(*) from employee_documents) = 1, 'own client: recorded');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'employee-documents') = 1, 'own client: file readable');
select pg_temp.expect_error($$insert into employee_documents (employee_id, slot, file_path, file_name)
  values ('20000000-0000-0000-0000-000000000221', 'selfie', '20000000-0000-0000-0000-000000000221/selfie/x.png', 'x.png')$$, '%employee_documents_slot_check%');
select pg_temp.expect_error($$insert into employee_documents (employee_id, slot, file_path, file_name)
  values ('20000000-0000-0000-0000-000000000221', 'spis', 'elsewhere/spis/x.pdf', 'x.pdf')$$, '%employee_documents_path%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :pb, true);
select pg_temp.check((select count(*) from employee_documents) = 0, 'another client''s admin: no rows');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'employee-documents') = 0, 'another client''s admin: no files');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('employee-documents', '20000000-0000-0000-0000-000000000221/spis/x.pdf')$$, '%row-level security%');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('employee-documents', 'not-a-uuid/spis/x.pdf')$$, '%row-level security%');
commit;
begin;
set local role anon;
select pg_temp.expect_error($$select * from employee_documents$$, '%permission denied%');
commit;
select pg_temp.check((select not public from storage.buckets where id = 'employee-documents'), 'a private bucket');

\echo 'PASSED 22'
