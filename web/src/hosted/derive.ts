// Derive results in a module worker when available so large histories never block
// the page; fall back to running inline (e.g. in tests or very old browsers).
import { deriveSelected, type ArtifactType, type DeriveInput, type DeriveResult } from '../analysis/pipeline'

export function deriveInWorker(input: DeriveInput, only: readonly ArtifactType[]): Promise<DeriveResult> {
  if (typeof Worker === 'undefined') return deriveSelected(input, only)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../analysis/derive.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: DeriveResult; message?: string }>) => {
      worker.terminate()
      if (event.data.ok && event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.message ?? 'Could not build results'))
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('Could not build results'))
    }
    worker.postMessage({ ...input, analysis: [...input.analysis.entries()], only: [...only] })
  })
}
