// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

import { canonicalJson, sha256Hex } from '../analysis/hash'
import { ENGINE_BUILD } from './protocol'

const bin = resolve(__dirname, '../../node_modules/stockfish/bin')
const digest = (file: string) => createHash('sha256').update(readFileSync(resolve(bin, file))).digest('hex')

test('the pinned engine build matches the installed stockfish package', () => {
  expect(digest('stockfish-19-lite-single.js')).toBe(ENGINE_BUILD.js_sha256)
  expect(digest('stockfish-19-lite-single.wasm')).toBe(ENGINE_BUILD.wasm_sha256)
})

test('engine and default configuration hashes equal the Python values', async () => {
  // Values from chess_ml_coach.hosted.analysis_config with default settings.
  expect(await sha256Hex(canonicalJson(ENGINE_BUILD)))
    .toBe('1093e329aca99a45121a5157025202e7f807474ce8a4a0fbb594826f1f0b85b9')
  const document = {
    brilliant_multipv: 2, config_version: '1', depth: 12, engine: ENGINE_BUILD, feature_schema: 1,
    min_group_size: 10, model_algorithm: 'logistic-gd-v1', puzzle_algorithm: 1, report_schema: 1,
    scoring_version: 3, thresholds: { blunder: 200, inaccuracy: 50, mistake: 100 },
  }
  expect(await sha256Hex(canonicalJson(document)))
    .toBe('6a6ff33c91130dd59f3921064fa11feea3efeff9a601b3f95d0cb06f5dd1c934')
})
