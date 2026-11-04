-- Tests for 20261023102637_cash_advances.sql (+ the hardening migration after it): requests, approval, the
-- balance guard, repayments, and payroll finalize/reopen moving the balance.
-- Invariant checked throughout: released = deducted by finalized payrolls
-- + repaid outside payroll + balance.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set za    '''00000000-0000-0000-0000-0000000000f9'''
\set xa    '''00000000-0000-0000-0000-0000000000f8'''
\set uz1   '''00000000-0000-0000-0000-0000000000f1'''
\set uz2   '''00000000-0000-0000-0000-0000000000f2'''

create or replace function pg_temp.expect_error(p_sql text, p_like text default '%') returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected error like % but got: %', p_like, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected an error but statement succeeded: %', p_sql;
end $$;
grant execute on function pg_temp.expect_error(text, text) to authenticated, anon, service_role;

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;

create or replace function pg_temp.computed(p_run uuid) returns void
language sql as $$
  update payslips p set employee_payroll_seq = e.payroll_seq
    from employees e where e.id = p.employee_id and p.payroll_run_id = p_run;
  -- lines that add up to each payslip's figures and run totals that add up
  -- to its payslips, as computeRun writes them (finalize cross-checks both)
  update payslips p set
      earnings = coalesce(p.earnings, '[]'::jsonb) || case when x.e = p.gross_pay then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('code', 'basic', 'label', 'Basic Pay', 'amount', p.gross_pay - x.e)) end,
      deductions = coalesce(p.deductions, '[]'::jsonb) || case when x.d = p.total_deductions then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('code', 'other', 'label', 'Other deductions', 'amount', p.total_deductions - x.d)) end
    from (select q.id,
            coalesce((select sum((l->>'amount')::numeric) from jsonb_array_elements(coalesce(q.earnings, '[]'::jsonb)) l), 0) as e,
            coalesce((select sum((l->>'amount')::numeric) from jsonb_array_elements(coalesce(q.deductions, '[]'::jsonb)) l), 0) as d
          from payslips q where q.payroll_run_id = p_run) x
    where p.id = x.id;
  update payroll_runs r
    set totals = (select jsonb_build_object('employees', count(*), 'gross', coalesce(sum(gross_pay), 0),
                    'net', coalesce(sum(net_pay), 0), 'withholding_tax', coalesce(sum(withholding_tax), 0))
                  from payslips where payroll_run_id = p_run)
    where r.id = p_run;
$$;
grant execute on function pg_temp.computed(uuid) to authenticated;

-- released = finalized payroll deductions + repayments + balance
create or replace function pg_temp.ledger_ok(p_adv uuid) returns boolean
language sql as $$
  select d.total_amount =
         coalesce((select sum((l->>'amount')::numeric)
                   from payslips p join payroll_runs r on r.id = p.payroll_run_id, jsonb_array_elements(p.deductions) l
                   where r.status in ('finalized','paid') and l->>'meta' = p_adv::text), 0)
       + coalesce((select sum(amount) from advance_repayments where advance_id = p_adv), 0)
       + d.balance
  from recurring_deductions d where d.id = p_adv
$$;
grant execute on function pg_temp.ledger_ok(uuid) to authenticated;

-- fixture: client ZETA with its admin and two employees (one separated), client XI with its admin
insert into auth.users (id, email, raw_app_meta_data) values
  (:za, 'za@zeta.test', '{"role":"entity_admin"}'),
  (:xa, 'xa@xi.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000000f0', 'ZETA', 'Zeta Bakery', 755),
  ('10000000-0000-0000-0000-0000000000f1', 'XI', 'Xi Hardware', 755);
insert into entity_admins (profile_id, entity_id) values
  (:za, '10000000-0000-0000-0000-0000000000f0'),
  (:xa, '10000000-0000-0000-0000-0000000000f1');
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency, is_minimum_wage_earner, separation_date, separation_reason)
values ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000f0', 'Z-001', 'Zeny', 'Uno', '2025-01-06', 'daily', 755, 'weekly', true, null, null),
       ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000f0', 'Z-002', 'Zandro', 'Dos', '2025-01-06', 'daily', 755, 'weekly', true, '2026-06-30', 'resignation'),
       ('20000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000f0', 'Z-003', 'Zita', 'Tres', '2025-01-06', 'daily', 755, 'weekly', true, null, null);
insert into auth.users (id, email, raw_app_meta_data) values
  (:uz1, 'emp-z1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000a1"}'),
  (:uz2, 'emp-z2@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000a2"}');

\echo '--- 13.1 employees file their own pending requests and may only cancel them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uz1, true);
insert into advance_requests (id, employee_id, amount, per_payroll, reason)
values ('6000000f-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', 3000, 500, 'School fees');
select pg_temp.check((select entity_id from advance_requests where id = '6000000f-0000-0000-0000-000000000001') = '10000000-0000-0000-0000-0000000000f0', 'client taken from the employee');
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll, status) values ('20000000-0000-0000-0000-0000000000a1', 1000, 500, 'approved')$$, '%Approve a request from Cash Advances%');
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll, status) values ('20000000-0000-0000-0000-0000000000a1', 1000, 500, 'rejected')$$, '%row-level security%');
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll) values ('20000000-0000-0000-0000-0000000000a3', 1000, 500)$$, '%row-level security%');
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll) values ('20000000-0000-0000-0000-0000000000a1', 1000, 1500)$$, '%advance_requests_installment_check%');
select pg_temp.expect_error($$update advance_requests set amount = 5000 where id = '6000000f-0000-0000-0000-000000000001'$$, '%only cancel a pending request%');
insert into advance_requests (id, employee_id, amount, per_payroll, reason)
values ('6000000f-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a1', 800, 400, 'Fare');
update advance_requests set status = 'cancelled' where id = '6000000f-0000-0000-0000-000000000002';
select pg_temp.check((select status from advance_requests where id = '6000000f-0000-0000-0000-000000000002') = 'cancelled', 'own pending request cancelled');
select pg_temp.check((select count(*) from recurring_deductions) = 0, 'no advance yet');
commit;
-- a separated employee can't ask
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uz2, true);
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll) values ('20000000-0000-0000-0000-0000000000a2', 500, 500)$$, '%Separated employees%');
commit;

\echo '--- 13.2 approval records the advance in the same step; only the client''s admins can approve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
select pg_temp.expect_error($$update advance_requests set status = 'approved' where id = '6000000f-0000-0000-0000-000000000001'$$, '%Approve a request from Cash Advances%');
select pg_temp.expect_error($$select public.approve_advance_request('6000000f-0000-0000-0000-000000000001', 3000, 4000, '2026-11-02', null, 'cash', '2026-11-02')$$, '%can''t be more than the advance%');
select pg_temp.expect_error($$select public.approve_advance_request('6000000f-0000-0000-0000-000000000001', 3000, 500, '2026-11-02', null, 'cash', null)$$, '%written authorization%');
select public.approve_advance_request('6000000f-0000-0000-0000-000000000001', 3000, 500, '2026-11-02', null, 'cash', '2026-11-02', 'Released by the cashier');
select pg_temp.check((select status from advance_requests where id = '6000000f-0000-0000-0000-000000000001') = 'approved', 'request approved');
select pg_temp.check((select d.balance = 3000 and d.total_amount = 3000 and d.amount_per_period = 500 and d.start_date = '2026-11-02'
                             and d.category = 'cash_advance' and d.label = 'Cash advance (Nov 2, 2026)' and d.active
                      from advance_requests r join recurring_deductions d on d.id = r.advance_id
                      where r.id = '6000000f-0000-0000-0000-000000000001'), 'advance recorded from the request');
select pg_temp.expect_error($$select public.approve_advance_request('6000000f-0000-0000-0000-000000000001', 3000, 500, '2026-11-02', null, 'cash', '2026-11-02')$$, '%no longer pending%');
commit;
-- another client's admin can neither file for this employee nor approve its requests
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uz1, true);
insert into advance_requests (id, employee_id, amount, per_payroll) values ('6000000f-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a1', 600, 300);
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll) values ('20000000-0000-0000-0000-0000000000a1', 1, 1)$$, '%row-level security%');
select pg_temp.expect_error($$select public.approve_advance_request('6000000f-0000-0000-0000-000000000003', 600, 300, '2026-11-02', null, 'cash', '2026-11-02')$$, '%Request not found%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
update advance_requests set status = 'rejected', review_notes = 'One advance at a time', reviewed_at = now() where id = '6000000f-0000-0000-0000-000000000003';
commit;
select pg_temp.check((select status from advance_requests where id = '6000000f-0000-0000-0000-000000000003') = 'rejected', 'the client''s own admin can reject');

\echo '--- 13.3 a cash advance recorded directly needs its release date, authorization and a matching balance'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, released_on) values ('20000000-0000-0000-0000-0000000000a1', 'Cash advance', 'cash_advance', 250, 1000, 1000, '2026-11-03')$$, '%written authorization%');
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, released_on, authorized_on) values ('20000000-0000-0000-0000-0000000000a1', 'Cash advance', 'cash_advance', 250, 1000, 600, '2026-11-03', '2026-11-03')$$, '%balance equal to the amount released%');
-- (payroll_deduction_overrides: 0 = no fixed installment is allowed; a negative one never is)
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, released_on, authorized_on) values ('20000000-0000-0000-0000-0000000000a1', 'Cash advance', 'cash_advance', -1, 1000, 1000, '2026-11-03', '2026-11-03')$$, '%per payroll%');
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, total_amount, balance, start_date, released_on, release_method, authorized_on)
values ('7000000f-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', 'Cash advance (Nov 3, 2026)', 'cash_advance', 250, 1000, 1000, '2026-11-03', '2026-11-03', 'e_wallet', '2026-11-03');
-- the release and authorization record can't be cleared, and the first deduction can't precede the release
select pg_temp.expect_error($$update recurring_deductions set authorized_on = null where id = '7000000f-0000-0000-0000-000000000001'$$, '%written authorization%');
select pg_temp.expect_error($$update recurring_deductions set released_on = null where id = '7000000f-0000-0000-0000-000000000001'$$, '%date the cash advance was released%');
select pg_temp.expect_error($$update recurring_deductions set start_date = '2026-11-02' where id = '7000000f-0000-0000-0000-000000000001'$$, '%can''t come before the release%');
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, start_date, released_on, authorized_on) values ('20000000-0000-0000-0000-0000000000a1', 'Cash advance', 'cash_advance', 250, 1000, 1000, '2026-11-01', '2026-11-03', '2026-11-03')$$, '%can''t come before the release%');
-- other deductions can't be turned into advances (that would skip the checks above)
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, authorized_on)
values ('7000000f-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a1', 'Uniform', 'other', 100, '2026-11-01');
select pg_temp.expect_error($$update recurring_deductions set category = 'cash_advance' where id = '7000000f-0000-0000-0000-000000000009'$$, '%Cash Advances%');
commit;

\echo '--- 13.4 the balance moves only through payroll or a repayment; corrections only before any repayment'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
select pg_temp.expect_error($$update recurring_deductions set balance = 400 where id = '7000000f-0000-0000-0000-000000000001'$$, '%changes only through payroll or a recorded repayment%');
update recurring_deductions set total_amount = 1200, balance = 1200 where id = '7000000f-0000-0000-0000-000000000001';
update recurring_deductions set amount_per_period = 300, active = false where id = '7000000f-0000-0000-0000-000000000001';
update recurring_deductions set active = true where id = '7000000f-0000-0000-0000-000000000001';
select pg_temp.expect_error($$update recurring_deductions set amount_per_period = -5 where id = '7000000f-0000-0000-0000-000000000001'$$, '%per payroll%');
select pg_temp.check((select balance = 1200 and amount_per_period = 300 and active from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001'), 'corrected before repayment; installment changed; resumed');
commit;

\echo '--- 13.5 repayments outside payroll: within the balance, never edited, deletable, client-scoped'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
insert into advance_repayments (id, advance_id, paid_on, amount, notes)
values ('8000000f-0000-0000-0000-000000000001', '7000000f-0000-0000-0000-000000000001', '2026-11-05', 200, 'Paid in cash');
select pg_temp.check((select employee_id = '20000000-0000-0000-0000-0000000000a1' and entity_id = '10000000-0000-0000-0000-0000000000f0' and recorded_by = :za
                      from advance_repayments where id = '8000000f-0000-0000-0000-000000000001'), 'repayment filled from the advance and the admin');
select pg_temp.check((select balance from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 1000, 'repayment reduced the balance');
select pg_temp.expect_error($$insert into advance_repayments (advance_id, paid_on, amount) values ('7000000f-0000-0000-0000-000000000001', '2026-11-05', 1000.01)$$, '%more than what is left%');
select pg_temp.expect_error($$insert into advance_repayments (advance_id, paid_on, amount) values ('7000000f-0000-0000-0000-000000000009', '2026-11-05', 10)$$, '%cash advances only%');
select pg_temp.expect_error($$update advance_repayments set amount = 100$$, '%can''t be edited%');
select pg_temp.expect_error($$update recurring_deductions set total_amount = 900, balance = 900 where id = '7000000f-0000-0000-0000-000000000001'$$, '%changes only through payroll%');
select pg_temp.expect_error($$delete from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001'$$, '%can''t be deleted%');
-- paying it all leaves nothing for payroll to take (a zero balance is skipped), and
-- repayments never touch the pause switch: removing one restores the balance only
insert into advance_repayments (id, advance_id, paid_on, amount) values ('8000000f-0000-0000-0000-000000000002', '7000000f-0000-0000-0000-000000000001', '2026-11-06', 1000);
select pg_temp.check((select balance = 0 and active from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001'), 'fully repaid: zero, pause switch untouched');
delete from advance_repayments where id = '8000000f-0000-0000-0000-000000000002';
select pg_temp.check((select balance = 1000 and active from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001'), 'deleted repayment restored the balance');
update recurring_deductions set active = false where id = '7000000f-0000-0000-0000-000000000001';
insert into advance_repayments (id, advance_id, paid_on, amount) values ('8000000f-0000-0000-0000-000000000005', '7000000f-0000-0000-0000-000000000001', '2026-11-06', 1000);
delete from advance_repayments where id = '8000000f-0000-0000-0000-000000000005';
select pg_temp.check((select balance = 1000 and not active from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001'), 'removing a repayment keeps a paused advance paused');
update recurring_deductions set active = true where id = '7000000f-0000-0000-0000-000000000001';
select pg_temp.check(pg_temp.ledger_ok('7000000f-0000-0000-0000-000000000001'), 'ledger ties out after repayments');
commit;
-- another client's admin can neither see nor repay it, and the balance is untouched
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.check((select count(*) from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 0, 'foreign admin cannot see the advance');
select pg_temp.expect_error($$insert into advance_repayments (advance_id, paid_on, amount) values ('7000000f-0000-0000-0000-000000000001', '2026-11-05', 50)$$, '%row-level security%');
commit;
select pg_temp.check((select balance from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 1000, 'foreign attempt left the balance alone');
-- the employee sees their own advances, repayments and requests, and can't record repayments
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uz1, true);
select pg_temp.check((select count(*) from recurring_deductions where category = 'cash_advance') = 2, 'employee sees own advances');
select pg_temp.check((select count(*) from advance_repayments) = 1, 'employee sees own repayment');
select pg_temp.check((select count(*) from advance_requests) = 3, 'employee sees own requests');
select pg_temp.expect_error($$insert into advance_repayments (advance_id, paid_on, amount) values ('7000000f-0000-0000-0000-000000000001', '2026-11-05', 10)$$, '%row-level security%');
update recurring_deductions set balance = 0 where id = '7000000f-0000-0000-0000-000000000001';  -- matches no row they may update
commit;
select pg_temp.check((select balance from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 1000, 'employee could not touch the balance');

\echo '--- 13.6 finalize deducts the installment from the balance; reopen gives it back'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000f-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000f0', 'regular', 'weekly', '2026-11-02', '2026-11-08', '2026-11-13', '2026-11-01', 1, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, deductions)
values ('3000000f-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', 4530, 3730, 800,
        '[{"code":"other:cash_advance","label":"Cash advance (Nov 3, 2026) — 700.00 left","amount":300,"meta":"7000000f-0000-0000-0000-000000000001"},
          {"code":"other:cash_advance","label":"Cash advance (Nov 2, 2026) — 2,500.00 left","amount":500,"meta":"__ADV__"}]');
update payslips set deductions = replace(deductions::text, '__ADV__',
  (select advance_id::text from advance_requests where id = '6000000f-0000-0000-0000-000000000001'))::jsonb
  where payroll_run_id = '3000000f-0000-0000-0000-000000000001';
select pg_temp.computed('3000000f-0000-0000-0000-000000000001');
-- a repayment after computing changes what the installment may be: the draft must be recomputed
insert into advance_repayments (id, advance_id, paid_on, amount) values ('8000000f-0000-0000-0000-000000000003', '7000000f-0000-0000-0000-000000000001', '2026-11-07', 100);
select pg_temp.check((select totals from payroll_runs where id = '3000000f-0000-0000-0000-000000000001') = '{}'::jsonb, 'a repayment makes the draft stale');
select pg_temp.expect_error($$select public.finalize_payroll_run('3000000f-0000-0000-0000-000000000001')$$, '%out of date%');
-- the race the client's compute token closes: a repayment lands while the draft is being
-- computed (balance 900 - 800 = 100, the line takes 300) and the draft is marked complete anyway
insert into advance_repayments (id, advance_id, paid_on, amount) values ('8000000f-0000-0000-0000-000000000004', '7000000f-0000-0000-0000-000000000001', '2026-11-07', 800);
select pg_temp.computed('3000000f-0000-0000-0000-000000000001');
select pg_temp.expect_error($$select public.finalize_payroll_run('3000000f-0000-0000-0000-000000000001')$$, '%must stay between 0 and%');
select pg_temp.check((select status from payroll_runs where id = '3000000f-0000-0000-0000-000000000001') = 'draft', 'the over-deducting draft was not finalized');
delete from advance_repayments where id = '8000000f-0000-0000-0000-000000000004';
delete from advance_repayments where id = '8000000f-0000-0000-0000-000000000003';
select pg_temp.computed('3000000f-0000-0000-0000-000000000001');
select public.finalize_payroll_run('3000000f-0000-0000-0000-000000000001');
select pg_temp.check((select balance from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 700, 'installment deducted on finalize');
select pg_temp.check((select d.balance from advance_requests r join recurring_deductions d on d.id = r.advance_id where r.id = '6000000f-0000-0000-0000-000000000001') = 2500, 'second advance deducted too');
select pg_temp.check(pg_temp.ledger_ok('7000000f-0000-0000-0000-000000000001'), 'ledger ties out after a payroll');
select pg_temp.check((select pg_temp.ledger_ok(advance_id) from advance_requests where id = '6000000f-0000-0000-0000-000000000001'), 'requested advance ledger ties out');
-- an untouched-by-repayment advance with a payroll deduction still can't be corrected or deleted
select pg_temp.expect_error($$update recurring_deductions set total_amount = 2000, balance = 2000 where id = (select advance_id from advance_requests where id = '6000000f-0000-0000-0000-000000000001')$$, '%changes only through payroll%');
select pg_temp.expect_error($$delete from recurring_deductions where id = (select advance_id from advance_requests where id = '6000000f-0000-0000-0000-000000000001')$$, '%can''t be deleted%');
select public.void_payroll_run('3000000f-0000-0000-0000-000000000001', 'Test: corrected and reissued');
select pg_temp.check((select balance from recurring_deductions where id = '7000000f-0000-0000-0000-000000000001') = 1000, 'reopen restored the balance');
select pg_temp.check(pg_temp.ledger_ok('7000000f-0000-0000-0000-000000000001'), 'ledger ties out after reopen');
commit;

\echo '--- 13.7 an untouched advance can be deleted; its request keeps the history'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :za, true);
delete from recurring_deductions where id = (select advance_id from advance_requests where id = '6000000f-0000-0000-0000-000000000001');
select pg_temp.check((select status = 'approved' and advance_id is null from advance_requests where id = '6000000f-0000-0000-0000-000000000001'), 'request stays approved, unlinked');
commit;

\echo '--- 13.8 requests and repayments are audited with the client'
select pg_temp.check((select count(*) from audit_logs where table_name = 'advance_requests' and entity_id = '10000000-0000-0000-0000-0000000000f0') >= 3, 'requests audited');
select pg_temp.check((select count(*) from audit_logs where table_name = 'advance_repayments' and entity_id = '10000000-0000-0000-0000-0000000000f0') = 9, 'repayments audited: 5 recorded, 4 deleted');

\echo 'ALL CASH-ADVANCE TESTS PASSED'
