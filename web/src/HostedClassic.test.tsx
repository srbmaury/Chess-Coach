import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

test('the hosted player bar shows the account and never polls the server pipeline', async () => {
  const calls = serve({
    '/api/profiles': () => new Response(JSON.stringify({ active_username: 'magnuscarlsen', profiles: [{ username: 'magnuscarlsen', display_username: 'MagnusCarlsen' }] })),
  })
  render(<CommunityControls hosted={hosted} onProfileChanged={() => undefined} />)

  expect(await screen.findByText('player@example.test')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(hosted.signOut).toHaveBeenCalled()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls.every((path) => !path.startsWith('/api/pipeline'))).toBe(true)
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
