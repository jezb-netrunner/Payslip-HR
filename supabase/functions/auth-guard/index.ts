// Sign-in guard for admin accounts. Deployed with verify_jwt OFF: sign_in
// and change_password come before there is a session (and the publishable
// key is not a JWT); set_password checks the caller's own token itself.
// BIR RMO 9-2021 Annex B, system security:
//   - five failed sign-ins in a row lock the account for 30 minutes
//   - one active session: a sign-in here signs the account out everywhere
//     else, and only the session admitted here has admin access (the RLS
//     helpers compare the token's session_id with profiles.admin_session_id,
//     so a sign-in made straight against the Auth API gets none)
//   - a temporary password, or one older than 30 days, must be changed
//     before the account gets a session
//   - passwords mix letters and digits (KEEP IN SYNC with src/lib/password.ts)
// The password is checked in the database (guard_sign_in: the lock, bcrypt
// and the count in one transaction), never by asking the Auth server with a
// wrong one: all requests from here share one IP address at the Auth
// server, whose per-IP limit a flood of wrong passwords would use up for
// every admin. A password set here is kept at the Auth server keyed (an
// HMAC under ADMIN_PASSWORD_PEPPER, an edge-function secret), so guessing
// straight against the Auth API gets nowhere either. Every sign-in, failure,
// lockout and password change is on the audit trail.
//
//   sign_in          {email, password}
//   change_password  {email, password, new_password}   (signs in afterwards)
//   set_password     {new_password, current_password?} (signed in: after a
//                    reset link, or from the account menu)
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 30;
const PASSWORD_DAYS = 30;

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

/** KEEP IN SYNC with passwordProblem in src/lib/password.ts. */
export function passwordProblem(password: string, email = ""): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password.length > 72) return "Use at most 72 characters.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Mix letters and digits.";
  }
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 3 && password.toLowerCase().includes(local)) {
    return "Don't put your email name in the password.";
  }
  return null;
}

/**
 * The password as the Auth server keeps it: an HMAC of it under a server
 * secret, so the Auth API alone can't confirm a guess. KEEP IN SYNC with
 * admin-users.
 */
export async function keyedPassword(password: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password)));
  return "k1." + btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user: { id: string; email?: string };
}

function claims(token: string): { sub?: string; iat?: number; session_id?: string; amr?: { method: string }[] } {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + (4 - (part.length % 4)) % 4, "=")));
  } catch {
    return {};
  }
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const pepper = Deno.env.get("ADMIN_PASSWORD_PEPPER") ?? "";
    if (pepper.length < 32) {
      return json({ error: "The sign-in guard is not set up: the ADMIN_PASSWORD_PEPPER secret is missing." }, 500);
    }
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const agent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
    const now = () => new Date().toISOString();

    async function audit(action: string, email: string, actor: string | null, detail: Record<string, unknown> = {}) {
      const { error } = await db.from("audit_logs").insert({
        actor_id: actor,
        actor_email: email,
        action,
        table_name: "activity",
        record_id: null,
        entity_id: null,
        new_data: { ...detail, ip, user_agent: agent, via: "admin sign-in" },
      });
      if (error) throw error;
    }

    async function passwordGrant(email: string, password: string): Promise<{ session?: Session; status: number; message?: string; code?: string }> {
      const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) return { session: body as Session, status: 200 };
      return { status: r.status, message: body.msg ?? body.error_description ?? body.message, code: body.error_code ?? body.error };
    }

    async function signOut(accessToken: string, scope: "local" | "others") {
      await fetch(`${supabaseUrl}/auth/v1/logout?scope=${scope}`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      });
    }

    async function guardRow(email: string) {
      const { data, error } = await db.from("auth_guard").select("*").eq("email", email).maybeSingle();
      if (error) throw error;
      return data as
        | { email: string; failed_attempts: number; locked_until: string | null; last_failed_at: string | null; password_changed_at: string | null }
        | null;
    }

    async function adminProfile(userId: string) {
      const { data, error } = await db.from("profiles").select("id, role, is_active, email").eq("id", userId).maybeSingle();
      if (error) throw error;
      return data as { id: string; role: string; is_active: boolean; email: string | null } | null;
    }

    // an unknown email answers about as slowly as a real one's bcrypt check
    const jitter = () => new Promise((resolve) => setTimeout(resolve, 60 + Math.floor(Math.random() * 90)));

    /**
     * The lock, then the password, in the database (one transaction, the
     * account's guard row locked). Gives the password in the form the Auth
     * server keeps it: keyed, or as typed for one set before the guard.
     */
    async function checkPassword(email: string, password: string): Promise<Response | { form: string }> {
      const keyed = await keyedPassword(password, pepper);
      const { data, error } = await db.rpc("guard_sign_in", {
        p_email: email,
        p_password: password,
        p_keyed: keyed,
        p_max: MAX_FAILURES,
        p_lock_minutes: LOCK_MINUTES,
        p_ip: ip,
        p_agent: agent,
      });
      if (error) throw error;
      const r = data as { result: string; keyed?: boolean; locked_until?: string };
      if (r.result === "ok") return { form: r.keyed ? keyed : password };
      // a hash only the Auth server reads: it checks the password as typed
      if (r.result === "upstream") return { form: password };
      if (r.result === "locked") return json({ error: "locked", locked_until: r.locked_until }, 423);
      if (r.result === "no_account") await jitter();
      // the same answer whether or not the account exists, and no count of
      // attempts left: either would tell which emails have an account
      return json({ error: "invalid" }, 401);
    }

    /** A session from the Auth server for a password the database accepted. */
    async function grant(email: string, form: string): Promise<Response | Session> {
      const r = await passwordGrant(email, form);
      if (r.session) return r.session;
      if (r.status === 400 && /invalid/i.test(`${r.code} ${r.message}`)) {
        // an upstream hash the Auth server rejected: counted like any failure
        const { data, error } = await db.rpc("guard_record_failure", {
          p_email: email,
          p_max: MAX_FAILURES,
          p_lock_minutes: LOCK_MINUTES,
          p_ip: ip,
          p_agent: agent,
        });
        if (error) throw error;
        const f = data as { result: string; locked_until?: string };
        return f.result === "locked" ? json({ error: "locked", locked_until: f.locked_until }, 423) : json({ error: "invalid" }, 401);
      }
      if (/banned/i.test(`${r.code} ${r.message}`)) return json({ error: "deactivated" }, 403);
      if (r.status === 429) return json({ error: "rate_limited" }, 429);
      return json({ error: r.message ?? "Sign-in failed" }, r.status >= 400 && r.status < 600 ? r.status : 500);
    }

    async function verify(email: string, password: string): Promise<Response | Session> {
      const checked = await checkPassword(email, password);
      if (checked instanceof Response) return checked;
      return await grant(email, checked.form);
    }

    /** One active session: this one gets admin access, every other session ends now. */
    async function admit(email: string, session: Session, how: string): Promise<Response> {
      const c = claims(session.access_token);
      // without its id the session couldn't be told from any other
      if (!c.session_id) throw new Error("The Auth server returned a session without an id.");
      await signOut(session.access_token, "others");
      const { error: admitErr } = await db
        .from("profiles")
        .update({
          admin_session_id: c.session_id,
          ...(c.iat ? { sessions_revoked_at: new Date(c.iat * 1000).toISOString() } : {}),
        })
        .eq("id", session.user.id);
      if (admitErr) throw admitErr;
      const guard = await guardRow(email);
      const { error: guardErr } = await db.from("auth_guard").upsert({
        email,
        failed_attempts: 0,
        locked_until: null,
        last_failed_at: null,
        last_sign_in_at: now(),
        password_changed_at: guard?.password_changed_at ?? null,
        updated_at: now(),
      });
      if (guardErr) throw guardErr;
      await audit("sign_in", email, session.user.id, { how });
      return json({ status: "ok", session });
    }

    function passwordDue(changedAt: string | null | undefined): "new" | "expired" | null {
      if (!changedAt) return "new";
      return Date.now() - new Date(changedAt).getTime() > PASSWORD_DAYS * 86_400_000 ? "expired" : null;
    }

    /** Sets the new password (keyed) and records the change. Gives the keyed form to sign in with. */
    async function setNewPassword(userId: string, email: string, newPassword: string): Promise<Response | string> {
      const problem = passwordProblem(newPassword, email);
      if (problem) return json({ error: "weak_password", message: problem }, 400);
      const form = await keyedPassword(newPassword, pepper);
      const { error } = await db.auth.admin.updateUserById(userId, { password: form });
      if (error) {
        return json({ error: "weak_password", message: /same/i.test(error.message) ? "Choose a password different from the current one." : error.message }, 400);
      }
      const guard = await guardRow(email);
      const { error: guardErr } = await db.from("auth_guard").upsert({
        email,
        failed_attempts: guard?.failed_attempts ?? 0,
        locked_until: guard?.locked_until ?? null,
        last_failed_at: guard?.last_failed_at ?? null,
        password_changed_at: now(),
        updated_at: now(),
      });
      if (guardErr) throw guardErr;
      await audit("password_change", email, userId);
      return form;
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    if (action === "sign_in" || action === "change_password") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email || !password) return json({ error: "Enter the email and password." }, 400);
      const verified = await verify(email, password);
      if (verified instanceof Response) return verified;
      const prof = await adminProfile(verified.user.id);
      if (!prof || (prof.role !== "company_admin" && prof.role !== "entity_admin")) {
        await signOut(verified.access_token, "local");
        return json({ error: "not_admin" }, 403);
      }
      if (!prof.is_active) {
        await signOut(verified.access_token, "local");
        return json({ error: "deactivated" }, 403);
      }
      if (action === "sign_in") {
        const due = passwordDue((await guardRow(email))?.password_changed_at);
        if (due) {
          // no session until the password is changed
          await signOut(verified.access_token, "local");
          return json({ status: "password_change_required", reason: due });
        }
        return await admit(email, verified, "password");
      }
      const newPassword = String(body.new_password ?? "");
      if (newPassword === password) {
        await signOut(verified.access_token, "local");
        return json({ error: "weak_password", message: "Choose a password different from the current one." }, 400);
      }
      // (a new password ends the account's sessions at the Auth server, this one included)
      const set = await setNewPassword(verified.user.id, email, newPassword);
      if (set instanceof Response) {
        await signOut(verified.access_token, "local");
        return set;
      }
      const fresh = await passwordGrant(email, set);
      if (!fresh.session) return json({ error: fresh.message ?? "Sign-in failed" }, 500);
      return await admit(email, fresh.session, "password change");
    }

    if (action === "set_password") {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const { data: userData, error: userErr } = await db.auth.getUser(jwt);
      if (userErr || !userData?.user?.email) return json({ error: "Not authenticated" }, 401);
      const user = userData.user;
      const email = user.email!.toLowerCase();
      const prof = await adminProfile(user.id);
      if (!prof || !prof.is_active || (prof.role !== "company_admin" && prof.role !== "entity_admin")) {
        return json({ error: "not_admin" }, 403);
      }
      // a reset-link session proves the mailbox: no current password needed
      const recovery = (claims(jwt).amr ?? []).some((m) => m.method === "recovery" || m.method === "otp");
      const newPassword = String(body.new_password ?? "");
      if (!recovery) {
        const current = String(body.current_password ?? "");
        if (!current) return json({ error: "Enter your current password." }, 400);
        if (current === newPassword) return json({ error: "weak_password", message: "Choose a password different from the current one." }, 400);
        // checked in the database: no session is made for it
        const checked = await checkPassword(email, current);
        if (checked instanceof Response) return checked;
      }
      const set = await setNewPassword(user.id, email, newPassword);
      if (set instanceof Response) return set;
      // the account's other sessions ended with the old password
      const fresh = await passwordGrant(email, set);
      if (!fresh.session) return json({ error: fresh.message ?? "Sign-in failed" }, 500);
      return await admit(email, fresh.session, recovery ? "reset link" : "password change");
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
