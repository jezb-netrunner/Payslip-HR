-- Spec T1 (payroll tax rules spec, 2026-10-25): the tax tables and ceilings
-- on file in the database, which is what payroll computes from.
\set ON_ERROR_STOP 1

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

-- every base equals the previous base plus the previous rate on the step, to the centavo
create or replace function pg_temp.continuous(b jsonb) returns boolean
language sql as $$
  select coalesce(bool_and(abs((r->>'base')::numeric - ((p->>'base')::numeric + (p->>'rate')::numeric * ((r->>'over')::numeric - (p->>'over')::numeric))) <= 0.01), false)
  from generate_series(1, jsonb_array_length(b) - 1) i, lateral (select b->i r, b->(i - 1) p) x
$$;

\echo '--- 17.1 the withholding tables on file are Annex E, row for row'
select pg_temp.check(
  (select data from statutory_versions where kind = 'bir_wht' and effective_from = '2023-01-01') = '{
    "daily":[{"over":0,"base":0,"rate":0},{"over":685,"base":0,"rate":0.15},{"over":1096,"base":61.65,"rate":0.20},{"over":2192,"base":280.85,"rate":0.25},{"over":5479,"base":1102.60,"rate":0.30},{"over":21918,"base":6034.30,"rate":0.35}],
    "weekly":[{"over":0,"base":0,"rate":0},{"over":4808,"base":0,"rate":0.15},{"over":7692,"base":432.60,"rate":0.20},{"over":15385,"base":1971.20,"rate":0.25},{"over":38462,"base":7740.45,"rate":0.30},{"over":153846,"base":42355.65,"rate":0.35}],
    "semi_monthly":[{"over":0,"base":0,"rate":0},{"over":10417,"base":0,"rate":0.15},{"over":16667,"base":937.50,"rate":0.20},{"over":33333,"base":4270.70,"rate":0.25},{"over":83333,"base":16770.70,"rate":0.30},{"over":333333,"base":91770.70,"rate":0.35}],
    "monthly":[{"over":0,"base":0,"rate":0},{"over":20833,"base":0,"rate":0.15},{"over":33333,"base":1875.00,"rate":0.20},{"over":66667,"base":8541.80,"rate":0.25},{"over":166667,"base":33541.80,"rate":0.30},{"over":666667,"base":183541.80,"rate":0.35}]
  }'::jsonb,
  'bir_wht 2023 equals the spec''s Annex E');
select pg_temp.check((select count(*) from statutory_versions where kind = 'bir_wht') = 1, 'one withholding table on file');

\echo '--- 17.2 the annual table and the 90,000 ceiling'
select pg_temp.check(
  (select data from statutory_versions where kind = 'bir_annual' and effective_from = '2023-01-01') = '{
    "brackets":[{"over":0,"base":0,"rate":0},{"over":250000,"base":0,"rate":0.15},{"over":400000,"base":22500,"rate":0.20},{"over":800000,"base":102500,"rate":0.25},{"over":2000000,"base":402500,"rate":0.30},{"over":8000000,"base":2202500,"rate":0.35}],
    "other_benefits_exemption_cap":90000
  }'::jsonb,
  'bir_annual 2023 equals the spec''s annual table and the 90,000 ceiling');

\echo '--- 17.3 each table is continuous to the centavo'
select pg_temp.check(pg_temp.continuous(data->'daily') and pg_temp.continuous(data->'weekly')
  and pg_temp.continuous(data->'semi_monthly') and pg_temp.continuous(data->'monthly'), 'Annex E tables are continuous')
  from statutory_versions where kind = 'bir_wht';
select pg_temp.check(pg_temp.continuous(data->'brackets'), 'annual table is continuous')
  from statutory_versions where kind = 'bir_annual';

\echo '--- 17.4 de minimis ceilings for pay dated 2026-01-07 and later (RR 29-2025)'
select pg_temp.check((select count(*) from statutory_versions where kind = 'de_minimis') = 1, 'one de minimis version on file');
select pg_temp.check((select effective_from from statutory_versions where kind = 'de_minimis') = '2026-01-07', 'effective 2026-01-07');
select pg_temp.check(
  (select jsonb_agg(i order by i->>'item') from statutory_versions, jsonb_array_elements(data->'items') i where kind = 'de_minimis') = '[
    {"item":"a","unit":"days_per_year","limit":12,"label":"Cash conversion of unused vacation leave credits (private employees)"},
    {"item":"c","unit":"per_semester","limit":2000,"per_month":333,"label":"Medical cash allowance to dependents of employees"},
    {"item":"d","unit":"per_month","limit":2500,"label":"Rice subsidy (or one 50-kg sack a month worth up to the ceiling)"},
    {"item":"e","unit":"per_year","limit":8000,"label":"Uniform and clothing allowance"},
    {"item":"f","unit":"per_year","limit":12000,"label":"Actual medical assistance"},
    {"item":"g","unit":"per_month","limit":400,"label":"Laundry allowance"},
    {"item":"h","unit":"per_year","limit":12000,"label":"Employee achievement awards under a written plan"},
    {"item":"i","unit":"per_year","limit":6000,"label":"Christmas and major anniversary gifts"},
    {"item":"j","unit":"share_of_regional_minimum_wage","limit":0.30,"label":"Daily meal allowance for overtime work and night or graveyard shift"},
    {"item":"k","unit":"per_year","limit":12000,"label":"CBA benefits and productivity incentives, combined"}
  ]'::jsonb,
  'the ten ceilings, items a and c–k');
select pg_temp.check((select legal_basis like '%RR 29-2025%' and verified_on is not null from statutory_versions where kind = 'de_minimis'), 'documented and verified');

\echo '--- 17.5 the database refuses a malformed de minimis version'
-- (the function itself, so no row is written)
select pg_temp.check(not public.valid_statutory_data('de_minimis', '{"items":[{"item":"a","unit":"days_per_year","limit":12,"label":"x"}]}'), 'missing items are refused');
select pg_temp.check(not public.valid_statutory_data('de_minimis',
  (select jsonb_set(data, '{items,0,item}', '"b"') from statutory_versions where kind = 'de_minimis')), 'item b (government only) is refused');
select pg_temp.check(not public.valid_statutory_data('de_minimis',
  (select jsonb_set(data, '{items,8,limit}', '1.5') from statutory_versions where kind = 'de_minimis')), 'a meal-allowance share above 100% is refused');
select pg_temp.check(not public.valid_statutory_data('de_minimis',
  (select jsonb_set(data, '{items,3,limit}', '-1') from statutory_versions where kind = 'de_minimis')), 'a negative ceiling is refused');
select pg_temp.check(public.valid_statutory_data('de_minimis', (select data from statutory_versions where kind = 'de_minimis')), 'the version on file passes');

\echo '--- 17.6 contribution tables still start on the 1st; tax tables may start mid-month'
select pg_temp.expect_error($q$insert into statutory_versions (kind, effective_from, description, source_url, legal_basis, data)
  select 'sss', '2027-01-07', 'x', 'https://example.com', 'x', data from statutory_versions where kind = 'sss'$q$, '%statutory_versions_month_start%');
begin;
insert into statutory_versions (kind, effective_from, description, source_url, legal_basis, data)
  select 'bir_annual', '2027-01-07', 'x', 'https://example.com', 'x', data from statutory_versions where kind = 'bir_annual';
rollback;

\echo '--- 17.7 API roles still only read the tables'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select pg_temp.check((select count(*) from statutory_versions where kind = 'de_minimis') = 1, 'a signed-in user reads the ceilings');
select pg_temp.expect_error($q$update statutory_versions set data = data where kind = 'de_minimis'$q$, '%permission denied%');
rollback;

\echo 'PASSED 17'
