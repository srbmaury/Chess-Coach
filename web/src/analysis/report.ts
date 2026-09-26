// Coaching report ported from report.py (report schema 1). Output markdown must match
// render_markdown(build_coaching_report(...)) byte for byte; see parity.test.ts.
import { Chess } from 'chess.js'

import { parseUci } from './board'
import { MATE_THRESHOLD_CP } from './classify'
import type { FeatureRow } from './features'
import { formatFixed, formatPercent, formatSigned, pyTitle } from './pyformat'

type Cell = string | number | null
type Stats = {
  samples: number
  mistake_rate: number
  blunder_rate: number
  median_cpl: number
  mean_cpl_non_mate: number
  mate_blunders: number
}
type ReportRow = { quality: string; significant_mistake: number; cpl: number; mate: boolean }
export type GroupTable = { indexName: string; rows: { label: string | null; stats: Stats }[] }
export type ContextRow = {
  dimension: string
  context: string
  samples: number
  mistake_rate: number
  blunder_rate: number
  median_cpl: number
  vs_baseline: number
}
export type CandidateRow = {
  game_id: string
  game: string
  move: string
  your_move: string
  better_move: string
  eval_loss: string
  quality: string
  game_url: string
}
export type CoachingReport = {
  overall: Stats
  by_color: GroupTable
  by_phase: GroupTable
  by_opening: GroupTable
  by_time_control: GroupTable
  recurring_contexts: ContextRow[]
  candidate_positions: CandidateRow[]
  feature_importance: { feature: string; relative_importance: number }[]
}

const DISPLAY_LABELS: Record<string, string> = {
  samples: 'Moves', mistake_rate: 'Mistake rate', blunder_rate: 'Blunder rate',
  median_cpl: 'Typical eval loss', mean_cpl_non_mate: 'Average eval loss',
  mate_blunders: 'Mate mistakes', dimension: 'Category', context: 'Context',
  vs_baseline: 'Vs baseline', game_id: 'Game ID', game: 'Game', move: 'Move',
  your_move: 'Your move', better_move: 'Best move', eval_loss: 'Eval loss',
  quality: 'Quality', game_url: 'Game link', feature: 'Signal',
  relative_importance: 'Relative importance',
}
const FEATURE_LABELS: Record<string, string> = {
  eval_before_cp: 'Position evaluation', engine_eval_before_cp: 'Position evaluation',
  clock_seconds: 'Time remaining', legal_move_count: 'Legal move choices',
  fullmove_number: 'Move number', rating_difference: 'Rating difference',
  material_balance: 'Material advantage', total_non_king_material: 'Material remaining',
  white_rating: 'White rating', black_rating: 'Black rating',
  material_balance_white: 'White material advantage', white_material: 'White material',
  black_material: 'Black material', king_ring_attacks: 'King pressure',
  own_castling_rights: 'Castling options', own_doubled_pawns: 'Doubled pawns',
  own_isolated_pawns: 'Isolated pawns', own_pawn_islands: 'Pawn islands',
}
const STAT_COLUMNS = ['samples', 'mistake_rate', 'blunder_rate', 'median_cpl', 'mean_cpl_non_mate', 'mate_blunders'] as const

function deliveredCheckmate(fen: string | null): boolean {
  if (!fen) return false
  try {
    return new Chess(fen).isCheckmate()
  } catch {
    return false
  }
}

type CleanRow = FeatureRow & { mate: boolean }

function sanitize(rows: FeatureRow[]): CleanRow[] {
  return rows.map((row) => {
    const sameMove = !!row.uci && !!row.best_move_uci && row.uci === row.best_move_uci
    const clean = sameMove || deliveredCheckmate(row.fen_after)
      ? { ...row, cpl: 0, quality: 'good', significant_mistake: 0 }
      : { ...row }
    const mate = Math.abs(clean.eval_before_cp) >= MATE_THRESHOLD_CP
      || Math.abs(clean.eval_after_cp) >= MATE_THRESHOLD_CP
      || clean.cpl >= MATE_THRESHOLD_CP
    return { ...clean, mate }
  })
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function summaryStats(rows: ReportRow[]): Stats {
  const normal = rows.filter((row) => !row.mate).map((row) => row.cpl)
  const count = rows.length
  return {
    samples: count,
    mistake_rate: rows.reduce((total, row) => total + row.significant_mistake, 0) / count,
    blunder_rate: rows.filter((row) => row.quality === 'blunder').length / count,
    median_cpl: normal.length ? median(normal) : 0,
    mean_cpl_non_mate: normal.length ? normal.reduce((total, value) => total + value, 0) / normal.length : 0,
    mate_blunders: rows.filter((row) => row.mate && row.quality === 'blunder').length,
  }
}

function aggregate(rows: CleanRow[], key: (row: CleanRow) => string | null, indexName: string, minGroupSize: number): GroupTable {
  // pandas groupby(dropna=False) sorts keys with missing values last.
  const groups = new Map<string | null, CleanRow[]>()
  rows.forEach((row) => {
    const label = key(row)
    groups.set(label, [...(groups.get(label) ?? []), row])
  })
  const labels = [...groups.keys()].sort((a, b) => {
    if (a === b) return 0
    if (a === null) return 1
    if (b === null) return -1
    return a < b ? -1 : 1
  })
  const table = labels
    .map((label) => ({ label, stats: summaryStats(groups.get(label)!) }))
    .filter((row) => row.stats.samples >= minGroupSize)
  // sort_values(["mistake_rate", "samples"], ascending=False) is a stable lexsort.
  const ordered = table
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.stats.mistake_rate - a.row.stats.mistake_rate
      || b.row.stats.samples - a.row.stats.samples || a.index - b.index)
    .map(({ row }) => row)
  return { indexName, rows: ordered }
}

function humanizeOpening(value: string): string {
  const replacements: [string, string][] = [
    ['Kings Pawn', "King's Pawn"], ['Queens Pawn', "Queen's Pawn"], ['Kings Indian', "King's Indian"],
    ['Queens Indian', "Queen's Indian"], ['Queens Gambit', "Queen's Gambit"], ['Petrovs Defense', "Petrov's Defense"],
  ]
  let text = value.trim()
  for (const [from, to] of replacements) text = text.split(from).join(to)
  return text
}

function openingLabel(row: CleanRow): string {
  const eco = String(row.eco || 'unknown')
  const opening = row.opening
  if (opening === null || ['', 'unknown', 'nan'].includes(String(opening).trim().toLowerCase())) return eco
  return `${humanizeOpening(opening)} (${eco})`
}

function recurringContexts(overallRate: number, tables: [string, GroupTable][]): ContextRow[] {
  const rows: (ContextRow & { score: number; index: number })[] = []
  for (const [dimension, table] of tables) {
    for (const { label, stats } of table.rows) {
      const excess = stats.mistake_rate - overallRate
      rows.push({
        dimension,
        context: label === null ? 'nan' : label,
        samples: stats.samples,
        mistake_rate: stats.mistake_rate,
        blunder_rate: stats.blunder_rate,
        median_cpl: stats.median_cpl,
        vs_baseline: excess,
        score: excess * Math.log1p(stats.samples),
        index: rows.length,
      })
    }
  }
  return rows
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ score: _score, index: _index, ...row }) => row)
}

function bestMoveSan(fen: string, bestMoveUci: string | null): string {
  if (!bestMoveUci) return 'unknown'
  try {
    return new Chess(fen).move(parseUci(bestMoveUci)).san
  } catch {
    return bestMoveUci
  }
}

function candidatePositions(rows: CleanRow[], limit = 20, maxPerGame = 2): CandidateRow[] {
  const mistakes = rows
    .filter((row) => row.quality === 'mistake' || row.quality === 'blunder')
    .filter((row) => !row.best_move_uci || !row.uci || row.uci !== row.best_move_uci)
  const ranked = mistakes
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.cpl - a.row.cpl || a.index - b.index)
    .map(({ row }) => row)
  const result: CandidateRow[] = []
  const perGame = new Map<string, number>()
  for (const row of ranked) {
    if ((perGame.get(row.game_id) ?? 0) >= maxPerGame) continue
    const separator = row.color === 'white' ? '.' : '...'
    result.push({
      game_id: row.game_id,
      game: row.white !== null && row.black !== null ? `${row.white} vs ${row.black}` : 'Game',
      move: `${row.fullmove_number}${separator}${row.san || row.uci || 'unknown'}`,
      your_move: String(row.san || row.uci || 'unknown'),
      better_move: bestMoveSan(row.fen_before, row.best_move_uci),
      eval_loss: row.mate ? 'Mate swing' : `${formatFixed(row.cpl / 100, 2)} pawns`,
      quality: String(row.quality ?? 'unknown'),
      game_url: String(row.source_url || ''),
    })
    perGame.set(row.game_id, (perGame.get(row.game_id) ?? 0) + 1)
    if (result.length >= limit) break
  }
  return result
}

function humanFeatureName(raw: string): string {
  let name = raw
  if (name.includes('__')) name = name.split('__').slice(1).join('__')
  if (name in FEATURE_LABELS) return FEATURE_LABELS[name]
  const prefixes: [string, string][] = [
    ['game_phase_', 'Game phase'], ['time_control_category_', 'Time control'], ['color_', 'Color'],
    ['eco_', 'Opening code'], ['opening_', 'Opening'],
  ]
  for (const [prefix, label] of prefixes) {
    if (name.startsWith(prefix)) return `${label}: ${name.slice(prefix.length).split('_').join(' ')}`
  }
  return pyTitle(name.split('_').join(' ').trim())
}

function featureImportance(items: { feature: string; importance: number }[] | null) {
  if (!items || !items.length) return []
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.importance) ? item.importance : 0), 0)
  return items.map((item) => ({
    feature: humanFeatureName(item.feature),
    relative_importance: total > 0 ? item.importance / total : 0,
  }))
}

export function buildCoachingReport(
  rows: FeatureRow[],
  minGroupSize: number,
  importance: { feature: string; importance: number }[] | null,
): CoachingReport {
  if (!rows.length) throw new Error('Feature dataset is empty')
  const clean = sanitize(rows)
  const overall = summaryStats(clean)
  const byColor = aggregate(clean, (row) => row.color, 'color', minGroupSize)
  const byPhase = aggregate(clean, (row) => row.game_phase, 'game_phase', minGroupSize)
  const byOpening = aggregate(clean, openingLabel, 'opening', minGroupSize)
  const byTimeControl = aggregate(clean, (row) => row.time_control_category, 'time_control_category', minGroupSize)
  return {
    overall,
    by_color: byColor,
    by_phase: byPhase,
    by_opening: byOpening,
    by_time_control: byTimeControl,
    recurring_contexts: recurringContexts(overall.mistake_rate, [
      ['color', byColor], ['phase', byPhase], ['opening', byOpening], ['time_control', byTimeControl],
    ]),
    candidate_positions: candidatePositions(clean),
    feature_importance: featureImportance(importance),
  }
}

function formatCell(column: string, value: Cell): string {
  if (value === null) return 'n/a'
  if (['mistake_rate', 'blunder_rate', 'relative_importance'].includes(column)) return formatPercent(Number(value), 1)
  if (column === 'vs_baseline') return `${formatSigned(Number(value) * 100, 1)} pp`
  if (column === 'median_cpl' || column === 'mean_cpl_non_mate') return `${formatFixed(Number(value) / 100, 2)} pawns`
  if (column === 'game_url') return value ? `[Open game](${value})` : 'n/a'
  if (column === 'quality' || column === 'dimension') return pyTitle(String(value).split('_').join(' '))
  return String(value)
}

function markdownTable(columns: string[], data: Cell[][], maxRows = 12): string {
  const limited = data.slice(0, maxRows)
  if (!limited.length) return '_Insufficient sample size._'
  const header = `| ${columns.map((column) => DISPLAY_LABELS[column] ?? pyTitle(column.split('_').join(' '))).join(' | ')} |`
  const separator = `| ${columns.map(() => '---').join(' | ')} |`
  const body = limited.map((row) => `| ${row.map((value, index) => formatCell(columns[index], value)).join(' | ')} |`)
  return [header, separator, ...body].join('\n')
}

function groupMarkdown(table: GroupTable): string {
  return markdownTable(
    [table.indexName, ...STAT_COLUMNS],
    table.rows.map(({ label, stats }) => [label, ...STAT_COLUMNS.map((column) => stats[column])]),
  )
}

function contextTitle(dimension: string, context: string): string {
  return ['color', 'phase', 'time_control'].includes(dimension) ? pyTitle(context.split('_').join(' ')) : context
}

function priorityLines(report: CoachingReport): string[] {
  const positive = report.recurring_contexts.filter((row) => row.vs_baseline > 0).slice(0, 3)
  if (!positive.length) return ['- No recurring context is clearly worse than your overall baseline yet.']
  return positive.map((row) =>
    `- **${contextTitle(row.dimension, row.context)}**: ${formatPercent(row.mistake_rate, 1)} significant mistakes `
    + `across ${row.samples} moves `
    + `(${formatSigned(row.vs_baseline * 100, 1)} percentage points vs your baseline).`)
}

export function renderMarkdown(report: CoachingReport): string {
  const contextColumns = ['dimension', 'context', 'samples', 'mistake_rate', 'blunder_rate', 'median_cpl', 'vs_baseline'] as const
  const candidateColumns = ['game', 'move', 'your_move', 'better_move', 'eval_loss', 'quality', 'game_url'] as const
  const overall = report.overall
  const lines = [
    '# Chess ML Coach Report',
    '',
    '## Your priorities',
    ...priorityLines(report),
    '',
    'Use these as training priorities, not absolute judgments; larger samples are more reliable.',
    '',
    '## Overall',
    `- Analyzed moves: ${overall.samples}`,
    `- Mistake rate: ${formatPercent(overall.mistake_rate, 1)}`,
    `- Blunder rate: ${formatPercent(overall.blunder_rate, 1)}`,
    `- Typical eval loss: ${formatFixed(overall.median_cpl / 100, 2)} pawns`,
    `- Average eval loss: ${formatFixed(overall.mean_cpl_non_mate / 100, 2)} pawns`,
    `- Mate mistakes: ${overall.mate_blunders}`,
    '',
    '## By color',
    groupMarkdown(report.by_color),
    '',
    '## By phase',
    groupMarkdown(report.by_phase),
    '',
    '## Openings',
    groupMarkdown(report.by_opening),
    '',
    '## Time controls',
    groupMarkdown(report.by_time_control),
    '',
    '## Recurring weakness contexts',
    markdownTable([...contextColumns], report.recurring_contexts.map((row) => contextColumns.map((column) => row[column]))),
    '',
    '## Candidate training positions',
    'These are positions from your own games to review first.',
    '',
    markdownTable([...candidateColumns], report.candidate_positions.map((row) => candidateColumns.map((column) => row[column])), 20),
  ]
  if (report.feature_importance.length) {
    lines.push(
      '',
      '## Model feature importance',
      'Feature importance is associative, not causal.',
      '',
      markdownTable(['feature', 'relative_importance'], report.feature_importance.map((row) => [row.feature, row.relative_importance])),
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}
