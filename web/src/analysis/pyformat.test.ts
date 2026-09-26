import { expect, test } from 'vitest'

import { formatFixed, formatPercent, formatSigned, pyTitle } from './pyformat'

// Expected values produced by CPython's format() for the same doubles.
test.each([
  [0.125, 2, '0.12'], [0.375, 2, '0.38'], [2.675, 2, '2.67'], [-0.0, 1, '-0.0'],
  [1.005, 2, '1.00'], [0.5, 0, '0'], [1.5, 0, '2'], [2.5, 0, '2'], [-2.5, 0, '-2'],
  [123456.789, 1, '123456.8'], [5e-324, 3, '0.000'], [1e22, 1, '10000000000000000000000.0'],
])('formatFixed(%s, %s) matches Python', (value, digits, expected) => {
  expect(formatFixed(value, digits)).toBe(expected)
})

test.each([
  [0.1665, '16.7%', '+16.7'], [0.0005, '0.1%', '+0.1'], [1 / 3, '33.3%', '+33.3'],
  [-0.00049, '-0.0%', '-0.0'], [0, '0.0%', '+0.0'],
])('percent and signed formatting of %s match Python', (value, percent, signed) => {
  expect(formatPercent(value, 1)).toBe(percent)
  expect(formatSigned(value * 100, 1)).toBe(signed)
})

test('title case follows str.title()', () => {
  expect(['game phase', 'time control category', "king's pawn", 'x2y'].map(pyTitle))
    .toEqual(['Game Phase', 'Time Control Category', "King'S Pawn", 'X2Y'])
})
