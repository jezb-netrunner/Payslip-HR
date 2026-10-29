-- The payroll system as a component of a computerized accounting system
-- (BIR RMO 9-2021, Annex B): control numbers on posted payrolls and
-- payslips, a cross-check of their totals before posting, void and reissue
-- instead of reopening (the posted version stays on record, marked VOID),
-- the client's VAT registration for report headings, an audit trail no app
-- user can alter that also records sign-ins and report runs, and the
-- sign-in guard of admin accounts (lockout, one active session, password
-- age).

-- ---------- the client's VAT registration (report headings) ----------
-- null until set: reports then print the TIN without VAT REG or NON-VAT REG
alter table public.entities add column if not exists vat_registered boolean;

-- ---------- control numbers ----------
create table public.document_counters (
  entity_id uuid not null references public.entities(id) on delete cascade,
  kind text not null constraint document_counters_kind_check check (kind in ('payroll_run', 'payslip')),
  last_no bigint not null default 0 constraint document_counters_last_no_check check (last_no >= 0),
  primary key (entity_id, kind)
);
alter table public.document_counters enable row level security;
revoke all on public.document_counters from anon, authenticated;

-- the first of p_count new numbers of a kind for a client: numbers are
-- never reused, a voided payroll keeps its numbers in the archive
create or replace function public.take_document_numbers(p_entity uuid, p_kind text, p_count int)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_last bigint;
begin
  if p_count < 1 then
    raise exception 'Nothing to number.';
  end if;
  insert into document_counters (entity_id, kind, last_no) values (p_entity, p_kind, p_count)
  on conflict (entity_id, kind) do update set last_no = document_counters.last_no + excluded.last_no
  returning last_no into v_last;
  return v_last - p_count + 1;
end
$$;
revoke execute on function public.take_document_numbers(uuid, text, int) from public, anon, authenticated;

alter table public.payroll_runs add column if not exists control_no text
  constraint payroll_runs_control_no_check check (control_no ~ '^PR-[0-9]{6,}$');
alter table public.payslips add column if not exists control_no text
  constraint payslips_control_no_check check (control_no ~ '^PS-[0-9]{6,}$');
create unique index payroll_runs_control_no_uidx on public.payroll_runs (entity_id, control_no) where control_no is not null;
create unique index payslips_control_no_uidx on public.payslips (entity_id, control_no) where control_no is not null;

-- only finalize (and void) set a control number
create or replace function public.guard_control_no()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if coalesce(current_setting('payroll.lifecycle', true), '') <> 'on'
     and new.control_no is distinct from (case when tg_op = 'UPDATE' then old.control_no end) then
    raise exception 'Control numbers are assigned by the system when a payroll is finalized.';
  end if;
  return new;
end
$$;
revoke execute on function public.guard_control_no() from public, anon, authenticated;
create trigger payroll_runs_control_no before insert or update on public.payroll_runs
  for each row execute function public.guard_control_no();
create trigger payslips_control_no before insert or update on public.payslips
  for each row execute function public.guard_control_no();

-- a posted payslip never changes. The one exception is numbering the
-- payslips posted before control numbers began (this migration).
create or replace function public.prevent_finalized_payslip_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_run uuid;
begin
  v_run := coalesce(new.payroll_run_id, old.payroll_run_id);
  if public.run_is_finalized(v_run) then
    if tg_op = 'UPDATE' and coalesce(current_setting('payroll.numbering', true), '') = 'on'
       and (to_jsonb(new) - 'control_no' - 'updated_at') = (to_jsonb(old) - 'control_no' - 'updated_at') then
      return new;
    end if;
    raise exception 'Payslips of a finalized payroll run are immutable. Void the run to correct it.';
  end if;
  return coalesce(new, old);
end
$$;

-- number the payrolls already posted, in the order they were posted
do $$
declare
  r record;
  v_first bigint;
  v_count int;
begin
  perform set_config('payroll.lifecycle', 'on', true);
  perform set_config('payroll.numbering', 'on', true);
  for r in
    select id, entity_id from payroll_runs
    where status in ('finalized', 'paid') and control_no is null
    order by entity_id, finalized_at nulls first, pay_date, created_at, id
  loop
    update payroll_runs
      set control_no = 'PR-' || lpad(public.take_document_numbers(r.entity_id, 'payroll_run', 1)::text, 6, '0')
      where id = r.id;
    select count(*) into v_count from payslips where payroll_run_id = r.id;
    if v_count > 0 then
      v_first := public.take_document_numbers(r.entity_id, 'payslip', v_count);
      update payslips p
        set control_no = 'PS-' || lpad((v_first + o.rn - 1)::text, 6, '0')
        from (select p2.id, row_number() over (order by e.last_name, e.first_name, e.employee_no, p2.id) as rn
              from payslips p2 join employees e on e.id = p2.employee_id
              where p2.payroll_run_id = r.id) o
        where p.id = o.id;
    end if;
  end loop;
  perform set_config('payroll.numbering', '', true);
  perform set_config('payroll.lifecycle', '', true);
end
$$;

-- ---------- totals cross-check ----------
-- null when every payslip adds up (gross = its earning lines, deductions =
-- its deduction lines, net = gross less deductions plus the cash rounding)
-- and the run's totals equal its payslips, else what is out of balance
create or replace function public.payroll_run_out_of_balance(p_run uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_bad text;
  v_totals jsonb;
  v_gross numeric;
  v_net numeric;
  v_wht numeric;
begin
  if not public.can_manage_entity((select entity_id from payroll_runs where id = p_run)) then
    raise exception 'Payroll run not found.';
  end if;
  select string_agg(coalesce(e.first_name || ' ' || e.last_name, p.employee_id::text), ', ' order by e.last_name, e.first_name)
    into v_bad
    from payslips p left join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run
      and (abs(p.gross_pay - coalesce((select sum((l->>'amount')::numeric) from jsonb_array_elements(coalesce(p.earnings, '[]'::jsonb)) l), 0)) > 0.005
           or abs(p.total_deductions - coalesce((select sum((l->>'amount')::numeric) from jsonb_array_elements(coalesce(p.deductions, '[]'::jsonb)) l), 0)) > 0.005
           or abs(p.net_pay - (p.gross_pay - p.total_deductions + coalesce(p.rounding_adjustment, 0))) > 0.005);
  if v_bad is not null then
    return 'Out of balance: the payslip lines of ' || v_bad || ' do not add up to their gross, deductions and net pay';
  end if;
  select totals into v_totals from payroll_runs where id = p_run;
  select coalesce(sum(gross_pay), 0), coalesce(sum(net_pay), 0), coalesce(sum(withholding_tax), 0)
    into v_gross, v_net, v_wht
    from payslips where payroll_run_id = p_run;
  if abs(coalesce((v_totals->>'gross')::numeric, -1) - v_gross) > 0.005
     or abs(coalesce((v_totals->>'net')::numeric, -1) - v_net) > 0.005
     or abs(coalesce((v_totals->>'withholding_tax')::numeric, -1) - v_wht) > 0.005 then
    return format('Out of balance: the run totals (gross %s, net %s, tax %s) differ from its payslips (gross %s, net %s, tax %s)',
                  coalesce(v_totals->>'gross', 'none'), coalesce(v_totals->>'net', 'none'), coalesce(v_totals->>'withholding_tax', 'none'),
                  v_gross, v_net, v_wht);
  end if;
  return null;
end
$$;
revoke execute on function public.payroll_run_out_of_balance(uuid) from public, anon;
grant execute on function public.payroll_run_out_of_balance(uuid) to authenticated;

-- ---------- finalize: cross-check, then number ----------
create or replace function public.finalize_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
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

  v_problem := public.payroll_run_out_of_balance(p_run);
  if v_problem is not null then
    raise exception '%. Recompute the draft, then finalize.', v_problem;
  end if;

  perform set_config('payroll.lifecycle', 'on', true);
  v_first := public.take_document_numbers(v_run.entity_id, 'payslip', v_count);
  update payslips p
    set control_no = 'PS-' || lpad((v_first + o.rn - 1)::text, 6, '0')
    from (select p2.id, row_number() over (order by e.last_name, e.first_name, e.employee_no, p2.id) as rn
          from payslips p2 join employees e on e.id = p2.employee_id
          where p2.payroll_run_id = p_run) o
    where p.id = o.id;
  update payroll_runs
    set status = 'finalized', finalized_at = now(), finalized_by = auth.uid(),
        control_no = 'PR-' || lpad(public.take_document_numbers(v_run.entity_id, 'payroll_run', 1)::text, 6, '0')
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
$$;

-- ---------- void and reissue ----------
-- A posted payroll is never edited: voiding it keeps the posted run and
-- payslips (with their control numbers) here, marked VOID with the reason,
-- and returns the run as a draft to correct and finalize again under new
-- numbers.
create table public.payroll_voids (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete restrict,
  -- no foreign key: the record outlives the draft it came from
  payroll_run_id uuid not null,
  run_control_no text,
  run_snapshot jsonb not null,
  payslips jsonb not null,
  reason text not null constraint payroll_voids_reason_check check (length(btrim(reason)) between 5 and 500),
  voided_by uuid,
  voided_by_email text,
  voided_at timestamptz not null default now()
);
create index payroll_voids_run_idx on public.payroll_voids (payroll_run_id);
create index payroll_voids_entity_idx on public.payroll_voids (entity_id, voided_at desc);
alter table public.payroll_voids enable row level security;
create policy "payroll_voids: admins read" on public.payroll_voids
  for select to authenticated using (public.can_manage_entity(entity_id));
revoke all on public.payroll_voids from anon;
revoke insert, update, delete, truncate, references, trigger on public.payroll_voids from authenticated;

create or replace function public.void_payroll_run(p_run uuid, p_reason text)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
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
    set status = 'draft', finalized_at = null, finalized_by = null, totals = '{}'::jsonb, control_no = null
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
$$;
revoke execute on function public.void_payroll_run(uuid, text) from public, anon;
grant execute on function public.void_payroll_run(uuid, text) to authenticated;

-- a posted run changes only through Void (and its notes)
create or replace function public.guard_payroll_run_update()
returns trigger
language plpgsql set search_path = public
as $$
declare
  v_lifecycle boolean := coalesce(current_setting('payroll.lifecycle', true), '') = 'on';
begin
  if new.entity_id is distinct from old.entity_id then
    raise exception 'A payroll run cannot move to another client.';
  end if;
  if new.status is distinct from old.status and not v_lifecycle then
    raise exception 'Use Finalize or Void to change a payroll run''s status.';
  end if;
  if old.status <> 'draft' and not v_lifecycle
     and (to_jsonb(new) - 'notes' - 'updated_at') is distinct from (to_jsonb(old) - 'notes' - 'updated_at') then
    raise exception 'This payroll run is finalized — void and reissue it to make changes.';
  end if;
  if old.status = 'draft' and new.status = 'draft'
     and (new.run_type, new.period_start, new.period_end, new.pay_date, new.pay_frequency, new.period_month,
          new.period_index, new.periods_in_month, new.annualize, new.employee_ids)
         is distinct from
         (old.run_type, old.period_start, old.period_end, old.pay_date, old.pay_frequency, old.period_month,
          old.period_index, old.periods_in_month, old.annualize, old.employee_ids) then
    new.totals := '{}'::jsonb;
  end if;
  return new;
end
$$;

-- reopening edited a posted payroll in place: it now refuses (void instead)
create or replace function public.reopen_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'A finalized payroll is not reopened: void it with a reason and reissue it (its posted payslips stay on record as VOID).';
end
$$;

-- ---------- the audit trail: no app user can write it ----------
revoke all on public.audit_logs from anon;
revoke insert, update, delete, truncate, references, trigger on public.audit_logs from authenticated;

-- a sign-in through the sign-in guard moves sessions_revoked_at (one active
-- session): it is logged as a sign-in, not as a change to the account
create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_entity uuid;
  v_email text;
  v_actor uuid := auth.uid();
  v_header text;
  v_ignore text[] := case tg_table_name
    when 'employees' then array['updated_at','payroll_seq','rounding_balance']
    when 'payroll_runs' then array['updated_at','totals']
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
$$;

-- a signed-in user's sign-in, sign-out and report runs (what was generated,
-- printed or exported), on the audit trail
create or replace function public.log_activity(p_action text, p_entity uuid, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_action not in ('sign_in', 'sign_out', 'report', 'print', 'export') then
    raise exception 'Unknown activity.';
  end if;
  if p_entity is not null and not (public.can_manage_entity(p_entity) or coalesce(public.current_employee_entity_id() = p_entity, false)) then
    raise exception 'Client not found.';
  end if;
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' or length(coalesce(p_detail, '{}'::jsonb)::text) > 2000 then
    raise exception 'The activity detail must be a short object.';
  end if;
  select coalesce(p.email, nullif(p.full_name, ''), nullif(btrim(e.first_name || ' ' || e.last_name), '')) into v_email
    from profiles p left join employees e on e.id = p.employee_id
    where p.id = auth.uid();
  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, new_data)
  -- an employee's sign-in and sign-out are filed under their own client
  values (auth.uid(), v_email, p_action, 'activity', null, coalesce(p_entity, public.current_employee_entity_id()), coalesce(p_detail, '{}'::jsonb));
end
$$;
revoke execute on function public.log_activity(text, uuid, jsonb) from public, anon;
grant execute on function public.log_activity(text, uuid, jsonb) to authenticated;

-- ---------- the sign-in guard of admin accounts ----------
-- Failed sign-ins (a lockout after five), the last sign-in and when the
-- password last changed (a temporary password or one older than 30 days
-- must be changed). Kept by the sign-in edge function (service role only).
create table public.auth_guard (
  email text primary key constraint auth_guard_email_check check (email = lower(btrim(email)) and length(email) between 3 and 320),
  failed_attempts int not null default 0 constraint auth_guard_failed_attempts_check check (failed_attempts >= 0),
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_sign_in_at timestamptz,
  password_changed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.auth_guard enable row level security;
revoke all on public.auth_guard from anon, authenticated;

-- The guard checks a password here, against the account's own bcrypt hash,
-- before it asks the Auth server for a session: a wrong password never
-- reaches the Auth server, whose per-IP sign-in limit all of the guard's
-- requests share (a flood of wrong passwords would use it up for every
-- admin). Answers ok, invalid, no_account, or upstream (a hash this check
-- doesn't read, which the Auth server then checks).
create or replace function public.guard_check_password(p_email text, p_password text)
returns text
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select u.encrypted_password into v_hash
    from auth.users u
    where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null
    order by u.created_at
    limit 1;
  if not found then
    return 'no_account';
  end if;
  if coalesce(v_hash, '') = '' or p_password is null or p_password = '' then
    return 'invalid';
  end if;
  if v_hash not like '$2_$%' then
    return 'upstream';
  end if;
  return case when extensions.crypt(p_password, v_hash) = v_hash then 'ok' else 'invalid' end;
end
$$;
revoke execute on function public.guard_check_password(text, text) from public, anon, authenticated;
grant execute on function public.guard_check_password(text, text) to service_role;

-- the one admin session the sign-in guard admitted. A session it did not
-- admit (a sign-in made straight against the Auth API, which would skip the
-- lockout, the password rules and the one-session rule, or a reset link
-- before the new password is set) gets no admin access. null: the account
-- has not been through the guard yet (the first sign-up of a deployment)
alter table public.profiles add column if not exists admin_session_id uuid;
-- every admin signs in once more, through the guard
update public.profiles set admin_session_id = gen_random_uuid()
  where role in ('company_admin', 'entity_admin') and admin_session_id is null;

-- only the system (the sign-in guard and the admin-users function, as the
-- service role) moves an account's sessions: an admin can't admit a second
-- session of their own
create or replace function public.guard_profile_sessions()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if auth.uid() is not null
     and (new.admin_session_id is distinct from old.admin_session_id
          or new.sessions_revoked_at is distinct from old.sessions_revoked_at) then
    raise exception 'Sign-in sessions are managed by the system.';
  end if;
  return new;
end
$$;
revoke execute on function public.guard_profile_sessions() from public, anon, authenticated;
create trigger profiles_guard_sessions before update on public.profiles
  for each row execute function public.guard_profile_sessions();

-- one active session: only the session the sign-in guard admitted has admin
-- access, and a session older than the account's sessions_revoked_at (a
-- deactivation or a password reset by another admin) loses it at once, as
-- an employee's already does
create or replace function public.is_company_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'company_admin' and is_active
      and (sessions_revoked_at is null
           or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from sessions_revoked_at)))
      and (admin_session_id is null or admin_session_id = nullif(auth.jwt()->>'session_id', '')::uuid)
  )
$$;

create or replace function public.can_manage_entity(p_entity uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_entity is not null and exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.is_active
      and (p.sessions_revoked_at is null
           or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from p.sessions_revoked_at)))
      and (p.admin_session_id is null or p.admin_session_id = nullif(auth.jwt()->>'session_id', '')::uuid)
      and (
        p.role = 'company_admin'
        or (p.role = 'entity_admin' and exists (
              select 1 from entity_admins ea
              join entities en on en.id = ea.entity_id
              where ea.profile_id = p.id and ea.entity_id = p_entity and en.is_active))
      )
  )
$$;

-- whether the caller's session is still the active one (the app signs out
-- a session replaced by a sign-in elsewhere)
create or replace function public.my_session_active()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
      select 1 from auth.sessions s
      where s.id = nullif(auth.jwt()->>'session_id', '')::uuid and s.user_id = auth.uid())
    and exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.is_active
        and (p.sessions_revoked_at is null
             or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from p.sessions_revoked_at)))
        and (p.admin_session_id is null or p.admin_session_id = nullif(auth.jwt()->>'session_id', '')::uuid))
$$;
revoke execute on function public.my_session_active() from public, anon;
grant execute on function public.my_session_active() to authenticated;


-- ---------- wording: a finalized payroll is voided and reissued, never reopened ----------

-- the same functions as before, only their messages changed

CREATE OR REPLACE FUNCTION public.protect_finalized_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' and old.status in ('finalized','paid') then
    raise exception 'A finalized payroll run is never deleted. Void it with a reason to correct and reissue it.';
  end if;
  return coalesce(new, old);
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_time_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp uuid;
begin
  for v_emp in
    select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.employee_id end,
                                        case when tg_op <> 'DELETE' then new.employee_id end]) x
    where x is not null order by x
  loop
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  end loop;

  if tg_op in ('UPDATE','DELETE') and public.attendance_locked(old.employee_id, old.work_date)
     and (tg_op = 'DELETE'
          or new.employee_id is distinct from old.employee_id
          or new.work_date is distinct from old.work_date
          or new.clock_in is distinct from old.clock_in
          or new.clock_out is distinct from old.clock_out) then
    raise exception 'Attendance on % was paid in a finalized payroll run and is locked. Void and reissue that run to change it.', old.work_date;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;

  if public.attendance_locked(new.employee_id, new.work_date)
     and (tg_op = 'INSERT'
          or new.employee_id is distinct from old.employee_id
          or new.work_date is distinct from old.work_date
          or new.clock_in is distinct from old.clock_in
          or new.clock_out is distinct from old.clock_out) then
    raise exception 'Attendance on % was paid in a finalized payroll run and is locked. Void and reissue that run to change it.', new.work_date;
  end if;

  -- an overnight shift may start after midnight (late arrival) but still
  -- belongs to the work date it was scheduled on
  if (new.clock_in at time zone 'Asia/Manila')::date not between new.work_date and new.work_date + 1 then
    raise exception 'Time in must fall on the work date (or just after midnight for an overnight shift).';
  end if;

  if exists (
    select 1 from time_entries t
    where t.employee_id = new.employee_id and t.id <> new.id
      and tstzrange(t.clock_in, coalesce(t.clock_out, t.clock_in + interval '1 minute'))
          && tstzrange(new.clock_in, coalesce(new.clock_out, new.clock_in + interval '1 minute'))
  ) then
    raise exception 'This entry overlaps another time entry of the same employee.';
  end if;

  new.status := case when new.clock_out is null then 'open' else 'closed' end;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_leave_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_type leave_types;
  v_from date;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A leave request cannot move to another employee.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || new.employee_id::text, 0));
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  select * into v_type from leave_types where id = new.leave_type_id and entity_id = new.entity_id;
  if v_type.id is null then
    raise exception 'Leave type does not belong to this employee''s company.';
  end if;
  if new.status in ('pending', 'approved') and v_type.min_service_months > 0
     and (tg_op = 'INSERT' or new.status is distinct from old.status
          or new.start_date is distinct from old.start_date
          or new.leave_type_id is distinct from old.leave_type_id) then
    select (hire_date + make_interval(months => v_type.min_service_months))::date into v_from
      from employees where id = new.employee_id;
    if new.start_date < v_from and not exists (
      select 1 from employee_leave_entitlements
       where employee_id = new.employee_id and leave_type_id = new.leave_type_id
         and year = extract(year from new.start_date)::int and days > 0
    ) then
      raise exception '% can be used after % months of service: from % for this employee. To grant it sooner, set the employee''s % leave credits.',
        v_type.name, v_type.min_service_months, to_char(v_from, 'FMMon FMDD, YYYY'),
        extract(year from new.start_date)::int;
    end if;
  end if;
  if (new.status = 'approved' or (tg_op = 'UPDATE' and old.status = 'approved'))
     and (tg_op = 'INSERT' or new.status is distinct from old.status
          or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date
          or new.leave_type_id is distinct from old.leave_type_id) then
    if exists (
      select 1 from generate_series(least(new.start_date, coalesce(old.start_date, new.start_date)),
                                    greatest(new.end_date, coalesce(old.end_date, new.end_date)),
                                    interval '1 day') d
      where public.attendance_locked(new.employee_id, d::date)
    ) then
      raise exception 'Part of this leave falls in a finalized payroll run. Void and reissue that run first, or settle the leave as an adjustment in the next payroll.';
    end if;
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_payroll_adjustment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run payroll_runs;
begin
  if tg_op = 'UPDATE' and (new.payroll_run_id is distinct from old.payroll_run_id
                           or new.employee_id is distinct from old.employee_id) then
    raise exception 'An adjustment cannot move to another run or employee.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' ||
    (case when tg_op = 'DELETE' then old.employee_id else new.employee_id end)::text, 0));
  select * into v_run from payroll_runs
    where id = case when tg_op = 'DELETE' then old.payroll_run_id else new.payroll_run_id end
    for no key update;
  -- (a run being deleted is already gone: its cascade passes through)
  if v_run.id is not null and v_run.status <> 'draft' then
    raise exception 'Adjustments of a finalized payroll run are locked. Void and reissue the run to change them.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if v_run.id is null then
    raise exception 'Payroll run not found.';
  end if;
  if not exists (select 1 from employees where id = new.employee_id and entity_id = v_run.entity_id) then
    raise exception 'Employee does not belong to this payroll run''s client.';
  end if;
  new.entity_id := v_run.entity_id;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_leave_request_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.status = 'approved' then
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || old.employee_id::text, 0));
    if exists (select 1 from generate_series(old.start_date, old.end_date, interval '1 day') d
               where public.attendance_locked(old.employee_id, d::date)) then
      raise exception 'Part of this leave falls in a finalized payroll run. Void and reissue that run first.';
    end if;
  end if;
  return old;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_employee_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp uuid := case when tg_op = 'DELETE' then old.employee_id else new.employee_id end;
  v_paid date;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A schedule cannot move to another employee.';
  end if;
  -- RLS checks a new row only after this trigger: refuse another client's
  -- employee before saying anything about their pay
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  -- same writer order as attendance and finalize: the employee's payroll lock first
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  v_paid := public.last_paid_date(v_emp);
  -- a note on a schedule already paid can still be corrected
  if tg_op = 'UPDATE' and new.effective_from = old.effective_from and new.pattern = old.pattern then
    v_paid := null;
  end if;
  if v_paid is not null then
    if tg_op in ('UPDATE','DELETE') and old.effective_from <= v_paid then
      raise exception 'This schedule covers days already paid (through %). Void and reissue that payroll to change it, or start a new schedule after %.', v_paid, v_paid;
    end if;
    if tg_op in ('INSERT','UPDATE') and new.effective_from <= v_paid then
      raise exception 'Pay through % is final: a schedule change can start on % at the earliest.', v_paid, v_paid + 1;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_schedule_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp uuid := case when tg_op = 'DELETE' then old.employee_id else new.employee_id end;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A roster entry cannot move to another employee.';
  end if;
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  if tg_op in ('UPDATE','DELETE') and public.attendance_locked(old.employee_id, old.work_date) then
    raise exception 'The schedule on % was paid in a finalized payroll run and is locked. Void and reissue that run to change it.', old.work_date;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if public.attendance_locked(new.employee_id, new.work_date) then
    raise exception 'The schedule on % was paid in a finalized payroll run and is locked. Void and reissue that run to change it.', new.work_date;
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_payroll_deduction_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run payroll_runs;
  v_ded recurring_deductions;
  v_emp uuid;
begin
  if tg_op = 'UPDATE' and (new.payroll_run_id is distinct from old.payroll_run_id
                           or new.deduction_id is distinct from old.deduction_id) then
    raise exception 'A payroll''s deduction amount cannot move to another run or deduction.';
  end if;
  if tg_op = 'DELETE' then
    -- the deduction itself is being deleted (a cascade: it is already gone)
    if not exists (select 1 from recurring_deductions where id = old.deduction_id) then
      return old;
    end if;
    v_emp := old.employee_id;
  else
    select * into v_ded from recurring_deductions where id = new.deduction_id;
    if v_ded.id is null then
      raise exception 'Deduction not found.';
    end if;
    v_emp := v_ded.employee_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  select * into v_run from payroll_runs
    where id = case when tg_op = 'DELETE' then old.payroll_run_id else new.payroll_run_id end
    for no key update;
  -- RLS checks a new row only after this trigger: another client's run or
  -- deduction is "not found" before anything about it is said
  if tg_op <> 'DELETE' and auth.uid() is not null
     and (v_run.id is null or not public.can_manage_entity(v_run.entity_id)) then
    raise exception 'Payroll run not found.';
  end if;
  -- (a run being deleted is already gone: its cascade passes through)
  if v_run.id is not null and v_run.status <> 'draft' then
    raise exception 'Deductions of a finalized payroll run are locked. Void and reissue the run to change them.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if v_run.id is null then
    raise exception 'Payroll run not found.';
  end if;
  if v_run.run_type = 'thirteenth_month' then
    raise exception 'A 13th month payroll makes no deductions.';
  end if;
  if not exists (select 1 from employees where id = v_emp and entity_id = v_run.entity_id) then
    raise exception 'Employee does not belong to this payroll run''s client.';
  end if;
  if v_ded.balance is not null and new.amount > v_ded.balance then
    raise exception 'This payroll can deduct at most % for "%" (what is left of it).', v_ded.balance, v_ded.label;
  end if;
  new.employee_id := v_emp;
  new.entity_id := v_run.entity_id;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_statutory_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- a deliberate correction of a published mistake (set in that migration)
  if coalesce(current_setting('statutory.correction', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  -- notes on a version (description, source, verification) stay editable
  if tg_op = 'UPDATE' and new.kind = old.kind and new.effective_from = old.effective_from and new.data = old.data then
    return new;
  end if;
  -- contribution tables follow the period, tax tables the pay date
  if exists (
    select 1 from payroll_runs r
    where r.status in ('finalized', 'paid') and greatest(r.period_end, r.pay_date) >= old.effective_from
  ) then
    raise exception 'Finalized payrolls may have used the % table effective %, so it is frozen. Ship a new version instead, or correct a published mistake deliberately (statutory.correction) and void and reissue the payrolls it affects.', old.kind, old.effective_from;
  end if;
  return coalesce(new, old);
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_employee_output()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp uuid;
  v_entity uuid;
  v_hire date;
  v_output_pay text;
  v_prefix text;
  v_pay_changes boolean := tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and (new.output_date, new.description, new.quantity, new.unit_rate, new.amount)
        is distinct from (old.output_date, old.description, old.quantity, old.unit_rate, old.amount));
begin
  -- finalize and void take the same per-employee locks first: an output
  -- saved while a payroll is finalized can't slip into the period it pays
  for v_emp in
    select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.employee_id end,
                                        case when tg_op <> 'DELETE' then new.employee_id end]) x
    where x is not null order by x
  loop
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  end loop;
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'An output cannot move to another employee.';
  end if;
  -- RLS checks a new row only after this trigger: refuse another client's
  -- employee before saying anything about their pay
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  -- a paid output keeps its pay (its report, approver and note can still be filed)
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or v_pay_changes)
     and public.attendance_locked(old.employee_id, old.output_date) then
    raise exception 'The output of % was paid in a finalized payroll and is locked. Void and reissue that payroll to change it.', old.output_date;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select entity_id, hire_date, output_pay into v_entity, v_hire, v_output_pay from employees where id = new.employee_id;
  if v_entity is null then
    raise exception 'Employee not found.';
  end if;
  new.entity_id := v_entity;
  if new.quantity is not null and new.unit_rate is not null then
    new.amount := round(new.quantity * new.unit_rate, 2);
    if new.amount <= 0 then
      raise exception 'The quantity times the rate comes to less than one centavo.';
    end if;
  end if;
  if v_pay_changes then
    if v_output_pay is null then
      raise exception 'Turn on output pay for this employee first (Pay & Policy).';
    end if;
    if new.output_date < v_hire then
      raise exception 'The output date is before the employee''s hire date (%).', v_hire;
    end if;
    if new.output_date > (now() at time zone 'Asia/Manila')::date then
      raise exception 'An output is recorded once accepted: its date can''t be in the future.';
    end if;
    if public.attendance_locked(new.employee_id, new.output_date) then
      raise exception 'A finalized payroll already paid % for this employee: date the output in a period not paid yet (the payroll covering the date pays it), or void and reissue that payroll.', new.output_date;
    end if;
  end if;
  v_prefix := new.entity_id::text || '/' || new.employee_id::text || '/';
  if new.report_path is not null and left(new.report_path, length(v_prefix)) <> v_prefix then
    raise exception 'The output report must be stored in the employee''s folder.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$function$;
