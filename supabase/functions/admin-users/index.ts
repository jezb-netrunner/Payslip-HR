// Account provisioning for Payslip-HR (service role; deployed with verify_jwt).
//
// Employee logins (company admins, or entity admins of the employee's client):
//   set_employee_code          {employee_id, code_part}  create/replace the login code
//   set_employee_login_active  {employee_id, active}
// Admin accounts (company admins only):
//   create_admin               {email, password, full_name, role, entity_ids?}
//   update_admin               {user_id, full_name?, entity_ids?, active?, password?}
//   admin_security             {}         lockouts, last sign-in, password age, two-step
//   unlock_admin               {user_id}  ends a lockout after failed sign-ins
//   reset_mfa                  {user_id}  removes an entity admin's authenticator apps
// A password set here for someone else is temporary: the sign-in guard
// (auth-guard) makes them change it at their next sign-in. It follows the
// guard's rule (12+ characters, screened against known breaches) and is kept
// at the Auth server keyed (HMAC under ADMIN_PASSWORD_PEPPER), as the guard
// keeps every admin password. Resets, unlocks and two-step resets are on the
// audit trail. A caller's admin session must meet the guard's rules: the
// admitted session, its second factor, within its time limits.
//
// Employee login codes are "<CLIENT CODE>-<PART>". Supabase Auth needs an
// email, so each code maps to an address and a password, both HMACs of the
// code under ADMIN_PASSWORD_PEPPER: the address is in every access token and
// stored session, and without the secret it says nothing about the code, nor
// can the Auth API alone confirm a guessed code. Employees sign in through
// auth-guard, which makes the same two. KEEP THE DERIVATION IN SYNC with
// auth-guard.
// Another company admin's account can never be managed from here.
import { createClient } from "npm:@supabase/supabase-js@2";

const EMPLOYEE_LOGIN_DOMAIN = "jezb-netrunner.github.io";

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

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The Auth address of an employee login code. KEEP IN SYNC with auth-guard. */
export async function employeeLoginEmail(code: string, pepper: string): Promise<string> {
  const mac = await hmac(pepper, "payslip-hr/employee-login-email/v2:" + code);
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `emp2-${hex.slice(0, 32)}@${EMPLOYEE_LOGIN_DOMAIN}`;
}

/** The password the Auth server keeps for an employee login code. KEEP IN SYNC with auth-guard. */
export async function employeeLoginPassword(code: string, pepper: string): Promise<string> {
  return "e1." + base64url(await hmac(pepper, "payslip-hr/employee-login-password/v2:" + code));
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
  const length = [...password].length;
  if (length < 12) return "Use at least 12 characters: a few words make a strong passphrase.";
  if (length > 128) return "Use at most 128 characters.";
  if (/^(.)\1+$/su.test(password)) return "Don't repeat one character.";
  const lower = password.toLowerCase();
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 3 && lower.includes(local)) {
    return "Don't put the email name in the password.";
  }
  if (lower.includes("payslip")) return "Don't put the app's name in the password.";
  return null;
}

/**
 * How often the password appears in known data breaches (Have I Been Pwned,
 * k-anonymity); null when the service doesn't answer. KEEP IN SYNC with
 * breachCount in auth-guard.
 */
async function breachCount(password: string, base: string): Promise<number | null> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password)));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  try {
    const r = await fetch(`${base}/range/${hex.slice(0, 5)}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    for (const line of (await r.text()).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === hex.slice(5)) return Number(count) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * The password as the Auth server keeps it: an HMAC of it under a server
 * secret. KEEP IN SYNC with keyedPassword in auth-guard.
 */
export async function keyedPassword(password: string, pepper: string): Promise<string> {
  return "k1." + base64url(await hmac(pepper, password));
}

function tokenClaims(token: string): { iat?: number; session_id?: string; aal?: string } {
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
    if (caller.admin_session_id) {
      // the admin session rules (as admin_session_ok): the second factor, and
      // within 12 hours of sign-in and 32 minutes of the last activity
      if (token.aal !== "aal2") return json({ error: "Finish two-step sign-in first." }, 403);
      const { data: clock, error: clockErr } = await admin
        .from("admin_session_activity")
        .select("started_at, seen_at")
        .eq("user_id", callerId)
        .eq("session_id", caller.admin_session_id)
        .maybeSingle();
      if (clockErr) throw clockErr;
      if (
        !clock || Date.now() - new Date(clock.started_at).getTime() >= 12 * 3600_000 ||
        Date.now() - new Date(clock.seen_at).getTime() >= 32 * 60_000
      ) {
        return json({ error: "Your session timed out. Sign in again." }, 401);
      }
    }
    const isCompanyAdmin = caller.role === "company_admin";

    // Database writes from here on name the admin they act for: the audit
    // trigger takes the actor from x-actor-id on service-role requests.
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-actor-id": callerId } },
    });
    const pepper = Deno.env.get("ADMIN_PASSWORD_PEPPER") ?? "";
    const pwnedUrl = Deno.env.get("PWNED_PASSWORDS_URL") ?? "https://api.pwnedpasswords.com";
    /** A temporary password from a known data breach is refused like a short one. */
    const breached = async (pw: string) => ((await breachCount(pw, pwnedUrl)) ?? 0) > 0;
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

      if (pepper.length < 32) {
        return json({ error: "Login codes can't be set: the ADMIN_PASSWORD_PEPPER secret is missing." }, 500);
      }
      const code = `${emp.entities.code}-${part}`;
      const email = await employeeLoginEmail(code, pepper);
      const loginPassword = await employeeLoginPassword(code, pepper);
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
            password: loginPassword,
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
        // it is derived from the code, and admins can read profiles (keyed,
        // it would give nothing away, but nothing needs it there).
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
          { email, password: loginPassword, email_confirm: true },
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
      if (await breached(password)) return json({ error: "Temporary password: it appears in known data breaches. Choose another." }, 400);
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
      const { error: guardErr } = await db
        .from("auth_guard")
        .upsert({ email, password_changed_at: null, temporary_password: true, updated_at: new Date().toISOString() });
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
        if (await breached(body.password)) return json({ error: "Password: it appears in known data breaches. Choose another." }, 400);
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
            temporary_password: true,
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
        ? await db
          .from("auth_guard")
          .select("email, failed_attempts, locked_until, last_sign_in_at, password_changed_at, temporary_password")
          .in("email", emails)
        : { data: [] };
      const byEmail = new Map((guards ?? []).map((g: { email: string }) => [g.email, g]));
      // each account's verified authenticator apps (two-step sign-in)
      const factors = await Promise.all(
        (admins ?? []).map(async (a: { id: string }) => {
          const { data } = await admin.auth.admin.mfa.listFactors({ userId: a.id });
          return (data?.factors ?? []).filter((f: { status: string }) => f.status === "verified").length;
        }),
      );
      return json({
        accounts: (admins ?? []).map((a: { id: string; email: string | null }, i: number) => ({
          user_id: a.id,
          ...(byEmail.get(String(a.email ?? "").toLowerCase()) ?? {}),
          mfa_factors: factors[i],
        })),
      });
    }

    if (action === "reset_mfa") {
      // a lost phone: the account sets up two-step sign-in again at its next sign-in
      const userId = String(body.user_id ?? "");
      if (userId === callerId) return json({ error: "Manage your own two-step sign-in from the account menu." }, 400);
      const { data: target } = await db.from("profiles").select("id, role, email").eq("id", userId).maybeSingle();
      if (!target || (target.role !== "company_admin" && target.role !== "entity_admin")) {
        return json({ error: "Admin account not found" }, 404);
      }
      if (target.role === "company_admin") {
        return json({ error: "Another company admin's account cannot be managed here" }, 403);
      }
      const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
      if (listErr) return json({ error: listErr.message }, 400);
      for (const f of listed?.factors ?? []) {
        const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
        if (delErr) return json({ error: delErr.message }, 400);
      }
      // its sessions end: the next sign-in sets up a new authenticator
      await db.rpc("revoke_user_sessions", { p_user: userId });
      await auditAccount("mfa_reset", String(target.email ?? userId).toLowerCase());
      return json({ ok: true });
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
