// Private Supabase Broadcast for job progress. Realtime is only an optimization:
// events nudge the coordinator to re-read the authorized job endpoint, which stays
// the source of truth, so a delayed, duplicated, or dropped event is harmless.
import type { SupabaseClient } from '@supabase/supabase-js'

export type ProgressEvent = {
  job_id: string
  status: string
  completed_work: number
  total_work: number
  checkpoint_sequence: number
  worker_active: boolean
  updated_at: string
}

export type ProgressFeed = { close(): void }

export function jobTopic(jobId: string): string {
  return `job:${jobId}`
}

function isProgressEvent(value: unknown, jobId: string): value is ProgressEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return event.job_id === jobId && typeof event.status === 'string'
    && Number.isInteger(event.completed_work) && Number.isInteger(event.checkpoint_sequence)
    && typeof event.updated_at === 'string'
}

/** Orders events so stale or repeated ones are ignored. */
export function createEventFilter() {
  let last: { sequence: number; completed: number; updatedAt: string; status: string } | null = null
  return (event: ProgressEvent): boolean => {
    const next = { sequence: event.checkpoint_sequence, completed: event.completed_work, updatedAt: event.updated_at, status: event.status }
    if (last) {
      if (next.sequence < last.sequence || next.completed < last.completed) return false
      if (next.updatedAt < last.updatedAt) return false
      if (next.sequence === last.sequence && next.completed === last.completed
        && next.updatedAt === last.updatedAt && next.status === last.status) return false
    }
    last = next
    return true
  }
}

/**
 * Subscribe to a job's private progress topic. `accessToken` must be the current
 * session token; call again with a refreshed token (the previous feed is replaced).
 */
export async function subscribeToJob(
  client: SupabaseClient,
  jobId: string,
  accessToken: string,
  onProgress: (event: ProgressEvent) => void,
  onConnectionChange: (connected: boolean) => void = () => undefined,
): Promise<ProgressFeed> {
  await client.realtime.setAuth(accessToken)
  const accept = createEventFilter()
  const channel = client.channel(jobTopic(jobId), { config: { private: true } })
  channel
    .on('broadcast', { event: 'progress' }, (message: { payload?: unknown }) => {
      // Broadcast payloads never carry account, device, or lease identifiers.
      if (isProgressEvent(message.payload, jobId) && accept(message.payload)) onProgress(message.payload)
    })
    .subscribe((status: string) => onConnectionChange(status === 'SUBSCRIBED'))
  return {
    close() {
      onConnectionChange(false)
      void client.removeChannel(channel)
    },
  }
}
