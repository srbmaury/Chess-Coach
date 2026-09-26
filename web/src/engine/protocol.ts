// Engine protocol types shared by the UCI parser, the worker client, and fakes.
import type { EngineLine } from '../analysis/classify'

export type { EngineLine }

/** The bundled Stockfish build. Must equal ENGINE_BUILD in hosted/analysis_config.py. */
export const ENGINE_BUILD = {
  package: 'stockfish',
  version: '19.0.0',
  flavor: 'lite-single',
  js_sha256: 'd3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6',
  wasm_sha256: '57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387',
} as const

/** The minimal Worker surface the client needs, so tests can supply a fake. */
export interface WorkerLike {
  postMessage(message: string): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type WorkerFactory = () => WorkerLike

export class EngineError extends Error {
  constructor(message: string, readonly code: 'terminated' | 'timeout' | 'crashed' | 'aborted') {
    super(message)
    this.name = 'EngineError'
  }
}
