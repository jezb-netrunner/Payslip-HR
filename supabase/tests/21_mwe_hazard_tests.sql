-- Spec T5 (payroll tax rules spec, 2026-10-25): a minimum wage earner's
-- hazard pay is exempt only with the criteria met and a DOLE certification
-- reference on file — two fields on the employee, off by default.
\set ON_ERROR_STOP 1

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;

\echo '--- 21.1 hazard pay criteria fields'
select pg_temp.check((select column_default = 'false' and is_nullable = 'NO' from information_schema.columns
  where table_schema = 'public' and table_name = 'employees' and column_name = 'hazard_criteria_met'), 'criteria: not met by default');
select pg_temp.check((select is_nullable = 'YES' from information_schema.columns
  where table_schema = 'public' and table_name = 'employees' and column_name = 'hazard_dole_cert_ref'), 'certification reference: optional');
select pg_temp.check((select count(*) from employees where hazard_criteria_met) = 0, 'existing employees: not met');

\echo 'PASSED 21'
