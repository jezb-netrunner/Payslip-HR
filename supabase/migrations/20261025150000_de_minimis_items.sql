-- Spec T7 (payroll tax rules spec, 2026-10-25): de minimis ceilings per item
-- and cash conversion of leave.
--
-- One pay code per de minimis item of RR 29-2025 (items a and c–k): payroll
-- tracks what each item used in its ceiling's month, semester or year (the
-- ceilings are the de_minimis statutory table of T1) and moves the excess
-- to the ₱90k bucket (RMC 50-2018 A6). The item-less DE_MINIMIS code is
-- retired: rows that have it keep working, unchecked, until they are
-- changed to an item. Cash conversion of unused leave (item a) is paid by
-- the day: under the client's leave policy "vacation leave in place of
-- SIL" up to 12 days a year are de minimis, under "SIL only" it is SIL
-- conversion, taxable (Labor Code Art. 95). Whether these are in the SSS
-- base is the P2 setting (out by default).

alter table public.entities
  add column leave_policy text not null default 'sil_only'
    constraint entities_leave_policy_check check (leave_policy in ('vl_in_place_of_sil','sil_only'));

alter table public.pay_codes
  add column de_minimis_item text check (de_minimis_item in ('a','c','d','e','f','g','h','i','j','k')),
  add constraint pay_codes_de_minimis_item check (de_minimis_item is null or bir_bucket = 'de_minimis');
create unique index pay_codes_de_minimis_item_key on public.pay_codes (de_minimis_item) where de_minimis_item is not null;

update public.pay_codes set
  active = false,
  label = 'De minimis benefit (no item)',
  description = 'Retired: a de minimis benefit saved before the items. Its ceiling is not checked, change it to the item''s pay code.'
  where code = 'DE_MINIMIS';

insert into public.pay_codes
  (sort_order, code, label, for_allowances, for_one_time, bir_bucket, income_class, tax_treatment, sss_include, sss_include_pending,
   de_minimis_item, description) values
(125, 'LEAVE_CONVERSION', 'Cash conversion of unused leave', false, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'a',
  'Unused leave paid in cash, with the days converted. A client giving vacation leave in place of SIL: de minimis up to 12 days a year, the rest to the ₱90k bucket. A client giving SIL only: SIL conversion, taxable supplementary compensation.'),
(141, 'DM_MEDICAL_DEPENDENTS', 'Medical cash allowance to dependents (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'c',
  'De minimis item (c) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(142, 'DM_RICE', 'Rice subsidy (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'd',
  'De minimis item (d) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(143, 'DM_UNIFORM', 'Uniform and clothing allowance (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'e',
  'De minimis item (e) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(144, 'DM_MEDICAL_ASSISTANCE', 'Actual medical assistance (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'f',
  'De minimis item (f) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(145, 'DM_LAUNDRY', 'Laundry allowance (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'g',
  'De minimis item (g) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(146, 'DM_ACHIEVEMENT', 'Employee achievement award (de minimis)', false, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'h',
  'De minimis item (h) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(147, 'DM_GIFTS', 'Christmas or anniversary gift (de minimis)', false, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'i',
  'De minimis item (i) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(148, 'DM_MEAL', 'Meal allowance for overtime or night shift (de minimis)', true, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'j',
  'De minimis item (j) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.'),
(149, 'DM_CBA_PRODUCTIVITY', 'CBA or productivity incentive (de minimis)', false, true, 'de_minimis', 'supplementary', 'de_minimis', false, true, 'k',
  'De minimis item (k) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.');

alter table public.payroll_adjustments
  add column days numeric(6,2) constraint payroll_adjustments_days_check check (days > 0);

-- the T2 trigger, plus: a leave cash conversion has its days, nothing else has any
create or replace function public.sync_pay_code()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_code pay_codes;
  v_allowance boolean := tg_table_name = 'employee_allowances';
  v_derived boolean := false;
begin
  if not v_allowance then
    if new.kind = 'deduction' then
      if new.pay_code is not null then
        raise exception 'A deduction has no pay code.';
      end if;
      if new.days is not null then
        raise exception 'Only a leave cash conversion has days.';
      end if;
      return new;
    end if;
    if new.pay_code is null
       or (tg_op = 'UPDATE' and new.pay_code is not distinct from old.pay_code
           and (new.category is distinct from old.category or new.benefit is distinct from old.benefit)) then
      new.pay_code := default_pay_code(new.category, new.benefit, false);
      v_derived := true;
    end if;
  elsif new.pay_code is null
     or (tg_op = 'UPDATE' and new.pay_code is not distinct from old.pay_code and new.category is distinct from old.category) then
    new.pay_code := default_pay_code(new.category, null, true);
    v_derived := true;
  end if;
  if new.pay_code is null then
    return new; -- no code for that category: the table's checks refuse the row
  end if;

  select * into v_code from pay_codes where code = new.pay_code;
  if v_code.code is null then
    raise exception 'Unknown pay code %.', new.pay_code;
  end if;
  if v_allowance and not v_code.for_allowances then
    raise exception 'Pay code % is not for recurring allowances.', new.pay_code;
  end if;
  if not v_allowance and not v_code.for_one_time then
    raise exception 'Pay code % is not for one-time earnings.', new.pay_code;
  end if;
  if not v_code.active and (tg_op = 'INSERT' or new.pay_code is distinct from old.pay_code) then
    raise exception 'Pay code % is no longer in use.', new.pay_code;
  end if;
  -- leave cash conversion is paid by the day (12 de minimis days a year, spec T7)
  if not v_allowance then
    if v_code.de_minimis_item = 'a' and new.days is null then
      raise exception 'Enter the number of leave days converted.';
    end if;
    if v_code.de_minimis_item is distinct from 'a' and new.days is not null then
      raise exception 'Only a leave cash conversion has days.';
    end if;
  end if;
  if not v_derived then
    new.category := v_code.bir_bucket;
    if not v_allowance then
      new.benefit := v_code.benefit;
    end if;
  end if;
  return new;
end
$$;
