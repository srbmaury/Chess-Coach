// Per-browser Leitner scheduling for opening lines. Storage can be unavailable
// (private mode, blocked site data), so every access degrades to "no progress".

const STORAGE_KEY = 'chess-ml-coach:openings:v1'
const DAY_MS = 24 * 60 * 60 * 1000
// Box index -> days until the next review. Box 0 is "seen but never passed".
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 16, 35]
export const MASTERED_BOX = 4

export type LessonProgress = {
  box: number
  dueAt: number
  reps: number
  lapses: number
  lastReviewedAt: number
}

export type LessonStatus = 'new' | 'due' | 'learning' | 'mastered'

export type ProgressMap = Record<string, LessonProgress>

export function loadProgress(): ProgressMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as ProgressMap : {}
  } catch {
    return {}
  }
}

export function saveProgress(progress: ProgressMap) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // Progress simply won't persist in this browser.
  }
}

export function recordDrill(previous: LessonProgress | undefined, mistakes: number, now = Date.now()): LessonProgress {
  const box = mistakes === 0 ? Math.min((previous?.box ?? 0) + 1, BOX_INTERVAL_DAYS.length - 1) : 0
  // A failed line comes back later today rather than tomorrow.
  const delay = mistakes === 0 ? BOX_INTERVAL_DAYS[box] * DAY_MS : 10 * 60 * 1000
  return {
    box,
    dueAt: now + delay,
    reps: (previous?.reps ?? 0) + 1,
    lapses: (previous?.lapses ?? 0) + (mistakes === 0 ? 0 : 1),
    lastReviewedAt: now,
  }
}

export function lessonStatus(progress: LessonProgress | undefined, now = Date.now()): LessonStatus {
  if (!progress) return 'new'
  if (progress.dueAt <= now) return 'due'
  if (progress.box >= MASTERED_BOX) return 'mastered'
  return 'learning'
}
