# Run Supabase security advisors after every DDL change

> `get_advisors(type=security)` caught real hardening gaps after the initial migrations: functions without pinned `search_path`, and SECURITY DEFINER functions executable by `anon`/`authenticated` via PostgREST /rpc — fixed in migration `harden_function_privileges`.

The recurring checklist for this project:
- Every function: `set search_path = public` (definer *and* plain trigger fns).
- Trigger functions: `revoke execute ... from public, anon, authenticated` —
  triggers still fire (they run as table owner); nobody should reach them via
  `/rest/v1/rpc/...`.
- RLS helper functions (`is_admin`, `current_employee_id`, `run_is_finalized`,
  `run_has_own_payslip`): revoke from `anon` only. `authenticated` MUST keep
  EXECUTE because policies evaluate them with the calling role's privileges.
- Intentional RPCs (`clock_in`, `clock_out`, `review_time_correction`): anon
  revoked, authenticated granted — the advisor still lists them as WARN; that
  is by design (they're the app's punch API), so don't "fix" them.

Why it mattered: the advisor's anon-executable findings were genuine exposure
(any unauthenticated caller could invoke definer functions); and future
migrations will re-introduce this class of issue unless the checklist is
re-run each time.
