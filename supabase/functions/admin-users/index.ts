// Admin-only user provisioning for Payslip-HR.
// Actions: create_employee_account, reset_password, set_active.
// The caller's JWT must belong to an active admin profile.
// Admin accounts cannot be reset/deactivated by other admins.
// Deployed with verify_jwt = true.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Not authenticated" }, 401);
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("role, is_active")
      .eq("id", userData.user.id)
      .single();
    if (!profile || profile.role !== "admin" || !profile.is_active) {
      return json({ error: "Admin access required" }, 403);
    }

    // Guard: admin accounts can only be managed by themselves, never by a
    // co-admin — prevents one admin hijacking or locking out another.
    async function isProtectedTarget(user_id: string): Promise<boolean> {
      if (user_id === userData!.user!.id) return false;
      const { data: target } = await admin
        .from("profiles")
        .select("role")
        .eq("id", user_id)
        .maybeSingle();
      return target?.role === "admin";
    }

    const body = await req.json();
    const action = body?.action as string;

    if (action === "create_employee_account") {
      const { employee_id, email, password } = body;
      if (!employee_id || !email || !password) {
        return json(
          { error: "employee_id, email and password are required" },
          400,
        );
      }
      if (typeof password !== "string" || password.length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400);
      }
      const { data: emp } = await admin
        .from("employees")
        .select("id, first_name, last_name")
        .eq("id", employee_id)
        .single();
      if (!emp) return json({ error: "Employee not found" }, 404);

      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .eq("employee_id", employee_id)
        .maybeSingle();
      if (existing) {
        return json({ error: "This employee already has an account" }, 409);
      }

      const fullName = `${emp.first_name} ${emp.last_name}`.trim();
      const { data: created, error: createErr } = await admin.auth.admin
        .createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { role: "employee", employee_id },
          user_metadata: { full_name: fullName },
        });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message ?? "Failed to create user" }, 400);
      }

      // The on_auth_user_created trigger creates the profile; upsert to be safe
      // and to guarantee the employee link.
      await admin.from("profiles").upsert({
        id: created.user.id,
        role: "employee",
        employee_id,
        email,
        full_name: fullName,
        is_active: true,
      });

      return json({ ok: true, user_id: created.user.id });
    }

    if (action === "reset_password") {
      const { user_id, password } = body;
      if (!user_id || !password) {
        return json({ error: "user_id and password are required" }, 400);
      }
      if (typeof password !== "string" || password.length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400);
      }
      if (await isProtectedTarget(user_id)) {
        return json(
          { error: "Another administrator's account cannot be managed here" },
          403,
        );
      }
      const { error: updErr } = await admin.auth.admin.updateUserById(user_id, {
        password,
      });
      if (updErr) return json({ error: updErr.message }, 400);
      return json({ ok: true });
    }

    if (action === "set_active") {
      const { user_id, active } = body;
      if (!user_id || typeof active !== "boolean") {
        return json({ error: "user_id and active(boolean) are required" }, 400);
      }
      if (user_id === userData.user.id && !active) {
        return json({ error: "You cannot deactivate your own account" }, 400);
      }
      if (await isProtectedTarget(user_id)) {
        return json(
          { error: "Another administrator's account cannot be managed here" },
          403,
        );
      }
      const { error: banErr } = await admin.auth.admin.updateUserById(user_id, {
        ban_duration: active ? "none" : "876000h",
      });
      if (banErr) return json({ error: banErr.message }, 400);
      await admin.from("profiles").update({ is_active: active }).eq(
        "id",
        user_id,
      );
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
