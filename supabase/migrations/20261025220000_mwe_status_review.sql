-- Owner's answer to the spec T12 question (2026-10-25): MWE status follows
-- the pay rate (RR 2-98 Sec. 2.78.1(B)(13), RMC 50-2018 A14). Before the
-- first payroll on the new rule, admins list the employees whose status
-- changes against the old checkbox, kept as the status last reviewed, to
-- warn those who will owe catch-up tax at the year-end adjustment. Payroll
-- no longer reads the checkbox, so saving it alone doesn't mark drafts for
-- recomputing. The apprentice rule (an apprentice or learner paid 75% of the
-- minimum is a minimum wage earner) is PENDING because no text supports it
-- yet: a setting, on by default (today's behavior), changed by company
-- admins through set_payroll_rule.

alter table public.payroll_rules
  add column apprentice_mwe boolean not null default true;

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
  if p_rule in ('pagibig_base_basic', 'pagibig_base_cola', 'pagibig_base_other_allowances', 'apprentice_mwe') then
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
  elsif p_rule = 'apprentice_mwe' then
    update payroll_rules set apprentice_mwe = v_flag, updated_at = now() where apprentice_mwe is distinct from v_flag;
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


comment on column public.employees.is_minimum_wage_earner is
  'The MWE status admins last reviewed (before spec T12, the checkbox payroll used). Payroll computes the status per pay period from minimum_wages, and the Employees page lists the employees whose computed status differs from this.';

-- Same as 20261024221511_payroll_deduction_overrides except that the
-- reviewed MWE status is not something payroll reads.
create or replace function public.stale_drafts_on_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rows jsonb[] := array_remove(array[
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end], null);
  v_ignore text[] := array['updated_at','rounding_balance','payroll_seq','login_code_hint','login_code_set_at',
                            'is_minimum_wage_earner'];
  r jsonb;
  v_entity uuid;
begin
  -- finalize/reopen: drafts sharing these employees are already stale
  -- through payroll_seq
  if coalesce(current_setting('payroll.lifecycle', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - v_ignore) = (to_jsonb(old) - v_ignore) then
    return new;
  end if;
  foreach r in array v_rows loop
    case tg_table_name
      when 'payroll_adjustments', 'payroll_deduction_overrides' then
        update payroll_runs set totals = '{}'::jsonb
          where id = (r->>'payroll_run_id')::uuid and status = 'draft' and totals <> '{}'::jsonb;
      when 'time_entries' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'work_date')::date, (r->>'work_date')::date);
      when 'schedule_overrides' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'work_date')::date, (r->>'work_date')::date);
      when 'employee_schedules' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'effective_from')::date, null);
      when 'leave_requests' then
        if r->>'status' = 'approved' then
          perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                            (r->>'start_date')::date, (r->>'end_date')::date);
        end if;
      when 'holidays' then
        perform mark_payroll_drafts_stale(nullif(r->>'entity_id','')::uuid, null,
                                          (r->>'holiday_date')::date, (r->>'holiday_date')::date);
      when 'entities' then
        perform mark_payroll_drafts_stale((r->>'id')::uuid, null, null, null);
      when 'employees' then
        -- who is eligible can change too: every draft of the client
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, null, null, null);
      when 'statutory_versions' then
        -- every client; 13th-month drafts included (withholding on the excess)
        update payroll_runs set totals = '{}'::jsonb
          where status = 'draft' and totals <> '{}'::jsonb
            and greatest(period_end, pay_date) >= (r->>'effective_from')::date;
      when 'leave_types' then
        if r->>'entity_id' is not null then
          perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, null, null, null);
        end if;
      else -- employee_allowances, recurring_deductions, employee_tax_years
        select entity_id into v_entity from employees where id = (r->>'employee_id')::uuid;
        perform mark_payroll_drafts_stale(v_entity, (r->>'employee_id')::uuid, null, null);
    end case;
  end loop;
  return coalesce(new, old);
end
$$;
