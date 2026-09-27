// @vitest-environment node
// Tests for the Supabase `send-email` Auth Hook (supabase/functions/send-email).
import { Webhook } from 'standardwebhooks'
import { expect, test } from 'vitest'

import { InvalidPayloadError, buildAuthEmails, type AuthEmailHookPayload } from '../../supabase/functions/send-email/auth-email.ts'
import { sendBrevoEmail } from '../../supabase/functions/send-email/brevo.ts'
import { createAuthEmailHandler } from '../../supabase/functions/send-email/handler.ts'

const SUPABASE_URL = 'https://project.supabase.co'
const SECRET = `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`
const ENV = new Map([
  ['SEND_EMAIL_HOOK_SECRET', `v1,${SECRET}`],
  ['SUPABASE_URL', SUPABASE_URL],
  ['BREVO_API_KEY', 'api-key'],
  ['BREVO_SENDER_EMAIL', 'coach@example.com'],
  ['BREVO_SENDER_NAME', 'Chess ML Coach'],
])
const BASE: AuthEmailHookPayload = {
  user: { email: 'player+tag@example.com', new_email: 'new@example.com' },
  email_data: {
    token: '123456',
    token_hash: 'hash/with+reserved=chars',
    token_new: '654321',
    token_hash_new: 'old-hash',
    redirect_to: 'https://chess-ml-coach.onrender.com',
    email_action_type: 'magiclink',
    site_url: 'https://chess-ml-coach.onrender.com',
  },
}
const withAction = (email_action_type: string): AuthEmailHookPayload =>
  ({ ...BASE, email_data: { ...BASE.email_data, email_action_type } }) as AuthEmailHookPayload

function signedRequest(payload: unknown, secret = SECRET): Request {
  const body = JSON.stringify(payload)
  const timestamp = new Date()
  return new Request('https://function.example/send-email', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'msg_test',
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': new Webhook(secret).sign('msg_test', timestamp, body),
    },
  })
}

// Email content ------------------------------------------------------------------------

test('magic-link sign-in builds an encoded verification link back to the app', () => {
  const [message] = buildAuthEmails(BASE, SUPABASE_URL)
  const url = new URL(message.actionUrl)

  expect(message.to).toBe('player+tag@example.com')
  expect(url.origin + url.pathname).toBe(`${SUPABASE_URL}/auth/v1/verify`)
  expect(url.searchParams.get('token')).toBe('hash/with+reserved=chars')
  expect(url.searchParams.get('type')).toBe('magiclink')
  expect(url.searchParams.get('redirect_to')).toBe('https://chess-ml-coach.onrender.com')
  expect(message.subject).toBe('Your Chess ML Coach sign-in link')
  expect(message.htmlContent).toContain('Chess ML Coach')
  expect(message.textContent).toContain(message.actionUrl)
  expect(message.htmlContent).not.toMatch(/DevFolio/)
})

test('account confirmation and password reset use their own wording', () => {
  const [signup] = buildAuthEmails(withAction('signup'), SUPABASE_URL)
  const [recovery] = buildAuthEmails(withAction('recovery'), SUPABASE_URL)

  expect(new URL(signup.actionUrl).searchParams.get('type')).toBe('signup')
  expect(signup.subject).toBe('Confirm your Chess ML Coach account')
  expect(new URL(recovery.actionUrl).searchParams.get('type')).toBe('recovery')
  expect(recovery.subject).toBe('Reset your Chess ML Coach password')
  expect(recovery.htmlContent).toContain('Choose a new password')
})

test('supports recovery, invites, and reauthentication', () => {
  for (const type of ['recovery', 'invite', 'reauthentication']) {
    const [message] = buildAuthEmails(withAction(type), SUPABASE_URL)
    expect(new URL(message.actionUrl).searchParams.get('type')).toBe(type)
    expect(message.subject.length).toBeGreaterThan(0)
  }
})

test('escapes HTML-sensitive content', () => {
  const [message] = buildAuthEmails({
    ...BASE,
    email_data: { ...BASE.email_data, redirect_to: 'https://x.example/"><script>alert(1)</script>' },
  }, SUPABASE_URL)
  expect(message.htmlContent).not.toContain('<script>')
})

test('secure email changes go to both addresses with the right hashes', () => {
  const messages = buildAuthEmails(withAction('email_change'), SUPABASE_URL)
  expect(messages.map((message) => ({ to: message.to, token: new URL(message.actionUrl).searchParams.get('token') }))).toEqual([
    { to: 'player+tag@example.com', token: 'old-hash' },
    { to: 'new@example.com', token: 'hash/with+reserved=chars' },
  ])
})

test('fails closed for unsupported actions and incomplete payloads', () => {
  expect(() => buildAuthEmails(withAction('unknown'), SUPABASE_URL)).toThrow(InvalidPayloadError)
  expect(() => buildAuthEmails({ ...BASE, user: { email: '' } }, SUPABASE_URL)).toThrow(InvalidPayloadError)
})

// Brevo delivery --------------------------------------------------------------------------

const MESSAGE = { to: 'player@example.com', subject: 'Sign in', htmlContent: '<p>Sign in</p>', textContent: 'Sign in', actionUrl: 'https://example.com/verify' }
const BREVO = { apiKey: 'secret-key', senderEmail: 'coach@example.com', senderName: 'Chess ML Coach' }

test('sends the expected Brevo transaction without leaking the key into content', async () => {
  let request: { url: string; init: RequestInit } | undefined
  const id = await sendBrevoEmail(MESSAGE, BREVO, async (url, init) => {
    request = { url: String(url), init: init! }
    return new Response(JSON.stringify({ messageId: 'brevo-id' }), { status: 201 })
  })

  expect(id).toBe('brevo-id')
  expect(request!.url).toBe('https://api.brevo.com/v3/smtp/email')
  expect((request!.init.headers as Record<string, string>)['api-key']).toBe('secret-key')
  const body = JSON.parse(String(request!.init.body))
  expect(body.sender).toEqual({ email: 'coach@example.com', name: 'Chess ML Coach' })
  expect(body.to).toEqual([{ email: 'player@example.com' }])
  expect(String(request!.init.body)).not.toContain('secret-key')
})

test('rejects Brevo errors, missing message ids, and network failures without leaking details', async () => {
  const cases: (typeof fetch)[] = [
    async () => new Response('{"message":"bad sender"}', { status: 400 }),
    async () => new Response('{}', { status: 202 }),
    async () => { throw new Error('socket failed') },
  ]
  for (const fetchImpl of cases) {
    const error = await sendBrevoEmail(MESSAGE, BREVO, fetchImpl).catch((caught: Error) => caught)
    expect((error as Error).name).toBe('BrevoDeliveryError')
    expect(String((error as Error).message)).not.toMatch(/secret-key|bad sender/)
  }
})

// Hook handler -----------------------------------------------------------------------------

test('requires POST and a valid Standard Webhooks signature', async () => {
  const handler = createAuthEmailHandler({ getEnv: (name) => ENV.get(name), fetchImpl: async () => new Response() })
  const wrongSecret = `whsec_${Buffer.from('wrong-wrong-wrong-wrong-wrong-12').toString('base64')}`

  expect((await handler(new Request('https://function.example', { method: 'GET' }))).status).toBe(405)
  expect((await handler(new Request('https://function.example', { method: 'POST', body: JSON.stringify(BASE) }))).status).toBe(401)
  expect((await handler(signedRequest(BASE, wrongSecret))).status).toBe(401)
})

test('returns 200 only after Brevo accepts every message', async () => {
  let calls = 0
  const handler = createAuthEmailHandler({
    getEnv: (name) => ENV.get(name),
    fetchImpl: async () => new Response(JSON.stringify({ messageId: `id-${++calls}` }), { status: 201 }),
  })
  const response = await handler(signedRequest(BASE))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
  expect(calls).toBe(1)
})

test('returns 500 for missing config, 400 for an invalid payload, and 502 for Brevo failure', async () => {
  expect((await createAuthEmailHandler({ getEnv: () => undefined })(signedRequest(BASE))).status).toBe(500)
  expect((await createAuthEmailHandler({ getEnv: (name) => ENV.get(name) })(signedRequest({ nope: true }))).status).toBe(400)
  const rejected = createAuthEmailHandler({
    getEnv: (name) => ENV.get(name),
    fetchImpl: async () => new Response('provider details', { status: 400 }),
  })
  expect((await rejected(signedRequest(BASE))).status).toBe(502)
})
