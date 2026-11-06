-- Output reports, faster. The three storage policies of the output-reports
-- bucket called can_manage_output_report(name) once per object: a plpgsql
-- path parse, an employees lookup and can_manage_employee (a profiles +
-- session lookup). 5,000 reports took 1.6 to 3.3 s to list on the replica.
-- Now the caller part runs once per statement, as for the tables
-- (20261106083347_admin_policies_initplan):
--
--   managed_output_report_keys()  client/employee (two uuids, as text) of
--                                 every employee the caller manages
--
-- and each policy asks whether the first two path segments, joined, are one
-- of those keys (a hashed lookup), for a path with a folder of at least two
-- segments (name LIKE '%/%/%': storage.foldername drops the file name).
-- The same answer as can_manage_output_report(name): a key can only match if
-- both segments are those canonical uuids, which is what its uuid checks
-- asked, and the employee of the second belongs to the client of the first
-- and is one the caller may manage, which is what its lookups asked. Any
-- other path matches no key. can_manage_output_report itself is unchanged.

create or replace function public.managed_output_report_keys()
returns setof text language sql stable security definer set search_path = public as $$
  select e.entity_id::text || '/' || e.id::text
  from employees e
  where e.id in (select public.managed_employee_ids())
$$;

revoke execute on function public.managed_output_report_keys() from public, anon;
grant execute on function public.managed_output_report_keys() to authenticated;

alter policy "output reports: admins read" on storage.objects
  using (((bucket_id = 'output-reports'::text) AND (name ~~ '%/%/%'::text)
    AND ((split_part(name, '/'::text, 1) || '/'::text || split_part(name, '/'::text, 2)) IN (select public.managed_output_report_keys()))));

alter policy "output reports: admins remove" on storage.objects
  using (((bucket_id = 'output-reports'::text) AND (name ~~ '%/%/%'::text)
    AND ((split_part(name, '/'::text, 1) || '/'::text || split_part(name, '/'::text, 2)) IN (select public.managed_output_report_keys()))));

alter policy "output reports: admins upload" on storage.objects
  with check (((bucket_id = 'output-reports'::text) AND (name ~~ '%/%/%'::text)
    AND ((split_part(name, '/'::text, 1) || '/'::text || split_part(name, '/'::text, 2)) IN (select public.managed_output_report_keys()))));
