// Typed client for the authenticated hosted analysis API and signed Storage URLs.
import type {
  ArtifactView, CheckpointView, JobView, LeaseResponse, ManifestResponse, ProfilesResponse,
  ResultsResponse, UploadResponse,
} from './types'

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class HostedApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'HostedApiError'
  }

  /** The server says this browser no longer owns (or cannot own) the lease. */
  get leaseLost(): boolean {
    return ['lease_lost', 'lease_unavailable', 'observer_only', 'not_subscribed'].includes(this.code)
      || this.status === 403 || this.status === 404
  }
}

type LeaseBody = { device_id: string; lease_token: string }

export class HostedApi {
  constructor(private readonly fetcher: Fetcher) {}

  private async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init
    const headers = new Headers(rest.headers)
    if (json !== undefined) headers.set('Content-Type', 'application/json')
    let response: Response
    try {
      response = await this.fetcher(path, { ...rest, headers, body: json === undefined ? rest.body : JSON.stringify(json) })
    } catch (error) {
      if (error instanceof Error && /sign in/i.test(error.message)) throw new HostedApiError(error.message, 401, 'signed_out')
      throw new HostedApiError('Network unavailable', 0, 'network')
    }
    if (response.status === 204) return undefined as T
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!response.ok) {
      const detail = body && typeof body === 'object' ? body as { detail?: unknown; code?: unknown } : {}
      const message = typeof detail.detail === 'string' ? detail.detail : `Request failed (${response.status})`
      throw new HostedApiError(message, response.status, typeof detail.code === 'string' ? detail.code : 'error')
    }
    return body as T
  }

  profiles() { return this.request<ProfilesResponse>('/api/hosted/profiles') }
  claimProfile(username: string) {
    return this.request<ProfilesResponse>('/api/hosted/profiles', { method: 'POST', json: { username } })
  }
  results(playerId: string) { return this.request<ResultsResponse>(`/api/hosted/profiles/${playerId}/results`) }
  createJob(playerId: string, canCompute: boolean) {
    return this.request<JobView>('/api/hosted/jobs', { method: 'POST', json: { player_id: playerId, can_compute: canCompute } })
  }
  job(jobId: string) { return this.request<JobView>(`/api/hosted/jobs/${jobId}`) }
  subscribe(jobId: string, canCompute: boolean) {
    return this.request<JobView>(`/api/hosted/jobs/${jobId}/subscribe`, { method: 'POST', json: { can_compute: canCompute } })
  }
  stop(jobId: string) { return this.request<JobView>(`/api/hosted/jobs/${jobId}/stop`, { method: 'POST', json: {} }) }
  setCompute(jobId: string, canCompute: boolean) {
    return this.request<JobView>(`/api/hosted/jobs/${jobId}/compute`, { method: 'POST', json: { can_compute: canCompute } })
  }
  claim(jobId: string, deviceId: string) {
    return this.request<LeaseResponse>(`/api/hosted/jobs/${jobId}/lease/claim`, { method: 'POST', json: { device_id: deviceId } })
  }
  renew(jobId: string, lease: LeaseBody) {
    return this.request<LeaseResponse>(`/api/hosted/jobs/${jobId}/lease/renew`, { method: 'POST', json: lease })
  }
  release(jobId: string, lease: LeaseBody, keepalive = false) {
    return this.request<void>(`/api/hosted/jobs/${jobId}/lease/release`, { method: 'POST', json: lease, keepalive })
  }
  manifest(jobId: string) { return this.request<ManifestResponse>(`/api/hosted/jobs/${jobId}/manifest`) }
  upload(jobId: string, body: LeaseBody & {
    kind: 'checkpoint' | 'artifact'; sequence?: number; artifact_type?: string; byte_size: number; content_hash: string
  }) {
    return this.request<UploadResponse>(`/api/hosted/jobs/${jobId}/uploads`, { method: 'POST', json: body })
  }
  finalizeCheckpoint(jobId: string, body: LeaseBody & { sequence: number; content_hash: string }) {
    return this.request<CheckpointView>(`/api/hosted/jobs/${jobId}/checkpoints/finalize`, { method: 'POST', json: body })
  }
  checkpoints(jobId: string) {
    return this.request<{ checkpoints: CheckpointView[]; dependency_hash: string | null }>(`/api/hosted/jobs/${jobId}/checkpoints`)
  }
  finalizeArtifact(jobId: string, body: LeaseBody & { artifact_type: string; content_hash: string }) {
    return this.request<ArtifactView>(`/api/hosted/jobs/${jobId}/artifacts/finalize`, { method: 'POST', json: body })
  }
  complete(jobId: string, lease: LeaseBody) {
    return this.request<JobView>(`/api/hosted/jobs/${jobId}/complete`, { method: 'POST', json: lease })
  }
}

/** Upload bytes to a signed Storage URL. An existing object (same key) already holds them. */
export async function putSigned(url: string, bytes: Uint8Array, contentType: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'PUT',
      body: bytes as BodyInit,
      headers: { 'content-type': contentType, 'x-upsert': 'false' },
    })
  } catch {
    throw new HostedApiError('Upload failed; will retry', 0, 'network')
  }
  if (response.ok || response.status === 409) return
  const text = await response.text().catch(() => '')
  if (/duplicate|already exists/i.test(text)) return
  throw new HostedApiError('Upload was rejected by storage', response.status, 'storage_rejected')
}

/** Download a signed object, refusing bodies larger than `maxBytes`. */
export async function downloadSigned(url: string, maxBytes: number, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetcher(url)
  } catch {
    throw new HostedApiError('Download failed', 0, 'network')
  }
  if (!response.ok) throw new HostedApiError('Download failed', response.status, 'storage_unavailable')
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new HostedApiError('Download is too large', 413, 'too_large')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new HostedApiError('Download is too large', 413, 'too_large')
  return bytes
}
