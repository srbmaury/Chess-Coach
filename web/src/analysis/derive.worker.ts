// Runs the derived pipeline (features, puzzles, model, report) off the UI thread.
import type { AnalysisRow } from './classify'
import { deriveSelected, type ArtifactType, type DeriveInput } from './pipeline'

type Request = Omit<DeriveInput, 'analysis'> & { analysis: [string, AnalysisRow[]][]; only: ArtifactType[] }

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const { only, ...input } = event.data
    const result = await deriveSelected({ ...input, analysis: new Map(input.analysis) }, only)
    self.postMessage({ ok: true, result })
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Could not build results' })
  }
}
