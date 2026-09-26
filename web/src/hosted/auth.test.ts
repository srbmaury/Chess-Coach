import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const client = {
    auth: {
      signInWithOtp: vi.fn(),
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
  }
  return {
    client,
    getHostedConfig: vi.fn(async () => ({ hosted: true })),
    createHostedClient: vi.fn(() => client),
  }
})

vi.mock('./config', () => ({
  getHostedConfig: mocks.getHostedConfig,
  createHostedClient: mocks.createHostedClient,
}))

import { authorizedFetch, logout, observeSession, requestMagicLink } from './auth'

const oldSession = { access_token: 'old-token' }
const freshSession = { access_token: 'fresh-token' }

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.client.auth.signInWithOtp.mockReset().mockResolvedValue({ error: null })
  mocks.client.auth.getSession.mockReset().mockResolvedValue({ data: { session: freshSession }, error: null })
  mocks.client.auth.signOut.mockReset().mockResolvedValue({ error: null })
  mocks.client.auth.onAuthStateChange.mockReset()
})

test('normalizes the email sent in a magic-link request', async () => {
  await requestMagicLink('  Player@Example.COM  ')

  expect(mocks.client.auth.signInWithOtp).toHaveBeenCalledWith({ email: 'player@example.com' })
})

test('recovers the current session then observes changes until unsubscribed', async () => {
  const callback = vi.fn()
  const unsubscribe = vi.fn()
  let onChange: (_event: string, session: typeof freshSession | null) => void = () => {}
  mocks.client.auth.onAuthStateChange.mockImplementation((handler) => {
    onChange = handler
    return { data: { subscription: { unsubscribe } } }
  })

  const stop = observeSession(callback)
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(freshSession))
  onChange('SIGNED_OUT', null)
  expect(callback).toHaveBeenLastCalledWith(null)
  stop()

  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

test('recovers a callback session after an initial empty auth event', async () => {
  const callback = vi.fn()
  mocks.client.auth.onAuthStateChange.mockImplementation((handler) => {
    handler('INITIAL_SESSION', null)
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })

  const stop = observeSession(callback)
  await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith(freshSession))
  stop()
})

test('logs out the active session', async () => {
  await logout()

  expect(mocks.client.auth.signOut).toHaveBeenCalledTimes(1)
})

test('attaches the refreshed access token while preserving request headers', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)

  await authorizedFetch(oldSession as never, '/api/hosted/account/me', {
    headers: { 'X-Request-ID': '123', Authorization: 'Bearer old-token' },
  })

  const [, options] = fetchMock.mock.calls[0]
  const headers = new Headers(options.headers)
  expect(headers.get('Authorization')).toBe('Bearer fresh-token')
  expect(headers.get('X-Request-ID')).toBe('123')
})

test('rejects a missing current session without sending a request', async () => {
  mocks.client.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await expect(authorizedFetch(oldSession as never, '/api/hosted/account/me')).rejects.toThrow(
    'Please sign in to continue',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test('does not send a bearer token to an external origin', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await expect(authorizedFetch(oldSession as never, 'https://other.example/api')).rejects.toThrow(
    'Authorized request must use this site',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test('does not expose malformed request input in an authorization error', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await expect(authorizedFetch(oldSession as never, 'https://%private-secret')).rejects.toThrow(
    'Authorized request must use this site',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test('keeps provider errors and secret-shaped details out of auth failures', async () => {
  mocks.client.auth.signInWithOtp.mockResolvedValue({
    error: new Error('sb_secret_private postgresql://private-user:private-password@example.invalid/chess'),
  })

  await expect(requestMagicLink('player@example.com')).rejects.toThrow('Unable to send sign-in link')
})
