/**
 * Single-file Process tab snapshot: floor plan image + Walkplotter CSV + path-loss CSV.
 * Versioned JSON so we can extend fields later.
 */

export const PROCESS_BUNDLE_VERSION = 1 as const

export type ProcessBundleV1 = {
  walkplotterBundleVersion: typeof PROCESS_BUNDLE_VERSION
  app: 'walkplotter'
  /** ISO 8601 timestamp when saved */
  savedAt: string
  floorPlan: {
    fileName: string
    mimeType: string
    /** Raw file bytes as base64 (not a data URL prefix) */
    dataBase64: string
  }
  /** Full Walkplotter CSV text (UTF-8), including preamble and POI tail if present */
  walkplotterCsv: string
  /** Full path-loss CSV text */
  pathLossCsv: string
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export function parseProcessBundleJson(text: string): ProcessBundleV1 | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(o)) return null
  if (o.walkplotterBundleVersion !== 1) return null
  if (o.app !== 'walkplotter') return null
  if (typeof o.savedAt !== 'string') return null
  if (typeof o.walkplotterCsv !== 'string' || typeof o.pathLossCsv !== 'string') return null
  const fp = o.floorPlan
  if (!isRecord(fp)) return null
  if (
    typeof fp.fileName !== 'string' ||
    typeof fp.mimeType !== 'string' ||
    typeof fp.dataBase64 !== 'string'
  ) {
    return null
  }
  return {
    walkplotterBundleVersion: 1,
    app: 'walkplotter',
    savedAt: o.savedAt,
    floorPlan: {
      fileName: fp.fileName,
      mimeType: fp.mimeType,
      dataBase64: fp.dataBase64,
    },
    walkplotterCsv: o.walkplotterCsv,
    pathLossCsv: o.pathLossCsv,
  }
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' })
}

/** Encode binary to base64 without going through a data URL (for JSON bundles). */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
