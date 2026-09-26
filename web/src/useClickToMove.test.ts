import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { useClickToMove } from './useClickToMove'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const CAPTURE = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'

test('clicking a piece then a legal square plays the move', () => {
  const onMove = vi.fn(() => true)
  const { result } = renderHook(() => useClickToMove(START))

  act(() => result.current.onSquareClick(true, onMove)({ square: 'e2' }))
  expect(result.current.selected).toBe('e2')
  expect(Object.keys(result.current.squareStyles(true)).sort()).toEqual(['e2', 'e3', 'e4'])

  act(() => result.current.onSquareClick(true, onMove)({ square: 'e4' }))
  expect(onMove).toHaveBeenCalledWith('e2', 'e4')
  expect(result.current.selected).toBeNull()
})

test('illegal targets, opponent pieces, and a second click clear or switch the selection', () => {
  const onMove = vi.fn(() => true)
  const { result } = renderHook(() => useClickToMove(START))

  act(() => result.current.onSquareClick(true, onMove)({ square: 'e7' }))
  expect(result.current.selected).toBeNull()
  act(() => result.current.onSquareClick(true, onMove)({ square: 'g1' }))
  act(() => result.current.onSquareClick(true, onMove)({ square: 'b1' }))
  expect(result.current.selected).toBe('b1')
  act(() => result.current.onSquareClick(true, onMove)({ square: 'b4' }))
  expect(result.current.selected).toBeNull()
  act(() => result.current.onSquareClick(true, onMove)({ square: 'd2' }))
  act(() => result.current.onSquareClick(true, onMove)({ square: 'd2' }))
  expect(result.current.selected).toBeNull()
  expect(onMove).not.toHaveBeenCalled()
})

test('captures are marked differently and a disabled board ignores clicks', () => {
  const onMove = vi.fn(() => true)
  const { result } = renderHook(() => useClickToMove(CAPTURE))

  act(() => result.current.onSquareClick(false, onMove)({ square: 'e4' }))
  expect(result.current.selected).toBeNull()
  act(() => result.current.onSquareClick(true, onMove)({ square: 'e4' }))
  const styles = result.current.squareStyles(true)
  expect(String(styles.d5.background)).toContain('transparent 58%')
  expect(String(styles.e5.background)).toContain('22%')
  expect(result.current.squareStyles(false)).toEqual({})
})

test('a new position clears the selection', () => {
  const { result, rerender } = renderHook(({ fen }) => useClickToMove(fen), { initialProps: { fen: START } })
  act(() => result.current.onSquareClick(true, () => true)({ square: 'e2' }))
  rerender({ fen: CAPTURE })
  expect(result.current.selected).toBeNull()
})
