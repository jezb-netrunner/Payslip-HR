// Account provisioning for Payslip-HR (service role; deployed with verify_jwt).
//
// Employee logins (company admins, or entity admins of the employee's client):
//   set_employee_code          {employee_id, code_part}  create/replace the login code
//   set_employee_login_active  {employee_id, active}
// Admin accounts (company admins only):
//   create_admin               {email, password, full_name, role, entity_ids?}
//   update_admin               {user_id, full_name?, entity_ids?, active?, password?}
//
// Employee login codes are "<CLIENT CODE>-<PART>". Supabase Auth needs an
// email, so each code maps to a synthetic address derived from a SHA-256 of
// the code, and the code itself is the password (stored only as Supabase's
// bcrypt hash; the derived address is kept only in auth.users, never in
// admin-readable tables). KEEP THE DERIVATION IN SYNC with src/lib/loginCode.ts.
// Another company admin's account can never be managed from here.
import { createClient } from "npm:@supabase/supabase-js@2";

const EMPLOYEE_LOGIN_DOMAIN = "jezb-netrunner.github.io";
const HASH_PREFIX = "payslip-hr/employee-login/v1:";

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

async function employeeLoginEmail(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(HASH_PREFIX + code),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `emp-${hex.slice(0, 32)}@${EMPLOYEE_LOGIN_DOMAIN}`;
}

function isAlreadyRegistered(message: string | undefined): boolean {
  return /already (been )?registered|already exists|duplicate/i.test(message ?? "");
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
    const callerId = userData.user.id;

    const { data: caller } = await admin
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", callerId)
      .single();
    if (
      !caller || !caller.is_active ||
      (caller.role !== "company_admin" && caller.role !== "entity_admin")
    ) {
      return json({ error: "Admin access required" }, 403);
    }
    const isCompanyAdmin = caller.role === "company_admin";

    async function canManageEntity(entityId: string): Promise<boolean> {
      if (isCompanyAdmin) return true;
      const { data } = await admin
        .from("entity_admins")
        .select("entity_id, entities!inner(is_active)")
        .eq("profile_id", callerId)
        .eq("entity_id", entityId)
        .eq("entities.is_active", true)
        .maybeSingle();
      return !!data;
    }

    async function loadEmployee(employeeId: string) {
      const { data } = await admin
        .from("employees")
        .select("id, entity_id, first_name, last_name, employee_no, entities(code)")
        .eq("id", employeeId)
        .maybeSingle();
      if (!data || !(await canManageEntity(data.entity_id))) return null;
      return data as unknown as {
        id: string;
        entity_id: string;
        first_name: string;
        last_name: string;
        employee_no: string;
        entities: { code: string } | null;
      };
    }

    const body = await req.json();
    const action = body?.action as string;

    // ---------------- employee login codes ----------------
    if (action === "set_employee_code") {
      const part = String(body.code_part ?? "").toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9]{8,24}$/.test(part)) {
        return json({ error: "The code must be 8–24 letters or digits." }, 400);
      }
      const emp = await loadEmployee(String(body.employee_id ?? ""));
      if (!emp || !emp.entities?.code) return json({ error: "Employee not found" }, 404);
      if (part === emp.employee_no.toUpperCase().replace(/[^A-Z0-9]/g, "")) {
        return json({ error: "Don't use the employee number as the login code — it is easy to guess." }, 400);
      }

      const code = `${emp.entities.code}-${part}`;
      const email = await employeeLoginEmail(code);
      const fullName = `${emp.first_name} ${emp.last_name}`.trim();
      const inUse = {
        error: "That code is already used by another employee of this client. Choose a different code.",
      };

      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .eq("employee_id", emp.id)
        .maybeSingle();

      if (!existing) {
        const { data: created, error: createErr } = await admin.auth.admin
          .createUser({
            email,
            password: code,
            email_confirm: true,
            app_metadata: { role: "employee", employee_id: emp.id },
            user_metadata: { full_name: fullName },
          });
        if (createErr || !created?.user) {
          if (isAlreadyRegistered(createErr?.message)) return json(inUse, 409);
          return json({ error: createErr?.message ?? "Failed to create login" }, 400);
        }
        // The on_auth_user_created trigger creates the profile; upsert to be
        // safe and to guarantee the employee link. No email on the profile:
        // it is derived from the code, and admins can read profiles.
        await admin.from("profiles").upsert({
          id: created.user.id,
          role: "employee",
          employee_id: emp.id,
          email: null,
          full_name: fullName,
          is_active: true,
        });
      } else {
        const { error: updErr } = await admin.auth.admin.updateUserById(
          existing.id,
          { email, password: code, email_confirm: true },
        );
        if (updErr) {
          if (isAlreadyRegistered(updErr.message)) return json(inUse, 409);
          return json({ error: updErr.message }, 400);
        }
        await admin.from("profiles").update({ email: null, full_name: fullName }).eq(
          "id",
          existing.id,
        );
        // the old code must stop working everywhere, not just for new sign-ins
        await admin.rpc("revoke_user_sessions", { p_user: existing.id });
      }

      await admin
        .from("employees")
        .update({
          login_code_hint: part.slice(-3),
          login_code_set_at: new Date().toISOString(),
        })
        .eq("id", emp.id);
      return json({ ok: true, code });
    }

    if (action === "set_employee_login_active") {
      if (typeof body.active !== "boolean") {
        return json({ error: "active(boolean) is required" }, 400);
      }
      const emp = await loadEmployee(String(body.employee_id ?? ""));
      if (!emp) return json({ error: "Employee not found" }, 404);
      const { data: prof } = await admin
        .from("profiles")
        .select("id")
        .eq("employee_id", emp.id)
        .maybeSingle();
      if (!prof) return json({ error: "This employee has no login code yet" }, 404);
      const { error: banErr } = await admin.auth.admin.updateUserById(prof.id, {
        ban_duration: body.active ? "none" : "876000h",
      });
      if (banErr) return json({ error: banErr.message }, 400);
      await admin.from("profiles").update({ is_active: body.active }).eq("id", prof.id);
      if (!body.active) await admin.rpc("revoke_user_sessions", { p_user: prof.id });
      return json({ ok: true });
    }

    // ---------------- admin accounts (company admins only) ----------------
    if (!isCompanyAdmin) {
      return json({ error: "Company admin access required" }, 403);
    }

    async function setAssignments(userId: string, entityIds: unknown) {
      if (!Array.isArray(entityIds)) return;
      const ids = entityIds.map(String);
      await admin.from("entity_admins").delete().eq("profile_id", userId);
      if (ids.length > 0) {
        const { data: valid } = await admin.from("entities").select("id").in("id", ids);
        const rows = (valid ?? []).map((e: { id: string }) => ({
          profile_id: userId,
          entity_id: e.id,
        }));
        if (rows.length > 0) await admin.from("entity_admins").insert(rows);
      }
    }

    if (action === "create_admin") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const fullName = String(body.full_name ?? "").trim();
      const role = body.role;
      if (!email || !fullName) return json({ error: "Name and email are required" }, 400);
      if (password.length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400);
      }
      if (role !== "company_admin" && role !== "entity_admin") {
        return json({ error: "Role must be company_admin or entity_admin" }, 400);
      }
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role },
        user_metadata: { full_name: fullName },
      });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message ?? "Failed to create user" }, 400);
      }
      await admin.from("profiles").upsert({
        id: created.user.id,
        role,
        employee_id: null,
        email,
        full_name: fullName,
        is_active: true,
      });
      if (role === "entity_admin") await setAssignments(created.user.id, body.entity_ids);
      return json({ ok: true, user_id: created.user.id });
    }

    if (action === "update_admin") {
      const userId = String(body.user_id ?? "");
      const { data: target } = await admin
        .from("profiles")
        .select("id, role")
        .eq("id", userId)
        .maybeSingle();
      if (!target || (target.role !== "company_admin" && target.role !== "entity_admin")) {
        return json({ error: "Admin account not found" }, 404);
      }
      // Company admins manage themselves only — never each other.
      if (target.role === "company_admin" && userId !== callerId) {
        return json({ error: "Another company admin's account cannot be managed here" }, 403);
      }
      if (typeof body.active === "boolean") {
        if (userId === callerId && !body.active) {
          return json({ error: "You cannot deactivate your own account" }, 400);
        }
        const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
          ban_duration: body.active ? "none" : "876000h",
        });
        if (banErr) return json({ error: banErr.message }, 400);
        const { error: profErr } = await admin.from("profiles").update({ is_active: body.active }).eq("id", userId);
        if (profErr) return json({ error: profErr.message }, 400);
        if (!body.active) await admin.rpc("revoke_user_sessions", { p_user: userId });
      }
      if (typeof body.password === "string" && body.password.length > 0) {
        if (body.password.length < 8) {
          return json({ error: "Password must be at least 8 characters" }, 400);
        }
        const { error: pwErr } = await admin.auth.admin.updateUserById(userId, {
          password: body.password,
        });
        if (pwErr) return json({ error: pwErr.message }, 400);
      }
      if (typeof body.full_name === "string" && body.full_name.trim()) {
        await admin.from("profiles").update({ full_name: body.full_name.trim() }).eq("id", userId);
      }
      if (target.role === "entity_admin" && body.entity_ids !== undefined) {
        await setAssignments(userId, body.entity_ids);
      }
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
