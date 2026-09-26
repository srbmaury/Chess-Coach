import { afterEach, expect, test, vi } from 'vitest'

import { FakeUciWorker, type FakeEngineOptions } from './fakeEngine'
import { EngineError, type EngineLine } from './protocol'
import { EngineWorkerClient } from './workerClient'

const ANSWER = (fen: string, multipv: number): EngineLine[] =>
  [{ score: { cp: fen.length }, pv: ['e2e4', 'e7e5'] }, { score: { cp: 1 }, pv: ['d2d4'] }].slice(0, multipv)

function client(options: Partial<FakeEngineOptions> = {}, timeouts: { searchTimeoutMs?: number } = {}) {
  const worker = new FakeUciWorker({ answer: ANSWER, ...options })
  return { worker, engine: new EngineWorkerClient(() => worker, { depth: 12, ...timeouts }) }
}

afterEach(() => vi.useRealTimers())

test('handshakes once and searches at the configured depth', async () => {
  const { worker, engine } = client()
  const lines = await engine.search('8/8/8/8/8/8/8/K6k w - - 0 1', 2)
  await engine.search('8/8/8/8/8/8/8/K6k w - - 0 1', 1)

  expect(lines).toEqual(ANSWER('8/8/8/8/8/8/8/K6k w - - 0 1', 2))
  expect(worker.commands.filter((command) => command === 'uci')).toHaveLength(1)
  expect(worker.commands).toContain('go depth 12')
  expect(worker.commands).toContain('setoption name MultiPV value 2')
})

test('runs one search at a time in call order', async () => {
  const { worker, engine } = client()
  const results = await Promise.all(['a', 'bb', 'ccc'].map((fen) => engine.search(fen, 1)))

  expect(results.map((lines) => (lines[0].score as { cp: number }).cp)).toEqual([1, 2, 3])
  const positions = worker.commands.filter((command) => command.startsWith('position'))
  expect(positions).toEqual(['position fen a', 'position fen bb', 'position fen ccc'])
})

test('stale output from a stopped search never leaks into the next result', async () => {
  const { engine } = client({ staleBestmove: true })
  expect(await engine.search('fen', 1)).toEqual(ANSWER('fen', 1))
})

test('abort stops the search and leaves the engine usable', async () => {
  const hanging = new FakeUciWorker({ answer: ANSWER, hang: true })
  const engine = new EngineWorkerClient(() => hanging, { depth: 12 })
  const controller = new AbortController()
  const search = engine.search('fen', 1, controller.signal)
  await vi.waitFor(() => expect(hanging.commands).toContain('go depth 12'))
  controller.abort()

  await expect(search).rejects.toMatchObject({ code: 'aborted' })
  expect(hanging.commands).toContain('stop')
  expect(engine.alive).toBe(true)
})

test('termination (lease loss) rejects the running search immediately', async () => {
  const { worker, engine } = client({ hang: true })
  const search = engine.search('fen', 1)
  await vi.waitFor(() => expect(worker.commands).toContain('go depth 12'))
  engine.terminate()

  await expect(search).rejects.toMatchObject({ code: 'terminated' })
  expect(worker.terminated).toBe(true)
  await expect(engine.search('fen', 1)).rejects.toBeInstanceOf(EngineError)
})

test('a crashed worker rejects with a crash error', async () => {
  const { engine } = client({ crashOnGo: true })
  await expect(engine.search('fen', 1)).rejects.toMatchObject({ code: 'crashed' })
  expect(engine.alive).toBe(false)
})

test('a hung search times out and terminates the worker', async () => {
  const { worker, engine } = client({ hang: true }, { searchTimeoutMs: 50 })
  await expect(engine.search('fen', 1)).rejects.toMatchObject({ code: 'timeout' })
  expect(worker.terminated).toBe(true)
})
