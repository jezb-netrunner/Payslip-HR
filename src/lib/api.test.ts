import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRefreshDiscardedError, AuthRetryableFetchError } from '@supabase/supabase-js'

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('./supabase', () => ({ supabase: { auth } }))

import { SESSION_ENDED, callAdminUsers } from './api'

const session = (token: string) => ({ data: { session: { access_token: token } } })
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  auth.getSession.mockResolvedValue(session('old'))
  auth.signOut.mockResolvedValue({ error: null })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

const bearer = (call: number) => (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>

describe('callAdminUsers', () => {
  it('sends the access token and returns the function result', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, user_id: 'u1' }))
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ ok: true, user_id: 'u1' })
    expect(bearer(0).Authorization).toBe('Bearer old')
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })

  it('refreshes once and retries when the token is rejected', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: 'Not authenticated' })).mockResolvedValueOnce(reply(200, { ok: true }))
    auth.refreshSession.mockResolvedValueOnce({ data: { session: { access_token: 'new' } }, error: null })
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ ok: true })
    expect(bearer(1).Authorization).toBe('Bearer new')
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('signs this device out when the session is gone (ended elsewhere)', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: 'Not authenticated' }))
    auth.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found'),
    })
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ error: SESSION_ENDED })
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the user signed in when only the network failed', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: 'Not authenticated' }))
    auth.refreshSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    expect((await callAdminUsers({ action: 'create_admin' })).error).toMatch(/connection/)
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('another tab refreshing at the same moment is not a sign-out: retry with its token', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: 'Not authenticated' })).mockResolvedValueOnce(reply(200, { ok: true }))
    auth.refreshSession.mockResolvedValueOnce({ data: null, error: new AuthRefreshDiscardedError() })
    auth.getSession.mockResolvedValueOnce(session('old')).mockResolvedValueOnce(session('from-other-tab'))
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ ok: true })
    expect(bearer(1).Authorization).toBe('Bearer from-other-tab')
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('a Supabase Auth hiccup (5xx, rate limit) asks to try again instead of signing out', async () => {
    for (const status of [500, 429]) {
      fetchMock.mockResolvedValueOnce(reply(401, { error: 'Not authenticated' }))
      auth.refreshSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthApiError('upstream', status, undefined) })
      expect((await callAdminUsers({ action: 'create_admin' })).error).toMatch(/try again/)
    }
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('an expired session that could not be refreshed offline is a connection problem', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    expect((await callAdminUsers({ action: 'create_admin' })).error).toMatch(/connection/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a signed-out state without calling the function', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null } })
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ error: SESSION_ENDED })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never reads a non-2xx gateway reply as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 502 }))
    expect(await callAdminUsers({ action: 'create_admin' })).toEqual({ error: 'Request failed (502)' })
  })
})
