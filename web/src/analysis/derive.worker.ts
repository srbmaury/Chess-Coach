// Runs the derived pipeline (features, puzzles, model, report) off the UI thread.
import type { AnalysisRow } from './classify'
import { deriveArtifacts, type DeriveInput } from './pipeline'

type Request = Omit<DeriveInput, 'analysis'> & { analysis: [string, AnalysisRow[]][] }

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const artifacts = await deriveArtifacts({ ...event.data, analysis: new Map(event.data.analysis) })
    self.postMessage({ ok: true, artifacts })
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Could not build results' })
  }
}
