/**
 * Recently opened floor-plan images for the Map tab (IndexedDB; capped count + size).
 */

const DB_NAME = 'walkplotter'
const DB_VERSION = 1
const STORE = 'recentFloorPlans'

export const RECENT_FLOOR_PLANS_MAX = 8
export const RECENT_FLOOR_PLAN_MAX_BYTES = 25 * 1024 * 1024

export type RecentFloorPlanMeta = {
  key: string
  fileName: string
  mimeType: string
  byteLength: number
  savedAt: number
}

type RecentFloorPlanRecord = RecentFloorPlanMeta & { data: ArrayBuffer }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf)
  const a = new Uint8Array(h)
  let s = ''
  for (let i = 0; i < a.length; i++) s += a[i]!.toString(16).padStart(2, '0')
  return s
}

function idbGetAll(db: IDBDatabase): Promise<RecentFloorPlanRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    tx.onerror = () => reject(tx.error)
    const r = tx.objectStore(STORE).getAll()
    r.onsuccess = () => resolve((r.result as RecentFloorPlanRecord[]) ?? [])
    r.onerror = () => reject(r.error)
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<RecentFloorPlanRecord | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    tx.onerror = () => reject(tx.error)
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => resolve(r.result as RecentFloorPlanRecord | undefined)
    r.onerror = () => reject(r.error)
  })
}

function idbPut(db: IDBDatabase, record: RecentFloorPlanRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE).put(record)
  })
}

async function idbPrune(db: IDBDatabase): Promise<void> {
  const all = await idbGetAll(db)
  if (all.length <= RECENT_FLOOR_PLANS_MAX) return
  all.sort((a, b) => b.savedAt - a.savedAt)
  const drop = all.slice(RECENT_FLOOR_PLANS_MAX)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const s = tx.objectStore(STORE)
    for (const r of drop) s.delete(r.key)
  })
}

export async function rememberFloorPlanFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  if (file.size > RECENT_FLOOR_PLAN_MAX_BYTES) return
  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch {
    return
  }
  const key = await sha256Hex(buf)
  const record: RecentFloorPlanRecord = {
    key,
    fileName: file.name || 'floor-plan',
    mimeType: file.type || 'image/jpeg',
    byteLength: buf.byteLength,
    savedAt: Date.now(),
    data: buf,
  }
  try {
    const db = await openDb()
    await idbPut(db, record)
    await idbPrune(db)
    db.close()
  } catch {
    /* quota / private mode */
  }
}

export async function listRecentFloorPlansMeta(): Promise<RecentFloorPlanMeta[]> {
  try {
    const db = await openDb()
    const all = await idbGetAll(db)
    db.close()
    all.sort((a, b) => b.savedAt - a.savedAt)
    return all.map(({ key, fileName, mimeType, byteLength, savedAt }) => ({
      key,
      fileName,
      mimeType,
      byteLength,
      savedAt,
    }))
  } catch {
    return []
  }
}

export async function loadRecentFloorPlanBlob(
  key: string,
): Promise<{ blob: Blob; fileName: string } | null> {
  try {
    const db = await openDb()
    const rec = await idbGet(db, key)
    db.close()
    if (!rec?.data) return null
    return {
      blob: new Blob([rec.data], { type: rec.mimeType }),
      fileName: rec.fileName,
    }
  } catch {
    return null
  }
}

export async function touchRecentFloorPlan(key: string): Promise<void> {
  try {
    const db = await openDb()
    const rec = await idbGet(db, key)
    if (!rec) {
      db.close()
      return
    }
    rec.savedAt = Date.now()
    await idbPut(db, rec)
    db.close()
  } catch {
    /* ignore */
  }
}

export async function removeRecentFloorPlan(key: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).delete(key)
    })
    db.close()
  } catch {
    /* ignore */
  }
}
