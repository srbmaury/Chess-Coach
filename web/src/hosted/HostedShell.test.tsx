import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { apiFetch } from '../apiTransport'
import type { HostedEnvironment } from '../hostedContext'
import HostedShell from './HostedShell'
import type { HostedConfig, HostedServices } from './services'

afterEach(cleanup)

const CONFIG = {
  hosted: true, supabase_url: 'https://p.supabase.co', supabase_publishable_key: 'sb_publishable_x', analysis_enabled: true,
  engine_version: '19.0.0', config_version: '1', lease_seconds: 60, renew_interval_seconds: 20, max_upload_bytes: 1,
  max_decompressed_bytes: 1, max_browser_cache_bytes: 1,
} as HostedConfig
const SESSION = { access_token: 'token', user: { id: 'user-1', email: 'player@example.test' } }

function setup(options: { session?: unknown; event?: string } = {}) {
  const services = {
    observeSession: (callback: (session: never, event?: never) => void) => {
      callback((options.session === undefined ? SESSION : options.session) as never, options.event as never)
      return () => undefined
    },
    signIn: vi.fn(async (_email: string, password: string) => { if (password === 'wrong password') throw new Error('Incorrect email or password') }),
    signUp: vi.fn(async () => 'confirm_email' as const),
    requestPasswordReset: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    authorizedFetch: vi.fn(async (_session: unknown, input: string) => new Response(JSON.stringify({ served: input }))),
    createPracticeEngine: vi.fn(() => ({ search: vi.fn(), terminate: vi.fn() })),
  } as unknown as HostedServices
  let hosted: HostedEnvironment | null = null
  render(<HostedShell config={CONFIG} services={services}>
    {(environment) => { hosted = environment; return <p>Classic app for {environment.email}</p> }}
  </HostedShell>)
  return { services, hosted: () => hosted }
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

test('signed-out visitors sign in with email and password', async () => {
  const { services } = setup({ session: null })
  fill('Email', 'Player@Example.test')
  fill('Password', 'correct horse battery')
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

  await waitFor(() => expect(services.signIn).toHaveBeenCalledWith('Player@Example.test', 'correct horse battery'))
})

test('wrong passwords, new accounts, and forgotten passwords', async () => {
  const { services } = setup({ session: null })
  fill('Email', 'player@example.test')
  fill('Password', 'wrong password')
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(await screen.findByText('Incorrect email or password')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Create an account' }))
  fill('Email', 'new@example.test')
  fill('Password', 'correct horse battery')
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  expect(await screen.findByText('Check your email to confirm your account, then sign in.')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
  fill('Email', 'someone@example.test')
  fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))
  expect(await screen.findByText('If an account exists for that email, a reset link is on its way.')).toBeTruthy()
  expect(services.requestPasswordReset).toHaveBeenCalledWith('someone@example.test')
})

test('a reset link asks for a new password before opening the app', async () => {
  const { services } = setup({ event: 'PASSWORD_RECOVERY' })
  expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeTruthy()
  fill('New password', 'a brand new password')
  fill('Confirm new password', 'a different password')
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }))
  expect(await screen.findByText('The passwords do not match')).toBeTruthy()

  fill('Confirm new password', 'a brand new password')
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }))
  expect(await screen.findByText('Classic app for player@example.test')).toBeTruthy()
  expect(services.updatePassword).toHaveBeenCalledWith('a brand new password')
})

test('signed in: the classic app gets an authenticated transport', async () => {
  const { services, hosted } = setup()
  expect(await screen.findByText('Classic app for player@example.test')).toBeTruthy()

  const response = await apiFetch('/api/dashboard')
  expect(await response.json()).toEqual({ served: '/api/dashboard' })
  expect(services.authorizedFetch).toHaveBeenCalledWith(SESSION, '/api/dashboard', undefined)
  hosted()!.signOut()
  expect(services.logout).toHaveBeenCalled()
})

test('engine practice routes are answered in the browser, not by the server', async () => {
  const { services } = setup()
  await screen.findByText('Classic app for player@example.test')
  const response = await apiFetch('/api/practice/adaptive/unknown/hint', { method: 'POST' })

  expect(response.status).toBe(404)
  expect(services.authorizedFetch).not.toHaveBeenCalled()
})
