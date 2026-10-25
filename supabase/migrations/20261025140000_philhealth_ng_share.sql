-- Spec T6 (payroll tax rules spec, 2026-10-25): PhilHealth's NG share by
-- month.
--
-- The national government pays the employee share only in the months it
-- applies (PhilHealth Circulars 2026-0015 and 2026-0017, RA 11228): from a
-- start month, for a solo parent only in months a valid SPIC fully covers,
-- for a PWD only once PhilHealth's status is "confirmed". The date range of
-- 20261024225137_legal_accuracy becomes a start month, a solo parent's end
-- date becomes the SPIC expiry, and an existing PWD waiver is "confirmed"
-- (owner's decision 5), so today's results don't change. Five document
-- slots per employee (PMRF, the SPIC or PWD ID front and back, SPIS, Annex
-- A, Annex B) in a private bucket only the admins of the employee's client
-- can reach.

alter table public.employees
  add column philhealth_waiver_start_month date,
  add column philhealth_spic_expiry date,
  add column philhealth_pwd_status text
    constraint employees_philhealth_pwd_status_check check (philhealth_pwd_status in ('for_verification','confirmed'));

-- existing waivers: bookkeeping, not an admin's change (no audit entry)
alter table public.employees disable trigger user;
update public.employees set
  philhealth_waiver_start_month = date_trunc('month', philhealth_ee_waiver_from)::date,
  philhealth_spic_expiry = case when philhealth_ee_waiver = 'solo_parent' then philhealth_ee_waiver_until end,
  philhealth_pwd_status = case when philhealth_ee_waiver = 'pwd' then 'confirmed' end
  where philhealth_ee_waiver is not null;
alter table public.employees enable trigger user;

alter table public.employees
  drop column philhealth_ee_waiver_from,
  drop column philhealth_ee_waiver_until,
  add constraint employees_philhealth_waiver check (
    (philhealth_ee_waiver is null) = (philhealth_waiver_start_month is null)
    and (philhealth_waiver_start_month is null or extract(day from philhealth_waiver_start_month) = 1)
    and (philhealth_spic_expiry is null or philhealth_ee_waiver = 'solo_parent')
    and (philhealth_pwd_status is null) = (philhealth_ee_waiver is distinct from 'pwd'));

-- ---------- documents ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('employee-documents', 'employee-documents', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp']);

create table public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  slot text not null check (slot in ('pmrf','id_front','id_back','spis','annex_a','annex_b')),
  file_path text not null unique,
  file_name text not null check (length(trim(file_name)) between 1 and 200),
  uploaded_by uuid default auth.uid(),
  uploaded_at timestamptz not null default now(),
  -- the employee's own folder, the slot's subfolder
  constraint employee_documents_path check (file_path like employee_id::text || '/' || slot || '/%')
);
create index employee_documents_employee_idx on public.employee_documents (employee_id);
alter table public.employee_documents enable row level security;
create policy "employee documents: client admins" on public.employee_documents for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
revoke all on public.employee_documents from anon;
create trigger audit_employee_documents after insert or update or delete on public.employee_documents
  for each row execute function public.audit_trigger();

-- a storage path's first folder is the employee's id
create or replace function public.can_manage_employee_folder(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_employee uuid;
begin
  begin
    v_employee := split_part(p_name, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return can_manage_employee(v_employee);
end
$$;
revoke execute on function public.can_manage_employee_folder(text) from public, anon;
grant execute on function public.can_manage_employee_folder(text) to authenticated;

create policy "employee documents: client admins read" on storage.objects for select to authenticated
  using (bucket_id = 'employee-documents' and public.can_manage_employee_folder(name));
create policy "employee documents: client admins upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-documents' and public.can_manage_employee_folder(name));
create policy "employee documents: client admins delete" on storage.objects for delete to authenticated
  using (bucket_id = 'employee-documents' and public.can_manage_employee_folder(name));
