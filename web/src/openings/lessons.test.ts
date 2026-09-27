import { Chess } from 'chess.js'
import { describe, expect, test } from 'vitest'

import { ALL_LESSONS, FAMILIES, TIERS } from './lessons'

describe('opening curriculum', () => {
  test('lesson ids are unique', () => {
    const ids = ALL_LESSONS.map((lesson) => lesson.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every family belongs to a known tier and has matching keywords', () => {
    const tierIds = new Set(TIERS.map((tier) => tier.id))
    for (const family of FAMILIES) {
      expect(tierIds.has(family.tier)).toBe(true)
      expect(family.keywords.length).toBeGreaterThan(0)
      for (const keyword of family.keywords) expect(keyword).toBe(keyword.toLowerCase())
    }
  })

  test.each(ALL_LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s is a legal line in canonical SAN', (_id, lesson) => {
    expect(lesson.eco).toMatch(/^[A-E]\d\d$/)
    expect(lesson.summary).not.toBe('')
    expect(lesson.plan).not.toBe('')
    // Learner must make at least three decisions for a drill to mean anything.
    const learnerMoves = lesson.moves.filter((_, index) => (index % 2 === 0) === (lesson.side === 'white'))
    expect(learnerMoves.length).toBeGreaterThanOrEqual(3)

    const board = new Chess()
    lesson.moves.forEach((move, index) => {
      expect(move.why, `${lesson.id} ply ${index + 1}`).not.toBe('')
      let played
      try {
        played = board.move(move.san)
      } catch {
        throw new Error(`${lesson.id}: illegal move ${move.san} at ply ${index + 1}`)
      }
      // Drills compare against chess.js SAN, so the data must already be canonical.
      expect(played.san, `${lesson.id} ply ${index + 1}`).toBe(move.san)
    })
  })

  test('traps end with the punishing move by the learner', () => {
    for (const lesson of ALL_LESSONS.filter((candidate) => candidate.kind === 'trap')) {
      const lastIndex = lesson.moves.length - 1
      expect((lastIndex % 2 === 0) === (lesson.side === 'white'), lesson.id).toBe(true)
    }
  })
})
