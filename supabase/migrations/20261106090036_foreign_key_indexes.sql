-- Indexes for the foreign keys the performance advisor listed as unindexed
-- (lint 0001): deleting or re-keying a parent row (an employee, a client, a
-- leave type, a time entry) scanned the whole child table to check or
-- cascade, and joins on these columns had no index. Each also serves a
-- filter the app uses where one exists (employee_tax_years by client and
-- year for the annualization, consultant declarations by client).

create index if not exists consultant_declarations_entity_idx on public.consultant_declarations (entity_id);
create index if not exists employee_leave_entitlements_leave_type_idx on public.employee_leave_entitlements (leave_type_id);
create index if not exists employee_tax_years_entity_year_idx on public.employee_tax_years (entity_id, year);
create index if not exists leave_requests_leave_type_idx on public.leave_requests (leave_type_id);
create index if not exists payroll_adjustments_employee_idx on public.payroll_adjustments (employee_id);
create index if not exists payroll_adjustments_entity_idx on public.payroll_adjustments (entity_id);
create index if not exists payroll_deduction_overrides_entity_idx on public.payroll_deduction_overrides (entity_id);
create index if not exists time_correction_requests_time_entry_idx on public.time_correction_requests (time_entry_id);
