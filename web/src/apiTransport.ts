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
