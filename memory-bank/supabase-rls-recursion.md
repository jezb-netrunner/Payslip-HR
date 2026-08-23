# RLS policies that reference each other's tables recurse

> Payslips' employee policy checks the run's status while payroll_runs' employee policy checks for an own payslip — written naively as subqueries, Postgres raises "infinite recursion detected in policy"; the fix is SECURITY DEFINER helper functions.

Pattern used (`functions_and_triggers` migration):
- `run_is_finalized(uuid)` and `run_has_own_payslip(uuid)` are
  `security definer` SQL functions (they bypass RLS on the tables they read),
  and the policies call these instead of inline subqueries.
- Same trick for the classic profiles self-reference: `is_admin()` /
  `current_employee_id()` read `profiles` as definer, so "admin can read all
  profiles" doesn't recurse into itself.

Rules that came with it:
- Always `set search_path = public` on definer functions.
- Revoke EXECUTE from `anon` on the helpers, keep it for `authenticated`
  (policies evaluate functions with the *calling* role's privileges, so
  authenticated must retain EXECUTE or every SELECT fails).
- Trigger functions get EXECUTE revoked from everyone — PostgREST exposes any
  executable function under /rpc, and the security advisors flag it.

Why it mattered: the first naive policy draft would have thrown runtime errors
on the employee payslip list — caught at design time because this is a known
Supabase pitfall, then verified against the security advisors.
