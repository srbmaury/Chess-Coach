// The bundled Stockfish 19 lite single-threaded WASM build (GPLv3, see README).
// stockfish.js runs as a classic Web Worker and reads its .wasm location from the
// URL fragment, so both files keep Vite's immutable hashed names.
import engineScriptUrl from 'stockfish/bin/stockfish-19-lite-single.js?url'
import engineWasmUrl from 'stockfish/bin/stockfish-19-lite-single.wasm?url'

import type { WorkerLike } from './protocol'

export function createStockfishWorker(): WorkerLike {
  const wasm = new URL(engineWasmUrl, window.location.href).href
  return new Worker(`${engineScriptUrl}#${encodeURIComponent(wasm)}`) as unknown as WorkerLike
}
