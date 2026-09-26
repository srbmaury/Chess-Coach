// UCI output parsing. Info lines are merged per MultiPV index the way python-chess's
// AnalysisResult does, so the final line for each index carries the last reported
// score and principal variation.
import type { UciScore } from '../analysis/classify'

export type UciInfo = {
  multipv: number
  depth?: number
  seldepth?: number
  nodes?: number
  score?: UciScore
  bound?: 'lowerbound' | 'upperbound'
  pv?: string[]
}

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/
const INTEGER = /^[+-]?\d+$/

/** Parse one `info …` line; returns null for non-search info (e.g. `info string`). */
export function parseInfoLine(line: string): UciInfo | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens[0] !== 'info' || tokens[1] === 'string') return null
  const info: UciInfo = { multipv: 1 }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    switch (token) {
      case 'depth':
      case 'seldepth':
      case 'nodes':
      case 'multipv':
        if (next !== undefined && INTEGER.test(next)) info[token] = Number(next)
        index += 1
        break
      case 'score': {
        const kind = tokens[index + 1]
        const value = tokens[index + 2]
        if ((kind === 'cp' || kind === 'mate') && value !== undefined && INTEGER.test(value)) {
          info.score = kind === 'cp' ? { cp: Number(value) } : { mate: Number(value) }
        }
        index += 2
        if (tokens[index + 1] === 'lowerbound' || tokens[index + 1] === 'upperbound') {
          info.bound = tokens[index + 1] as UciInfo['bound']
          index += 1
        }
        break
      }
      case 'pv': {
        const moves: string[] = []
        while (index + 1 < tokens.length && UCI_MOVE.test(tokens[index + 1])) {
          moves.push(tokens[index + 1])
          index += 1
        }
        info.pv = moves
        break
      }
      case 'string':
        return info
      default:
        break
    }
  }
  return info.score || info.pv ? info : null
}

/** `bestmove e2e4 ponder e7e5` -> 'e2e4'; `bestmove (none)` -> null. */
export function parseBestMove(line: string): string | null | undefined {
  const tokens = line.trim().split(/\s+/)
  if (tokens[0] !== 'bestmove') return undefined
  return tokens[1] && UCI_MOVE.test(tokens[1]) ? tokens[1] : null
}

export class SearchAccumulator {
  private readonly lines = new Map<number, UciInfo>()

  add(info: UciInfo): void {
    const current = this.lines.get(info.multipv) ?? { multipv: info.multipv }
    this.lines.set(info.multipv, { ...current, ...info })
  }

  /** Lines in MultiPV order; positions with no legal move yield one pv-less line. */
  result(): { score: UciScore; pv: string[] }[] {
    return [...this.lines.values()]
      .filter((info): info is UciInfo & { score: UciScore } => info.score !== undefined)
      .sort((a, b) => a.multipv - b.multipv)
      .map((info) => ({ score: info.score, pv: info.pv ?? [] }))
  }
}
