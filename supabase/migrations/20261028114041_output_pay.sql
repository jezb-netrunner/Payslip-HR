-- Output-based pay: admins record the outputs an employee delivered (units
-- × a rate, or a fixed amount for a deliverable or milestone), each with its
-- output report, and the payroll whose period holds the output's date pays
-- it. Per employee, output pay is either the basic pay (paid by results:
-- piece rate, or per deliverable without a salary) or pay on top of the
-- salary, classified for the BIR as fees, commission or other supplementary
-- pay. Whether pay on top of the salary counts toward the 13th month is the
-- client's policy (on by default). Admins only, like the pay history.
alter table public.employees
  add column if not exists output_pay text
    constraint employees_output_pay_check check (output_pay in ('basic', 'fees', 'commission', 'other_supplementary')),
  add column if not exists output_thirteenth_month boolean not null default true,
  -- the 13th month policy applies to pay on top of the salary only: a
  -- worker paid by results earns the 13th month on all of it
  add constraint employees_output_thirteenth_policy check (output_thirteenth_month or coalesce(output_pay, '') in ('fees', 'commission', 'other_supplementary'));

create table public.employee_outputs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  -- the date the output was accepted: the payroll covering it pays it
  output_date date not null,
  description text not null constraint employee_outputs_description_check check (length(btrim(description)) between 1 and 200),
  -- units × a rate (the amount follows), or neither for a fixed amount
  quantity numeric(12,2) constraint employee_outputs_quantity_check check (quantity > 0),
  unit_rate numeric(14,4) constraint employee_outputs_unit_rate_check check (unit_rate > 0),
  amount numeric(14,2) not null constraint employee_outputs_amount_check check (amount > 0),
  accepted_by text not null default '' constraint employee_outputs_accepted_by_check check (length(accepted_by) <= 120),
  note text not null default '' constraint employee_outputs_note_check check (length(note) <= 500),
  -- the output report in the output-reports bucket: <client>/<employee>/<file>
  report_path text constraint employee_outputs_report_path_check check (length(report_path) <= 400),
  report_name text constraint employee_outputs_report_name_check check (length(report_name) <= 200),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_outputs_units check ((quantity is null) = (unit_rate is null)),
  constraint employee_outputs_report check ((report_path is null) = (report_name is null))
);
create index employee_outputs_employee_idx on public.employee_outputs (employee_id, output_date);
create index employee_outputs_entity_idx on public.employee_outputs (entity_id, output_date);
create trigger employee_outputs_updated_at before update on public.employee_outputs
  for each row execute function public.set_updated_at();

create or replace function public.guard_employee_output()
returns trigger
language plpgsql security definer set search_path = public
as $$
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
  -- finalize and reopen take the same per-employee locks first: an output
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
    raise exception 'The output of % was paid in a finalized payroll and is locked. Reopen that payroll to change it.', old.output_date;
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
      raise exception 'A finalized payroll already paid % for this employee: date the output in a period not paid yet (the payroll covering the date pays it), or reopen that payroll.', new.output_date;
    end if;
  end if;
  v_prefix := new.entity_id::text || '/' || new.employee_id::text || '/';
  if new.report_path is not null and left(new.report_path, length(v_prefix)) <> v_prefix then
    raise exception 'The output report must be stored in the employee''s folder.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger employee_outputs_guard before insert or update or delete on public.employee_outputs
  for each row execute function public.guard_employee_output();

alter table public.employee_outputs enable row level security;
create policy "employee_outputs: admins manage" on public.employee_outputs
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
revoke all on public.employee_outputs from anon;

create trigger employee_outputs_stale after insert or update or delete on public.employee_outputs
  for each row execute function public.stale_drafts_on_change();
create trigger audit_employee_outputs after insert or update or delete on public.employee_outputs
  for each row execute function public.audit_trigger();

-- output pay stays on while an output waits for its payroll
create or replace function public.guard_employee_output_pay()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_n int;
begin
  if old.output_pay is not null and new.output_pay is null then
    select count(*) into v_n from employee_outputs o
      where o.employee_id = new.id and not public.attendance_locked(o.employee_id, o.output_date);
    if v_n > 0 then
      raise exception '% output(s) of this employee are not paid yet: remove them first, or keep output pay on.', v_n;
    end if;
  end if;
  return new;
end
$$;
create trigger employees_output_pay_off before update of output_pay on public.employees
  for each row execute function public.guard_employee_output_pay();

-- ---------- output reports ----------
-- Private: PDFs, images, Word, Excel and CSV files (a CSV can come as
-- Excel's type) up to 10 MB, at
-- <client id>/<employee id>/<file>. The admins who manage that client's
-- employee may store, read and remove them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('output-reports', 'output-reports', false, 10485760, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel', 'text/csv'])
on conflict (id) do nothing;

create or replace function public.can_manage_output_report(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_parts text[] := storage.foldername(p_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(array_length(v_parts, 1), 0) < 2 or v_parts[1] !~ v_uuid or v_parts[2] !~ v_uuid then
    return false;
  end if;
  return exists (select 1 from employees e where e.id = v_parts[2]::uuid and e.entity_id = v_parts[1]::uuid)
    and public.can_manage_employee(v_parts[2]::uuid);
end
$$;

create policy "output reports: admins read" on storage.objects for select to authenticated
  using (bucket_id = 'output-reports' and public.can_manage_output_report(name));
create policy "output reports: admins upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'output-reports' and public.can_manage_output_report(name));
create policy "output reports: admins remove" on storage.objects for delete to authenticated
  using (bucket_id = 'output-reports' and public.can_manage_output_report(name));

revoke execute on function public.guard_employee_output() from public, anon, authenticated;
revoke execute on function public.guard_employee_output_pay() from public, anon, authenticated;
revoke execute on function public.can_manage_output_report(text) from public, anon;
grant execute on function public.can_manage_output_report(text) to authenticated;
