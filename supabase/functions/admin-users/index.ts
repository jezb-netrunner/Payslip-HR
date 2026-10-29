// Account provisioning for Payslip-HR (service role; deployed with verify_jwt).
//
// Employee logins (company admins, or entity admins of the employee's client):
//   set_employee_code          {employee_id, code_part}  create/replace the login code
//   set_employee_login_active  {employee_id, active}
// Admin accounts (company admins only):
//   create_admin               {email, password, full_name, role, entity_ids?}
//   update_admin               {user_id, full_name?, entity_ids?, active?, password?}
//   admin_security             {}         lockouts, last sign-in, password age
//   unlock_admin               {user_id}  ends a lockout after failed sign-ins
// A password set here for someone else is temporary: the sign-in guard
// (auth-guard) makes them change it at their next sign-in. It is kept at
// the Auth server keyed (HMAC under ADMIN_PASSWORD_PEPPER), as the guard
// keeps every admin password. Resets and unlocks are on the audit trail.
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

/** KEEP IN SYNC with weakCodeReason in src/lib/loginCode.ts. */
function weakCodeReason(part: string, employeeNo = "", names: string[] = []): string | null {
  if (!/^[A-Z0-9]{8,24}$/.test(part)) return "The code must be 8–24 letters or digits.";
  if (part === employeeNo.toUpperCase().replace(/[^A-Z0-9]/g, "")) {
    return "Don't use the employee number as the login code — it is easy to guess.";
  }
  if (/^[0-9]+$/.test(part)) {
    return "Mix in letters: an all-number code (a date, a phone number) is easy to guess.";
  }
  if (/^[A-Z]+$/.test(part)) {
    return "Mix in digits: an all-letter code (a word or a name) is easy to guess.";
  }
  const name = names
    .map((n) => n.toUpperCase().replace(/[^A-Z]/g, ""))
    .find((n) => n.length >= 3 && part.includes(n));
  if (name) return "Don't put the employee's name in the login code.";
  if (new Set(part).size < 5) return "Use at least 5 different characters.";
  const steps = [...part].slice(1).map((c, i) => c.charCodeAt(0) - part.charCodeAt(i));
  if (steps.every((d) => d === 1) || steps.every((d) => d === -1)) {
    return "Avoid runs like ABCDEFGH or 23456789.";
  }
  return null;
}

/** KEEP IN SYNC with passwordProblem in src/lib/password.ts and auth-guard. */
function passwordProblem(password: string, email = ""): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password.length > 72) return "Use at most 72 characters.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Mix letters and digits.";
  }
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 3 && password.toLowerCase().includes(local)) {
    return "Don't put the email name in the password.";
  }
  return null;
}

/**
 * The password as the Auth server keeps it: an HMAC of it under a server
 * secret. KEEP IN SYNC with keyedPassword in auth-guard.
 */
async function keyedPassword(password: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password)));
  return "k1." + btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenClaims(token: string): { iat?: number; session_id?: string } {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + (4 - (part.length % 4)) % 4, "=")));
  } catch {
    return {};
  }
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
      .select("id, role, is_active, email, sessions_revoked_at, admin_session_id")
      .eq("id", callerId)
      .single();
    if (
      !caller || !caller.is_active ||
      (caller.role !== "company_admin" && caller.role !== "entity_admin")
    ) {
      return json({ error: "Admin access required" }, 403);
    }
    // one active session: only the session the sign-in guard admitted acts,
    // and none older than a revocation (as the RLS helpers check)
    const token = tokenClaims(jwt);
    if (
      (caller.sessions_revoked_at && Number(token.iat ?? 0) < Math.floor(new Date(caller.sessions_revoked_at).getTime() / 1000)) ||
      (caller.admin_session_id && token.session_id !== caller.admin_session_id)
    ) {
      return json({ error: "Your session ended: this account signed in elsewhere. Sign in again." }, 401);
    }
    const isCompanyAdmin = caller.role === "company_admin";

    // Database writes from here on name the admin they act for: the audit
    // trigger takes the actor from x-actor-id on service-role requests.
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-actor-id": callerId } },
    });
    const pepper = Deno.env.get("ADMIN_PASSWORD_PEPPER") ?? "";
    const callerEmail = (caller.email as string | null) ?? null;

    // an admin account's action on the audit trail (the account rows hold no trace of it)
    async function auditAccount(action: string, target: string, detail: Record<string, unknown> = {}) {
      const { error } = await db.from("audit_logs").insert({
        actor_id: callerId,
        actor_email: callerEmail,
        action,
        table_name: "activity",
        record_id: null,
        entity_id: null,
        new_data: { ...detail, account: target, via: "admin users" },
      });
      if (error) throw error;
    }

    async function canManageEntity(entityId: string): Promise<boolean> {
      if (isCompanyAdmin) return true;
      const { data } = await db
        .from("entity_admins")
        .select("entity_id, entities!inner(is_active)")
        .eq("profile_id", callerId)
        .eq("entity_id", entityId)
        .eq("entities.is_active", true)
        .maybeSingle();
      return !!data;
    }

    async function loadEmployee(employeeId: string) {
      const { data } = await db
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
      const weak = weakCodeReason(part, emp.employee_no, [emp.first_name, emp.last_name]);
      if (weak) return json({ error: weak }, 400);

      const code = `${emp.entities.code}-${part}`;
      const email = await employeeLoginEmail(code);
      const fullName = `${emp.first_name} ${emp.last_name}`.trim();
      const inUse = {
        error: "That code is already used by another employee of this client. Choose a different code.",
      };

      const { data: existing } = await db
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
        await db.from("profiles").upsert({
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
        await db.from("profiles").update({ email: null, full_name: fullName }).eq(
          "id",
          existing.id,
        );
        // the old code must stop working everywhere, not just for new sign-ins
        await db.rpc("revoke_user_sessions", { p_user: existing.id });
      }

      await db
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
      const { data: prof } = await db
        .from("profiles")
        .select("id")
        .eq("employee_id", emp.id)
        .maybeSingle();
      if (!prof) return json({ error: "This employee has no login code yet" }, 404);
      const { error: banErr } = await admin.auth.admin.updateUserById(prof.id, {
        ban_duration: body.active ? "none" : "876000h",
      });
      if (banErr) return json({ error: banErr.message }, 400);
      await db.from("profiles").update({ is_active: body.active }).eq("id", prof.id);
      if (!body.active) await db.rpc("revoke_user_sessions", { p_user: prof.id });
      return json({ ok: true });
    }

    // ---------------- admin accounts (company admins only) ----------------
    if (!isCompanyAdmin) {
      return json({ error: "Company admin access required" }, 403);
    }

    async function setAssignments(userId: string, entityIds: unknown) {
      if (!Array.isArray(entityIds)) return;
      const ids = entityIds.map(String);
      await db.from("entity_admins").delete().eq("profile_id", userId);
      if (ids.length > 0) {
        const { data: valid } = await db.from("entities").select("id").in("id", ids);
        const rows = (valid ?? []).map((e: { id: string }) => ({
          profile_id: userId,
          entity_id: e.id,
        }));
        if (rows.length > 0) await db.from("entity_admins").insert(rows);
      }
    }

    if (action === "create_admin") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const fullName = String(body.full_name ?? "").trim();
      const role = body.role;
      if (!email || !fullName) return json({ error: "Name and email are required" }, 400);
      const weak = passwordProblem(password, email);
      if (weak) return json({ error: `Temporary password: ${weak}` }, 400);
      if (role !== "company_admin" && role !== "entity_admin") {
        return json({ error: "Role must be company_admin or entity_admin" }, 400);
      }
      if (pepper.length < 32) return json({ error: "Admin passwords can't be set: the ADMIN_PASSWORD_PEPPER secret is missing." }, 500);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: await keyedPassword(password, pepper),
        email_confirm: true,
        app_metadata: { role },
        user_metadata: { full_name: fullName },
      });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message ?? "Failed to create user" }, 400);
      }
      const { error: profErr } = await db.from("profiles").upsert({
        id: created.user.id,
        role,
        employee_id: null,
        email,
        full_name: fullName,
        is_active: true,
        // no session has admin access until the first sign-in through the guard
        admin_session_id: crypto.randomUUID(),
      });
      if (profErr) {
        // no half-made admin: the account goes with its profile
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: profErr.message }, 400);
      }
      if (role === "entity_admin") await setAssignments(created.user.id, body.entity_ids);
      // a temporary password: changed at the first sign-in
      const { error: guardErr } = await db.from("auth_guard").upsert({ email, password_changed_at: null, updated_at: new Date().toISOString() });
      if (guardErr) return json({ error: guardErr.message }, 400);
      return json({ ok: true, user_id: created.user.id });
    }

    if (action === "update_admin") {
      const userId = String(body.user_id ?? "");
      const { data: target } = await db
        .from("profiles")
        .select("id, role, email")
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
        const { error: profErr } = await db.from("profiles").update({ is_active: body.active }).eq("id", userId);
        if (profErr) return json({ error: profErr.message }, 400);
        if (!body.active) await db.rpc("revoke_user_sessions", { p_user: userId });
      }
      if (typeof body.password === "string" && body.password.length > 0) {
        // your own password changes through the sign-in guard (account menu):
        // it asks for the current one and starts the new session; set here,
        // the Auth server would end this session with nothing to replace it
        if (userId === callerId) {
          return json({ error: "Change your own password from the account menu (the key icon by your name)." }, 400);
        }
        const targetEmail = String(target.email ?? "").toLowerCase();
        const weak = passwordProblem(body.password, targetEmail);
        if (weak) return json({ error: `Password: ${weak}` }, 400);
        if (pepper.length < 32) return json({ error: "Admin passwords can't be set: the ADMIN_PASSWORD_PEPPER secret is missing." }, 500);
        const { error: pwErr } = await admin.auth.admin.updateUserById(userId, {
          password: await keyedPassword(body.password, pepper),
        });
        if (pwErr) return json({ error: pwErr.message }, 400);
        if (targetEmail) {
          // a password set here is temporary (changed at the next sign-in),
          // and the account's sessions end now
          const { error: guardErr } = await db.from("auth_guard").upsert({
            email: targetEmail,
            password_changed_at: null,
            updated_at: new Date().toISOString(),
          });
          if (guardErr) return json({ error: guardErr.message }, 400);
        }
        await db.rpc("revoke_user_sessions", { p_user: userId });
        await auditAccount("password_reset", targetEmail || userId);
      }
      if (typeof body.full_name === "string" && body.full_name.trim()) {
        await db.from("profiles").update({ full_name: body.full_name.trim() }).eq("id", userId);
      }
      if (target.role === "entity_admin" && body.entity_ids !== undefined) {
        await setAssignments(userId, body.entity_ids);
      }
      return json({ ok: true });
    }

    if (action === "admin_security") {
      const { data: admins } = await db
        .from("profiles")
        .select("id, email")
        .in("role", ["company_admin", "entity_admin"]);
      const emails = (admins ?? []).map((a: { email: string | null }) => String(a.email ?? "").toLowerCase()).filter(Boolean);
      const { data: guards } = emails.length > 0
        ? await db.from("auth_guard").select("email, failed_attempts, locked_until, last_sign_in_at, password_changed_at").in("email", emails)
        : { data: [] };
      const byEmail = new Map((guards ?? []).map((g: { email: string }) => [g.email, g]));
      return json({
        accounts: (admins ?? []).map((a: { id: string; email: string | null }) => ({
          user_id: a.id,
          ...(byEmail.get(String(a.email ?? "").toLowerCase()) ?? {}),
        })),
      });
    }

    if (action === "unlock_admin") {
      const userId = String(body.user_id ?? "");
      const { data: target } = await db
        .from("profiles")
        .select("id, role, email, is_active")
        .eq("id", userId)
        .maybeSingle();
      if (!target || (target.role !== "company_admin" && target.role !== "entity_admin") || !target.email) {
        return json({ error: "Admin account not found" }, 404);
      }
      const { error: guardErr } = await db.from("auth_guard").upsert({
        email: String(target.email).toLowerCase(),
        failed_attempts: 0,
        locked_until: null,
        last_failed_at: null,
        updated_at: new Date().toISOString(),
      });
      if (guardErr) return json({ error: guardErr.message }, 400);
      await auditAccount("unlock", String(target.email).toLowerCase());
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
