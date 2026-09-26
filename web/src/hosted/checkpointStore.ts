// IndexedDB resume store for browser analysis.
//
// Holds only analysis data: per-game rows analyzed since the last acknowledged
// checkpoint, the sealed-but-unacknowledged batch awaiting upload, and cached
// manifests. Session and lease tokens are never written here. The server's
// acknowledged sequence is always the resume boundary; local data only saves
// recomputation when it lines up with that boundary.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

import type { AnalysisRow } from '../analysis/classify'

export const DB_NAME = 'chess-coach-analysis'
export const DB_VERSION = 2
export const MAX_BROWSER_CACHE_BYTES = 256 * 1024 * 1024
const RECORD_VERSION = 1

export type GameRecord = { version: 1; jobId: string; unit: number; gameId: string; rows: AnalysisRow[] }
export type BatchRecord = {
  version: 1
  jobId: string
  sequence: number
  firstUnit: number
  lastUnit: number
  contentHash: string
  bytes: Uint8Array
}
type ManifestRecord = { version: 1; hash: string; jobId: string; bytes: Uint8Array; storedAt: number }

interface ResumeSchema extends DBSchema {
  games: { key: [string, number]; value: GameRecord; indexes: { byJob: string } }
  batches: { key: [string, number]; value: BatchRecord; indexes: { byJob: string } }
  manifests: { key: [string, string]; value: ManifestRecord; indexes: { byJob: string } }
}

export class StorageQuotaError extends Error {
  constructor() {
    super('This browser is out of storage space for analysis. Free some space or observe instead.')
    this.name = 'StorageQuotaError'
  }
}

type Estimate = () => Promise<{ usage?: number; quota?: number }>

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)
}

function isBytes(value: unknown): value is Uint8Array {
  // IndexedDB may clone into a different realm (also exercised by fake-indexeddb).
  return Object.prototype.toString.call(value) === '[object Uint8Array]'
}

export class CheckpointStore {
  private constructor(
    private readonly db: IDBPDatabase<ResumeSchema>,
    private readonly maxBytes: number,
    private readonly estimate: Estimate | undefined,
  ) {}

  static async open(options: { maxBytes?: number; estimate?: Estimate; name?: string }): Promise<CheckpointStore> {
    const db = await openDB<ResumeSchema>(options.name ?? DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('games', { keyPath: ['jobId', 'unit'] }).createIndex('byJob', 'jobId')
          database.createObjectStore('batches', { keyPath: ['jobId', 'sequence'] }).createIndex('byJob', 'jobId')
        }
        // Version 1 keyed manifests by hash alone, allowing another job to overwrite
        // the first job's cache. Cached manifests can safely be downloaded again.
        if (oldVersion === 1) database.deleteObjectStore('manifests')
        if (oldVersion < 2) database.createObjectStore('manifests', { keyPath: ['jobId', 'hash'] }).createIndex('byJob', 'jobId')
      },
    })
    try { await globalThis.navigator?.storage?.persist?.() } catch { /* Best effort. */ }
    const estimate = options.estimate
      ?? (globalThis.navigator?.storage?.estimate ? () => globalThis.navigator.storage.estimate() : undefined)
    return new CheckpointStore(db, Math.min(options.maxBytes ?? MAX_BROWSER_CACHE_BYTES, MAX_BROWSER_CACHE_BYTES), estimate)
  }

  close(): void {
    this.db.close()
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (isQuotaError(error)) throw new StorageQuotaError()
      throw error
    }
  }

  /** Make room for `bytes` more, evicting caches, within the app's own cap. */
  async ensureCapacity(bytes: number, keepJobId: string): Promise<void> {
    const used = async () => {
      let total = 0
      for (const record of await this.db.getAll('manifests')) total += record.bytes.byteLength
      for (const record of await this.db.getAll('batches')) total += record.bytes.byteLength
      for (const record of await this.db.getAll('games')) total += new TextEncoder().encode(JSON.stringify(record)).byteLength
      return total
    }
    let total = await used()
    if (total + bytes > this.maxBytes) {
      // Manifests of other jobs are re-downloadable; drop them first, oldest first.
      const manifests = (await this.db.getAll('manifests'))
        .filter((record) => record.jobId !== keepJobId)
        .sort((a, b) => a.storedAt - b.storedAt)
      for (const record of manifests) {
        if (total + bytes <= this.maxBytes) break
        await this.db.delete('manifests', [record.jobId, record.hash])
        total -= record.bytes.byteLength
      }
    }
    if (total + bytes > this.maxBytes) throw new StorageQuotaError()
    if (this.estimate) {
      try {
        const { usage, quota } = await this.estimate()
        if (usage !== undefined && quota !== undefined && usage + bytes > quota) throw new StorageQuotaError()
      } catch (error) {
        if (error instanceof StorageQuotaError) throw error
      }
    }
  }

  // Manifests -------------------------------------------------------------------------

  async cacheManifest(jobId: string, hash: string, bytes: Uint8Array): Promise<void> {
    const existing = await this.db.get('manifests', [jobId, hash])
    await this.ensureCapacity(bytes.byteLength - (existing?.bytes.byteLength ?? 0), jobId)
    await this.write(() => this.db.put('manifests', { version: RECORD_VERSION, hash, jobId, bytes, storedAt: Date.now() }))
  }

  async manifest(jobId: string, hash: string): Promise<Uint8Array | null> {
    const record = await this.db.get('manifests', [jobId, hash])
    if (!record) return null
    if (record.version !== RECORD_VERSION || !isBytes(record.bytes)) {
      await this.db.delete('manifests', [jobId, hash])
      return null
    }
    return new Uint8Array(record.bytes)
  }

  // Per-game rows ----------------------------------------------------------------------

  async saveGameRows(jobId: string, unit: number, gameId: string, rows: AnalysisRow[]): Promise<void> {
    const record: GameRecord = { version: RECORD_VERSION, jobId, unit, gameId, rows }
    const existing = await this.db.get('games', [jobId, unit])
    const size = (value: GameRecord) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    await this.ensureCapacity(size(record) - (existing ? size(existing) : 0), jobId)
    await this.write(() => this.db.put('games', record))
  }

  /** Rows for `unit`, or null if absent or corrupt (corrupt records are discarded). */
  async gameRows(jobId: string, unit: number, gameId: string): Promise<AnalysisRow[] | null> {
    const record = await this.db.get('games', [jobId, unit])
    if (!record) return null
    if (record.version !== RECORD_VERSION || record.gameId !== gameId || !Array.isArray(record.rows)) {
      await this.db.delete('games', [jobId, unit])
      return null
    }
    return record.rows
  }

  // Sealed batches ---------------------------------------------------------------------

  async saveBatch(batch: Omit<BatchRecord, 'version'>): Promise<void> {
    const existing = await this.db.get('batches', [batch.jobId, batch.sequence])
    await this.ensureCapacity(batch.bytes.byteLength - (existing?.bytes.byteLength ?? 0), batch.jobId)
    await this.write(() => this.db.put('batches', { version: RECORD_VERSION, ...batch }))
  }

  /** The unacknowledged batch that resumes exactly at the server's boundary, if any. */
  async pendingBatch(jobId: string, sequence: number, firstUnit: number): Promise<BatchRecord | null> {
    const record = await this.db.get('batches', [jobId, sequence])
    if (!record) return null
    if (record.version !== RECORD_VERSION || !isBytes(record.bytes) || record.firstUnit !== firstUnit) {
      await this.db.delete('batches', [jobId, sequence])
      return null
    }
    return record
  }

  /** The server acknowledged `sequence`: evict it and every row it covers. */
  async acknowledge(jobId: string, sequence: number, lastUnit: number): Promise<void> {
    const tx = this.db.transaction(['batches', 'games'], 'readwrite')
    for (const key of await tx.objectStore('batches').index('byJob').getAllKeys(jobId)) {
      if (key[1] <= sequence) await tx.objectStore('batches').delete(key)
    }
    for (const key of await tx.objectStore('games').index('byJob').getAllKeys(jobId)) {
      if (key[1] <= lastUnit) await tx.objectStore('games').delete(key)
    }
    await tx.done
  }

  /** Drop everything below the server's boundary (e.g. another browser advanced it). */
  async discardBefore(jobId: string, sequence: number, firstUnit: number): Promise<void> {
    await this.acknowledge(jobId, sequence, firstUnit - 1)
  }

  async clearJob(jobId: string): Promise<void> {
    const tx = this.db.transaction(['batches', 'games', 'manifests'], 'readwrite')
    for (const name of ['batches', 'games', 'manifests'] as const) {
      const store = tx.objectStore(name)
      for (const key of await store.index('byJob').getAllKeys(jobId)) await store.delete(key)
    }
    await tx.done
  }
}
