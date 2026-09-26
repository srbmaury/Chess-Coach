import { expect, test } from 'vitest'

import { parseBestMove, parseInfoLine, SearchAccumulator } from './uci'

test('parses centipawn, mate, negative mate, and bounds', () => {
  expect(parseInfoLine('info depth 12 seldepth 18 multipv 1 score cp 25 nodes 99 pv e2e4 e7e5')).toEqual({
    multipv: 1, depth: 12, seldepth: 18, nodes: 99, score: { cp: 25 }, pv: ['e2e4', 'e7e5'],
  })
  expect(parseInfoLine('info depth 9 score mate 3 pv h5f7')?.score).toEqual({ mate: 3 })
  expect(parseInfoLine('info depth 9 score mate -2 pv g8h8')?.score).toEqual({ mate: -2 })
  expect(parseInfoLine('info depth 0 score mate 0')).toEqual({ multipv: 1, depth: 0, score: { mate: 0 } })
  expect(parseInfoLine('info depth 10 score cp -40 upperbound nodes 5 pv d2d4')).toMatchObject({
    score: { cp: -40 }, bound: 'upperbound', pv: ['d2d4'],
  })
})

test('parses MultiPV and promotions', () => {
  expect(parseInfoLine('info depth 5 multipv 2 score cp -3 pv e7e8q d8e8')).toMatchObject({
    multipv: 2, pv: ['e7e8q', 'd8e8'],
  })
})

test('ignores non-search and malformed info', () => {
  expect(parseInfoLine('info string NNUE evaluation using nn-xyz.nnue')).toBeNull()
  expect(parseInfoLine('info depth 3 currmove e2e4 currmovenumber 1')).toBeNull()
  expect(parseInfoLine('info depth 3 score cp abc')).toBeNull()
  expect(parseInfoLine('readyok')).toBeNull()
})

test('parses bestmove including terminal positions', () => {
  expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4')
  expect(parseBestMove('bestmove (none)')).toBeNull()
  expect(parseBestMove('info depth 1')).toBeUndefined()
})

test('accumulator keeps the last score and pv per MultiPV index, in index order', () => {
  const accumulator = new SearchAccumulator()
  accumulator.add(parseInfoLine('info depth 1 multipv 2 score cp 5 pv a2a3')!)
  accumulator.add(parseInfoLine('info depth 1 multipv 1 score cp 10 pv e2e4')!)
  accumulator.add(parseInfoLine('info depth 2 multipv 1 score cp 12 lowerbound')!)
  accumulator.add(parseInfoLine('info depth 3 multipv 1 score cp 15 pv d2d4 d7d5')!)
  expect(accumulator.result()).toEqual([
    { score: { cp: 15 }, pv: ['d2d4', 'd7d5'] },
    { score: { cp: 5 }, pv: ['a2a3'] },
  ])
})

test('a checkmated position yields one pv-less line', () => {
  const accumulator = new SearchAccumulator()
  accumulator.add(parseInfoLine('info depth 0 score mate 0')!)
  expect(accumulator.result()).toEqual([{ score: { mate: 0 }, pv: [] }])
})

test('parses a real Stockfish 19 lite transcript', () => {
  const transcript = [
    'info depth 10 seldepth 2 multipv 1 score mate 1 nodes 2936 nps 489333 hashfull 0 time 6 pv h5f7',
    'info depth 10 seldepth 12 multipv 2 score cp -237 nodes 2936 nps 489333 hashfull 0 time 6 pv h5e2 c6d4 e2d1 f6e4',
    'bestmove h5f7',
  ]
  const accumulator = new SearchAccumulator()
  transcript.forEach((line) => { const info = parseInfoLine(line); if (info) accumulator.add(info) })
  expect(accumulator.result()).toEqual([
    { score: { mate: 1 }, pv: ['h5f7'] },
    { score: { cp: -237 }, pv: ['h5e2', 'c6d4', 'e2d1', 'f6e4'] },
  ])
  expect(parseBestMove(transcript[2])).toBe('h5f7')
})
