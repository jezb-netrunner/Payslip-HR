-- Spec T11 (payroll tax rules spec, 2026-10-25, PENDING P5): Pag-IBIG's
-- monthly compensation and ceiling are settings for every client until
-- HDMF Circular 460 is read. RA 9679 Sec. 4(b) defines compensation as the
-- basic monthly salary plus mandated COLA, and Sec. 7 lets the HDMF Board
-- set the ceiling. The defaults keep today's rule: basic pay plus the
-- regular allowances, up to the statutory table's maximum fund salary
-- (pagibig_ceiling null). Company admins change them through
-- set_payroll_rule, which marks every draft payroll for recomputing.

alter table public.payroll_rules
  add column pagibig_base_basic boolean not null default true,
  add column pagibig_base_cola boolean not null default true,
  add column pagibig_base_other_allowances boolean not null default true,
  add column pagibig_ceiling numeric(12,2)
    constraint payroll_rules_pagibig_ceiling_check check (pagibig_ceiling > 0);

create or replace function public.set_payroll_rule(p_rule text, p_value text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_flag boolean;
  v_amount numeric;
begin
  if not is_company_admin() then
    raise exception 'Only a company admin changes the payroll rules.';
  end if;
  if p_rule in ('pagibig_base_basic', 'pagibig_base_cola', 'pagibig_base_other_allowances') then
    if p_value not in ('true', 'false') then
      raise exception 'Set % to true or false.', p_rule;
    end if;
    v_flag := p_value = 'true';
  elsif p_rule = 'pagibig_ceiling' and nullif(trim(p_value), '') is not null then
    if trim(p_value) !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'The Pag-IBIG ceiling is an amount in pesos (blank = the statutory table''s).';
    end if;
    v_amount := trim(p_value)::numeric;
  end if;

  if p_rule = 'maternity_contributions' then
    update payroll_rules set maternity_contributions = p_value, updated_at = now()
      where maternity_contributions is distinct from p_value;
  elsif p_rule = 'pagibig_base_basic' then
    update payroll_rules set pagibig_base_basic = v_flag, updated_at = now() where pagibig_base_basic is distinct from v_flag;
  elsif p_rule = 'pagibig_base_cola' then
    update payroll_rules set pagibig_base_cola = v_flag, updated_at = now() where pagibig_base_cola is distinct from v_flag;
  elsif p_rule = 'pagibig_base_other_allowances' then
    update payroll_rules set pagibig_base_other_allowances = v_flag, updated_at = now()
      where pagibig_base_other_allowances is distinct from v_flag;
  elsif p_rule = 'pagibig_ceiling' then
    update payroll_rules set pagibig_ceiling = v_amount, updated_at = now() where pagibig_ceiling is distinct from v_amount;
  else
    raise exception 'Unknown payroll rule %.', p_rule;
  end if;
  if found then
    update payroll_runs set totals = '{}'::jsonb where status = 'draft' and totals <> '{}'::jsonb;
  end if;
end
$$;
revoke execute on function public.set_payroll_rule(text, text) from public, anon;
grant execute on function public.set_payroll_rule(text, text) to authenticated;
