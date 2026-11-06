// auth-guard's employee sign-in, without a stack: the real handler under Node
// (a Deno shim), with the database and the Auth server faked at the HTTP
// level. The budget of failed sign-ins itself is tested in SQL (suite 25).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'

const URL_ = 'http://stack.test'
const PEPPER = 'unit-test-pepper-0123456789abcdef0123456789'
const USER = '00000000-0000-0000-0000-00000000e001'
const env: Record<string, string> = {
  SUPABASE_URL: URL_,
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
  ADMIN_PASSWORD_PEPPER: PEPPER,
}

type Handler = (req: Request) => Promise<Response>
interface Derivation {
  employeeLoginEmail: (code: string, pepper: string) => Promise<string>
  employeeLoginPassword: (code: string, pepper: string) => Promise<string>
  keyedPassword: (password: string, pepper: string) => Promise<string>
}
async function load(path: string): Promise<{ handler: Handler; mod: Derivation }> {
  let handler: Handler | null = null
  ;(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => env[k] }, serve: (h: Handler) => { handler = h } }
  const mod = (await import(path)) as Derivation
  return { handler: handler!, mod }
}

const mac = (message: string) => crypto.createHmac('sha256', PEPPER).update(message).digest()
const keyedEmail = (code: string) => `emp2-${mac(`payslip-hr/employee-login-email/v2:${code}`).toString('hex').slice(0, 32)}@jezb-netrunner.github.io`
const keyedPassword = (code: string) => `e1.${mac(`payslip-hr/employee-login-password/v2:${code}`).toString('base64url')}`
/** The address the browser used to derive: an unsalted SHA-256 of the code. */
const legacyEmail = (code: string) => `emp-${crypto.createHash('sha256').update(`payslip-hr/employee-login/v1:${code}`).digest('hex').slice(0, 32)}@jezb-netrunner.github.io`

// the fake network: what the handler sent, and what it gets back
let calls: { url: string; body: Record<string, unknown> | undefined }[] = []
let rpc: { status: number; body: unknown } = { status: 200, body: {} }
let token: { status: number; body: unknown } = { status: 200, body: {} }
const reply = (r: { status: number; body: unknown }) =>
  new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
const session = (id = USER) => ({ access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id } })
const sent = (path: string) => calls.filter((c) => c.url.startsWith(`${URL_}${path}`))

let guard: Handler
let guardMod: Derivation
let usersMod: Derivation

beforeAll(async () => {
  ;({ handler: guard, mod: guardMod } = await load('../auth-guard/index.ts'))
  ;({ mod: usersMod } = await load('../admin-users/index.ts'))
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === `${URL_}/rest/v1/rpc/employee_sign_in_check`) return reply(rpc)
    if (url === `${URL_}/auth/v1/token?grant_type=password`) return reply(token)
    if (url.startsWith(`${URL_}/auth/v1/logout`)) return new Response(null, { status: 204 })
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
})

beforeEach(() => {
  calls = []
  rpc = { status: 200, body: { result: 'ok', user_id: USER } }
  token = { status: 200, body: session() }
})

async function signIn(code: string, origin?: string) {
  const res = await guard(
    new Request('http://edge/auth-guard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ action: 'employee_sign_in', code }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('employee sign-in through auth-guard', () => {
  it('maps a right code to its keyed address and password, and returns the session', async () => {
    const r = await signIn(' acme–7q4k x9tb ')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ok', session: { access_token: 'a.b.c', refresh_token: 'r' } })
    const [check] = sent('/rest/v1/rpc/employee_sign_in_check')
    expect(check.body).toMatchObject({ p_client: 'ACME', p_email: keyedEmail('ACME-7Q4KX9TB'), p_max: 50, p_window_minutes: 15 })
    const [grant] = sent('/auth/v1/token')
    expect(grant.body).toEqual({ email: keyedEmail('ACME-7Q4KX9TB'), password: keyedPassword('ACME-7Q4KX9TB') })
    // nothing public is enough to make the address: not the old recipe, not the code
    expect(JSON.stringify(calls)).not.toContain(legacyEmail('ACME-7Q4KX9TB'))
    expect(grant.body?.password).not.toBe('ACME-7Q4KX9TB')
  })

  it('the address depends on the secret, and both functions derive the same', async () => {
    const code = 'ACME-7Q4KX9TB'
    expect(await guardMod.employeeLoginEmail(code, PEPPER)).toMatch(/^emp2-[0-9a-f]{32}@jezb-netrunner\.github\.io$/)
    expect(await guardMod.employeeLoginEmail(code, PEPPER)).not.toBe(await guardMod.employeeLoginEmail(code, `${PEPPER}x`))
    for (const c of [code, 'KM5-ABCD2345', 'Z9-QWERTY234567']) {
      expect(await usersMod.employeeLoginEmail(c, PEPPER)).toBe(await guardMod.employeeLoginEmail(c, PEPPER))
      expect(await usersMod.employeeLoginPassword(c, PEPPER)).toBe(await guardMod.employeeLoginPassword(c, PEPPER))
    }
  })

  it('admin passwords keep the keyed form the Auth server already holds', async () => {
    // a different form would lock every admin out at the next sign-in
    const stored = `k1.${crypto.createHmac('sha256', PEPPER).update('Acme2026payroll').digest('base64url')}`
    expect(await guardMod.keyedPassword('Acme2026payroll', PEPPER)).toBe(stored)
    expect(await usersMod.keyedPassword('Acme2026payroll', PEPPER)).toBe(stored)
  })

  it('refuses a malformed code without asking the database', async () => {
    for (const code of ['ACME7Q4KX9TB', 'ACME-1234', '', '-ABCDEFGH']) {
      expect(await signIn(code)).toEqual({ status: 401, body: { error: 'invalid' } })
    }
    expect(calls).toEqual([])
  })

  it('a wrong code, a deactivated login or a throttled client never reaches the Auth server', async () => {
    rpc = { status: 200, body: { result: 'invalid' } }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 401, body: { error: 'invalid' } })
    rpc = { status: 200, body: { result: 'deactivated' } }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 403, body: { error: 'deactivated' } })
    rpc = { status: 200, body: { result: 'throttled', retry_at: '2026-11-06T10:15:00Z' } }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 429, body: { error: 'throttled', retry_at: '2026-11-06T10:15:00Z' } })
    expect(sent('/auth/v1/token')).toEqual([])
  })

  it('passes on a busy Auth server, and refuses a session for any other account', async () => {
    token = { status: 429, body: { error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' } }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 429, body: { error: 'rate_limited' } })
    token = { status: 400, body: { error_code: 'user_banned', msg: 'User is banned' } }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 403, body: { error: 'deactivated' } })
    token = { status: 200, body: session('00000000-0000-0000-0000-00000000e999') }
    expect(await signIn('ACME-7Q4KX9TB')).toEqual({ status: 401, body: { error: 'invalid' } })
    expect(sent('/auth/v1/logout')).toHaveLength(1)
  })

  it("only the app's own pages may call it", async () => {
    expect(await signIn('ACME-7Q4KX9TB', 'https://evil.example')).toEqual({ status: 403, body: { error: 'origin_not_allowed' } })
    expect(calls).toEqual([])
    expect((await signIn('ACME-7Q4KX9TB', 'https://jezb-netrunner.github.io')).status).toBe(200)
    expect((await signIn('ACME-7Q4KX9TB', 'http://localhost:5173')).status).toBe(200)
  })

  it("keeps a server error's details out of the answer", async () => {
    rpc = { status: 500, body: { code: 'XX000', message: 'relation "employee_sign_in_failures" does not exist' } }
    const r = await signIn('ACME-7Q4KX9TB')
    expect(r).toEqual({ status: 500, body: { error: 'server_error' } })
  })
})
