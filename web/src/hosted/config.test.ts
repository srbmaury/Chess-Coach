import { beforeEach, expect, test, vi } from 'vitest'

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn(() => ({ auth: {} })) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import { createHostedClient, getHostedConfig } from './config'

const hostedConfig = {
  hosted: true as const,
  supabase_url: 'https://public-project.supabase.co',
  supabase_publishable_key: 'sb_publishable_public',
  analysis_enabled: false,
  engine_version: '19.0.0',
  config_version: '1',
  lease_seconds: 60,
  renew_interval_seconds: 20,
  max_upload_bytes: 8_388_608,
  max_decompressed_bytes: 33_554_432,
  max_browser_cache_bytes: 268_435_456,
}

beforeEach(() => {
  vi.unstubAllGlobals()
  createClientMock.mockClear()
})

test('loads the public hosted config without authentication', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => hostedConfig }))
  vi.stubGlobal('fetch', fetchMock)

  expect(await getHostedConfig()).toEqual(hostedConfig)
  expect(fetchMock).toHaveBeenCalledWith('/api/hosted/config', { credentials: 'same-origin' })
})

test('uses one Supabase client for the same hosted configuration', () => {
  const first = createHostedClient(hostedConfig)
  const second = createHostedClient(hostedConfig)

  expect(second).toBe(first)
  expect(createClientMock).toHaveBeenCalledTimes(1)
  expect(createClientMock).toHaveBeenCalledWith(
    hostedConfig.supabase_url,
    hostedConfig.supabase_publishable_key,
  )
})

test('does not build a client from missing or secret-shaped browser configuration', () => {
  for (const config of [
    { hosted: false as const },
    { ...hostedConfig, supabase_url: null },
    { ...hostedConfig, supabase_publishable_key: 'sb_secret_private' },
  ]) {
    expect(() => createHostedClient(config)).toThrow('Hosted sign-in is unavailable')
  }
  expect(createClientMock).not.toHaveBeenCalled()
})

test('does not echo server errors or secrets in config failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 500,
    text: async () => 'postgresql://private-user:private-password@example.invalid/chess',
  })))

  await expect(getHostedConfig()).rejects.toThrow('Hosted sign-in is unavailable')
})

test('drops unexpected server fields before returning public configuration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...hostedConfig, service_role_key: 'sb_secret_private' }),
  })))

  const config = await getHostedConfig()

  expect(config).toEqual(hostedConfig)
  expect(JSON.stringify(config)).not.toContain('sb_secret_private')
})
