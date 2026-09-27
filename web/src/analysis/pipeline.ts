// Derived stages: features -> puzzles, model summary, report. Pure: no network, DOM,
// Supabase, or IndexedDB. The payloads are the versioned hosted artifact documents.
import type { AnalysisRow, ManifestGame } from './classify'
import { buildFeatureDataset } from './features'
import { trainLightweightModel, type ModelSummary } from './model'
import { extractPuzzles, type PuzzleSeed } from './puzzles'
import { buildCoachingReport, renderMarkdown, type CoachingReport } from './report'

export const ARTIFACT_SCHEMA_VERSION = 1
export type ArtifactType = 'puzzles' | 'model_summary' | 'report'
export const ARTIFACT_TYPES: ArtifactType[] = ['puzzles', 'model_summary', 'report']

type ArtifactBase = {
  schema_version: 1
  artifact_type: ArtifactType
  dependency_hash: string
  analysis_config_hash: string
}
export type PuzzlesArtifact = ArtifactBase & { artifact_type: 'puzzles'; puzzles: PuzzleSeed[] }
export type ModelArtifact = ArtifactBase & ModelSummary & { artifact_type: 'model_summary' }
export type ReportArtifact = ArtifactBase & {
  artifact_type: 'report'
  markdown: string
  overall: CoachingReport['overall']
  recurring_contexts: CoachingReport['recurring_contexts']
  candidate_positions: CoachingReport['candidate_positions']
}
export type DerivedArtifacts = {
  puzzles: PuzzlesArtifact
  model_summary: ModelArtifact
  report: ReportArtifact
}

export type DeriveInput = {
  games: ManifestGame[]
  analysis: Map<string, AnalysisRow[]>
  minGroupSize: number
  dependencyHash: string
  analysisConfigHash: string
}

/** What a pipeline stage builds: the feature table alone, or some published artifacts. */
export type DeriveResult = { featureRows: number; artifacts: Partial<DerivedArtifacts> }

export async function deriveArtifacts(input: DeriveInput): Promise<DerivedArtifacts> {
  return (await deriveSelected(input, ARTIFACT_TYPES)).artifacts as DerivedArtifacts
}

export async function deriveSelected(input: DeriveInput, only: readonly ArtifactType[]): Promise<DeriveResult> {
  const base = {
    schema_version: ARTIFACT_SCHEMA_VERSION as 1,
    dependency_hash: input.dependencyHash,
    analysis_config_hash: input.analysisConfigHash,
  }
  const features = buildFeatureDataset(input.games, input.analysis)
  const artifacts: Partial<DerivedArtifacts> = {}
  if (only.includes('puzzles')) {
    artifacts.puzzles = { ...base, artifact_type: 'puzzles', puzzles: await extractPuzzles(features) }
  }
  if (!only.includes('model_summary') && !only.includes('report')) return { featureRows: features.length, artifacts }
  const model = trainLightweightModel(features)
  if (only.includes('model_summary')) artifacts.model_summary = { ...base, ...model, artifact_type: 'model_summary' }
  if (only.includes('report')) {
    const importance = model.status === 'trained'
      ? model.feature_importance.map(({ feature, importance }) => ({ feature, importance }))
      : null
    const report = features.length ? buildCoachingReport(features, input.minGroupSize, importance) : null
    artifacts.report = {
      ...base,
      artifact_type: 'report',
      markdown: report ? renderMarkdown(report) : '# Chess ML Coach Report\n\nNo analyzed moves yet.\n',
      overall: report?.overall ?? {
        samples: 0, mistake_rate: 0, blunder_rate: 0, median_cpl: 0, mean_cpl_non_mate: 0, mate_blunders: 0,
      },
      recurring_contexts: report?.recurring_contexts.slice(0, 12) ?? [],
      candidate_positions: report?.candidate_positions ?? [],
    }
  }
  return { featureRows: features.length, artifacts }
}
