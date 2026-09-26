// A deterministic fake UCI worker for tests: it speaks enough UCI for the client and
// answers searches from a lookup function instead of calculating.
import type { EngineLine, WorkerLike } from './protocol'

export type FakeEngineOptions = {
  answer: (fen: string, multipv: number) => EngineLine[]
  /** Never answer `go` (to exercise timeouts and stop). */
  hang?: boolean
  /** Raise a worker error when a search starts. */
  crashOnGo?: boolean
  /** Emit a stale bestmove before readyok, as an engine finishing a stopped search would. */
  staleBestmove?: boolean
}

export class FakeUciWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly commands: string[] = []
  terminated = false
  private multipv = 1
  private fen = ''
  private searching = false

  constructor(private readonly options: FakeEngineOptions) {}

  private emit(line: string): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: line })
    })
  }

  postMessage(command: string): void {
    if (this.terminated) throw new Error('worker terminated')
    this.commands.push(command)
    if (command === 'uci') {
      this.emit('id name Fakefish')
      this.emit('uciok')
    } else if (command === 'isready') {
      if (this.options.staleBestmove) this.emit('bestmove a1a1')
      this.emit('readyok')
    } else if (command.startsWith('setoption name MultiPV value ')) {
      this.multipv = Number(command.split(' ').pop())
    } else if (command.startsWith('position fen ')) {
      this.fen = command.slice('position fen '.length)
    } else if (command.startsWith('go')) {
      if (this.options.crashOnGo) {
        queueMicrotask(() => this.onerror?.(new Error('wasm trap')))
        return
      }
      this.searching = true
      if (this.options.hang) return
      const lines = this.options.answer(this.fen, this.multipv)
      this.emit('info depth 1 currmove e2e4 currmovenumber 1')
      lines.forEach((line, index) => {
        const score = 'cp' in line.score ? `cp ${line.score.cp}` : `mate ${line.score.mate}`
        this.emit(`info depth 12 seldepth 14 multipv ${index + 1} score ${score} nodes 100 pv ${line.pv.join(' ')}`.trim())
      })
      this.emit(`bestmove ${lines[0]?.pv[0] ?? '(none)'}`)
      this.searching = false
    } else if (command === 'stop' && this.searching) {
      this.searching = false
      this.emit('bestmove (none)')
    }
  }

  terminate(): void {
    this.terminated = true
  }
}
