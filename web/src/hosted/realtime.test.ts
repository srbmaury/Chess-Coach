import { expect, test, vi } from 'vitest'

import { createEventFilter, jobTopic, subscribeToJob, type ProgressEvent } from './realtime'

const JOB = '11111111-1111-1111-1111-111111111111'
const event = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
  job_id: JOB, status: 'running', completed_work: 2, total_work: 9, checkpoint_sequence: 1,
  worker_active: true, updated_at: '2026-09-26T10:00:00Z', ...overrides,
})

function fakeClient() {
  let handler: ((message: { payload?: unknown }) => void) | undefined
  let statusCallback: ((status: string) => void) | undefined
  const channel = {
    on: vi.fn((_type: string, _filter: unknown, callback: typeof handler) => { handler = callback; return channel }),
    subscribe: vi.fn((callback: typeof statusCallback) => { statusCallback = callback; return channel }),
  }
  const client = {
    realtime: { setAuth: vi.fn(async () => undefined) },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => 'ok'),
  }
  return {
    client, channel,
    deliver: (payload: unknown) => handler?.({ payload }),
    status: (value: string) => statusCallback?.(value),
  }
}

test('subscribes to the private job topic with the session token', async () => {
  const fake = fakeClient()
  await subscribeToJob(fake.client as never, JOB, 'access-token', () => undefined)

  expect(jobTopic(JOB)).toBe(`job:${JOB}`)
  expect(fake.client.realtime.setAuth).toHaveBeenCalledWith('access-token')
  expect(fake.client.channel).toHaveBeenCalledWith(`job:${JOB}`, { config: { private: true } })
})

test('delivers valid progress once and drops out-of-order, duplicate, or foreign events', async () => {
  const fake = fakeClient()
  const received: ProgressEvent[] = []
  await subscribeToJob(fake.client as never, JOB, 'token', (value) => received.push(value))

  fake.deliver(event())
  fake.deliver(event())
  fake.deliver(event({ completed_work: 1, updated_at: '2026-09-26T09:00:00Z' }))
  fake.deliver(event({ job_id: 'other-job' }))
  fake.deliver({ nonsense: true })
  fake.deliver(event({ completed_work: 4, checkpoint_sequence: 2, updated_at: '2026-09-26T10:01:00Z' }))

  expect(received.map((item) => item.completed_work)).toEqual([2, 4])
})

test('reports connection state and removes the channel on close', async () => {
  const fake = fakeClient()
  const states: boolean[] = []
  const feed = await subscribeToJob(fake.client as never, JOB, 'token', () => undefined, (value) => states.push(value))
  fake.status('SUBSCRIBED')
  fake.status('CHANNEL_ERROR')
  feed.close()

  expect(states).toEqual([true, false, false])
  expect(fake.client.removeChannel).toHaveBeenCalledWith(fake.channel)
})

test('filter accepts a terminal status change at the same progress', () => {
  const accept = createEventFilter()
  expect(accept(event({ completed_work: 9, checkpoint_sequence: 3 }))).toBe(true)
  expect(accept(event({ completed_work: 9, checkpoint_sequence: 3, status: 'succeeded' }))).toBe(true)
})
