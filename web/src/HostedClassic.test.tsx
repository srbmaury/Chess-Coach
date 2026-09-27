import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { setApiTransport } from './apiTransport'
import CommunityControls from './CommunityControls'
import type { HostedEnvironment } from './hostedContext'
import CoachApp from './LegacyApp'

afterEach(() => {
  cleanup()
  setApiTransport(null)
  window.history.pushState({}, '', '/')
})

const hosted = { email: 'player@example.test', signOut: vi.fn() } as unknown as HostedEnvironment

function serve(routes: Record<string, () => Response>) {
  const calls: string[] = []
  setApiTransport(async (path) => {
    calls.push(path)
    const route = routes[path]
    return route ? route() : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
  })
  return calls
}

test('the hosted player bar shows the account and offers Stop while analysis runs', async () => {
  const calls = serve({
    '/api/profiles': () => new Response(JSON.stringify({ active_username: 'magnuscarlsen', profiles: [{ username: 'magnuscarlsen', display_username: 'MagnusCarlsen' }] })),
    '/api/pipeline/status': () => new Response(JSON.stringify({ stage: 'analyze', status: 'running' })),
  })
  render(<CommunityControls hosted={hosted} onProfileChanged={() => undefined} />)

  expect(await screen.findByText('player@example.test')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(hosted.signOut).toHaveBeenCalled()
  expect(await screen.findByRole('button', { name: 'Stop analysis' })).toBeTruthy()
  expect(calls).toContain('/api/pipeline/status')
})

test('first-run in hosted mode still offers sign out', async () => {
  serve({ '/api/profiles': () => new Response(JSON.stringify({ active_username: null, profiles: [] })) })
  render(<CommunityControls hosted={hosted} onProfileChanged={() => undefined} />)
  expect(await screen.findByText('Choose your Chess.com player')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
})

test('the hosted dashboard opens the report in the app instead of a new tab', async () => {
  serve({
    '/api/dashboard': () => new Response(JSON.stringify({
      analyzed_moves: 120,
      training: { total_puzzles: 5, due_puzzles: 2, reviewed_puzzles: 1, mastered_puzzles: 0, total_reviews: 1, accuracy: 1 },
      artifacts: { analysis: { exists: true }, puzzles: { exists: true }, model: { exists: true }, report: { exists: true } },
    })),
    '/api/report': () => new Response('<!doctype html><h1>Chess ML Coach Report</h1>', { headers: { 'Content-Type': 'text/html' } }),
  })
  render(<CoachApp hosted={hosted} />)

  const link = await screen.findByRole('link', { name: /report/i })
  expect(link.getAttribute('target')).toBeNull()
  fireEvent.click(link)
  await waitFor(() => expect(screen.getByTitle('Coaching report').getAttribute('srcdoc')).toContain('Chess ML Coach Report'))
})

test('the hosted Pipeline page is the local one: a Run button per stage and live progress', async () => {
  let listener: ((event: Record<string, unknown>) => void) | null = null
  const pipeline = { depth: 16, subscribe: vi.fn((next) => { listener = next; return () => undefined }) }
  const started: { stage: string; body: string }[] = []
  let statusReads = 0
  setApiTransport(async (path, init) => {
    if (path === '/api/pipeline/status') statusReads += 1
    if (path === '/api/pipeline/status') return new Response(JSON.stringify({ stage: null, status: 'idle' }))
    const match = path.match(/^\/api\/pipeline\/(\w+)$/)
    if (match && init?.method === 'POST') {
      started.push({ stage: match[1], body: String(init.body) })
      return new Response(JSON.stringify({ stage: match[1], status: 'running' }))
    }
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
  })
  window.history.pushState({}, '', '/pipeline')
  render(<CoachApp hosted={{ ...hosted, pipeline } as unknown as HostedEnvironment} />)

  expect(await screen.findByText('Build your coach')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Run' })).toHaveLength(6)
  expect((screen.getByLabelText('Stockfish depth') as HTMLInputElement).value).toBe('16')
  fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[3])
  await waitFor(() => expect(started).toEqual([{ stage: 'puzzles', body: JSON.stringify({ depth: 16 }) }]))

  // Starting re-reads the status once the new subscription is in place.
  await waitFor(() => expect(statusReads).toBeGreaterThanOrEqual(2))
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  act(() => listener!({ stage: 'puzzles', status: 'running', phase: 'publishing' }))
  expect(await screen.findByText('Live progress')).toBeTruthy()
  expect(screen.getByText('publishing')).toBeTruthy()
})
