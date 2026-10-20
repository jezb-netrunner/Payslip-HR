-- 1604-C alphalist: the previous-employer section carries its own employment
-- status and reason of separation (BIR 1604-C alphalist format, RMC 73-2019),
-- next to the TIN and employment period already stored. Plus audit triggers
-- on the records that change pay or an employee's history but were not yet
-- logged. Additive only: new nullable columns and new triggers.

alter table public.employee_tax_years
  add column prev_employment_status text
    check (prev_employment_status in ('regular','probationary','casual','contractual','project_based','seasonal','apprentice')),
  add column prev_separation_reason text
    check (prev_separation_reason in ('resignation','termination','end_of_contract','retirement','death','transfer','other'));

-- who approved, revoked or filed a leave or a time correction, who changed
-- an announcement, a career event, previous-employer tax data, leave credits
-- or a leave type's pay flag
create trigger audit_leave_requests
  after insert or update or delete on public.leave_requests
  for each row execute function public.audit_trigger();
create trigger audit_time_correction_requests
  after insert or update or delete on public.time_correction_requests
  for each row execute function public.audit_trigger();
create trigger audit_announcements
  after insert or update or delete on public.announcements
  for each row execute function public.audit_trigger();
create trigger audit_career_events
  after insert or update or delete on public.career_events
  for each row execute function public.audit_trigger();
create trigger audit_employee_tax_years
  after insert or update or delete on public.employee_tax_years
  for each row execute function public.audit_trigger();
create trigger audit_employee_leave_entitlements
  after insert or update or delete on public.employee_leave_entitlements
  for each row execute function public.audit_trigger();
create trigger audit_leave_types
  after insert or update or delete on public.leave_types
  for each row execute function public.audit_trigger();
