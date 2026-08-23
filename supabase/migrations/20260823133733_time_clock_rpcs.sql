-- ============================================================
-- Time clock RPCs.
-- Internal controls against buddy punching:
--   1. Employee identity is derived from auth.uid() server-side —
--      a caller can never punch for another employee.
--   2. Timestamps come from the database clock (now()), never the client.
--   3. Only one open entry per employee (partial unique index).
--   4. Selfie / device fingerprint / geolocation / IP are captured and
--      anomalies are flagged for admin review.
--   5. Employees cannot modify entries afterwards (RLS: select-only);
--      changes require an admin-reviewed correction request (audited).
-- ============================================================

create or replace function public.request_ip()
returns text
language plpgsql stable
as $$
declare
  v_headers jsonb;
begin
  begin
    v_headers := current_setting('request.headers', true)::jsonb;
  exception when others then
    return null;
  end;
  return nullif(trim(split_part(coalesce(v_headers->>'x-forwarded-for',''), ',', 1)), '');
end
$$;

create or replace function public.clock_in(
  p_selfie_path text default null,
  p_device jsonb default null,
  p_location jsonb default null
)
returns public.time_entries
language plpgsql security definer set search_path = public
as $$
declare
  v_emp uuid;
  v_now timestamptz := now();
  v_tz text;
  v_work_date date;
  v_flags text[] := '{}';
  v_last_fp text;
  v_require_selfie boolean;
  v_require_location boolean;
  v_entry time_entries;
begin
  v_emp := current_employee_id();
  if v_emp is null then
    raise exception 'No active employee record is linked to this account.';
  end if;

  if exists (
    select 1 from employees e
    where e.id = v_emp
      and e.employment_status in ('resigned','terminated','retired')
  ) then
    raise exception 'This employee is no longer active and cannot clock in.';
  end if;

  if exists (select 1 from time_entries t where t.employee_id = v_emp and t.clock_out is null) then
    raise exception 'You already have an open time entry. Please clock out first.';
  end if;

  select coalesce(timezone,'Asia/Manila'), require_selfie_on_punch, require_location_on_punch
    into v_tz, v_require_selfie, v_require_location
    from company_settings where id = 1;
  v_work_date := (v_now at time zone coalesce(v_tz,'Asia/Manila'))::date;

  if p_selfie_path is null then
    if v_require_selfie then
      raise exception 'A verification selfie is required to clock in.';
    end if;
    v_flags := v_flags || 'no_selfie';
  end if;

  if p_location is null then
    if v_require_location then
      raise exception 'Location sharing is required to clock in.';
    end if;
    v_flags := v_flags || 'no_location';
  end if;

  select t.clock_in_device->>'fingerprint'
    into v_last_fp
    from time_entries t
    where t.employee_id = v_emp
      and t.clock_in_device->>'fingerprint' is not null
    order by t.clock_in desc
    limit 1;
  if v_last_fp is not null
     and (p_device->>'fingerprint') is distinct from v_last_fp then
    v_flags := v_flags || 'new_device';
  end if;

  insert into time_entries (
    employee_id, work_date, clock_in,
    clock_in_selfie_path, clock_in_ip, clock_in_device, clock_in_location,
    source, status, flags
  ) values (
    v_emp, v_work_date, v_now,
    p_selfie_path, request_ip(), p_device, p_location,
    'web', 'open', v_flags
  )
  returning * into v_entry;

  return v_entry;
end
$$;

create or replace function public.clock_out(
  p_selfie_path text default null,
  p_device jsonb default null,
  p_location jsonb default null
)
returns public.time_entries
language plpgsql security definer set search_path = public
as $$
declare
  v_emp uuid;
  v_now timestamptz := now();
  v_entry time_entries;
  v_flags text[] := '{}';
  v_require_selfie boolean;
begin
  v_emp := current_employee_id();
  if v_emp is null then
    raise exception 'No active employee record is linked to this account.';
  end if;

  select * into v_entry
    from time_entries t
    where t.employee_id = v_emp and t.clock_out is null
    order by t.clock_in desc
    limit 1;

  if v_entry.id is null then
    raise exception 'No open time entry found. Please clock in first.';
  end if;

  select require_selfie_on_punch into v_require_selfie from company_settings where id = 1;

  if p_selfie_path is null then
    if v_require_selfie then
      raise exception 'A verification selfie is required to clock out.';
    end if;
    v_flags := v_flags || 'no_selfie_out';
  end if;

  if p_device is not null
     and (v_entry.clock_in_device->>'fingerprint') is not null
     and (p_device->>'fingerprint') is distinct from (v_entry.clock_in_device->>'fingerprint') then
    v_flags := v_flags || 'device_mismatch';
  end if;

  if v_now - v_entry.clock_in > interval '16 hours' then
    v_flags := v_flags || 'overlong_shift';
  end if;

  update time_entries set
    clock_out = v_now,
    clock_out_selfie_path = p_selfie_path,
    clock_out_ip = request_ip(),
    clock_out_device = p_device,
    clock_out_location = p_location,
    status = 'closed',
    flags = (
      select coalesce(array_agg(distinct f), '{}')
      from unnest(time_entries.flags || v_flags) as f
    )
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end
$$;

-- Admin-only: approve/reject a correction request; approval applies the times.
create or replace function public.review_time_correction(
  p_request_id uuid,
  p_approve boolean,
  p_notes text default null
)
returns public.time_correction_requests
language plpgsql security definer set search_path = public
as $$
declare
  v_req time_correction_requests;
  v_tz text;
begin
  if not is_admin() then
    raise exception 'Only administrators can review correction requests.';
  end if;

  select * into v_req from time_correction_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Correction request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  if p_approve then
    if v_req.time_entry_id is not null then
      update time_entries set
        clock_in = coalesce(v_req.requested_clock_in, clock_in),
        clock_out = coalesce(v_req.requested_clock_out, clock_out),
        status = case when coalesce(v_req.requested_clock_out, clock_out) is not null
                      then 'closed' else status end,
        manually_edited = true,
        flags = (
          select coalesce(array_agg(distinct f), '{}')
          from unnest(time_entries.flags || array['corrected']) as f
        )
      where id = v_req.time_entry_id;
    else
      if v_req.requested_clock_in is null or v_req.requested_clock_out is null then
        raise exception 'A new-entry correction needs both clock in and clock out times.';
      end if;
      select coalesce(timezone,'Asia/Manila') into v_tz from company_settings where id = 1;
      insert into time_entries (
        employee_id, work_date, clock_in, clock_out,
        source, status, flags, manually_edited, admin_notes
      ) values (
        v_req.employee_id,
        (v_req.requested_clock_in at time zone coalesce(v_tz,'Asia/Manila'))::date,
        v_req.requested_clock_in,
        v_req.requested_clock_out,
        'admin', 'closed', array['corrected'], true,
        'Created from approved correction request'
      );
    end if;
  end if;

  update time_correction_requests set
    status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_notes = p_notes
  where id = p_request_id
  returning * into v_req;

  return v_req;
end
$$;

revoke execute on function public.clock_in(text, jsonb, jsonb) from public, anon;
revoke execute on function public.clock_out(text, jsonb, jsonb) from public, anon;
revoke execute on function public.review_time_correction(uuid, boolean, text) from public, anon;
grant execute on function public.clock_in(text, jsonb, jsonb) to authenticated;
grant execute on function public.clock_out(text, jsonb, jsonb) to authenticated;
grant execute on function public.review_time_correction(uuid, boolean, text) to authenticated;
