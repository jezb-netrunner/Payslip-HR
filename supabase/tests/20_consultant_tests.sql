-- Tests for independent consultants: billing waits for the checklist
-- sign-off, the database withholds EWT at the table's rate for the payee
-- and declaration, a declaration re-rates unpaid billings, a filed quarter
-- locks its billings, the EWT tables are read-only, admins only.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ca    '''00000000-0000-0000-0000-000000000201'''
\set other '''00000000-0000-0000-0000-000000000089'''

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

-- the consultancy rates of the table in force on a date
create or replace function pg_temp.band(p_type text, p_band text, p_date date) returns numeric
language sql stable as $$
  select (data->'fees'->'consultancy'->p_type->p_band->>'rate')::numeric
  from ewt_versions where effective_from <= p_date order by effective_from desc limit 1
$$;
grant execute on function pg_temp.band(text, text, date) to authenticated;

select pg_temp.check((select count(*) >= 1 from ewt_versions), 'an EWT table ships with the migrations');

-- fixture: client CU and its admin
insert into auth.users (id, email, raw_app_meta_data) values (:ca, 'ca@cu.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000020f0', 'CU', 'Cu Holdings', 695);
insert into entity_admins (profile_id, entity_id) values (:ca, '10000000-0000-0000-0000-0000000020f0');
commit;

\echo '--- 20.1 a consultant is billed only after the checklist sign-off'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ca, true);
insert into consultants (id, entity_id, payee_type, last_name, first_name, tin, service, fee_basis, fee_amount, billing, contract_start, checklist)
values ('70000000-0000-0000-0000-0000000020a1', '10000000-0000-0000-0000-0000000020f0', 'individual', 'Santos', 'Rhea', '123456789',
        'Management consultancy', 'retainer', 60000, 'semi_monthly', '2026-01-05', '{"control": true}');
select pg_temp.check((select tin = '123-456-789' and signed_off_at is null from consultants where id = '70000000-0000-0000-0000-0000000020a1'), 'the TIN is formatted, nothing signed off yet');
select pg_temp.expect_error($$insert into consultant_billings (consultant_id, invoice_no, billed_on, gross_amount) values ('70000000-0000-0000-0000-0000000020a1', 'INV-1', '2026-07-15', 30000)$$, '%Sign off the employee-or-contractor checklist%');
update consultants set signed_off_by = 'Ana Cruz, HR head' where id = '70000000-0000-0000-0000-0000000020a1';
select pg_temp.check((select signed_off_at is not null and signed_off_user = :ca::uuid from consultants where id = '70000000-0000-0000-0000-0000000020a1'), 'the sign-off records who and when');
-- changing an answer needs a new sign-off
update consultants set checklist = '{"control": false}' where id = '70000000-0000-0000-0000-0000000020a1';
select pg_temp.check((select signed_off_by is null and signed_off_at is null from consultants where id = '70000000-0000-0000-0000-0000000020a1'), 'a changed answer clears the sign-off');
update consultants set checklist = '{"control": true}', checklist_note = 'sets results only' where id = '70000000-0000-0000-0000-0000000020a1';
update consultants set signed_off_by = 'Ana Cruz, HR head' where id = '70000000-0000-0000-0000-0000000020a1';
select pg_temp.expect_error($$insert into consultants (entity_id, payee_type, last_name, first_name, tin, service, fee_basis, billing, contract_start) values ('10000000-0000-0000-0000-0000000020f0', 'individual', 'Dup', 'Licate', '123-456-789', 'x', 'retainer', 'monthly', '2026-01-01')$$, '%consultants_tin_unique%');
select pg_temp.expect_error($$insert into consultants (entity_id, payee_type, tin, service, fee_basis, billing, contract_start) values ('10000000-0000-0000-0000-0000000020f0', 'juridical', '111-222-333', 'x', 'retainer', 'monthly', '2026-01-01')$$, '%consultants_named%');
select pg_temp.expect_error($$insert into consultants (entity_id, payee_type, registered_name, tin, service, fee_kind, fee_basis, billing, contract_start) values ('10000000-0000-0000-0000-0000000020f0', 'juridical', 'Royal Co.', '111-222-333', 'x', 'royalties', 'retainer', 'monthly', '2026-01-01')$$, '%Unknown kind of fee%');
commit;

\echo '--- 20.2 the database withholds at the table''s rate for the payee and declaration'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ca, true);
-- no declaration on file
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount)
values ('71000000-0000-0000-0000-0000000020b1', '70000000-0000-0000-0000-0000000020a1', 'INV-1', '2026-07-15', 30000);
select pg_temp.check((select ewt_rate = case when (select (data->'fees'->'consultancy'->'individual'->>'no_declaration_above')::boolean from ewt_versions where effective_from <= '2026-07-15' order by effective_from desc limit 1)
                                          then pg_temp.band('individual', 'above', '2026-07-15') else pg_temp.band('individual', 'within', '2026-07-15') end
                             and ewt_amount = round(30000 * ewt_rate, 2) and net_amount = 30000 - ewt_amount and entity_id = '10000000-0000-0000-0000-0000000020f0'
  from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'without a declaration: the table decides');
-- a declaration within the threshold re-rates the unpaid billings of its year
insert into consultant_declarations (consultant_id, year, over_threshold, submitted_on)
values ('70000000-0000-0000-0000-0000000020a1', 2026, false, '2026-07-20');
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'within', '2026-07-15') and ewt_amount = round(30000 * ewt_rate, 2)
  from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'declared within the threshold: the lower rate');
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount, paid_on)
values ('71000000-0000-0000-0000-0000000020b2', '70000000-0000-0000-0000-0000000020a1', 'INV-2', '2026-07-31', 30000, '2026-08-05');
update consultant_declarations set over_threshold = true where consultant_id = '70000000-0000-0000-0000-0000000020a1' and year = 2026;
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'above', '2026-07-15') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'an unpaid billing takes the new declaration');
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'within', '2026-07-31') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b2'), 'a paid one keeps what was withheld');
update consultant_billings set note = 'paid by check' where id = '71000000-0000-0000-0000-0000000020b2';
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'within', '2026-07-31') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b2'), 'and a note on it changes nothing');
-- the kind of fee re-codes the unpaid billings
update consultants set fee_kind = 'professional' where id = '70000000-0000-0000-0000-0000000020a1';
select pg_temp.check((select atc = 'WI011' from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'a professional fee: WI011');
select pg_temp.check((select atc = 'WI050' from consultant_billings where id = '71000000-0000-0000-0000-0000000020b2'), 'the paid one keeps WI050');
update consultants set fee_kind = 'consultancy' where id = '70000000-0000-0000-0000-0000000020a1';
select pg_temp.check((select atc = 'WI051' from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'back to consultancy: WI051');
select pg_temp.expect_error($$insert into consultant_billings (consultant_id, invoice_no, billed_on, gross_amount, vat_amount) values ('70000000-0000-0000-0000-0000000020a1', 'INV-3', '2026-08-15', 30000, 3600)$$, '%VAT-registered consultant%');
select pg_temp.expect_error($$insert into consultant_billings (consultant_id, invoice_no, billed_on, gross_amount) values ('70000000-0000-0000-0000-0000000020a1', 'INV-1', '2026-08-15', 30000)$$, '%consultant_billings_invoice_unique%');
-- a firm
insert into consultants (id, entity_id, payee_type, registered_name, tin, tin_branch_code, vat_registered, service, fee_basis, billing, contract_start, checklist, signed_off_by)
values ('70000000-0000-0000-0000-0000000020a2', '10000000-0000-0000-0000-0000000020f0', 'juridical', 'Abaca Advisory Inc.', '987-654-321', '000', true,
        'Audit advisory', 'per_deliverable', 'per_deliverable', '2026-06-01', '{"control": true}', 'Ana Cruz, HR head');
insert into consultant_declarations (consultant_id, year, over_threshold, submitted_on) values ('70000000-0000-0000-0000-0000000020a2', 2026, true, '2026-06-01');
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount, vat_amount)
values ('71000000-0000-0000-0000-0000000020b3', '70000000-0000-0000-0000-0000000020a2', 'SI-0042', '2026-08-31', 100000, 12000);
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'above', '2026-08-31') and ewt_amount = round(100000 * ewt_rate, 2)
                             and net_amount = 100000 + 12000 - ewt_amount and atc = 'WC051'
  from consultant_billings where id = '71000000-0000-0000-0000-0000000020b3'), 'a firm above its threshold: the fee withheld, VAT paid on top');
-- a firm declared within its threshold: the billing that passes it, and the later ones, take the rate above
update consultant_declarations set over_threshold = false where consultant_id = '70000000-0000-0000-0000-0000000020a2';
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'within', '2026-08-31') and atc = 'WC050'
  from consultant_billings where id = '71000000-0000-0000-0000-0000000020b3'), 'declared within: the lower rate');
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount, vat_amount)
values ('71000000-0000-0000-0000-0000000020b4', '70000000-0000-0000-0000-0000000020a2', 'SI-0050', '2026-09-30', 700000, 84000);
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'above', '2026-09-30') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b4'),
  'the billing that takes the year past the threshold: the rate above');
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'within', '2026-08-31') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b3'), 'the earlier one keeps its rate');
-- an earlier billing dated before it moves the later one past too
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount)
values ('71000000-0000-0000-0000-0000000020b5', '70000000-0000-0000-0000-0000000020a2', 'SI-0031', '2026-06-30', 50000);
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'within', '2026-06-30') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b5'), 'the June billing: within');
delete from consultant_billings where id = '71000000-0000-0000-0000-0000000020b4';
delete from consultant_billings where id = '71000000-0000-0000-0000-0000000020b5';
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount)
values ('71000000-0000-0000-0000-0000000020b6', '70000000-0000-0000-0000-0000000020a2', 'SI-0060', '2026-09-30', 620000);
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'within', '2026-09-30') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b6'), '720,000 exactly: still within');
insert into consultant_billings (id, consultant_id, invoice_no, billed_on, gross_amount)
values ('71000000-0000-0000-0000-0000000020b7', '70000000-0000-0000-0000-0000000020a2', 'SI-0010', '2026-02-27', 1000);
select pg_temp.check((select ewt_rate = pg_temp.band('juridical', 'above', '2026-09-30') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b6'), 'a February billing entered later moves September past the threshold');
delete from consultant_billings where id in ('71000000-0000-0000-0000-0000000020b6', '71000000-0000-0000-0000-0000000020b7');
update consultant_declarations set over_threshold = true where consultant_id = '70000000-0000-0000-0000-0000000020a2';
-- a consultant no longer VAT-registered: its unpaid VAT invoice stays, and so does the change
update consultants set vat_registered = false where id = '70000000-0000-0000-0000-0000000020a2';
select pg_temp.check((select vat_amount = 12000 from consultant_billings where id = '71000000-0000-0000-0000-0000000020b3'), 'the VAT invoice stays as billed');
select pg_temp.expect_error($$update consultant_billings set gross_amount = 90000 where id = '71000000-0000-0000-0000-0000000020b3'$$, '%VAT-registered consultant%');
update consultants set vat_registered = true where id = '70000000-0000-0000-0000-0000000020a2';
commit;

\echo '--- 20.3 admins only; the EWT tables are read-only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :other, true);
select pg_temp.check((select count(*) from consultants where entity_id = '10000000-0000-0000-0000-0000000020f0') = 0, 'another client''s admin sees no consultant');
select pg_temp.check((select count(*) from consultant_billings where entity_id = '10000000-0000-0000-0000-0000000020f0') = 0, 'nor a billing');
select pg_temp.expect_error($$insert into consultant_billings (consultant_id, invoice_no, billed_on, gross_amount) values ('70000000-0000-0000-0000-0000000020a1', 'X-1', '2026-08-15', 1000)$$, '%Consultant not found%');
select pg_temp.expect_error($$insert into consultant_declarations (consultant_id, year, over_threshold, submitted_on) values ('70000000-0000-0000-0000-0000000020a1', 2027, false, '2027-01-10')$$, '%Consultant not found%');
select pg_temp.check((select count(*) >= 1 from ewt_versions), 'the EWT tables are readable');
select pg_temp.expect_error($$update ewt_versions set description = 'x'$$, '%permission denied%');
select pg_temp.expect_error($$insert into ewt_versions (effective_from, description, legal_basis, source_url, data) values ('2099-01-01', 'x', 'x', 'https://x', '{}')$$, '%permission denied%');
commit;

\echo '--- 20.4 a filed quarter locks its billings; reopening frees them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ca, true);
insert into ewt_quarter_filings (id, entity_id, quarter, filed_on, reference)
values ('72000000-0000-0000-0000-0000000020c1', '10000000-0000-0000-0000-0000000020f0', '2026-07-01', '2026-10-30', 'RR-123');
select pg_temp.expect_error($$update consultant_billings set gross_amount = 40000 where id = '71000000-0000-0000-0000-0000000020b1'$$, '%marked filed%');
select pg_temp.expect_error($$delete from consultant_billings where id = '71000000-0000-0000-0000-0000000020b3'$$, '%marked filed%');
select pg_temp.expect_error($$insert into consultant_billings (consultant_id, invoice_no, billed_on, gross_amount) values ('70000000-0000-0000-0000-0000000020a1', 'INV-9', '2026-09-30', 30000)$$, '%marked filed%');
-- a declaration doesn't re-rate an unpaid billing of a filed quarter
update consultant_declarations set over_threshold = false where consultant_id = '70000000-0000-0000-0000-0000000020a1' and year = 2026;
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'above', '2026-07-15') and paid_on is null from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'a filed quarter keeps its rates');
-- the payment can still be recorded, and doesn't re-rate it
update consultant_billings set paid_on = '2026-11-03', payment_ref = 'CHK 1002' where id = '71000000-0000-0000-0000-0000000020b1';
select pg_temp.check((select ewt_rate = pg_temp.band('individual', 'above', '2026-07-15') from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'paid in a filed quarter: as withheld');
-- removing a consultant with a filed quarter keeps its billings
select pg_temp.expect_error($$delete from consultants where id = '70000000-0000-0000-0000-0000000020a1'$$, '%are kept: reopen the quarter%');
select pg_temp.expect_error($$insert into ewt_quarter_filings (entity_id, quarter, filed_on) values ('10000000-0000-0000-0000-0000000020f0', '2026-08-01', '2026-10-30')$$, '%ewt_quarter_filings_quarter_check%');
delete from ewt_quarter_filings where id = '72000000-0000-0000-0000-0000000020c1';
update consultant_billings set gross_amount = 40000 where id = '71000000-0000-0000-0000-0000000020b1';
select pg_temp.check((select ewt_amount = round(40000 * ewt_rate, 2) from consultant_billings where id = '71000000-0000-0000-0000-0000000020b1'), 'reopened: the billing changes and is withheld again');
commit;

\echo '--- 20.5 a client''s own EWT filing dates: its admins only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ca, true);
insert into ewt_due_dates (entity_id, filing, period, due_date, note)
values ('10000000-0000-0000-0000-0000000020f0', '1601eq', '2026-07-01', '2026-11-03', 'extension');
select pg_temp.expect_error($$insert into ewt_due_dates (entity_id, filing, period, due_date) values ('10000000-0000-0000-0000-0000000020f0', '1601eq', '2026-07-01', '2026-11-04')$$, '%ewt_due_dates_one%');
select pg_temp.expect_error($$insert into ewt_due_dates (entity_id, filing, period, due_date) values ('10000000-0000-0000-0000-0000000020f0', '1601-eq', '2026-07-01', '2026-11-04')$$, '%ewt_due_dates_filing_check%');
select set_config('request.jwt.claim.sub', :other, true);
select pg_temp.check((select count(*) from ewt_due_dates where entity_id = '10000000-0000-0000-0000-0000000020f0') = 0, 'another client''s admin sees none');
select pg_temp.expect_error($$insert into ewt_due_dates (entity_id, filing, period, due_date) values ('10000000-0000-0000-0000-0000000020f0', '2307', '2026-07-01', '2026-10-21')$$, '%row-level security%');
commit;

\echo 'PASSED 20'
