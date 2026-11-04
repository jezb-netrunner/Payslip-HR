// auth-guard and admin-users, end to end: the real handlers under Node (a
// Deno shim) against a local Supabase stack — GoTrue and PostgREST behind a
// gateway, on a database with every migration (MEMORY.md → "Browser
// walkthroughs need a local Supabase stack"). It needs the company admin
// OWNER_EMAIL and a client with employees, and it changes that admin's
// password (it ends on PASSWORD below) and authenticator app.
//   STACK_ANON_KEY=… npm run test:edge
// Optional: STACK_URL (http://127.0.0.1:8000), STACK_JWT_SECRET, OWNER_EMAIL,
// ADMIN_PASSWORD_PEPPER (use the local functions server's, so the stack's
// own sign-in keeps working). Have I Been Pwned is stood in for locally.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const URL_ = process.env.STACK_URL ?? 'http://127.0.0.1:8000'
const ANON = process.env.STACK_ANON_KEY ?? ''
const SECRET = process.env.STACK_JWT_SECRET ?? 'local-dev-jwt-secret-at-least-32-characters-long'
const PEPPER = process.env.ADMIN_PASSWORD_PEPPER ?? 'local-qa-pepper-0123456789abcdef0123456789'
const OWNER = process.env.OWNER_EMAIL ?? 'owner@acme.ph'
const PASSWORD = 'Acme2026payroll'
const LEGACY = 'QaTemp2026x' // 11 characters: set before the rule, too short for it
const BREACHED = 'correct horse battery staple'
const EA = `ea-${Date.now()}@acme.ph`

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function sign(payload: Record<string, unknown>) {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
}
const SERVICE = sign({ role: 'service_role', iss: 'supabase', exp: Math.floor(Date.now() / 1000) + 3600 })
const env: Record<string, string> = {
  SUPABASE_URL: URL_,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SUPABASE_ANON_KEY: ANON,
  ADMIN_PASSWORD_PEPPER: PEPPER,
}
/** The password as the Auth server keeps it (auth-guard's keyedPassword). */
const keyed = (pw: string) => `k1.${crypto.createHmac('sha256', PEPPER).update(pw).digest('base64url')}`
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

/** RFC 6238 code of a base32 secret, as an authenticator app shows it. */
function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const mac = crypto.createHmac('sha1', key).update(counter).digest()
  const off = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0')
}

type Handler = (req: Request) => Promise<Response>
async function load(path: string): Promise<Handler> {
  let handler: Handler | null = null
  ;(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => env[k] }, serve: (h: Handler) => { handler = h } }
  await import(path)
  return handler!
}
async function call(h: Handler, body: unknown, token = ANON) {
  const res = await h(
    new Request('http://edge/fn', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: await res.json() }
}
async function api(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}${path}`, {
    ...init,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const rest = (path: string, token: string, init: RequestInit = {}) => api(`/rest/v1/${path}`, token, init)
/** A password grant straight at the Auth API, around the guard. */
const grant = (email: string, password: string) =>
  api('/auth/v1/token?grant_type=password', ANON, { method: 'POST', body: JSON.stringify({ email, password }) })
const state = async (token: string) => (await rest('rpc/my_session_state', token, { method: 'POST', body: '{}' })).body?.state
const employees = async (token: string) => (await rest('employees?select=id', token)).body as unknown[]

/** Each account's authenticator app: enrolled once, then a code per sign-in (the session's second factor). */
const apps = new Map<string, { id: string; secret: string }>()
async function secondFactor(email: string, token: string): Promise<string> {
  let app = apps.get(email)
  if (!app) {
    const made = await api('/auth/v1/factors', token, { method: 'POST', body: JSON.stringify({ factor_type: 'totp', friendly_name: 'phone' }) })
    expect(made.status).toBe(200)
    app = { id: made.body.id, secret: made.body.totp.secret }
    apps.set(email, app)
  }
  const challenge = await api(`/auth/v1/factors/${app.id}/challenge`, token, { method: 'POST', body: '{}' })
  const verified = await api(`/auth/v1/factors/${app.id}/verify`, token, {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challenge.body.id, code: totp(app.secret) }),
  })
  expect(verified.status).toBe(200)
  expect(claimsOf(verified.body.access_token).aal).toBe('aal2')
  return verified.body.access_token
}

let guard: Handler
let users: Handler
let pwned: http.Server
let ownerToken = ''

describe.skipIf(!ANON)('auth-guard and admin-users on a local stack', () => {
  beforeAll(async () => {
    // Have I Been Pwned, stood in for: BREACHED is in a breach, nothing else is
    const sha = crypto.createHash('sha1').update(BREACHED).digest('hex').toUpperCase()
    pwned = http.createServer((req, res) => {
      const prefix = (req.url ?? '').split('/').pop()
      res.end(prefix === sha.slice(0, 5) ? `${sha.slice(5)}:3730471\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0` : '0018A45C4D1DEF81644B54AB7F969B88D65:0')
    })
    await new Promise<void>((resolve) => pwned.listen(0, '127.0.0.1', resolve))
    env.PWNED_PASSWORDS_URL = `http://127.0.0.1:${(pwned.address() as AddressInfo).port}`
    guard = await load(new URL('../auth-guard/index.ts', import.meta.url).pathname)
    users = await load(new URL('../admin-users/index.ts', import.meta.url).pathname)
    // re-runnable: the owner starts with a short password set before the guard
    // (plain at the Auth server) and no authenticator app
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    const put = await api(`/auth/v1/admin/users/${owner.id}`, SERVICE, { method: 'PUT', body: JSON.stringify({ password: LEGACY, ban_duration: 'none' }) })
    expect(put.status).toBe(200)
    const factors = await api(`/auth/v1/admin/users/${owner.id}/factors`, SERVICE)
    for (const f of (factors.body ?? []) as { id: string }[]) await api(`/auth/v1/admin/users/${owner.id}/factors/${f.id}`, SERVICE, { method: 'DELETE' })
    await rest(`auth_guard?email=eq.${OWNER}`, SERVICE, { method: 'DELETE' })
  })
  afterAll(() => new Promise<void>((resolve) => pwned.close(() => resolve())))

  it('a password short of the rule must be changed before a session', async () => {
    const r = await call(guard, { action: 'sign_in', email: OWNER, password: LEGACY })
    expect(r.body).toEqual({ status: 'password_change_required', reason: 'weak' })
  })

  it('refuses a short, breached or reused new password, then changes it and signs in', async () => {
    const short = await call(guard, { action: 'change_password', email: OWNER, password: LEGACY, new_password: 'only8char' })
    expect([short.status, short.body.message]).toEqual([400, 'Use at least 12 characters: a few words make a strong passphrase.'])
    const breached = await call(guard, { action: 'change_password', email: OWNER, password: LEGACY, new_password: BREACHED })
    expect(breached.body.message).toBe('That password appears in known data breaches. Choose another.')
    const same = await call(guard, { action: 'change_password', email: OWNER, password: LEGACY, new_password: LEGACY })
    expect(same.body.message).toMatch(/different/)
    // no letters-and-digits rule: a passphrase of words is fine
    const ok = await call(guard, { action: 'change_password', email: OWNER, password: LEGACY, new_password: 'blue harbor morning tide' })
    expect(ok.body.status).toBe('ok')
    // admitted, but no admin access until the second factor
    const aal1 = ok.body.session.access_token
    expect(claimsOf(aal1).aal).toBe('aal1')
    expect(await employees(aal1)).toEqual([])
    expect(await state(aal1)).toBe('active')
    expect((await call(users, { action: 'admin_security' }, aal1)).body.error).toBe('Finish two-step sign-in first.')
    ownerToken = await secondFactor(OWNER, aal1)
    expect((await employees(ownerToken)).length).toBeGreaterThan(0)
    // back to the stack's shared password (an in-session change needs the second factor)
    const back = await call(guard, { action: 'set_password', current_password: 'blue harbor morning tide', new_password: PASSWORD }, ownerToken)
    expect(back.body.status).toBe('ok')
    ownerToken = await secondFactor(OWNER, back.body.session.access_token)
  })

  it("a password set through the guard can't be confirmed straight at the Auth API", async () => {
    expect((await grant(OWNER, PASSWORD)).status).toBe(400)
    expect((await grant(OWNER, keyed(PASSWORD))).status).toBe(200)
  })

  it('a second sign-in ends the first session at once', async () => {
    await new Promise((r) => setTimeout(r, 1100))
    const again = await call(guard, { action: 'sign_in', email: OWNER, password: PASSWORD })
    expect(again.body.status).toBe('ok')
    const second = await secondFactor(OWNER, again.body.session.access_token)
    expect(await employees(ownerToken)).toEqual([])
    expect(await state(ownerToken)).toBe('ended')
    expect((await employees(second)).length).toBeGreaterThan(0)
    expect(await state(second)).toBe('active')
    ownerToken = second
  })

  it('a session made straight against the Auth API gets no admin access, even with the second factor', async () => {
    const direct = await grant(OWNER, keyed(PASSWORD))
    expect(direct.status).toBe(200)
    const token = await secondFactor(OWNER, direct.body.access_token)
    expect(await employees(token)).toEqual([])
    expect(await state(token)).toBe('ended')
    expect((await call(users, { action: 'admin_security' }, token)).status).toBe(401)
    // nor can it make itself the admitted session
    const self = await rest(`profiles?id=eq.${direct.body.user.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ admin_session_id: null }),
      headers: { Prefer: 'return=representation' },
    })
    expect(self.body).toEqual([])
    expect((await employees(ownerToken)).length).toBeGreaterThan(0)
  })

  it('times a session out after 32 minutes without activity; activity keeps it going', async () => {
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    const old = new Date(Date.now() - 40 * 60_000).toISOString()
    await rest(`admin_session_activity?user_id=eq.${owner.id}`, SERVICE, { method: 'PATCH', body: JSON.stringify({ seen_at: old }) })
    expect(await employees(ownerToken)).toEqual([])
    expect(await state(ownerToken)).toBe('idle')
    expect((await call(users, { action: 'admin_security' }, ownerToken)).body.error).toBe('Your session timed out. Sign in again.')
    // a fresh sign-in, then activity reported by the app
    const again = await call(guard, { action: 'sign_in', email: OWNER, password: PASSWORD })
    ownerToken = await secondFactor(OWNER, again.body.session.access_token)
    const touched = await rest('rpc/touch_admin_session', ownerToken, { method: 'POST', body: '{}' })
    expect(touched.body.state).toBe('active')
    expect(touched.body.idle_seconds).toBeLessThan(5)
  })

  it('creates an entity admin with a temporary password, refusing a short or breached one', async () => {
    const short = await call(users, { action: 'create_admin', email: EA, password: 'short1pass', full_name: 'Eli Admin', role: 'entity_admin', entity_ids: [] }, ownerToken)
    expect(short.body.error).toMatch(/at least 12/)
    const breached = await call(users, { action: 'create_admin', email: EA, password: BREACHED, full_name: 'Eli Admin', role: 'entity_admin', entity_ids: [] }, ownerToken)
    expect(breached.body.error).toMatch(/known data breaches/)
    const made = await call(users, { action: 'create_admin', email: EA, password: 'Temp2026pass', full_name: 'Eli Admin', role: 'entity_admin', entity_ids: [] }, ownerToken)
    expect(made.body.ok).toBe(true)
    expect((await grant(EA, 'Temp2026pass')).status).toBe(400)
    const first = await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })
    expect(first.body).toEqual({ status: 'password_change_required', reason: 'new' })
  })

  it('locks after five failures until a company admin unlocks, without touching live sessions', async () => {
    const answers: unknown[] = []
    for (let i = 0; i < 4; i++) {
      const r = await call(guard, { action: 'sign_in', email: EA, password: `Wrong${i}password` })
      answers.push([r.status, r.body.error, r.body.attempts_left])
    }
    // no count of attempts left: it would tell which emails have an account
    expect(answers).toEqual(Array(4).fill([401, 'invalid', undefined]))
    const fifth = await call(guard, { action: 'sign_in', email: EA, password: 'Wrong4password' })
    expect([fifth.status, fifth.body.error]).toEqual([423, 'locked'])
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })).body.error).toBe('locked')
    // no ban at the Auth server: a lock can't end anyone's live session
    expect((await grant(EA, keyed('Temp2026pass'))).status).toBe(200)
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    const status = await call(users, { action: 'admin_security' }, ownerToken)
    const row = status.body.accounts.find((a: { user_id: string }) => a.user_id === eli.id)
    expect(row.locked_until).toBeTruthy()
    expect(row.temporary_password).toBe(true)
    expect((await call(users, { action: 'unlock_admin', user_id: eli.id }, ownerToken)).body.ok).toBe(true)
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })).body.status).toBe('password_change_required')
  })

  it('concurrent wrong passwords count one by one', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => call(guard, { action: 'sign_in', email: EA, password: `Burst${i}password` })))
    expect(all.map((r) => r.status).sort()).toEqual([401, 401, 401, 401, 423, 423, 423, 423])
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    expect((await call(users, { action: 'unlock_admin', user_id: eli.id }, ownerToken)).body.ok).toBe(true)
  })

  it('an unknown email gets the answer a wrong password gets, and nothing is stored', async () => {
    const ghost = `ghost-${Date.now()}@acme.ph`
    const r = await call(guard, { action: 'sign_in', email: ghost, password: 'Whatever2026pass' })
    expect([r.status, r.body]).toEqual([401, { error: 'invalid' }])
    expect((await rest(`auth_guard?email=eq.${ghost}`, SERVICE)).body).toEqual([])
  })

  it('a company admin resets a lost authenticator; the account sets up a new one', async () => {
    // the entity admin sets their own password and authenticator
    const changed = await call(guard, { action: 'change_password', email: EA, password: 'Temp2026pass', new_password: 'quiet river lantern 7' })
    expect(changed.body.status).toBe('ok')
    await secondFactor(EA, changed.body.session.access_token)
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    let row = (await call(users, { action: 'admin_security' }, ownerToken)).body.accounts.find((a: { user_id: string }) => a.user_id === eli.id)
    expect([row.mfa_factors, row.temporary_password]).toEqual([1, false])
    expect((await call(users, { action: 'reset_mfa', user_id: eli.id }, ownerToken)).body.ok).toBe(true)
    row = (await call(users, { action: 'admin_security' }, ownerToken)).body.accounts.find((a: { user_id: string }) => a.user_id === eli.id)
    expect(row.mfa_factors).toBe(0)
    apps.delete(EA)
    const next = await call(guard, { action: 'sign_in', email: EA, password: 'quiet river lantern 7' })
    expect(next.body.status).toBe('ok')
    // a new authenticator app, from a password-only session: allowed only because none is left
    await secondFactor(EA, next.body.session.access_token)
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    expect((await call(users, { action: 'reset_mfa', user_id: owner.id }, ownerToken)).body.error).toMatch(/your own/)
  })

  it("resets another admin's password as a temporary one, never one's own", async () => {
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    const reset = await call(users, { action: 'update_admin', user_id: eli.id, password: 'Reset2026passw' }, ownerToken)
    expect(reset.body.ok).toBe(true)
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Reset2026passw' })).body).toEqual({ status: 'password_change_required', reason: 'new' })
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    const own = await call(users, { action: 'update_admin', user_id: owner.id, password: 'Mine2026password' }, ownerToken)
    expect([own.status, own.body.error]).toEqual([400, 'Change your own password from the account menu (the key icon by your name).'])
  })

  it('an in-session password change needs the current password and the second factor', async () => {
    const no = await call(guard, { action: 'set_password', new_password: 'Another2026password' }, ownerToken)
    expect(no.body.error).toMatch(/current password/)
    const again = await call(guard, { action: 'sign_in', email: OWNER, password: PASSWORD })
    const aal1 = again.body.session.access_token
    const noFactor = await call(guard, { action: 'set_password', current_password: PASSWORD, new_password: 'Another2026password' }, aal1)
    expect([noFactor.status, noFactor.body.error]).toEqual([403, 'mfa_required'])
    ownerToken = await secondFactor(OWNER, aal1)
    const ok = await call(guard, { action: 'set_password', current_password: PASSWORD, new_password: 'Another2026password' }, ownerToken)
    expect(ok.body.status).toBe('ok')
    const back = await call(guard, { action: 'set_password', current_password: 'Another2026password', new_password: PASSWORD }, await secondFactor(OWNER, ok.body.session.access_token))
    expect(back.body.status).toBe('ok')
  })

  it('the trail has the sign-ins, failures, lockouts, password changes, resets, unlocks and two-step resets', async () => {
    const svc = await rest(`audit_logs?select=action&table_name=eq.activity&order=id.desc&limit=120`, SERVICE)
    const actions = new Set((svc.body as { action: string }[]).map((r) => r.action))
    for (const a of ['sign_in', 'sign_in_failed', 'sign_in_locked', 'password_change', 'password_reset', 'unlock', 'mfa_reset']) {
      expect(actions.has(a)).toBe(true)
    }
  })
})
