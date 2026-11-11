-- Internal controls on posting a payroll (audit of 2026-11-11).
--
-- 1. A payroll run starts as a draft. An API caller could insert one already
--    marked finalized, with any finalizer named, past finalize_payroll_run
--    (no control number, no cross-check), and such a run locked the
--    attendance of its period.
-- 2. Who created, computed and finalized a run, who reviewed a leave request
--    and who entered a payroll adjustment are recorded by the database, never
--    taken from the caller.
-- 3. A client can require a second person to finalize a payroll (four eyes):
--    whoever computed the draft last cannot finalize it. Only company admins
--    switch the rule on or off.
-- 4. A payroll with a negative net pay is not posted: it would move loan
--    balances by amounts nobody collected.
-- 5. Housekeeping: no negative loan amounts, and the last function the
--    anonymous role could execute is closed.
-- Nothing destructive and no semicolon inside a string or comment: the
-- migration applies through the Supabase MCP (see MEMORY.md).

alter table public.entities
  add column if not exists require_second_approver boolean not null default false;
comment on column public.entities.require_second_approver is
  'Four eyes: the admin who computed a payroll draft cannot finalize it. Changed by company admins only.';

alter table public.payroll_runs
  add column if not exists computed_by uuid,
  add column if not exists computed_by_name text,
  add column if not exists computed_at timestamptz,
  add column if not exists finalized_by_name text;
comment on column public.payroll_runs.computed_by is
  'Who completed the computation of the draft last (set by the database when the totals are written).';
comment on column public.payroll_runs.finalized_by_name is
  'The name or email of the admin who finalized the run, as it was then.';

-- Runs posted before this migration keep finalized_by only (a posted run is
-- not rewritten): the screens show the name where it was recorded.

-- Who did what on a payroll run comes from the session, not from the request.
-- Runs as the caller: an API request acts as the authenticated role, while
-- finalize, void and the staleness triggers (definer functions) and direct
-- database sessions (migrations, seed scripts, the SQL editor) do not.
create or replace function public.stamp_payroll_run()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_lifecycle boolean := coalesce(current_setting('payroll.lifecycle', true), '') = 'on';
  v_api boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_api then
      if new.status <> 'draft' then
        raise exception 'A payroll run starts as a draft. Compute it, then use Finalize to post it.';
      end if;
      new.created_by := auth.uid();
      new.finalized_by := null;
      new.finalized_at := null;
      new.finalized_by_name := null;
      new.totals := '{}'::jsonb;
      new.computed_by := null;
      new.computed_by_name := null;
      new.computed_at := null;
    end if;
    return new;
  end if;

  if v_api and not v_lifecycle then
    new.created_by := old.created_by;
    new.finalized_by := old.finalized_by;
    new.finalized_at := old.finalized_at;
    new.finalized_by_name := old.finalized_by_name;
  end if;
  if old.status = 'draft' and new.status = 'draft'
     and new.totals ? 'employees' and new.totals is distinct from old.totals then
    -- a computation just completed: the payslips of this draft are this caller's work
    new.computed_by := auth.uid();
    new.computed_by_name := (select coalesce(nullif(p.full_name, ''), p.email) from profiles p where p.id = auth.uid());
    new.computed_at := now();
  elsif v_api then
    new.computed_by := old.computed_by;
    new.computed_by_name := old.computed_by_name;
    new.computed_at := old.computed_at;
  end if;
  return new;
end
$$;
revoke execute on function public.stamp_payroll_run() from public, anon, authenticated;

-- after payroll_runs_guard (which clears the totals of a draft whose period
-- changed) by name order, before payroll_runs_updated_at
create trigger payroll_runs_stamp
  before insert or update on public.payroll_runs
  for each row execute function public.stamp_payroll_run();

-- The admin who approves, rejects or files a leave is the reviewer on
-- record, and the admin who enters a payroll adjustment is its author.
create or replace function public.stamp_actor()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_api boolean := current_user in ('authenticated', 'anon');
begin
  if not v_api then
    return new;
  end if;
  if tg_table_name = 'leave_requests' then
    if tg_op = 'INSERT' then
      if new.status in ('approved', 'rejected') then
        new.reviewed_by := auth.uid();
        new.reviewed_at := now();
      else
        new.reviewed_by := null;
        new.reviewed_at := null;
      end if;
    elsif new.status is distinct from old.status and (select public.caller_is_admin()) then
      -- approved, rejected or revoked: the admin who decided it
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    else
      -- an edit that decides nothing, or the employee cancelling their own request
      new.reviewed_by := old.reviewed_by;
      new.reviewed_at := old.reviewed_at;
    end if;
  elsif tg_table_name = 'payroll_adjustments' then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end
$$;
revoke execute on function public.stamp_actor() from public, anon, authenticated;

create trigger leave_requests_actor
  before insert or update on public.leave_requests
  for each row execute function public.stamp_actor();
create trigger payroll_adjustments_actor
  before insert or update on public.payroll_adjustments
  for each row execute function public.stamp_actor();


-- Finalize: the four-eyes rule, and the finalizer's name kept on the run.
CREATE OR REPLACE FUNCTION public.finalize_payroll_run(p_run uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run payroll_runs;
  v_names text;
  v_count int;
  v_locked uuid[];
  v_problem text;
  v_first bigint;
begin
  select * into v_run from payroll_runs where id = p_run;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  v_locked := lock_run_participants(p_run);
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.status <> 'draft' then
    raise exception 'This run is not a draft — it may already be finalized.';
  end if;
  -- four eyes, when the client requires it: whoever computed the draft does not post it
  if (select e.require_second_approver from entities e where e.id = v_run.entity_id) then
    if v_run.computed_by is null then
      raise exception 'This client requires a second person to finalize a payroll. Recompute the draft so that it records who prepared it, then have another admin review and finalize it.';
    elsif v_run.computed_by = auth.uid() then
      raise exception 'This client requires a second person to finalize a payroll: you computed this draft, so another admin of the client must review and finalize it.';
    end if;
  end if;
  if exists (select 1 from payslips where payroll_run_id = p_run and employee_id <> all(v_locked)) then
    raise exception 'This draft is out of date or its computation did not finish. Recompute the draft, then finalize.';
  end if;

  select count(*) into v_count from payslips where payroll_run_id = p_run;
  if not (v_run.totals ? 'employees') or (v_run.totals->>'employees')::int <> v_count then
    raise exception 'This draft is out of date or its computation did not finish. Recompute the draft, then finalize.';
  end if;
  if v_count = 0 then
    raise exception 'Nothing to finalize: the draft has no payslips.';
  end if;

  select string_agg(distinct e.first_name || ' ' || e.last_name, ', ') into v_names
    from payroll_adjustments a join employees e on e.id = a.employee_id
    where a.payroll_run_id = p_run
      and not exists (select 1 from payslips p where p.payroll_run_id = p_run and p.employee_id = a.employee_id);
  if v_names is not null then
    raise exception 'This run has adjustments for % but no payslip for them (left out of the run). Remove those adjustments or add them to a run that pays them, then finalize.', v_names;
  end if;

  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_names
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run
      and (e.rounding_balance <> p.rounding_carry_in
           or e.payroll_seq is distinct from p.employee_payroll_seq);
  if v_names is not null then
    raise exception 'Another payroll for % was finalized or voided after this draft was computed. Recompute the draft, then finalize.', v_names;
  end if;

  if v_run.run_type <> 'thirteenth_month' then
    select string_agg(distinct e.first_name || ' ' || e.last_name, ', ') into v_names
      from payslips p
      join employees e on e.id = p.employee_id
      join payslips q on q.employee_id = p.employee_id and q.payroll_run_id <> p_run
      join payroll_runs r on r.id = q.payroll_run_id
      where p.payroll_run_id = p_run
        and r.status in ('finalized','paid') and r.run_type <> 'thirteenth_month'
        and r.period_start <= v_run.period_end and r.period_end >= v_run.period_start;
    if v_names is not null then
      raise exception 'Already paid for an overlapping period in another finalized run: %. Recompute the draft (they are left out), then finalize.', v_names;
    end if;
  end if;

  -- a payroll cannot collect more than it pays (the engine stops deductions at the pay)
  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_names
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run and p.net_pay < 0;
  if v_names is not null then
    raise exception 'Net pay is negative for %: a payroll cannot collect more than it pays. Reduce or skip a deduction for this payroll, recompute, then finalize.', v_names;
  end if;

  v_problem := public.payroll_run_out_of_balance(p_run);
  if v_problem is not null then
    raise exception '%. Recompute the draft, then finalize.', v_problem;
  end if;

  perform set_config('payroll.lifecycle', 'on', true);
  v_first := public.take_document_numbers(v_run.entity_id, 'payslip', v_count);
  update payslips p
    set control_no = public.format_control_no('PS', v_first + o.rn - 1)
    from (select p2.id, row_number() over (order by e.last_name, e.first_name, e.employee_no, p2.id) as rn
          from payslips p2 join employees e on e.id = p2.employee_id
          where p2.payroll_run_id = p_run) o
    where p.id = o.id;
  update payroll_runs
    set status = 'finalized', finalized_at = now(), finalized_by = auth.uid(),
        finalized_by_name = (select coalesce(nullif(pr.full_name, ''), pr.email) from profiles pr where pr.id = auth.uid()),
        control_no = public.format_control_no('PR', public.take_document_numbers(v_run.entity_id, 'payroll_run', 1))
    where id = p_run
    returning * into v_run;
  update employees e
    set rounding_balance = p.rounding_carry_out,
        payroll_seq = e.payroll_seq + 1
    from payslips p
    where p.payroll_run_id = p_run and p.employee_id = e.id;
  perform adjust_run_deduction_balances(p_run, -1);
  perform set_config('payroll.lifecycle', '', true);
  return v_run;
end
$function$;

-- Void: the run goes back to a draft without a finalizer's name.
CREATE OR REPLACE FUNCTION public.void_payroll_run(p_run uuid, p_reason text)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run payroll_runs;
  v_used text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_email text;
  v_control text;
begin
  select * into v_run from payroll_runs where id = p_run;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Give the reason for voiding this payroll (5 to 500 characters).';
  end if;
  perform lock_run_participants(p_run);
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.status not in ('finalized','paid') then
    raise exception 'This run is not finalized: there is nothing to void.';
  end if;

  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_used
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run
      and (e.rounding_balance <> p.rounding_carry_out
           or ((p.rounding_carry_in <> 0 or p.rounding_carry_out <> 0) and exists (
                 select 1 from payslips q join payroll_runs r on r.id = q.payroll_run_id
                 where q.employee_id = p.employee_id and q.payroll_run_id <> p_run
                   and r.status in ('finalized','paid')
                   and q.employee_payroll_seq > p.employee_payroll_seq)));
  if v_used is not null then
    raise exception 'A later finalized payroll already carried forward this run''s rounding for: %. Void that later run first.', v_used;
  end if;

  v_control := v_run.control_no;
  select coalesce(email, nullif(full_name, '')) into v_email from profiles where id = auth.uid();
  insert into payroll_voids (entity_id, payroll_run_id, run_control_no, run_snapshot, payslips, reason, voided_by, voided_by_email)
  values (v_run.entity_id, v_run.id, v_control, to_jsonb(v_run),
          coalesce((select jsonb_agg(to_jsonb(p) order by p.control_no, p.id) from payslips p where p.payroll_run_id = p_run), '[]'::jsonb),
          v_reason, auth.uid(), v_email);

  perform set_config('payroll.lifecycle', 'on', true);
  update payroll_runs
    set status = 'draft', finalized_at = null, finalized_by = null, finalized_by_name = null, totals = '{}'::jsonb, control_no = null
    where id = p_run
    returning * into v_run;
  update payslips set control_no = null where payroll_run_id = p_run;
  update employees e
    set rounding_balance = p.rounding_carry_in,
        payroll_seq = e.payroll_seq + 1
    from payslips p
    where p.payroll_run_id = p_run and p.employee_id = e.id;
  perform adjust_run_deduction_balances(p_run, 1);
  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, new_data)
  values (auth.uid(), v_email, 'void', 'payroll_runs', p_run::text, v_run.entity_id,
          jsonb_build_object('control_no', v_control, 'reason', v_reason));
  perform set_config('payroll.lifecycle', '', true);
  return v_run;
end
$function$;

-- The audit trail skips the computation stamp (a bookkeeping write, like the totals).
CREATE OR REPLACE FUNCTION public.audit_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row jsonb;
  v_entity uuid;
  v_email text;
  v_actor uuid := auth.uid();
  v_header text;
  v_ignore text[] := case tg_table_name
    when 'employees' then array['updated_at','payroll_seq','rounding_balance']
    when 'payroll_runs' then array['updated_at','totals','computed_by','computed_by_name','computed_at']
    when 'profiles' then array['updated_at','sessions_revoked_at','admin_session_id']
    else array['updated_at'] end;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - v_ignore) = (to_jsonb(old) - v_ignore) then
    return new;
  end if;
  if v_actor is null
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role' then
    v_header := nullif(current_setting('request.headers', true), '')::jsonb->>'x-actor-id';
    if v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_actor := v_header::uuid;
    end if;
  end if;

  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_table_name = 'entities' then
    v_entity := (v_row->>'id')::uuid;
  elsif v_row ? 'entity_id' then
    v_entity := nullif(v_row->>'entity_id','')::uuid;
  elsif nullif(v_row->>'employee_id','') is not null then
    -- employee-owned rows without a client column of their own
    -- (allowances, recurring deductions, employee login profiles)
    select entity_id into v_entity from employees where id = (v_row->>'employee_id')::uuid;
  end if;
  -- employee logins have no email on their profile: name them instead
  select coalesce(email, nullif(full_name, '')) into v_email from profiles where id = v_actor;

  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, old_data, new_data)
  values (
    v_actor,
    v_email,
    lower(tg_op),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'profile_id'),
    v_entity,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end
$function$;

-- Only company admins change the four-eyes rule.
CREATE OR REPLACE FUNCTION public.guard_entity_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.code is distinct from old.code then
    raise exception 'The client code is the prefix of every employee login code and cannot be changed.';
  end if;
  if new.is_active is distinct from old.is_active and not public.is_company_admin() then
    raise exception 'Only company admins can archive or reactivate a client.';
  end if;
  if new.require_second_approver is distinct from old.require_second_approver and not public.is_company_admin() then
    raise exception 'Only company admins can change whether a second person must finalize payroll.';
  end if;
  return new;
end
$function$;

-- A loan or deduction never carries a negative installment, balance or total
-- (the screens refuse them, a direct API call did not).
alter table public.recurring_deductions
  add constraint recurring_deductions_amounts_not_negative
  check (amount_per_period >= 0 and (balance is null or balance >= 0) and (total_amount is null or total_amount >= 0));

-- The EWT table's validator was the one function the anonymous role could
-- still call (its siblings were closed with their migrations).
revoke execute on function public.valid_ewt_data(jsonb) from public, anon;
grant execute on function public.valid_ewt_data(jsonb) to authenticated, service_role;
