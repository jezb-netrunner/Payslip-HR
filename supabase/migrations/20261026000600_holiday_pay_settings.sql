-- C8 (compliance update 2026-10-25): holiday pay settings.
-- holiday_absence_rule: when on, no regular holiday pay after unpaid
-- absence on the workday before a holiday not worked (Omnibus Rules Book
-- III, Rule IV, Sec. 6 "may not be paid"). Off by default: the holiday is
-- paid (open item O8).
-- holiday_pay_exempt: a retail or service establishment regularly employing
-- less than 10 workers pays no holiday pay (Labor Code Art. 94(a), Omnibus
-- Rules Book III, Rule IV, Sec. 1). Only such a client can claim it.
alter table public.entities
  add column if not exists holiday_absence_rule boolean not null default false,
  add column if not exists retail_service_establishment boolean not null default false,
  add column if not exists regular_workers integer
    constraint entities_regular_workers_check check (regular_workers >= 0),
  add column if not exists holiday_pay_exempt boolean not null default false,
  add constraint entities_holiday_pay_exempt_small_retail check (
    not holiday_pay_exempt or (retail_service_establishment and regular_workers is not null and regular_workers < 10));
