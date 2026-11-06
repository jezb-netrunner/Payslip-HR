-- Test client "DEMO" (Demo Trading Corporation): fictitious data that
-- exercises every payroll and HR workflow. Attendance runs 1 Oct – 5 Nov
-- 2026 (weekly-paid from 28 Sep), so the October payrolls (semi-monthly and weekly) can be computed
-- and finalized end to end, and the 1–15 Nov period is in progress.
--
-- All names, TINs and government numbers are made up. Statutory figures are
-- not seeded here (they are global tables), and the client's minimum wage is the
-- verified NCR figure (MEMORY.md: WO NCR-28, P755 from 26 Sep 2026).
--
-- Run once as the database owner (SQL editor or MCP execute_sql). Employee
-- logins and client admins are NOT created here: issue them in the app
-- (employee Login tab, Admin Users), which is the only supported path.

begin;

-- ---------------------------------------------------------------- client
insert into public.entities (
  code, name, trade_name, tin, tin_branch_code, rdo_code, registered_address, zip_code,
  contact_number, contact_email, sss_employer_no, philhealth_employer_no, pagibig_employer_no,
  default_pay_frequency, minimum_wage_region, minimum_wage_daily, minimum_wage_reference,
  grace_period_minutes, net_pay_rounding, vat_registered, payslip_footer_note)
values (
  'DEMO', 'Demo Trading Corporation', 'Demo Mart (TEST CLIENT)', '000-123-456', '00000', '050',
  'Unit 5, 123 Sample Street, Brgy. San Antonio, Makati City', '1203',
  '(02) 8123 4567', 'hr@demo-trading.example', '03-9999999-9', '00-999999999-0', '2099-9999-9999',
  'semi_monthly', 'NCR', 755, 'Wage Order NCR-28, effective 26 Sep 2026 (non-agriculture)',
  5, 'none', true, 'TEST CLIENT - sample data only. This is a system-generated payslip.');

-- NCR-only special non-working days (Proclamation 1447), a client-local holiday
insert into public.holidays (entity_id, holiday_date, name, kind)
select e.id, d::date, 'NCR special non-working day (Proclamation 1447)', 'special_non_working'
from public.entities e, generate_series('2026-11-16'::date, '2026-11-18'::date, '1 day') d
where e.code = 'DEMO';

-- ------------------------------------------------------------- shifts
insert into public.shift_templates (entity_id, name, shift, sort_order)
select e.id, s.name, s.shift::jsonb, s.ord
from public.entities e, (values
  ('Office 8-5',     '{"start":"08:00","end":"17:00","break_minutes":60}', 1),
  ('Warehouse 8-5',  '{"start":"08:00","end":"17:00","break_minutes":60}', 2),
  ('Store 10-7',     '{"start":"10:00","end":"19:00","break_minutes":60}', 3),
  ('Night guard 10pm-6am', '{"start":"22:00","end":"06:00","break_minutes":60}', 4),
  ('Half day 8-12',  '{"start":"08:00","end":"12:00","break_minutes":0}', 5)
) s(name, shift, ord)
where e.code = 'DEMO';

-- ---------------------------------------------------------- employees
-- k = schedule kind used below: office (Mon-Fri), warehouse (Mon-Sat),
-- store (Tue-Sun), night (Mon-Sat, 22:00-06:00)
create temp table _demo_emp (
  no text, first text, middle text, last text, birth date, gender text, civil text,
  hire date, regular date, status text, pos text, dept text,
  pay_type text, rate numeric, freq text, mwe boolean, dpy numeric, method text,
  fixed boolean, output text, k text, sep date, sep_reason text,
  tin text, sss text, ph text, hdmf text
) on commit drop;

insert into _demo_emp values
 ('DEMO-0001','Maria','Lopez','Santos','1985-04-12','Female','Married','2021-03-01','2021-09-01','regular','HR & Admin Manager','Administration','monthly',45000,'semi_monthly',false,null,'bank_transfer',false,null,'office',null,null,'901-111-001','34-9000001-1','09-900000001-1','9900-0000-0001'),
 ('DEMO-0002','Jose','Ramos','Reyes','1990-08-23','Male','Married','2023-06-15','2023-12-15','regular','Accountant','Finance','monthly',30000,'semi_monthly',false,null,'bank_transfer',false,null,'office',null,null,'901-111-002','34-9000002-2','09-900000002-2','9900-0000-0002'),
 ('DEMO-0003','Ana','Villar','Cruz','1993-01-30','Female','Single','2022-02-01','2022-08-01','regular','Sales Supervisor','Sales','monthly',28000,'semi_monthly',false,null,'e_wallet',false,'commission','office',null,null,'901-111-003','34-9000003-3','09-900000003-3','9900-0000-0003'),
 ('DEMO-0004','Pedro','Dela Paz','Garcia','1988-11-05','Male','Married','2022-05-16','2022-11-16','regular','Warehouse Staff','Operations','daily',755,'semi_monthly',true,313,'cash',false,null,'warehouse',null,null,'901-111-004','34-9000004-4','09-900000004-4','9900-0000-0004'),
 ('DEMO-0005','Liza','Manalo','Mendoza','2000-06-18','Female','Single','2026-07-01',null,'probationary','Cashier','Store','daily',800,'weekly',false,313,'cash',false,null,'store',null,null,'901-111-005','34-9000005-5','09-900000005-5','9900-0000-0005'),
 ('DEMO-0006','Ramon','Castro','Villanueva','1979-03-09','Male','Married','2020-01-06','2020-07-06','regular','Security Guard','Operations','daily',755,'weekly',true,313,'cash',false,null,'night',null,null,'901-111-006','34-9000006-6','09-900000006-6','9900-0000-0006'),
 ('DEMO-0007','Carmela','Ortiz','Bautista','1991-12-01','Female','Single','2024-01-08','2024-07-08','regular','Executive Assistant','Administration','monthly',38000,'semi_monthly',false,null,'bank_transfer',true,null,'office',null,null,'901-111-007','34-9000007-7','09-900000007-7','9900-0000-0007'),
 ('DEMO-0008','Daniel','Navarro','Flores','1997-09-14','Male','Single','2025-03-03','2025-09-03','regular','Production Worker (piece rate)','Operations','daily',0,'semi_monthly',false,313,'cash',false,'basic','warehouse',null,null,'901-111-008','34-9000008-8','09-900000008-8','9900-0000-0008'),
 ('DEMO-0009','Grace','Salazar','Torres','1995-05-27','Female','Single','2023-09-01','2024-03-01','regular','Marketing Associate','Sales','monthly',25000,'semi_monthly',false,null,'bank_transfer',false,null,'office','2026-10-31','resignation','901-111-009','34-9000009-9','09-900000009-9','9900-0000-0009'),
 ('DEMO-0010','Mark','Tan','Aquino','1998-02-11','Male','Single','2026-10-12',null,'probationary','IT Support Specialist','Administration','monthly',30000,'semi_monthly',false,null,'bank_transfer',false,null,'office',null,null,'901-111-010','34-9000010-0','09-900000010-0','9900-0000-0010');

create temp table _demo_kind (k text, days int[], start_t time, end_t time, brk int) on commit drop;
insert into _demo_kind values
  ('office',    '{1,2,3,4,5}',   '08:00', '17:00', 60),
  ('warehouse', '{1,2,3,4,5,6}', '08:00', '17:00', 60),
  ('store',     '{2,3,4,5,6,7}', '10:00', '19:00', 60),
  ('night',     '{1,2,3,4,5,6}', '22:00', '06:00', 60);

insert into public.employees (
  entity_id, employee_no, first_name, middle_name, last_name, birth_date, gender, civil_status,
  email, phone, address, tin, sss_no, philhealth_no, pagibig_no,
  hire_date, regularization_date, employment_status, position, department,
  pay_type, monthly_rate, daily_rate, is_minimum_wage_earner, days_per_year,
  pay_frequency, payment_method, bank_name, bank_account_no, fixed_salary, output_pay,
  work_schedule, separation_date, separation_reason, separation_remarks,
  emergency_contact_name, emergency_contact_phone, nationality, zip_code)
select ent.id, d.no, d.first, d.middle, d.last, d.birth, d.gender, d.civil,
  lower(d.first || '.' || replace(d.last, ' ', '')) || '@demo-trading.example',
  '0917' || lpad(right(d.no, 3), 7, '5'),
  'Sample address, Makati City', d.tin, d.sss, d.ph, d.hdmf,
  d.hire, d.regular, d.status, d.pos, d.dept,
  d.pay_type, case when d.pay_type = 'monthly' then d.rate else 0 end,
  case when d.pay_type = 'daily' then d.rate else 0 end, d.mwe, d.dpy,
  d.freq, d.method,
  case when d.method = 'bank_transfer' then 'Sample Bank' end,
  case when d.method = 'bank_transfer' then '0000-' || right(d.no, 4) || '-99' end,
  d.fixed, d.output,
  jsonb_build_object('start', to_char(k.start_t, 'HH24:MI'), 'end', to_char(k.end_t, 'HH24:MI'),
                     'days', to_jsonb(k.days), 'break_minutes', k.brk),
  d.sep, d.sep_reason, case when d.sep is not null then 'Resigned to pursue further studies (test data)' end,
  'Emergency contact of ' || d.first, '0918' || lpad(right(d.no, 3), 7, '4'), 'Filipino', '1203'
from _demo_emp d
join _demo_kind k on k.k = d.k
cross join (select id from public.entities where code = 'DEMO') ent;

-- hire events (the app writes one per new employee, and the hire rate row is
-- written by the employees_seed_pay_rate trigger)
insert into public.career_events (employee_id, event_type, effective_date, position, department, details)
select e.id, 'hired', e.hire_date, e.position, e.department, 'Start of employment'
from public.employees e join public.entities ent on ent.id = e.entity_id and ent.code = 'DEMO';

insert into public.career_events (employee_id, event_type, effective_date, position, department, details)
select e.id, 'regularized', e.regularization_date, e.position, e.department, 'Passed probation'
from public.employees e join public.entities ent on ent.id = e.entity_id and ent.code = 'DEMO'
where e.regularization_date is not null;

-- Grace resigned effective 31 Oct (final pay to be run)
insert into public.career_events (employee_id, event_type, effective_date, details)
select e.id, 'separated', '2026-10-31', 'Resignation — Resigned to pursue further studies (test data)'
from public.employees e where e.employee_no = 'DEMO-0009';

-- Jose: merit increase 30,000 -> 32,000 from 21 Oct (mid-period rate change)
with ev as (
  insert into public.career_events (employee_id, event_type, effective_date, position, department, monthly_rate, details)
  select id, 'salary_adjustment', '2026-10-21', position, department, 32000, 'Merit increase after performance review'
  from public.employees where employee_no = 'DEMO-0002'
  returning id, employee_id)
insert into public.employee_pay_rates (employee_id, entity_id, effective_from, pay_type, rate, reason, approved_by, note, career_event_id)
select ev.employee_id, e.entity_id, '2026-10-21', 'monthly', 32000, 'merit_increase', 'Maria Santos, HR & Admin Manager',
       'Merit increase after performance review', ev.id
from ev join public.employees e on e.id = ev.employee_id;

-- ---------------------------------------------------------- schedules
insert into public.employee_schedules (employee_id, entity_id, effective_from, pattern, note)
select e.id, e.entity_id, greatest(e.hire_date, '2026-01-01'::date),
  (select jsonb_agg(case when wd = any(k.days)
            then jsonb_build_object('start', to_char(k.start_t, 'HH24:MI'), 'end', to_char(k.end_t, 'HH24:MI'), 'break_minutes', k.brk)
            else 'null'::jsonb end order by wd)
     from generate_series(1, 7) wd),
  'Regular schedule'
from public.employees e
join _demo_emp d on d.no = e.employee_no
join _demo_kind k on k.k = d.k;

-- Maria: Saturday inventory count, half day (a roster change)
insert into public.schedule_overrides (employee_id, entity_id, work_date, shift, note)
select id, entity_id, '2026-10-24', '{"start":"08:00","end":"12:00","break_minutes":0}'::jsonb, 'Quarterly inventory count'
from public.employees where employee_no = 'DEMO-0001';

-- ------------------------------------------------- leave entitlements
insert into public.employee_leave_entitlements (employee_id, leave_type_id, year, days)
select e.id, lt.id, 2026, case lt.code when 'VL' then 10 when 'SL' then 10 end
from public.employees e
join public.leave_types lt on lt.entity_id = e.entity_id and lt.code in ('VL', 'SL')
where e.employee_no in ('DEMO-0001','DEMO-0002','DEMO-0003','DEMO-0004','DEMO-0006','DEMO-0007','DEMO-0008','DEMO-0009');

-- ------------------------------------------------------ leave requests
-- approved (owner as reviewer) and pending ones
insert into public.leave_requests (employee_id, entity_id, leave_type_id, start_date, end_date, days, reason, status, reviewed_by, reviewed_at, review_notes)
select e.id, e.entity_id, lt.id, r.s::date, r.f::date, r.days, r.reason, r.status,
       case when r.status <> 'pending' then (select id from public.profiles where role = 'company_admin' order by created_at limit 1) end,
       case when r.status <> 'pending' then r.s::date - 3 + time '09:00' end,
       case when r.status <> 'pending' then 'Approved' end
from (values
  ('DEMO-0002','VL','2026-10-08','2026-10-09',2,'Family trip to Batangas','approved'),
  ('DEMO-0001','SL','2026-10-27','2026-10-27',1,'Fever, with medical certificate','approved'),
  ('DEMO-0004','VL','2026-10-19','2026-10-19',1,'Personal errand','approved'),
  ('DEMO-0003','VL','2026-11-12','2026-11-13',2,'Out-of-town wedding','pending'),
  ('DEMO-0005','LWOP','2026-11-10','2026-11-10',1,'Enrollment at school','pending')
) r(no, code, s, f, days, reason, status)
join public.employees e on e.employee_no = r.no
join public.leave_types lt on lt.entity_id = e.entity_id and lt.code = r.code;

-- -------------------------------------------------------- attendance
-- One closed entry per scheduled day from 1 Oct (weekly-paid: 28 Sep, the
-- first week ending in October) to 5 Nov 2026, with
-- deterministic lates, overtime, undertime and absences. Skips approved
-- leave, days before hire / after separation, and the 2 Nov special day for
-- office staff. Extra rest-day and holiday work is added after.
create temp table _demo_days on commit drop as
select e.id as employee_id, e.entity_id, e.employee_no, dt::date as work_date, k.start_t, k.end_t, k.k,
       abs(hashtext(e.employee_no || dt::date::text)) % 100 as h
from public.employees e
join _demo_emp d on d.no = e.employee_no
join _demo_kind k on k.k = d.k
cross join generate_series('2026-09-28'::date, '2026-11-05'::date, '1 day') dt
where extract(isodow from dt)::int = any(k.days)
  and dt::date >= greatest(e.hire_date, case when e.pay_frequency = 'weekly' then '2026-09-28'::date else '2026-10-01'::date end)
  and (e.separation_date is null or dt::date <= e.separation_date)
  and not (k.k = 'night' and dt::date > '2026-11-04')
  and not (k.k = 'office' and dt::date = '2026-11-02')
  and not (e.employee_no = 'DEMO-0008' and dt::date = '2026-11-02')
  and not exists (select 1 from public.leave_requests l
                   where l.employee_id = e.id and l.status = 'approved'
                     and dt::date between l.start_date and l.end_date);

insert into public.time_entries (employee_id, entity_id, work_date, clock_in, clock_out, source, status, admin_notes)
select employee_id, entity_id, work_date,
  (work_date + start_t + make_interval(mins =>
     case when h < 12 then 6 + h * 2          -- late (beyond the 5-minute grace)
          else -(h % 10) end))                 -- on time / a few minutes early
    at time zone 'Asia/Manila',
  (work_date + case when end_t <= start_t then 1 else 0 end + end_t + make_interval(mins =>
     case when h between 80 and 91 then 120 + (h % 3) * 30   -- overtime 2-3 h
          when h between 92 and 95 then -90                  -- undertime
          else h % 7 end))
    at time zone 'Asia/Manila',
  'admin', 'closed',
  case when h between 80 and 91 then 'Overtime approved by supervisor' end
from _demo_days
where h < 97;   -- h 97-99: absent

-- Ramon works his Sunday rest day (25 Oct), and Maria her half-day Saturday
-- override (24 Oct). Pedro and Ramon work the 2 Nov special day and Liza
-- All Saints' Day (1 Nov), all on their regular schedules.
insert into public.time_entries (employee_id, entity_id, work_date, clock_in, clock_out, source, status, admin_notes)
select e.id, e.entity_id, x.d::date,
       (x.d::date + x.i::time) at time zone 'Asia/Manila',
       (x.d::date + x.plus + x.o::time) at time zone 'Asia/Manila', 'admin', 'closed', x.note
from (values
  ('DEMO-0006', '2026-10-25', '22:00', '06:00', 1, 'Rest-day duty: reliever absent'),
  ('DEMO-0001', '2026-10-24', '07:58', '12:03', 0, 'Inventory count')
) x(no, d, i, o, plus, note)
join public.employees e on e.employee_no = x.no
where not exists (select 1 from public.time_entries t where t.employee_id = e.id and t.work_date = x.d::date);

-- Liza forgot to time out on 20 Oct: open entry, with her correction request
update public.time_entries t set clock_out = null, status = 'open', admin_notes = 'No time-out recorded'
from public.employees e
where e.id = t.employee_id and e.employee_no = 'DEMO-0005' and t.work_date = '2026-10-20';

insert into public.time_correction_requests (employee_id, entity_id, time_entry_id, work_date, requested_clock_in, requested_clock_out, reason)
select t.employee_id, t.entity_id, t.id, t.work_date, t.clock_in,
       ('2026-10-20'::date + time '19:05') at time zone 'Asia/Manila',
       'Forgot to time out, left after closing the register at 7:05 PM.'
from public.time_entries t join public.employees e on e.id = t.employee_id
where e.employee_no = 'DEMO-0005' and t.work_date = '2026-10-20';

-- ------------------------------------------------- outputs (piece rate, commission)
insert into public.employee_outputs (employee_id, entity_id, output_date, description, quantity, unit_rate, amount, accepted_by, note)
select t.employee_id, t.entity_id, t.work_date, 'Assembled storage boxes',
       110 + (abs(hashtext(t.work_date::text)) % 31), 6.50,
       round((110 + (abs(hashtext(t.work_date::text)) % 31)) * 6.50, 2),
       'Line supervisor', ''
from public.time_entries t join public.employees e on e.id = t.employee_id
where e.employee_no = 'DEMO-0008';

insert into public.employee_outputs (employee_id, entity_id, output_date, description, amount, accepted_by, note)
select e.id, e.entity_id, x.d::date, x.descr, x.amt, 'Maria Santos', 'Per sales commission policy (test data)'
from (values
  ('2026-10-15', 'Sales commission, 1-15 Oct', 3250.00),
  ('2026-10-31', 'Sales commission, 16-31 Oct', 4180.50)
) x(d, descr, amt)
join public.employees e on e.employee_no = 'DEMO-0003';

-- --------------------------------------------------------- allowances
insert into public.employee_allowances (employee_id, label, amount, category, basis, de_minimis_kind)
select e.id, a.label, a.amount, a.category, a.basis, a.dm
from (values
  ('DEMO-0001', 'Rice subsidy', 2000, 'de_minimis', 'monthly', 'rice'),
  ('DEMO-0001', 'Transportation allowance', 2500, 'transportation', 'monthly', null),
  ('DEMO-0002', 'Rice subsidy', 2000, 'de_minimis', 'monthly', 'rice'),
  ('DEMO-0003', 'Communication allowance', 1000, 'other_taxable', 'monthly', null),
  ('DEMO-0004', 'Rice subsidy', 1500, 'de_minimis', 'monthly', 'rice'),
  ('DEMO-0004', 'Meal allowance', 60, 'other_taxable', 'per_day', null),
  ('DEMO-0006', 'Laundry allowance', 300, 'de_minimis', 'monthly', 'laundry'),
  ('DEMO-0007', 'Rice subsidy', 2000, 'de_minimis', 'monthly', 'rice')
) a(no, label, amount, category, basis, dm)
join public.employees e on e.employee_no = a.no;

-- ------------------------------------------------- loans and deductions
insert into public.recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, start_date, authorized_on, notes)
select e.id, x.label, x.cat, x.per, x.total, x.bal, x.s::date, x.auth::date, x.notes
from (values
  ('DEMO-0001', 'SSS salary loan', 'sss_loan', 1050, 25200, 18900, '2026-01-01', '2025-12-15', 'SSS loan no. 9999-TEST'),
  ('DEMO-0004', 'Pag-IBIG multi-purpose loan', 'pagibig_loan', 600, 14400, 9000, '2026-03-01', '2026-02-20', 'MPL no. TEST-0004'),
  ('DEMO-0002', 'HMO dependent premium', 'hmo', 450, null, null, '2026-01-01', '2025-12-20', 'Spouse coverage')
) x(no, label, cat, per, total, bal, s, auth, notes)
join public.employees e on e.employee_no = x.no;

-- an approved cash advance being repaid (Ramon), and a pending request (Pedro)
insert into public.recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, start_date, released_on, release_method, authorized_on, notes)
select e.id, 'Cash advance', 'cash_advance', 1000, 4000, 4000, '2026-10-01', '2026-09-30', 'cash', '2026-09-29', 'Emergency advance, 4 weekly installments'
from public.employees e where e.employee_no = 'DEMO-0006';

insert into public.advance_requests (entity_id, employee_id, amount, per_payroll, reason)
select entity_id, id, 3000, 500, 'School supplies for my children'
from public.employees where employee_no = 'DEMO-0004';

-- ------------------------------------------------------ previous employer
-- Mark joined on 12 Oct, Jan-Sep 2026 at a previous employer (BIR 2316)
insert into public.employee_tax_years (employee_id, entity_id, year, has_previous_employer, prev_employer_tin, prev_employer_name,
  prev_employer_address, prev_employer_zip, prev_employment_from, prev_employment_to, prev_employment_status, prev_separation_reason,
  prev_contributions, prev_13th_other_benefits_exempt, prev_taxable_basic, prev_tax_withheld, notes)
select id, entity_id, 2026, true, '000-987-654', 'Sample Previous Employer Inc.', 'Pasig City', '1600',
       '2026-01-05', '2026-09-30', 'regular', 'resignation', 13500, 21000, 228000, 6450, 'From the 2316 given by the previous employer (test data)'
from public.employees where employee_no = 'DEMO-0010';

-- ---------------------------------------------------------- consultant
insert into public.consultants (entity_id, payee_type, last_name, first_name, middle_name, tin, address, zip_code, vat_registered,
  service, fee_kind, fee_basis, fee_amount, billing, contract_ref, contract_start, contract_end, checklist, signed_off_by, signed_off_at, notes)
select id, 'individual', 'Rivera', 'Paolo', 'Lim', '000-555-777', 'Quezon City', '1100', false,
       'Graphic design and social media content', 'consultancy', 'retainer', 20000, 'monthly',
       'Service agreement DEMO-SA-2026-01', '2026-01-15', '2026-12-31',
       '{"control":true,"results":true,"tools":true,"others":true,"no_rules":true,"registered":true,"term":true}'::jsonb,
       'Maria Santos', '2026-01-10 10:00+08', 'Freelance designer (test data)'
from public.entities where code = 'DEMO';

-- ------------------------------------------------------- announcement
insert into public.announcements (entity_id, title, body, pinned)
select id, 'Welcome to the test client',
       'This client holds sample data for trying every workflow: payroll runs, time in/out, leave and correction requests, cash advances, reports. Nothing here is real.',
       true
from public.entities where code = 'DEMO';

commit;
