import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { deleteDB, openDB } from 'idb'

import { sha256Hex } from '../analysis/hash'
import { CheckpointStore, DB_NAME, DB_VERSION, MAX_BROWSER_CACHE_BYTES, StorageQuotaError } from './checkpointStore'

const MiB = 1024 * 1024
let stores: CheckpointStore[] = []
let serial = 0

async function store(options: Partial<Parameters<typeof CheckpointStore.open>[0]> = {}) {
  const name = `checkpoint-test-${++serial}`
  const opened = await CheckpointStore.open({ name, maxBytes: 256 * MiB, ...options })
  stores.push(opened)
  return { opened, name }
}

afterEach(async () => {
  for (const opened of stores) opened.close()
  stores = []
  for (let index = 1; index <= serial; index += 1) await deleteDB(`checkpoint-test-${index}`)
  serial = 0
  vi.unstubAllGlobals()
})

test('uses the versioned analysis database and requests persistent storage when supported', async () => {
  const persist = vi.fn(async () => true)
  vi.stubGlobal('navigator', { storage: { persist, estimate: async () => ({ usage: 0, quota: 512 * MiB }) } })
  const opened = await CheckpointStore.open({ maxBytes: 256 * MiB })
  stores.push(opened)
  expect(persist).toHaveBeenCalledOnce()
  const db = await openDB(DB_NAME)
  expect(db.version).toBe(DB_VERSION)
  expect([...db.objectStoreNames]).toEqual(['batches', 'games', 'manifests'])
  db.close()
  opened.close()
  stores = []
  await deleteDB(DB_NAME)
})

test('isolates manifests with the same hash by job and recovers after reopening', async () => {
  const { opened, name } = await store()
  await opened.cacheManifest('job-a', 'shared', new Uint8Array([1]))
  await opened.cacheManifest('job-b', 'shared', new Uint8Array([2]))
  opened.close()
  const reopened = await CheckpointStore.open({ name, maxBytes: 256 * MiB })
  stores.push(reopened)
  expect(await reopened.manifest('job-a', 'shared')).toEqual(new Uint8Array([1]))
  expect(await reopened.manifest('job-b', 'shared')).toEqual(new Uint8Array([2]))
})

test('keeps only the canonical next batch and removes acknowledged batches and rows', async () => {
  const { opened } = await store()
  await opened.saveGameRows('job', 0, 'g0', [])
  await opened.saveGameRows('job', 1, 'g1', [])
  const hash1 = await sha256Hex(new Uint8Array([1]))
  const hash2 = await sha256Hex(new Uint8Array([2]))
  await opened.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: hash1, bytes: new Uint8Array([1]) })
  await opened.saveBatch({ jobId: 'job', sequence: 2, firstUnit: 1, lastUnit: 1, contentHash: hash2, bytes: new Uint8Array([2]) })
  expect((await opened.pendingBatch('job', 1, 0))?.contentHash).toBe(hash1)
  await opened.acknowledge('job', 1, 0)
  expect(await opened.pendingBatch('job', 1, 0)).toBeNull()
  expect(await opened.gameRows('job', 0, 'g0')).toBeNull()
  expect(await opened.gameRows('job', 1, 'g1')).toEqual([])
  expect((await opened.pendingBatch('job', 2, 1))?.contentHash).toBe(hash2)
  expect(await opened.pendingBatch('job', 2, 0)).toBeNull()
})

test('discards corrupt records and clears all data for a completed job only', async () => {
  const { opened, name } = await store()
  await opened.cacheManifest('job', 'h', new Uint8Array([1]))
  await opened.cacheManifest('other', 'h', new Uint8Array([2]))
  await opened.saveGameRows('job', 0, 'g', [])
  await opened.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: 'h', bytes: new Uint8Array([1]) })
  const db = await openDB(name)
  await db.put('games', { version: 99, jobId: 'job', unit: 0, gameId: 'g', rows: [] })
  db.close()
  expect(await opened.gameRows('job', 0, 'g')).toBeNull()
  await opened.clearJob('job')
  expect(await opened.manifest('job', 'h')).toBeNull()
  expect(await opened.manifest('other', 'h')).toEqual(new Uint8Array([2]))
  expect(await opened.pendingBatch('job', 1, 0)).toBeNull()
})

test('counts per-game rows toward the application cap', async () => {
  const { opened } = await store({ maxBytes: 128, estimate: async () => ({ usage: 0, quota: 1024 * MiB }) })
  await opened.saveGameRows('job', 0, 'g', [{ quality_reason: 'x'.repeat(40) } as never])
  await expect(opened.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: 'h', bytes: new Uint8Array(50) })).rejects.toBeInstanceOf(StorageQuotaError)
})

test('uses navigator storage estimate to report quota exhaustion', async () => {
  const { opened } = await store({ estimate: async () => ({ usage: 99, quota: 100 }) })
  await expect(opened.cacheManifest('job', 'h', new Uint8Array(2))).rejects.toThrow('out of storage space')
})

test('never permits more than the recorded 256 MiB working-data ceiling', async () => {
  const { opened } = await store({ maxBytes: 512 * MiB, estimate: async () => ({ usage: 0, quota: 1024 * MiB }) })
  await opened.ensureCapacity(MAX_BROWSER_CACHE_BYTES, 'job')
  await expect(opened.ensureCapacity(268_435_457, 'job')).rejects.toBeInstanceOf(StorageQuotaError)
})

test('checks real navigator storage estimate before writing', async () => {
  const estimate = vi.fn(async () => ({ usage: 99, quota: 100 }))
  vi.stubGlobal('navigator', { storage: { estimate } })
  const { opened } = await store()
  await expect(opened.cacheManifest('job', 'h', new Uint8Array(2))).rejects.toBeInstanceOf(StorageQuotaError)
  expect(estimate).toHaveBeenCalledOnce()
})

test('discards a cached batch when its bytes no longer match its content hash', async () => {
  const { opened, name } = await store()
  const good = new Uint8Array([1, 2, 3])
  const contentHash = await sha256Hex(good)
  await opened.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash, bytes: good })
  const db = await openDB(name)
  await db.put('batches', { version: 1, jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash, bytes: new Uint8Array([9]) })
  db.close()
  expect(await opened.pendingBatch('job', 1, 0)).toBeNull()
  const inspect = await openDB(name)
  expect(await inspect.get('batches', ['job', 1])).toBeUndefined()
  inspect.close()
})

test('discards malformed saved analysis rows instead of returning them', async () => {
  const { opened, name } = await store()
  const db = await openDB(name)
  await db.put('games', { version: 1, jobId: 'job', unit: 0, gameId: 'g', rows: [{ wrong: true }] })
  db.close()
  expect(await opened.gameRows('job', 0, 'g')).toBeNull()
})
