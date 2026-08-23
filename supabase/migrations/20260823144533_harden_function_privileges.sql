-- Address security advisor findings:
-- 1) pin search_path on remaining functions
-- 2) trigger functions should not be RPC-executable at all
-- 3) helper functions should not be callable by anon

alter function public.set_updated_at() set search_path = public;
alter function public.request_ip() set search_path = public;

-- trigger-only functions: nobody needs EXECUTE (triggers run as table owner)
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.audit_trigger() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.prevent_finalized_payslip_change() from public, anon, authenticated;
revoke execute on function public.protect_finalized_run() from public, anon, authenticated;

-- RLS helper functions: needed by authenticated (policies evaluate them as the
-- calling role), never by anon
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.current_employee_id() from public, anon;
revoke execute on function public.run_is_finalized(uuid) from public, anon;
revoke execute on function public.run_has_own_payslip(uuid) from public, anon;
revoke execute on function public.request_ip() from public, anon;
