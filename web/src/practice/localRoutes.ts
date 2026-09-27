// Hosted mode's browser-side handlers for the classic practice API routes that need an
// engine. Responses match the local server's (same JSON and error shape), so the
// Practice page works unchanged.
import type { Transport } from '../apiTransport'
import { AdaptiveError, AdaptivePractice, type AdaptivePuzzle, type AdaptiveReview } from './adaptive'
import { Explainer, type ExplainablePuzzle } from './explanations'
import type { MoveEngine } from '../analysis/classify'

type PuzzleItem = ExplainablePuzzle & { orientation: string; attempts: number }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function serverJson<T>(server: Transport, path: string, init?: RequestInit): Promise<T> {
  const response = await server(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new AdaptiveError(body.detail ?? `Request failed (${response.status})`, response.status)
  return body as T
}

export function createPracticeRoutes(server: Transport, engine: () => MoveEngine, depth: number) {
  const puzzle = (id: string) => serverJson<PuzzleItem>(server, `/api/puzzles/${encodeURIComponent(id)}`)
  const adaptive = new AdaptivePractice(engine, (puzzleId, outcome) =>
    serverJson<AdaptiveReview>(server, `/api/practice/${encodeURIComponent(puzzleId)}/adaptive/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outcome),
    }))
  const explainer = new Explainer(engine, depth)

  const routes: { method: string; pattern: RegExp; handle: (match: RegExpMatchArray, body: Record<string, unknown>) => Promise<unknown> }[] = [
    {
      method: 'POST',
      pattern: /^\/api\/practice\/([^/]+)\/adaptive\/start$/,
      handle: async ([, id]) => {
        const item = await puzzle(decodeURIComponent(id))
        const start: AdaptivePuzzle = { puzzle_id: item.puzzle_id, fen: item.fen, orientation: item.orientation, best_move_uci: item.best_move_uci }
        return adaptive.start(start)
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/practice\/adaptive\/([^/]+)\/move$/,
      handle: ([, session], body) => adaptive.move(session, String(body.move_uci ?? '')),
    },
    { method: 'POST', pattern: /^\/api\/practice\/adaptive\/([^/]+)\/hint$/, handle: ([, session]) => adaptive.hint(session) },
    { method: 'POST', pattern: /^\/api\/practice\/adaptive\/([^/]+)\/abandon$/, handle: ([, session]) => adaptive.abandon(session) },
    {
      method: 'GET',
      pattern: /^\/api\/practice\/([^/]+)\/explanation$/,
      handle: async ([, id]) => {
        const item = await puzzle(decodeURIComponent(id))
        if (item.attempts <= 0) throw new AdaptiveError('Attempt this puzzle before requesting its explanation.', 409)
        return explainer.explain(item)
      },
    },
  ]

  /** Handle the request locally if it is an engine route; otherwise return null. */
  return async (path: string, init?: RequestInit): Promise<Response | null> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const pathname = path.split('?')[0]
    for (const route of routes) {
      const match = route.method === method ? pathname.match(route.pattern) : null
      if (!match) continue
      try {
        const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : {}
        return json(200, await route.handle(match, body))
      } catch (error) {
        if (error instanceof AdaptiveError) return json(error.status, { detail: error.message })
        return json(500, { detail: 'Practice failed unexpectedly' })
      }
    }
    return null
  }
}

/** Hosted transport: engine routes in the browser, everything else to the server. */
export function hostedTransport(server: Transport, local: (path: string, init?: RequestInit) => Promise<Response | null>): Transport {
  return async (input, init) => (await local(input, init)) ?? server(input, init)
}
