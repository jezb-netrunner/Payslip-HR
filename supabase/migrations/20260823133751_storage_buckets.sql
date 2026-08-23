-- ============================================================
-- Storage: private buckets for punch selfies and employee photos
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('punch-selfies', 'punch-selfies', false, 5242880, array['image/jpeg','image/png','image/webp']),
  ('employee-photos', 'employee-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Punch selfies: employees may only upload into their own folder
-- (<employee_id>/...), may view their own; admins view all. No updates or
-- deletes by employees — selfies are evidence.
create policy "punch selfies: employee upload own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'punch-selfies'
    and (storage.foldername(name))[1] = (public.current_employee_id())::text
  );

create policy "punch selfies: read own or admin"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'punch-selfies'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = (public.current_employee_id())::text
    )
  );

create policy "punch selfies: admin delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'punch-selfies' and public.is_admin());

-- Employee photos: admin manages; any authenticated user can view (directory).
create policy "employee photos: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'employee-photos');

create policy "employee photos: admin insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-photos' and public.is_admin());

create policy "employee photos: admin update"
  on storage.objects for update to authenticated
  using (bucket_id = 'employee-photos' and public.is_admin())
  with check (bucket_id = 'employee-photos' and public.is_admin());

create policy "employee photos: admin delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'employee-photos' and public.is_admin());
