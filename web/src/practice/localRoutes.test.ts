import { expect, test, vi } from 'vitest'

import { createPracticeRoutes, hostedTransport } from './localRoutes'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const ITEM = {
  puzzle_id: 'p1', fen: START, orientation: 'white', best_move_uci: 'd2d4', best_move_san: 'd4',
  your_move_uci: 'a2a3', your_move_san: 'a3', motif: 'positional / calculation', evaluation_loss_pawns: 1, attempts: 1,
}

function setup(item = ITEM) {
  const server = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path === '/api/puzzles/p1') return new Response(JSON.stringify(item), { status: 200 })
    if (path === '/api/puzzles/missing') return new Response(JSON.stringify({ detail: 'Puzzle not found' }), { status: 404 })
    return new Response(JSON.stringify({ served: path }), { status: 200 })
  })
  const engine = { search: vi.fn(async () => [{ score: { cp: 20 }, pv: ['d2d4', 'd7d5'] }]) }
  const local = createPracticeRoutes(server, () => engine, 14)
  return { server, engine, transport: hostedTransport(server, local) }
}

test('adaptive routes run in the browser with the local API shapes', async () => {
  const { transport, server } = setup()
  const start = await transport('/api/practice/p1/adaptive/start', { method: 'POST' })
  const session = await start.json()
  expect(start.status).toBe(200)
  expect(session).toMatchObject({ puzzle_id: 'p1', status: 'active', current_fen: START, max_user_decisions: 4, steps: [] })

  const hint = await (await transport(`/api/practice/adaptive/${session.session_id}/hint`, { method: 'POST' })).json()
  expect(hint.move_san).toBe('d4')
  const bad = await transport(`/api/practice/adaptive/${session.session_id}/move`, { method: 'POST', body: JSON.stringify({ move_uci: 'e2e5' }) })
  expect(bad.status).toBe(422)
  expect((await bad.json()).detail).toBe('Submitted move is not legal in this position')
  expect(server.mock.calls.map(([path]) => path)).toEqual(['/api/puzzles/p1'])
})

test('explanations need an attempt first and use the engine', async () => {
  const fresh = setup({ ...ITEM, attempts: 0 })
  expect((await fresh.transport('/api/practice/p1/explanation')).status).toBe(409)
  const tried = setup()
  const explanation = await (await tried.transport('/api/practice/p1/explanation')).json()
  expect(explanation).toMatchObject({ engine_grounded: true, best_line: ['d4', 'd5'] })
})

test('unknown puzzles surface the server error; other routes go to the server', async () => {
  const { transport } = setup()
  const missing = await transport('/api/practice/missing/adaptive/start', { method: 'POST' })
  expect(missing.status).toBe(404)
  expect((await (await transport('/api/practice/next')).json()).served).toBe('/api/practice/next')
  expect((await (await transport('/api/practice/p1/attempt', { method: 'POST', body: '{}' })).json()).served).toBe('/api/practice/p1/attempt')
})
