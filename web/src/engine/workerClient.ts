// Drives a UCI engine running in a dedicated Web Worker. One search runs at a time;
// every search starts behind an `isready` barrier so output from an earlier, stopped
// search can never leak into the next result.
import type { MoveEngine } from '../analysis/classify'
import { EngineError, type EngineLine, type WorkerFactory, type WorkerLike } from './protocol'
import { parseBestMove, parseInfoLine, SearchAccumulator } from './uci'

export type EngineClientOptions = {
  depth: number
  hashMb?: number
  handshakeTimeoutMs?: number
  searchTimeoutMs?: number
}

type Waiter = {
  onLine: (line: string) => boolean
  resolve: () => void
  reject: (error: EngineError) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class EngineWorkerClient implements MoveEngine {
  private worker: WorkerLike | null = null
  private started: Promise<void> | null = null
  private waiter: Waiter | null = null
  private failure: EngineError | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly factory: WorkerFactory, private readonly options: EngineClientOptions) {}

  get alive(): boolean {
    return this.failure === null
  }

  private send(command: string): void {
    if (this.failure) throw this.failure
    this.worker!.postMessage(command)
  }

  private handle(data: unknown): void {
    for (const line of String(data).split('\n')) {
      if (!line.trim() || !this.waiter) continue
      if (this.waiter.onLine(line)) {
        const done = this.waiter
        this.waiter = null
        if (done.timer) clearTimeout(done.timer)
        done.resolve()
      }
    }
  }

  private waitFor(onLine: (line: string) => boolean, timeoutMs: number | undefined, timeoutError: EngineError): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { onLine, resolve, reject, timer: null }
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          if (this.waiter === waiter) this.fail(timeoutError)
        }, timeoutMs)
      }
      this.waiter = waiter
    })
  }

  private fail(error: EngineError): void {
    if (this.failure) return
    this.failure = error
    const pending = this.waiter
    this.waiter = null
    if (pending?.timer) clearTimeout(pending.timer)
    try {
      this.worker?.terminate()
    } finally {
      this.worker = null
      pending?.reject(error)
    }
  }

  /** Stop immediately (e.g. on lease loss); any running search rejects. */
  terminate(): void {
    this.fail(new EngineError('Engine stopped', 'terminated'))
  }

  start(): Promise<void> {
    if (!this.started) {
      this.started = (async () => {
        const worker = this.factory()
        this.worker = worker
        worker.onmessage = (event) => this.handle(event.data)
        worker.onerror = () => this.fail(new EngineError('Engine crashed', 'crashed'))
        const timeout = this.options.handshakeTimeoutMs ?? 30_000
        const handshake = this.waitFor((line) => line.trim() === 'uciok', timeout, new EngineError('Engine did not start', 'timeout'))
        this.send('uci')
        await handshake
        this.send(`setoption name Hash value ${this.options.hashMb ?? 16}`)
        this.send('ucinewgame')
        await this.barrier(timeout)
      })()
    }
    return this.started
  }

  private barrier(timeoutMs: number): Promise<void> {
    const ready = this.waitFor((line) => line.trim() === 'readyok', timeoutMs, new EngineError('Engine stopped responding', 'timeout'))
    this.send('isready')
    return ready
  }

  search(fen: string, multipv: number, signal?: AbortSignal): Promise<EngineLine[]> {
    const run = this.queue.then(() => this.runSearch(fen, multipv, signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async runSearch(fen: string, multipv: number, signal?: AbortSignal): Promise<EngineLine[]> {
    if (signal?.aborted) throw new EngineError('Search aborted', 'aborted')
    await this.start()
    this.send(`setoption name MultiPV value ${multipv}`)
    await this.barrier(this.options.handshakeTimeoutMs ?? 30_000)
    const accumulator = new SearchAccumulator()
    let aborted = false
    const onAbort = () => {
      aborted = true
      if (!this.failure) this.worker?.postMessage('stop')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const done = this.waitFor((line) => {
        if (parseBestMove(line) !== undefined) return true
        const info = parseInfoLine(line)
        if (info) accumulator.add(info)
        return false
      }, this.options.searchTimeoutMs ?? 120_000, new EngineError('Engine search timed out', 'timeout'))
      this.send(`position fen ${fen}`)
      this.send(`go depth ${this.options.depth}`)
      await done
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (aborted) throw new EngineError('Search aborted', 'aborted')
    return accumulator.result()
  }
}
