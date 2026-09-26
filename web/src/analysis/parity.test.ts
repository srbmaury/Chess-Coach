// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { analyzeGame, type AnalysisRow, type EngineLine, type ManifestGame, type MoveEngine } from './classify'
import { buildFeatureDataset } from './features'
import { trainLightweightModel } from './model'
import { deriveArtifacts } from './pipeline'
import { extractPuzzles } from './puzzles'
import { buildCoachingReport, renderMarkdown } from './report'

type Fixture = {
  depth: number
  min_group_size: number
  manifest: { games: ManifestGame[] }
  engine: Record<string, EngineLine[]>
  analysis: (AnalysisRow & { game_id: string })[]
  features: Record<string, unknown>[]
  puzzles: unknown[]
  model_summary: Record<string, unknown> & { status: string }
  report: { overall: Record<string, number>; markdown: string }
}

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../tests/fixtures/browser_parity.json'), 'utf-8'),
)

class ReplayEngine implements MoveEngine {
  readonly queried = new Set<string>()
  async search(fen: string, multipv: number): Promise<EngineLine[]> {
    const key = `${fen}|${multipv}`
    this.queried.add(key)
    const lines = fixture.engine[key]
    if (!lines) throw new Error(`Unexpected engine query: ${key}`)
    return lines
  }
}

async function analyzeAll() {
  const engine = new ReplayEngine()
  const analysis = new Map<string, AnalysisRow[]>()
  for (const game of fixture.manifest.games) {
    analysis.set(game.game_id, await analyzeGame(game, engine, { multipv: 2 }))
  }
  return { engine, analysis }
}

function closeTo(actual: unknown, expected: unknown, path = 'value'): void {
  if (typeof expected === 'number' && typeof actual === 'number' && !Number.isInteger(expected)) {
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)))
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as unknown[]).length, path).toBe(expected.length)
    expected.forEach((item, index) => closeTo((actual as unknown[])[index], item, `${path}[${index}]`))
  } else if (expected && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort())
    for (const [key, value] of Object.entries(expected)) closeTo((actual as Record<string, unknown>)[key], value, `${path}.${key}`)
  } else {
    expect(actual, path).toEqual(expected)
  }
}

describe('browser pipeline parity with the Python pipeline', () => {
  test('move classification matches exactly and makes the same engine queries', async () => {
    const { engine, analysis } = await analyzeAll()
    const rows = fixture.manifest.games.flatMap((game) =>
      analysis.get(game.game_id)!.map((row) => ({ game_id: game.game_id, ...row })))
    const byKey = (row: { game_id: string; ply: number }) => `${row.game_id}#${String(row.ply).padStart(4, '0')}`
    rows.sort((a, b) => (byKey(a) < byKey(b) ? -1 : 1))
    const expected = [...fixture.analysis].sort((a, b) => (byKey(a) < byKey(b) ? -1 : 1))
    expect(rows).toEqual(expected)
    expect([...engine.queried].sort()).toEqual(Object.keys(fixture.engine).sort())
  })

  test('feature rows match column for column', async () => {
    const { analysis } = await analyzeAll()
    const features = buildFeatureDataset(fixture.manifest.games, analysis)
    const columns = Object.keys(fixture.features[0])
    const projected = features.map((row) =>
      Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column] ?? null])))
    expect(projected).toEqual(fixture.features)
  })

  test('puzzles match exactly', async () => {
    const { analysis } = await analyzeAll()
    const puzzles = await extractPuzzles(buildFeatureDataset(fixture.manifest.games, analysis))
    expect(puzzles).toEqual(fixture.puzzles)
  })

  test('lightweight model summary matches the Python reference', async () => {
    const { analysis } = await analyzeAll()
    const model = trainLightweightModel(buildFeatureDataset(fixture.manifest.games, analysis))
    expect(model.status).toBe('trained')
    closeTo(model, fixture.model_summary, 'model')
  })

  test('report markdown matches byte for byte', async () => {
    const { analysis } = await analyzeAll()
    const features = buildFeatureDataset(fixture.manifest.games, analysis)
    const model = trainLightweightModel(features)
    const importance = model.status === 'trained' ? model.feature_importance : null
    const report = buildCoachingReport(features, fixture.min_group_size, importance)
    closeTo(report.overall, fixture.report.overall, 'overall')
    expect(renderMarkdown(report)).toBe(fixture.report.markdown)
  })

  test('derived artifact payloads are versioned and carry their dependency', async () => {
    const { analysis } = await analyzeAll()
    const artifacts = await deriveArtifacts({
      games: fixture.manifest.games,
      analysis,
      minGroupSize: fixture.min_group_size,
      dependencyHash: 'd'.repeat(64),
      analysisConfigHash: 'c'.repeat(64),
    })
    for (const [type, artifact] of Object.entries(artifacts)) {
      expect(artifact.artifact_type).toBe(type)
      expect(artifact.schema_version).toBe(1)
      expect(artifact.dependency_hash).toBe('d'.repeat(64))
    }
    expect(artifacts.report.markdown).toBe(fixture.report.markdown)
    expect(artifacts.puzzles.puzzles).toEqual(fixture.puzzles)
  })

  test('small and empty inputs degrade gracefully', async () => {
    const [game] = fixture.manifest.games
    const empty = await deriveArtifacts({
      games: [game],
      analysis: new Map(),
      minGroupSize: 10,
      dependencyHash: 'd'.repeat(64),
      analysisConfigHash: 'c'.repeat(64),
    })
    expect(empty.model_summary.status).toBe('insufficient_data')
    expect(empty.puzzles.puzzles).toEqual([])
    expect(empty.report.markdown.startsWith('# Chess ML Coach Report')).toBe(true)
  })
})
