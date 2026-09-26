// Derive results in a module worker when available so large histories never block
// the page; fall back to running inline (e.g. in tests or very old browsers).
import { deriveArtifacts, type DeriveInput, type DerivedArtifacts } from '../analysis/pipeline'

export function deriveInWorker(input: DeriveInput): Promise<DerivedArtifacts> {
  if (typeof Worker === 'undefined') return deriveArtifacts(input)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../analysis/derive.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ ok: boolean; artifacts?: DerivedArtifacts; message?: string }>) => {
      worker.terminate()
      if (event.data.ok && event.data.artifacts) resolve(event.data.artifacts)
      else reject(new Error(event.data.message ?? 'Could not build results'))
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('Could not build results'))
    }
    worker.postMessage({ ...input, analysis: [...input.analysis.entries()] })
  })
}
