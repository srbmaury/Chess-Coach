import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const client = {
    auth: {
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
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

import {
  authorizedFetch, logout, observeSession, requestPasswordReset, signIn, signUp, updatePassword,
} from './auth'

const oldSession = { access_token: 'old-token' }
const freshSession = { access_token: 'fresh-token' }

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.client.auth.signUp.mockReset().mockResolvedValue({ data: { session: null, user: {} }, error: null })
  mocks.client.auth.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null })
  mocks.client.auth.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null })
  mocks.client.auth.updateUser.mockReset().mockResolvedValue({ data: {}, error: null })
  mocks.client.auth.getSession.mockReset().mockResolvedValue({ data: { session: freshSession }, error: null })
  mocks.client.auth.signOut.mockReset().mockResolvedValue({ error: null })
  mocks.client.auth.onAuthStateChange.mockReset()
})

test('sign-up normalizes the email, returns to this site, and asks for confirmation', async () => {
  expect(await signUp('  Player@Example.COM  ', 'correct horse')).toBe('confirm_email')

  expect(mocks.client.auth.signUp).toHaveBeenCalledWith({
    email: 'player@example.com',
    password: 'correct horse',
    options: { emailRedirectTo: window.location.origin },
  })
})

test('sign-up reports an immediate session when confirmation is disabled', async () => {
  mocks.client.auth.signUp.mockResolvedValue({ data: { session: freshSession }, error: null })
  expect(await signUp('player@example.com', 'correct horse')).toBe('signed_in')
})

test('short passwords and blank emails are rejected before calling Supabase', async () => {
  await expect(signUp('player@example.com', 'short')).rejects.toThrow('Use at least 8 characters')
  await expect(signIn('   ', 'correct horse')).rejects.toThrow('Enter an email address')
  await expect(signIn('player@example.com', '')).rejects.toThrow('Enter your password')
  await expect(updatePassword('short')).rejects.toThrow('Use at least 8 characters')
  expect(mocks.client.auth.signUp).not.toHaveBeenCalled()
  expect(mocks.client.auth.signInWithPassword).not.toHaveBeenCalled()
  expect(mocks.client.auth.updateUser).not.toHaveBeenCalled()
})

test('sign-in maps known Supabase errors and hides everything else', async () => {
  const cases: [string, string][] = [
    ['invalid_credentials', 'Incorrect email or password'],
    ['email_not_confirmed', 'Confirm your email first. Check your inbox for the link.'],
    ['over_request_rate_limit', 'Too many attempts. Try again in a few minutes.'],
    ['something_internal', 'Unable to sign in'],
  ]
  for (const [code, message] of cases) {
    mocks.client.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code, message: 'provider detail' } })
    await expect(signIn('player@example.com', 'correct horse')).rejects.toThrow(new RegExp(`^${message.replace(/[.]/g, '\\.')}$`))
  }
  expect(mocks.client.auth.signInWithPassword).toHaveBeenLastCalledWith({ email: 'player@example.com', password: 'correct horse' })
})

test('password reset emails return to this site and hide rate-limit details', async () => {
  await requestPasswordReset(' Player@Example.com ')
  expect(mocks.client.auth.resetPasswordForEmail).toHaveBeenCalledWith('player@example.com', { redirectTo: window.location.origin })

  mocks.client.auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: { code: 'over_email_send_rate_limit' } })
  await expect(requestPasswordReset('player@example.com')).rejects.toThrow('Too many emails were sent recently')
})

test('updating the password maps reused-password errors', async () => {
  await updatePassword('a brand new password')
  expect(mocks.client.auth.updateUser).toHaveBeenCalledWith({ password: 'a brand new password' })

  mocks.client.auth.updateUser.mockResolvedValueOnce({ data: {}, error: { code: 'same_password' } })
  await expect(updatePassword('a brand new password')).rejects.toThrow('Choose a password different from your current one')
})

test('password-recovery events reach the session observer', async () => {
  const callback = vi.fn()
  let onChange: (event: string, session: typeof freshSession | null) => void = () => {}
  mocks.client.auth.onAuthStateChange.mockImplementation((handler) => {
    onChange = handler
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
  const stop = observeSession(callback)
  await vi.waitFor(() => expect(callback).toHaveBeenCalled())

  onChange('PASSWORD_RECOVERY', freshSession)

  expect(callback).toHaveBeenLastCalledWith(freshSession, 'PASSWORD_RECOVERY')
  stop()
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
  expect(callback).toHaveBeenLastCalledWith(null, 'SIGNED_OUT')
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

test('keeps headers carried by a Request input and overlays init headers', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const request = new Request(new URL('/api/hosted/jobs', window.location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trace': 'from-request' },
  })

  await authorizedFetch(oldSession as never, request, { headers: { 'X-Trace': 'from-init' } })

  const [, options] = fetchMock.mock.calls[0]
  const headers = new Headers(options.headers)
  expect(headers.get('Content-Type')).toBe('application/json')
  expect(headers.get('X-Trace')).toBe('from-init')
  expect(headers.get('Authorization')).toBe('Bearer fresh-token')
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
  const leaky = Object.assign(
    new Error('sb_secret_private postgresql://private-user:private-password@example.invalid/chess'),
    { code: 'unexpected_failure' },
  )
  mocks.client.auth.signInWithPassword.mockResolvedValue({ data: {}, error: leaky })
  mocks.client.auth.signUp.mockResolvedValue({ data: {}, error: leaky })

  await expect(signIn('player@example.com', 'correct horse')).rejects.toThrow(/^Unable to sign in$/)
  await expect(signUp('player@example.com', 'correct horse')).rejects.toThrow(/^Unable to create your account$/)
})
