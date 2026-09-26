// A stable, non-secret identifier for this browser profile, and a check of whether it
// can compute analysis or should only observe.
const DEVICE_KEY = 'chess-coach.device-id'
let fallbackDeviceId: string | undefined

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `dev-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function deviceId(provided?: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  try {
    // Reading localStorage itself can throw (blocked storage), so stay inside the guard.
    const storage = provided === undefined ? globalThis.localStorage ?? null : provided
    const existing = storage?.getItem(DEVICE_KEY)
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing
    const created = randomId()
    storage?.setItem(DEVICE_KEY, created)
    return created
  } catch {
    fallbackDeviceId ??= randomId()
    return fallbackDeviceId
  }
}

export type Capabilities = {
  /** The browser has everything the worker pipeline needs. */
  supported: boolean
  /** Supported, and not a phone, data-saver, or low-memory device. */
  recommended: boolean
  reason: string | null
}

type Environment = {
  WebAssembly?: unknown
  Worker?: unknown
  indexedDB?: unknown
  CompressionStream?: unknown
  crypto?: { subtle?: unknown }
  navigator?: {
    deviceMemory?: number
    connection?: { saveData?: boolean }
    userAgentData?: { mobile?: boolean }
    userAgent?: string
    storage?: { estimate?: () => Promise<{ quota?: number }> }
  }
}

export async function detectCapabilities(env: Environment = globalThis as unknown as Environment): Promise<Capabilities> {
  const missing = [
    ['WebAssembly', env.WebAssembly], ['Web Workers', env.Worker], ['IndexedDB', env.indexedDB],
    ['compression streams', env.CompressionStream], ['Web Crypto', env.crypto?.subtle],
  ].filter(([, present]) => !present).map(([name]) => name)
  if (missing.length) {
    return { supported: false, recommended: false, reason: `This browser lacks ${missing.join(', ')}; it can follow progress but not compute.` }
  }
  const navigator = env.navigator ?? {}
  try {
    const quota = (await navigator.storage?.estimate?.())?.quota
    if (quota !== undefined && quota < 64 * 1024 * 1024) {
      return { supported: false, recommended: false, reason: 'This browser does not allow enough local storage to compute.' }
    }
  } catch {
    // Unknown quota: allow and let the resume store report quota errors.
  }
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent ?? '')
  if (mobile) return { supported: true, recommended: false, reason: 'Phones and tablets observe by default to save battery.' }
  if (navigator.connection?.saveData) return { supported: true, recommended: false, reason: 'Data saver is on.' }
  if (navigator.deviceMemory !== undefined && navigator.deviceMemory < 2) {
    return { supported: true, recommended: false, reason: 'This device has little memory.' }
  }
  return { supported: true, recommended: true, reason: null }
}
