-- Independent consultants (not employees): a per-client list kept off
-- payroll, each with the contract, the fee, an employee-or-contractor
-- checklist the client signs off, the payee's yearly sworn declaration of
-- gross income, and the billings the client pays. Expanded withholding tax
-- (EWT) is withheld on each billing at the rate the EWT table in force gives
-- (shipped as a migration and read-only, like the statutory tables). No SSS,
-- PhilHealth, Pag-IBIG, 13th month or leave. Admins only. A quarter whose
-- BIR 1601-EQ is marked filed locks its billings.

-- ---------- EWT tables ----------
create table public.ewt_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null constraint ewt_versions_effective_from_unique unique
    constraint ewt_versions_first_of_month check (extract(day from effective_from) = 1),
  description text not null constraint ewt_versions_description_check check (length(btrim(description)) > 0),
  legal_basis text not null constraint ewt_versions_legal_basis_check check (length(btrim(legal_basis)) > 0),
  source_url text not null constraint ewt_versions_source_url_check check (source_url ~ '^https://'),
  verified_on date,
  data jsonb not null,
  created_at timestamptz not null default now()
);

-- the shape of an EWT table: per kind of fee (its label), for individual
-- and for juridical payees, a gross-income threshold with the rate and ATC
-- within and above it, and whether VAT registration or a missing sworn
-- declaration means the rate above
create or replace function public.valid_ewt_data(d jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  k text;
  p text;
  b text;
  r jsonb;
begin
  if d is null or jsonb_typeof(d->'fees') is distinct from 'object' or d->'fees' = '{}'::jsonb then
    return false;
  end if;
  for k in select jsonb_object_keys(d->'fees') loop
    if k !~ '^[a-z_]{1,40}$' or length(btrim(coalesce(d->'fees'->k->>'label', ''))) = 0 then
      return false;
    end if;
    foreach p in array array['individual', 'juridical'] loop
      r := d->'fees'->k->p;
      if jsonb_typeof(r) is distinct from 'object'
         or jsonb_typeof(r->'threshold') is distinct from 'number' or (r->>'threshold')::numeric <= 0
         or jsonb_typeof(r->'vat_registered_above') is distinct from 'boolean'
         or jsonb_typeof(r->'no_declaration_above') is distinct from 'boolean' then
        return false;
      end if;
      foreach b in array array['within', 'above'] loop
        if jsonb_typeof(r->b->'rate') is distinct from 'number'
           or (r->b->>'rate')::numeric not between 0.01 and 0.5
           or coalesce(r->b->>'atc', '') !~ '^W[A-Z][0-9]{3}$' then
          return false;
        end if;
      end loop;
      if (r->'above'->>'rate')::numeric < (r->'within'->>'rate')::numeric then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end
$$;
alter table public.ewt_versions add constraint ewt_versions_data_check check (public.valid_ewt_data(data));

-- RR 2-98 Sec. 2.57.2 as amended by RR 11-2018 and RR 14-2018 (effective on
-- filing, 20 April 2018). Fees of an individual: 5% when the payee's gross
-- income for the year is P3,000,000 or less, the payee is not VAT-registered
-- and its sworn declaration is on file, else 10%. Of a juridical person: 10%
-- on P720,000 or less with its declaration, else 15%. The ATC follows the
-- kind of service: licensed professionals WI010/WI011 and WC010/WC011,
-- management and technical consultants WI050/WI051 and WC050/WC051 (BIR
-- Form 1601-EQ, January 2019 ENCS, and RMO 38-2018). Checked 2026-10-28 on
-- the BIR digests of RR 11-2018 and RR 14-2018 and the form, with an
-- adversarial pass. No later issuance changes these rates.
insert into public.ewt_versions (effective_from, description, legal_basis, source_url, verified_on, data) values (
  '2018-05-01',
  'Expanded withholding on professional and consultancy fees: individuals 5% (gross income for the year P3,000,000 or less, not VAT-registered, sworn declaration on file) or 10%, juridical persons 10% (P720,000 or less, declaration on file) or 15%.',
  'RR 2-98 Sec. 2.57.2 as amended by RR 11-2018 and RR 14-2018, ATCs of BIR Form 1601-EQ (January 2019 ENCS) and RMO 38-2018',
  'https://bir-cdn.bir.gov.ph/local/pdf/Digest%20RR%2014-2018.pdf',
  '2026-10-28',
  '{"fees": {
     "professional": {"label": "Professional fees (lawyers, CPAs, engineers and other licensed professionals)",
       "individual": {"threshold": 3000000, "within": {"rate": 0.05, "atc": "WI010"}, "above": {"rate": 0.10, "atc": "WI011"},
                      "vat_registered_above": true, "no_declaration_above": true},
       "juridical": {"threshold": 720000, "within": {"rate": 0.10, "atc": "WC010"}, "above": {"rate": 0.15, "atc": "WC011"},
                     "vat_registered_above": false, "no_declaration_above": true}},
     "consultancy": {"label": "Management and technical consultancy fees",
       "individual": {"threshold": 3000000, "within": {"rate": 0.05, "atc": "WI050"}, "above": {"rate": 0.10, "atc": "WI051"},
                      "vat_registered_above": true, "no_declaration_above": true},
       "juridical": {"threshold": 720000, "within": {"rate": 0.10, "atc": "WC050"}, "above": {"rate": 0.15, "atc": "WC051"},
                     "vat_registered_above": false, "no_declaration_above": true}}}}'
);

alter table public.ewt_versions enable row level security;
create policy "ewt_versions: read" on public.ewt_versions for select to authenticated using (true);
revoke all on public.ewt_versions from anon;
revoke insert, update, delete on public.ewt_versions from authenticated;

-- ---------- consultants ----------
create table public.consultants (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  payee_type text not null constraint consultants_payee_type_check check (payee_type in ('individual', 'juridical')),
  last_name text not null default '' constraint consultants_last_name_check check (length(last_name) <= 80),
  first_name text not null default '' constraint consultants_first_name_check check (length(first_name) <= 80),
  middle_name text not null default '' constraint consultants_middle_name_check check (length(middle_name) <= 80),
  registered_name text not null default '' constraint consultants_registered_name_check check (length(registered_name) <= 200),
  tin text not null constraint consultants_tin_check check (tin ~ '^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$'),
  tin_branch_code text not null default '00000' constraint consultants_tin_branch_code_check check (tin_branch_code ~ '^[0-9]{3,5}$'),
  address text not null default '' constraint consultants_address_check check (length(address) <= 300),
  zip_code text not null default '' constraint consultants_zip_code_check check (zip_code ~ '^([0-9]{4})?$'),
  vat_registered boolean not null default false,
  -- the nature of the service: the "nature of income payment" of the BIR forms
  service text not null constraint consultants_service_check check (length(btrim(service)) between 1 and 200),
  -- the kind of fee of the EWT table (its ATCs): professional, consultancy
  fee_kind text not null default 'consultancy' constraint consultants_fee_kind_check check (fee_kind ~ '^[a-z_]{1,40}$'),
  fee_basis text not null constraint consultants_fee_basis_check check (fee_basis in ('retainer', 'per_deliverable')),
  -- a retainer's monthly fee, or the usual fee of a deliverable
  fee_amount numeric(14,2) constraint consultants_fee_amount_check check (fee_amount > 0),
  billing text not null constraint consultants_billing_check check (billing in ('monthly', 'semi_monthly', 'per_deliverable')),
  contract_ref text not null default '' constraint consultants_contract_ref_check check (length(contract_ref) <= 120),
  contract_start date not null,
  contract_end date,
  -- the employee-or-contractor checklist: answers, the client's sign-off
  checklist jsonb not null default '{}'::jsonb constraint consultants_checklist_check check (jsonb_typeof(checklist) = 'object'),
  checklist_note text not null default '' constraint consultants_checklist_note_check check (length(checklist_note) <= 1000),
  signed_off_by text constraint consultants_signed_off_by_check check (length(btrim(signed_off_by)) between 1 and 120),
  signed_off_at timestamptz,
  signed_off_user uuid,
  active boolean not null default true,
  notes text not null default '' constraint consultants_notes_check check (length(notes) <= 1000),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultants_named check (case payee_type
    when 'individual' then length(btrim(last_name)) > 0 and length(btrim(first_name)) > 0
    else length(btrim(registered_name)) > 0 end),
  constraint consultants_contract_dates check (contract_end is null or contract_end >= contract_start),
  constraint consultants_tin_unique unique (entity_id, tin, tin_branch_code)
);
create index consultants_entity_idx on public.consultants (entity_id);
create trigger consultants_updated_at before update on public.consultants
  for each row execute function public.set_updated_at();

-- a sign-off records who signed and when, and changing an answer needs a new one
create or replace function public.guard_consultant()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.entity_id is distinct from old.entity_id then
    raise exception 'A consultant cannot move to another client.';
  end if;
  new.tin := regexp_replace(new.tin, '^([0-9]{3})-?([0-9]{3})-?([0-9]{3})$', '\1-\2-\3');
  if (tg_op = 'INSERT' or new.fee_kind is distinct from old.fee_kind)
     and not exists (select 1 from ewt_versions v where v.data->'fees' ? new.fee_kind) then
    raise exception 'Unknown kind of fee: %.', new.fee_kind;
  end if;
  if tg_op = 'UPDATE' and new.signed_off_by is not distinct from old.signed_off_by
     and (new.checklist is distinct from old.checklist or new.checklist_note is distinct from old.checklist_note) then
    new.signed_off_by := null;
  end if;
  if new.signed_off_by is null then
    new.signed_off_at := null;
    new.signed_off_user := null;
  elsif tg_op = 'INSERT' or new.signed_off_by is distinct from old.signed_off_by
        or new.checklist is distinct from old.checklist or new.checklist_note is distinct from old.checklist_note then
    new.signed_off_at := now();
    new.signed_off_user := auth.uid();
  else
    new.signed_off_at := old.signed_off_at;
    new.signed_off_user := old.signed_off_user;
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger consultants_guard before insert or update on public.consultants
  for each row execute function public.guard_consultant();

-- ---------- the payee's sworn declaration, per year ----------
create table public.consultant_declarations (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references public.consultants(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  year int not null constraint consultant_declarations_year_check check (year between 2018 and 2100),
  -- the payee declared gross income for the year above the table's threshold
  over_threshold boolean not null,
  submitted_on date not null,
  note text not null default '' constraint consultant_declarations_note_check check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint consultant_declarations_one_per_year unique (consultant_id, year)
);

-- ---------- quarters whose BIR 1601-EQ was filed ----------
create table public.ewt_quarter_filings (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  quarter date not null constraint ewt_quarter_filings_quarter_check
    check (extract(day from quarter) = 1 and extract(month from quarter) in (1, 4, 7, 10)),
  filed_on date not null,
  reference text not null default '' constraint ewt_quarter_filings_reference_check check (length(reference) <= 120),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint ewt_quarter_filings_one_per_quarter unique (entity_id, quarter)
);

create or replace function public.ewt_quarter_filed(p_entity uuid, p_date date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from ewt_quarter_filings f
                 where f.entity_id = p_entity and f.quarter = date_trunc('quarter', p_date)::date)
$$;

-- ---------- billings ----------
create table public.consultant_billings (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references public.consultants(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  invoice_no text not null constraint consultant_billings_invoice_no_check check (length(btrim(invoice_no)) between 1 and 60),
  -- when the fee became payable: its month and quarter carry the withholding
  billed_on date not null,
  service_from date,
  service_to date,
  description text not null default '' constraint consultant_billings_description_check check (length(description) <= 200),
  -- the fee, VAT excluded: the base of the withholding
  gross_amount numeric(14,2) not null constraint consultant_billings_gross_amount_check check (gross_amount > 0),
  vat_amount numeric(14,2) not null default 0 constraint consultant_billings_vat_amount_check check (vat_amount >= 0),
  -- set from the EWT table in force on billed_on
  atc text not null default '',
  ewt_rate numeric(6,4) not null default 0,
  ewt_amount numeric(14,2) not null default 0,
  net_amount numeric(14,2) not null default 0,
  paid_on date,
  payment_ref text not null default '' constraint consultant_billings_payment_ref_check check (length(payment_ref) <= 120),
  note text not null default '' constraint consultant_billings_note_check check (length(note) <= 500),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultant_billings_service_dates check (service_to is null or service_from is null or service_to >= service_from),
  constraint consultant_billings_invoice_unique unique (consultant_id, invoice_no)
);
create index consultant_billings_entity_idx on public.consultant_billings (entity_id, billed_on);
create index consultant_billings_consultant_idx on public.consultant_billings (consultant_id, billed_on);
create trigger consultant_billings_updated_at before update on public.consultant_billings
  for each row execute function public.set_updated_at();

-- the rate and ATC a billing is withheld at: the EWT table in force on its
-- date for the consultant's kind of fee, the payee's type and VAT
-- registration, its sworn declaration for the year, and what the client
-- has billed it so far that year (p_ytd, this billing included): passing
-- the threshold means the rate above from that billing on
create or replace function public.consultant_billing_ewt(p_consultant uuid, p_date date, p_ytd numeric)
returns table (atc text, rate numeric)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_type text;
  v_kind text;
  v_vat boolean;
  v_over boolean;
  v_rules jsonb;
  v_band text;
begin
  select c.payee_type, c.fee_kind, c.vat_registered into v_type, v_kind, v_vat from consultants c where c.id = p_consultant;
  select v.data->'fees'->v_kind->v_type into v_rules
    from ewt_versions v where v.effective_from <= p_date order by v.effective_from desc limit 1;
  if v_rules is null then
    raise exception 'No EWT table in force on % has this kind of fee: the system maintainer publishes it.', p_date;
  end if;
  select d.over_threshold into v_over
    from consultant_declarations d where d.consultant_id = p_consultant and d.year = extract(year from p_date)::int;
  v_band := case
    when v_over then 'above'
    when v_over is null and (v_rules->>'no_declaration_above')::boolean then 'above'
    when v_vat and (v_rules->>'vat_registered_above')::boolean then 'above'
    when p_ytd > (v_rules->>'threshold')::numeric then 'above'
    else 'within' end;
  atc := v_rules->v_band->>'atc';
  rate := (v_rules->v_band->>'rate')::numeric;
  return next;
end
$$;

create or replace function public.guard_consultant_billing()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_entity uuid;
  v_vat boolean;
  v_signed timestamptz;
  v_ytd numeric;
  -- a re-rating of the year's unpaid billings (recompute_consultant_billings)
  v_rerate boolean := coalesce(current_setting('consultants.rerate', true), '') = 'on';
  v_pay_changes boolean := tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and (new.billed_on, new.gross_amount, new.vat_amount, new.invoice_no)
        is distinct from (old.billed_on, old.gross_amount, old.vat_amount, old.invoice_no));
  e record;
begin
  if tg_op = 'UPDATE' and new.consultant_id is distinct from old.consultant_id then
    raise exception 'A billing cannot move to another consultant.';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or v_pay_changes)
     and public.ewt_quarter_filed(old.entity_id, old.billed_on) then
    if tg_op = 'DELETE' and not exists (select 1 from consultants c where c.id = old.consultant_id) then
      raise exception 'Billings of a quarter whose BIR 1601-EQ is marked filed are kept: reopen the quarter of % on the Consultants page first.', old.billed_on;
    end if;
    raise exception 'The BIR 1601-EQ for the quarter of % is marked filed: its billings are locked. Reopen the quarter to change it.', old.billed_on;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select c.entity_id, c.vat_registered, c.signed_off_at into v_entity, v_vat, v_signed from consultants c where c.id = new.consultant_id;
  if v_entity is null or (auth.uid() is not null and not public.can_manage_entity(v_entity)) then
    raise exception 'Consultant not found.';
  end if;
  new.entity_id := v_entity;
  if v_pay_changes then
    if v_signed is null then
      raise exception 'Sign off the employee-or-contractor checklist of this consultant first.';
    end if;
    if public.ewt_quarter_filed(new.entity_id, new.billed_on) then
      raise exception 'The BIR 1601-EQ for the quarter of % is marked filed: date the billing in an open quarter, or reopen that quarter.', new.billed_on;
    end if;
  end if;
  if v_pay_changes and new.vat_amount > 0 and not v_vat then
    raise exception 'VAT on a billing needs a VAT-registered consultant.';
  end if;
  -- the withholding follows the table, the payee, the declaration and the
  -- year's billings so far: worked out when the fee or its date changes and
  -- on a re-rating, never on a payment or a note (what was withheld stays)
  if v_pay_changes or v_rerate then
    select coalesce(sum(b.gross_amount), 0) + new.gross_amount into v_ytd
      from consultant_billings b
      where b.consultant_id = new.consultant_id and b.id <> new.id
        and extract(year from b.billed_on) = extract(year from new.billed_on)
        and (b.billed_on, b.created_at, b.id) < (new.billed_on, new.created_at, new.id);
    select x.atc, x.rate into e from public.consultant_billing_ewt(new.consultant_id, new.billed_on, v_ytd) x;
    new.atc := e.atc;
    new.ewt_rate := e.rate;
    new.ewt_amount := round(new.gross_amount * e.rate, 2);
    new.net_amount := new.gross_amount + new.vat_amount - new.ewt_amount;
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger consultant_billings_guard before insert or update or delete on public.consultant_billings
  for each row execute function public.guard_consultant_billing();

-- a declaration or the consultant's tax profile changes the rate of the
-- billings not paid yet in an open quarter (of that year, for a declaration)
create or replace function public.recompute_consultant_billings(p_consultant uuid, p_year int)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('consultants.rerate', 'on', true);
  update consultant_billings b set gross_amount = b.gross_amount
    where b.consultant_id = p_consultant and b.paid_on is null
      and (p_year is null or extract(year from b.billed_on)::int = p_year)
      and not public.ewt_quarter_filed(b.entity_id, b.billed_on);
  perform set_config('consultants.rerate', 'off', true);
end
$$;

create or replace function public.consultant_profile_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (new.payee_type, new.vat_registered, new.fee_kind) is distinct from (old.payee_type, old.vat_registered, old.fee_kind) then
    perform public.recompute_consultant_billings(new.id, null);
  end if;
  return null;
end
$$;
create trigger consultants_rates_changed after update on public.consultants
  for each row execute function public.consultant_profile_changed();

create or replace function public.consultant_declaration_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    perform public.recompute_consultant_billings(old.consultant_id, old.year);
  end if;
  if tg_op <> 'DELETE' then
    perform public.recompute_consultant_billings(new.consultant_id, new.year);
  end if;
  return null;
end
$$;
create trigger consultant_declarations_rates_changed after insert or update or delete on public.consultant_declarations
  for each row execute function public.consultant_declaration_changed();

-- a billing moves the year's running total: the others not paid yet in an
-- open quarter take their rate again (not from inside that re-rating)
create or replace function public.consultant_billing_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1
     or (tg_op = 'UPDATE' and (new.billed_on, new.gross_amount) is not distinct from (old.billed_on, old.gross_amount)) then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    perform public.recompute_consultant_billings(old.consultant_id, extract(year from old.billed_on)::int);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or extract(year from new.billed_on) <> extract(year from old.billed_on)) then
    perform public.recompute_consultant_billings(new.consultant_id, extract(year from new.billed_on)::int);
  end if;
  return null;
end
$$;
create trigger consultant_billings_rates_changed after insert or update of billed_on, gross_amount or delete on public.consultant_billings
  for each row execute function public.consultant_billing_changed();

-- a declaration belongs to the consultant's client
create or replace function public.guard_consultant_declaration()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_entity uuid;
begin
  if tg_op = 'UPDATE' and new.consultant_id is distinct from old.consultant_id then
    raise exception 'A declaration cannot move to another consultant.';
  end if;
  select c.entity_id into v_entity from consultants c where c.id = new.consultant_id;
  if v_entity is null or (auth.uid() is not null and not public.can_manage_entity(v_entity)) then
    raise exception 'Consultant not found.';
  end if;
  new.entity_id := v_entity;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger consultant_declarations_guard before insert or update on public.consultant_declarations
  for each row execute function public.guard_consultant_declaration();

-- ---------- the client's own EWT filing dates ----------
-- A date the BIR moved (an extension) replaces the computed one for that
-- client: the month a 0619-E covers, the quarter of a 2307 or 1601-EQ, or
-- 1 January of the year of the payees' declarations list and the 1604-E.
create table public.ewt_due_dates (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  filing text not null constraint ewt_due_dates_filing_check check (filing in ('0619e', '2307', '1601eq', 'declarations', '1604e')),
  period date not null constraint ewt_due_dates_period_check check (period = date_trunc('month', period)::date),
  due_date date not null,
  note text not null default '' constraint ewt_due_dates_note_check check (length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ewt_due_dates_one unique (entity_id, filing, period)
);
create trigger ewt_due_dates_updated_at before update on public.ewt_due_dates
  for each row execute function public.set_updated_at();

-- ---------- access: the client's admins ----------
alter table public.consultants enable row level security;
alter table public.consultant_declarations enable row level security;
alter table public.consultant_billings enable row level security;
alter table public.ewt_quarter_filings enable row level security;
alter table public.ewt_due_dates enable row level security;
create policy "consultants: admins manage" on public.consultants
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "consultant_declarations: admins manage" on public.consultant_declarations
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "consultant_billings: admins manage" on public.consultant_billings
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "ewt_quarter_filings: admins manage" on public.ewt_quarter_filings
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "ewt_due_dates: admins manage" on public.ewt_due_dates
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
revoke all on public.consultants, public.consultant_declarations, public.consultant_billings, public.ewt_quarter_filings, public.ewt_due_dates from anon;

create trigger audit_consultants after insert or update or delete on public.consultants
  for each row execute function public.audit_trigger();
create trigger audit_consultant_declarations after insert or update or delete on public.consultant_declarations
  for each row execute function public.audit_trigger();
create trigger audit_consultant_billings after insert or update or delete on public.consultant_billings
  for each row execute function public.audit_trigger();
create trigger audit_ewt_quarter_filings after insert or update or delete on public.ewt_quarter_filings
  for each row execute function public.audit_trigger();
create trigger audit_ewt_due_dates after insert or update or delete on public.ewt_due_dates
  for each row execute function public.audit_trigger();

revoke execute on function public.guard_consultant() from public, anon, authenticated;
revoke execute on function public.guard_consultant_billing() from public, anon, authenticated;
revoke execute on function public.guard_consultant_declaration() from public, anon, authenticated;
revoke execute on function public.consultant_profile_changed() from public, anon, authenticated;
revoke execute on function public.consultant_declaration_changed() from public, anon, authenticated;
revoke execute on function public.recompute_consultant_billings(uuid, int) from public, anon, authenticated;
revoke execute on function public.consultant_billing_ewt(uuid, date, numeric) from public, anon, authenticated;
revoke execute on function public.consultant_billing_changed() from public, anon, authenticated;
revoke execute on function public.ewt_quarter_filed(uuid, date) from public, anon, authenticated;
