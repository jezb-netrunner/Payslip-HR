-- Owner's answer to the spec T10 question (2026-10-25): the 2316 follows
-- BIR Form 2316 September 2021 (ENCS) (RMC 34-2022), item by item. It adds
-- the employee's RDO code (item 5), local home address and ZIP code (items
-- 6B and 6C) and foreign address (item 6D), and whether this employer is the
-- employee's main or a secondary employer for the year (item 15).

alter table public.employees
  add column rdo_code text not null default ''
    constraint employees_rdo_code_check check (rdo_code = '' or rdo_code ~ '^[0-9]{2,3}[A-Z]?$'),
  add column local_address text,
  add column local_zip_code text,
  add column foreign_address text;

alter table public.employee_tax_years
  add column employer_type text not null default 'main'
    constraint employee_tax_years_employer_type_check check (employer_type in ('main', 'secondary'));
