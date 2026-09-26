import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type HostedBrowserConfig =
  | { hosted: false }
  | {
      hosted: true
      supabase_url: string | null
      supabase_publishable_key: string | null
      analysis_enabled: boolean
      engine_version: string
      config_version: string
      lease_seconds: number
      renew_interval_seconds: number
      max_upload_bytes: number
      max_decompressed_bytes: number
      max_browser_cache_bytes: number
    }

let hostedClient: SupabaseClient | undefined

export async function getHostedConfig(): Promise<HostedBrowserConfig> {
  try {
    const response = await fetch('/api/hosted/config', { credentials: 'same-origin' })
    if (!response.ok) throw new Error('Hosted config request failed')
    const config: unknown = await response.json()
    if (!config || typeof config !== 'object' || !('hosted' in config)) {
      throw new Error('Invalid hosted config')
    }
    if (config.hosted === false) return { hosted: false }
    if (config.hosted !== true) throw new Error('Invalid hosted config')
    const values = config as Record<string, unknown>
    const nullableString = (key: string): string | null => {
      const value = values[key]
      if (value !== null && typeof value !== 'string') throw new Error('Invalid hosted config')
      return value
    }
    const string = (key: string): string => {
      const value = values[key]
      if (typeof value !== 'string') throw new Error('Invalid hosted config')
      return value
    }
    const number = (key: string): number => {
      const value = values[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Invalid hosted config')
      }
      return value
    }
    if (typeof values.analysis_enabled !== 'boolean') throw new Error('Invalid hosted config')
    return {
      hosted: true,
      supabase_url: nullableString('supabase_url'),
      supabase_publishable_key: nullableString('supabase_publishable_key'),
      analysis_enabled: values.analysis_enabled,
      engine_version: string('engine_version'),
      config_version: string('config_version'),
      lease_seconds: number('lease_seconds'),
      renew_interval_seconds: number('renew_interval_seconds'),
      max_upload_bytes: number('max_upload_bytes'),
      max_decompressed_bytes: number('max_decompressed_bytes'),
      max_browser_cache_bytes: number('max_browser_cache_bytes'),
    }
  } catch {
    throw new Error('Hosted sign-in is unavailable')
  }
}

export function createHostedClient(config: HostedBrowserConfig): SupabaseClient {
  if (
    !config.hosted ||
    !config.supabase_url ||
    !config.supabase_publishable_key?.startsWith('sb_publishable_')
  ) {
    throw new Error('Hosted sign-in is unavailable')
  }
  if (!hostedClient) {
    try {
      hostedClient = createClient(config.supabase_url, config.supabase_publishable_key)
    } catch {
      throw new Error('Hosted sign-in is unavailable')
    }
  }
  return hostedClient
}
