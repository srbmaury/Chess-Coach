import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position: string; allowDragging?: boolean; onPieceDrop?: (move: { sourceSquare: string; targetSquare: string }) => boolean } }) => (
    <div>
      <span data-testid="board-position">{options.position}</span>
      <span data-testid="board-dragging">{String(options.allowDragging)}</span>
      {[['e2', 'e4'], ['d2', 'd4'], ['g1', 'f3']].map(([from, to]) => (
        <button key={from + to} aria-label={`Drop ${from}${to}`} onClick={() => options.onPieceDrop?.({ sourceSquare: from, targetSquare: to })}>{from}{to}</button>
      ))}
    </div>
  ),
}))

import LegacyApp from '../LegacyApp'
import { recommendFamilies } from './OpeningsPage'
import { recordDrill, lessonStatus } from './progress'

const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'

function stubProgress(byOpening: Array<{ label: string; puzzles: number }> = []) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (String(input) === '/api/progress') return { ok: true, json: async () => ({ by_opening: byOpening }) } as Response
    throw new Error(`Unexpected fetch: ${String(input)}`)
  }))
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.pushState({}, '', '/openings')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

test('Openings tab lists the tiered curriculum and recommends weak families', async () => {
  stubProgress([
    { label: 'Sicilian Defense Najdorf Variation', puzzles: 7 },
    { label: 'Sicilian Defense Alapin Variation', puzzles: 2 },
    { label: 'Italian Game Two Knights Defense', puzzles: 4 },
  ])
  render(<LegacyApp />)

  expect(screen.getByRole('link', { name: 'Openings' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Opening lessons' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Principles' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Closed games' })).toBeTruthy()
  expect(screen.getByText('Najdorf Variation')).toBeTruthy()
  expect(await screen.findByText('Recommended from your games')).toBeTruthy()
  expect(screen.getByText('9 mistake positions in your games')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Review due (0)' }) as HTMLButtonElement).disabled).toBe(true)
})

test('Learn mode steps through moves with their reasons', async () => {
  stubProgress()
  render(<LegacyApp />)

  fireEvent.click(screen.getByRole('button', { name: /^New The classical setup/ }))
  expect(screen.getByRole('heading', { name: 'The classical setup' })).toBeTruthy()
  expect(screen.getByText('THE IDEA')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Next move' }))
  expect(screen.getByText(/Grabs central space/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next move' }))
  expect(screen.getByTestId('board-position').textContent).toBe(AFTER_E4_E5)
  expect(screen.getByText('2 / 10')).toBeTruthy()
})

test('Drill accepts book moves, auto-plays replies, and counts misses once per position', async () => {
  stubProgress()
  render(<LegacyApp />)

  fireEvent.click(screen.getByRole('button', { name: /^New The classical setup/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Drill' }))

  fireEvent.click(screen.getByRole('button', { name: 'Drop e2e4' }))
  expect(screen.getByText('1.e4 ✓')).toBeTruthy()
  await waitFor(() => expect(screen.getByTestId('board-position').textContent).toBe(AFTER_E4_E5))
  expect(screen.getByText('OPPONENT · 1…e5')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Drop d2d4' }))
  expect(screen.getByText("d4 isn't the book move")).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Drop d2d4' }))
  expect(screen.getByText(/Book move:/)).toBeTruthy()
  expect(screen.getByText(/1 mistake$/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Drop g1f3' }))
  expect(screen.getByText('2.Nf3 ✓')).toBeTruthy()
})

test('recommendations ignore unknown openings and rank by mistake positions', () => {
  const ranked = recommendFamilies([
    { label: 'Bongcloud Attack', puzzles: 20 },
    { label: "Queen's Gambit Declined", puzzles: 3 },
    { label: 'French Defense Advance Variation', puzzles: 5 },
  ])
  expect(ranked.map((entry) => entry.family.id)).toEqual(['french', 'queens-gambit'])
})

test('clean drills climb the Leitner boxes and misses reset them', () => {
  const now = 1_000_000
  const first = recordDrill(undefined, 0, now)
  expect(first.box).toBe(1)
  expect(lessonStatus(first, now)).toBe('learning')
  const second = recordDrill(first, 0, now)
  expect(second.box).toBe(2)
  const missed = recordDrill(second, 2, now)
  expect(missed.box).toBe(0)
  expect(missed.lapses).toBe(1)
  expect(lessonStatus(missed, now + 11 * 60 * 1000)).toBe('due')
})
