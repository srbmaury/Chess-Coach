// Content hashing and canonical JSON shared by the analysis pipeline and coordinator.

const encoder = new TextEncoder()

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/**
 * Python `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` for the
 * integer/string/boolean documents that are hashed on both sides (configuration and
 * dependency hashes). Floats are deliberately unsupported: their reprs differ.
 */
export function canonicalJson(value: unknown): string {
  const check = (item: unknown): void => {
    if (typeof item === 'number' && !Number.isInteger(item)) {
      throw new Error('canonicalJson only supports integers')
    }
    if (Array.isArray(item)) item.forEach(check)
    else if (item && typeof item === 'object') Object.values(item).forEach(check)
  }
  check(value)
  return JSON.stringify(sortKeys(value))
}
