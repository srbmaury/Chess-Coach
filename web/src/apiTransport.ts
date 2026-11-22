// The one place the classic pages send API requests through. Local mode uses plain
// fetch; hosted mode swaps in a transport that adds the session token and answers
// engine-backed routes in the browser.
export type Transport = (input: string, init?: RequestInit) => Promise<Response>

const defaultTransport: Transport = (input, init) => fetch(input, init)
let transport: Transport = defaultTransport

export function setApiTransport(next: Transport | null): void {
  transport = next ?? defaultTransport
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return transport(input, init)
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      message = body.detail || message
    } catch {
      // Keep generic message when the response is not JSON.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}
