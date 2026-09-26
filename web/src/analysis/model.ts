// Lightweight, deterministic mistake model ("logistic-gd-v1").
//
// The local Python pipeline trains LightGBM, which cannot run in the browser. This
// model is a full-batch logistic regression with fixed iterations and no randomness,
// so every browser produces the same summary. Its pure-Python reference lives in
// tests/browser_parity.py; keep loop order identical so floating point matches.
import type { FeatureRow } from './features'

export const MODEL_ALGORITHM = 'logistic-gd-v1'
const NUMERIC = [
  'clock_seconds', 'legal_move_count', 'fullmove_number', 'rating_difference',
  'material_balance', 'total_non_king_material', 'king_ring_attacks', 'own_castling_rights',
  'own_doubled_pawns', 'own_isolated_pawns', 'own_pawn_islands', 'engine_eval_before_cp',
] as const
const CATEGORICAL = ['color', 'game_phase', 'time_control_category'] as const
const ITERATIONS = 300
const LEARNING_RATE = 0.1
const L2 = 0.001

export type ModelSummary =
  | { schema_version: 1; algorithm: string; status: 'insufficient_data'; reason: string }
  | {
      schema_version: 1
      algorithm: string
      status: 'trained'
      train_rows: number
      test_rows: number
      train_positive_rate: number
      test_positive_rate: number
      chronological_test_start: string
      metrics: { roc_auc: number | null; log_loss: number; brier_score: number }
      feature_names: string[]
      weights: number[]
      bias: number
      feature_importance: { feature: string; importance: number }[]
    }

const sigmoid = (value: number) => {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function auc(labels: number[], scores: number[]): number {
  const order = scores.map((_, index) => index).sort((a, b) => scores[a] - scores[b] || a - b)
  const ranks = new Array<number>(scores.length).fill(0)
  let index = 0
  while (index < order.length) {
    let end = index
    while (end + 1 < order.length && scores[order[end + 1]] === scores[order[index]]) end += 1
    const average = (index + end) / 2 + 1
    for (let position = index; position <= end; position += 1) ranks[order[position]] = average
    index = end + 1
  }
  const positives = labels.reduce((total, label) => total + label, 0)
  const negatives = labels.length - positives
  let positiveRanks = 0
  labels.forEach((label, position) => { if (label === 1) positiveRanks += ranks[position] })
  return (positiveRanks - (positives * (positives + 1)) / 2) / (positives * negatives)
}

// Python's sum() adds left to right from 0; keep that order everywhere.
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

export function trainLightweightModel(rows: FeatureRow[]): ModelSummary {
  const base = { schema_version: 1 as const, algorithm: MODEL_ALGORITHM }
  const insufficient = (reason: string): ModelSummary => ({ ...base, status: 'insufficient_data', reason })
  const labels = rows.map((row) => row.significant_mistake)
  if (!rows.length || new Set(labels).size < 2) return insufficient('Both outcomes are required')
  if (rows.some((row) => row.game_date === null)) return insufficient('Every game needs a date')
  const firstSeen = new Map<string, string>()
  rows.forEach((row) => { if (!firstSeen.has(row.game_id)) firstSeen.set(row.game_id, row.game_date!) })
  const games = [...firstSeen.entries()].sort((a, b) =>
    a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  if (games.length < 3) return insufficient('At least 3 games are required')
  const testCount = Math.min(Math.max(1, Math.ceil(games.length * 0.2)), games.length - 1)
  const testIds = new Set(games.slice(-testCount).map(([id]) => id))
  const train = rows.filter((row) => !testIds.has(row.game_id))
  const test = rows.filter((row) => testIds.has(row.game_id))
  if (new Set(train.map((row) => row.significant_mistake)).size < 2) {
    return insufficient('Training games must include both outcomes')
  }

  const numeric = (row: FeatureRow, name: (typeof NUMERIC)[number]): number | null => {
    const value = row[name]
    if (value === null || value === undefined) return null
    return name === 'engine_eval_before_cp' ? Math.max(-1000, Math.min(1000, value)) : value
  }
  const medians: number[] = []
  const means: number[] = []
  const scales: number[] = []
  for (const name of NUMERIC) {
    const present = train.map((row) => numeric(row, name)).filter((value): value is number => value !== null)
    const middle = present.length ? median(present) : 0
    const filled = train.map((row) => numeric(row, name) ?? middle)
    const mean = sum(filled) / filled.length
    const variance = sum(filled.map((value) => (value - mean) ** 2)) / filled.length
    medians.push(middle)
    means.push(mean)
    scales.push(variance > 0 ? Math.sqrt(variance) : 1)
  }
  const category = (row: FeatureRow, name: (typeof CATEGORICAL)[number]) => String(row[name] || 'unknown')
  const categories = Object.fromEntries(CATEGORICAL.map((name) =>
    [name, [...new Set(train.map((row) => category(row, name)))].sort()])) as Record<string, string[]>
  const names = [
    ...NUMERIC.map((name) => `numeric__${name}`),
    ...CATEGORICAL.flatMap((name) => categories[name].map((value) => `categorical__${name}_${value}`)),
  ]
  const vector = (row: FeatureRow): number[] => {
    const values: number[] = []
    NUMERIC.forEach((name, index) => {
      const value = numeric(row, name) ?? medians[index]
      values.push((value - means[index]) / scales[index])
    })
    for (const name of CATEGORICAL) {
      const current = category(row, name)
      for (const value of categories[name]) values.push(current === value ? 1 : 0)
    }
    return values
  }

  const trainX = train.map(vector)
  const trainY = train.map((row) => row.significant_mistake)
  const positiveRate = sum(trainY) / trainY.length
  const weights = new Array<number>(names.length).fill(0)
  let bias = Math.log(positiveRate / (1 - positiveRate))
  const count = trainX.length
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const gradient = new Array<number>(names.length).fill(0)
    let biasGradient = 0
    trainX.forEach((features, rowIndex) => {
      let linear = bias
      features.forEach((value, index) => { linear += weights[index] * value })
      const error = sigmoid(linear) - trainY[rowIndex]
      biasGradient += error
      features.forEach((value, index) => { gradient[index] += error * value })
    })
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= LEARNING_RATE * (gradient[index] / count + L2 * weights[index])
    }
    bias -= (LEARNING_RATE * biasGradient) / count
  }

  const testY = test.map((row) => row.significant_mistake)
  const probabilities = test.map((row) => {
    let linear = bias
    vector(row).forEach((value, index) => { linear += weights[index] * value })
    return sigmoid(linear)
  })
  const eps = 1e-15
  const logLoss = -sum(testY.map((label, index) => {
    const p = probabilities[index]
    return label * Math.log(Math.min(1 - eps, Math.max(eps, p)))
      + (1 - label) * Math.log(Math.min(1 - eps, Math.max(eps, 1 - p)))
  })) / testY.length
  const brier = sum(testY.map((label, index) => (probabilities[index] - label) ** 2)) / testY.length
  const importance = names
    .map((feature, index) => ({ feature, importance: Math.abs(weights[index]) }))
    .sort((a, b) => b.importance - a.importance || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0))
  return {
    ...base,
    status: 'trained',
    train_rows: train.length,
    test_rows: test.length,
    train_positive_rate: positiveRate,
    test_positive_rate: sum(testY) / testY.length,
    chronological_test_start: test.map((row) => row.game_date!).sort()[0],
    metrics: {
      roc_auc: new Set(testY).size === 2 ? auc(testY, probabilities) : null,
      log_loss: logLoss,
      brier_score: brier,
    },
    feature_names: names,
    weights,
    bias,
    feature_importance: importance,
  }
}
