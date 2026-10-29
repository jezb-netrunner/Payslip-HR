// auth-guard and admin-users, end to end: the real handlers under Node (a
// Deno shim) against a local Supabase stack — GoTrue and PostgREST behind a
// gateway, on a database with every migration (MEMORY.md → "Browser
// walkthroughs need a local Supabase stack"). It needs the company admin
// OWNER_EMAIL and a client with employees, and it changes that admin's
// password (it ends on PASSWORD below).
//   STACK_ANON_KEY=… npm run test:edge
// Optional: STACK_URL (http://127.0.0.1:8000), STACK_JWT_SECRET, OWNER_EMAIL,
// ADMIN_PASSWORD_PEPPER (use the local functions server's, so the stack's
// own sign-in keeps working).
import { beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'

const URL_ = process.env.STACK_URL ?? 'http://127.0.0.1:8000'
const ANON = process.env.STACK_ANON_KEY ?? ''
const SECRET = process.env.STACK_JWT_SECRET ?? 'local-dev-jwt-secret-at-least-32-characters-long'
const PEPPER = process.env.ADMIN_PASSWORD_PEPPER ?? 'local-qa-pepper-0123456789abcdef0123456789'
const OWNER = process.env.OWNER_EMAIL ?? 'owner@acme.ph'
const PASSWORD = 'Acme2026payroll'
const TEMP = 'QaTemp2026x'
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
async function rest(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
/** A password grant straight at the Auth API, around the guard. */
async function grant(email: string, password: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { status: r.status, body: await r.json() }
}
const active = async (token: string) => (await rest('rpc/my_session_active', token, { method: 'POST', body: '{}' })).body

let guard: Handler
let users: Handler
let ownerToken = ''

describe.skipIf(!ANON)('auth-guard and admin-users on a local stack', () => {
  beforeAll(async () => {
    guard = await load(new URL('../auth-guard/index.ts', import.meta.url).pathname)
    users = await load(new URL('../admin-users/index.ts', import.meta.url).pathname)
    // re-runnable: the owner starts with a password set before the guard (plain at the Auth server)
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    const put = await fetch(`${URL_}/auth/v1/admin/users/${owner.id}`, {
      method: 'PUT',
      headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEMP, ban_duration: 'none' }),
    })
    expect(put.status).toBe(200)
    await rest(`auth_guard?email=eq.${OWNER}`, SERVICE, { method: 'DELETE' })
  })

  it('a password never changed through the guard must be changed before a session', async () => {
    const r = await call(guard, { action: 'sign_in', email: OWNER, password: TEMP })
    expect(r.body).toEqual({ status: 'password_change_required', reason: 'new' })
  })

  it('refuses a weak or reused new password, then changes it and signs in', async () => {
    const weak = await call(guard, { action: 'change_password', email: OWNER, password: TEMP, new_password: 'onlyletters' })
    expect([weak.status, weak.body.message]).toEqual([400, 'Mix letters and digits.'])
    const same = await call(guard, { action: 'change_password', email: OWNER, password: TEMP, new_password: TEMP })
    expect(same.body.message).toMatch(/different/)
    const ok = await call(guard, { action: 'change_password', email: OWNER, password: TEMP, new_password: PASSWORD })
    expect(ok.body.status).toBe('ok')
    ownerToken = ok.body.session.access_token
    expect((await rest('employees?select=id', ownerToken)).body.length).toBeGreaterThan(0)
  })

  it("a password set through the guard can't be confirmed straight at the Auth API", async () => {
    expect((await grant(OWNER, PASSWORD)).status).toBe(400)
    expect((await grant(OWNER, keyed(PASSWORD))).status).toBe(200)
  })

  it('a second sign-in ends the first session at once', async () => {
    await new Promise((r) => setTimeout(r, 1100))
    const again = await call(guard, { action: 'sign_in', email: OWNER, password: PASSWORD })
    expect(again.body.status).toBe('ok')
    const second = again.body.session.access_token
    expect((await rest('employees?select=id', ownerToken)).body).toEqual([])
    expect(await active(ownerToken)).toBe(false)
    expect((await rest('employees?select=id', second)).body.length).toBeGreaterThan(0)
    expect(await active(second)).toBe(true)
    ownerToken = second
  })

  it('a session made straight against the Auth API gets no admin access', async () => {
    const direct = await grant(OWNER, keyed(PASSWORD))
    expect(direct.status).toBe(200)
    const token = direct.body.access_token
    expect((await rest('employees?select=id', token)).body).toEqual([])
    expect(await active(token)).toBe(false)
    const viaUsers = await call(users, { action: 'admin_security' }, token)
    expect(viaUsers.status).toBe(401)
    // nor can it make itself the admitted session
    const self = await rest(`profiles?id=eq.${direct.body.user.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ admin_session_id: null }),
      headers: { Prefer: 'return=representation' },
    })
    expect(self.body).toEqual([])
    expect((await rest('employees?select=id', ownerToken)).body.length).toBeGreaterThan(0)
  })

  it('creates an entity admin with a temporary password, refusing a weak one', async () => {
    const weak = await call(users, { action: 'create_admin', email: EA, password: 'short1', full_name: 'Eli Admin', role: 'entity_admin', entity_ids: [] }, ownerToken)
    expect(weak.body.error).toMatch(/at least 8/)
    const made = await call(users, { action: 'create_admin', email: EA, password: 'Temp2026pass', full_name: 'Eli Admin', role: 'entity_admin', entity_ids: [] }, ownerToken)
    expect(made.body.ok).toBe(true)
    expect((await grant(EA, 'Temp2026pass')).status).toBe(400)
    const first = await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })
    expect(first.body).toEqual({ status: 'password_change_required', reason: 'new' })
  })

  it('locks after five failures until a company admin unlocks, without touching live sessions', async () => {
    const answers: unknown[] = []
    for (let i = 0; i < 4; i++) {
      const r = await call(guard, { action: 'sign_in', email: EA, password: `Wrong${i}pass` })
      answers.push([r.status, r.body.error, r.body.attempts_left])
    }
    // no count of attempts left: it would tell which emails have an account
    expect(answers).toEqual(Array(4).fill([401, 'invalid', undefined]))
    const fifth = await call(guard, { action: 'sign_in', email: EA, password: 'Wrong4pass' })
    expect([fifth.status, fifth.body.error]).toEqual([423, 'locked'])
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })).body.error).toBe('locked')
    // no ban at the Auth server: a lock can't end anyone's live session
    expect((await grant(EA, keyed('Temp2026pass'))).status).toBe(200)
    const status = await call(users, { action: 'admin_security' }, ownerToken)
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    expect(status.body.accounts.find((a: { user_id: string }) => a.user_id === eli.id)?.locked_until).toBeTruthy()
    expect((await call(users, { action: 'unlock_admin', user_id: eli.id }, ownerToken)).body.ok).toBe(true)
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Temp2026pass' })).body.status).toBe('password_change_required')
  })

  it('concurrent wrong passwords count one by one', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => call(guard, { action: 'sign_in', email: EA, password: `Burst${i}pass` })))
    const statuses = all.map((r) => r.status).sort()
    expect(statuses).toEqual([401, 401, 401, 401, 423, 423, 423, 423])
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    expect((await call(users, { action: 'unlock_admin', user_id: eli.id }, ownerToken)).body.ok).toBe(true)
  })

  it('an unknown email gets the answer a wrong password gets, and nothing is stored', async () => {
    const ghost = `ghost-${Date.now()}@acme.ph`
    const r = await call(guard, { action: 'sign_in', email: ghost, password: 'Whatever2026' })
    expect([r.status, r.body]).toEqual([401, { error: 'invalid' }])
    expect((await rest(`auth_guard?email=eq.${ghost}`, SERVICE)).body).toEqual([])
  })

  it("resets another admin's password as a temporary one, never one's own", async () => {
    const eli = (await rest(`profiles?select=id&email=eq.${encodeURIComponent(EA)}`, ownerToken)).body[0]
    const reset = await call(users, { action: 'update_admin', user_id: eli.id, password: 'Reset2026pw' }, ownerToken)
    expect(reset.body.ok).toBe(true)
    expect((await call(guard, { action: 'sign_in', email: EA, password: 'Reset2026pw' })).body.status).toBe('password_change_required')
    const owner = (await rest(`profiles?select=id&email=eq.${OWNER}`, SERVICE)).body[0]
    const own = await call(users, { action: 'update_admin', user_id: owner.id, password: 'Mine2026pw' }, ownerToken)
    expect([own.status, own.body.error]).toEqual([400, 'Change your own password from the account menu (the key icon by your name).'])
  })

  it('set_password from a session needs the current password', async () => {
    const no = await call(guard, { action: 'set_password', new_password: 'Another2026pw' }, ownerToken)
    expect(no.body.error).toMatch(/current password/)
    const ok = await call(guard, { action: 'set_password', current_password: PASSWORD, new_password: 'Another2026pw' }, ownerToken)
    expect(ok.body.status).toBe('ok')
    // back to the stack's shared password
    const back = await call(guard, { action: 'set_password', current_password: 'Another2026pw', new_password: PASSWORD }, ok.body.session.access_token)
    expect(back.body.status).toBe('ok')
  })

  it('the trail has the sign-ins, failures, lockouts, password changes, resets and unlocks', async () => {
    const svc = await rest(`audit_logs?select=action&table_name=eq.activity&order=id.desc&limit=80`, SERVICE)
    const actions = new Set((svc.body as { action: string }[]).map((r) => r.action))
    for (const a of ['sign_in', 'sign_in_failed', 'sign_in_locked', 'password_change', 'password_reset', 'unlock']) expect(actions.has(a)).toBe(true)
  })
})
