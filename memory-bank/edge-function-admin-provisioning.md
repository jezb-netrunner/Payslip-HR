# Employee logins: admin-users edge function + first-signup bootstrap

> Employee auth accounts can't be created from the browser with the anon key, so the `admin-users` edge function (service role, deployed with verify_jwt) does it — and the very first account ever created in auth becomes the admin via the `handle_new_user` trigger.

Flow:
1. Bootstrap: Login page has "create the admin account"; `handle_new_user`
   makes the first-ever profile `role='admin'` (any later self-signup becomes a
   role-less `employee` profile with no employee link — harmless, admin can
   delete).
2. Admin creates an employee record, then on the employee's Account tab calls
   the edge function `create_employee_account {employee_id, email, password}`.
   The function verifies the caller's JWT belongs to an active admin profile,
   creates the auth user with `app_metadata: {role:'employee', employee_id}`
   (email pre-confirmed), and upserts the profile link.
3. `reset_password` and `set_active` (ban/unban ~100y + profiles.is_active)
   are the other actions. Self-deactivation is blocked.

Gotchas learned:
- The DB trigger creates the profile from `raw_app_meta_data`; the function's
  upsert is a belt-and-suspenders for the employee link.
- Supabase edge functions get SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env
  automatically — no secrets in the repo.
- Client must send the user's access token (not the anon key) as the
  Authorization bearer (`callAdminUsers` in `src/lib/api.ts`).

Why it mattered: without this, the only alternatives were sharing the service
key with the browser (unacceptable) or asking employees to self-signup
(defeats admin control of who exists in payroll).
