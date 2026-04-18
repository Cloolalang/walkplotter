/**
 * Single-file Process tab snapshot: map image + Walkplotter CSV + path-loss and/or RSSI CSV.
 * Versioned JSON so we can extend fields later.
 */

export const PROCESS_BUNDLE_VERSION = 1 as const

export type ProcessBundleSettingsV1 = {
  overlayShiftPx?: { x: number; y: number }
  flip?: { x: boolean; y: boolean }
  dotScale?: number
  rssiOffsetDb?: number
  heatmap?: {
    enabled?: boolean
    useBoundary?: boolean
    boundaryClosed?: boolean
    boundaryPoints?: { x: number; y: number }[]
    radiusPx?: number
    opacity?: number
  }
  plotMetric?: 'path_loss' | 'rssi'
  show?: {
    pointLabels?: boolean
    route?: boolean
    colorTrail?: boolean
  }
  fspl?: {
    enabled?: boolean
    measuredMhz?: number
    estimateMhz?: number
  }
}

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
  /** Optional full RSSI CSV text (for RSSI-only or combined workflows). */
  rssiCsv?: string
  /** Optional Process tab display/plot settings. */
  settings?: ProcessBundleSettingsV1
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function asFiniteNumberOrUndefined(x: unknown): number | undefined {
  const n = Number(x)
  return Number.isFinite(n) ? n : undefined
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
  if (o.rssiCsv != null && typeof o.rssiCsv !== 'string') return null
  const fp = o.floorPlan
  if (!isRecord(fp)) return null
  if (
    typeof fp.fileName !== 'string' ||
    typeof fp.mimeType !== 'string' ||
    typeof fp.dataBase64 !== 'string'
  ) {
    return null
  }
  let settings: ProcessBundleSettingsV1 | undefined
  if (o.settings != null) {
    if (!isRecord(o.settings)) return null
    const out: ProcessBundleSettingsV1 = {}
    const s = o.settings

    if (s.overlayShiftPx != null) {
      if (!isRecord(s.overlayShiftPx)) return null
      const x = asFiniteNumberOrUndefined(s.overlayShiftPx.x)
      const y = asFiniteNumberOrUndefined(s.overlayShiftPx.y)
      if (x == null || y == null) return null
      out.overlayShiftPx = { x, y }
    }

    if (s.flip != null) {
      if (!isRecord(s.flip)) return null
      const x = s.flip.x
      const y = s.flip.y
      if (typeof x !== 'boolean' || typeof y !== 'boolean') return null
      out.flip = { x, y }
    }

    if (s.dotScale != null) {
      const dotScale = asFiniteNumberOrUndefined(s.dotScale)
      if (dotScale == null) return null
      out.dotScale = dotScale
    }
    if (s.rssiOffsetDb != null) {
      const rssiOffsetDb = asFiniteNumberOrUndefined(s.rssiOffsetDb)
      if (rssiOffsetDb == null) return null
      out.rssiOffsetDb = rssiOffsetDb
    }
    if (s.heatmap != null) {
      if (!isRecord(s.heatmap)) return null
      const heatmap: NonNullable<ProcessBundleSettingsV1['heatmap']> = {}
      if (s.heatmap.enabled != null) {
        if (typeof s.heatmap.enabled !== 'boolean') return null
        heatmap.enabled = s.heatmap.enabled
      }
      if (s.heatmap.useBoundary != null) {
        if (typeof s.heatmap.useBoundary !== 'boolean') return null
        heatmap.useBoundary = s.heatmap.useBoundary
      }
      if (s.heatmap.boundaryClosed != null) {
        if (typeof s.heatmap.boundaryClosed !== 'boolean') return null
        heatmap.boundaryClosed = s.heatmap.boundaryClosed
      }
      if (s.heatmap.boundaryPoints != null) {
        if (!Array.isArray(s.heatmap.boundaryPoints)) return null
        const pts: { x: number; y: number }[] = []
        for (const p of s.heatmap.boundaryPoints) {
          if (!isRecord(p)) return null
          const x = asFiniteNumberOrUndefined(p.x)
          const y = asFiniteNumberOrUndefined(p.y)
          if (x == null || y == null) return null
          pts.push({ x, y })
        }
        heatmap.boundaryPoints = pts
      }
      if (s.heatmap.radiusPx != null) {
        const radiusPx = asFiniteNumberOrUndefined(s.heatmap.radiusPx)
        if (radiusPx == null) return null
        heatmap.radiusPx = radiusPx
      }
      if (s.heatmap.opacity != null) {
        const opacity = asFiniteNumberOrUndefined(s.heatmap.opacity)
        if (opacity == null) return null
        heatmap.opacity = opacity
      }
      out.heatmap = heatmap
    }

    if (s.plotMetric != null) {
      if (s.plotMetric !== 'path_loss' && s.plotMetric !== 'rssi') return null
      out.plotMetric = s.plotMetric
    }

    if (s.show != null) {
      if (!isRecord(s.show)) return null
      const show: NonNullable<ProcessBundleSettingsV1['show']> = {}
      if (s.show.pointLabels != null) {
        if (typeof s.show.pointLabels !== 'boolean') return null
        show.pointLabels = s.show.pointLabels
      }
      if (s.show.route != null) {
        if (typeof s.show.route !== 'boolean') return null
        show.route = s.show.route
      }
      if (s.show.colorTrail != null) {
        if (typeof s.show.colorTrail !== 'boolean') return null
        show.colorTrail = s.show.colorTrail
      }
      out.show = show
    }

    if (s.fspl != null) {
      if (!isRecord(s.fspl)) return null
      const fspl: NonNullable<ProcessBundleSettingsV1['fspl']> = {}
      if (s.fspl.enabled != null) {
        if (typeof s.fspl.enabled !== 'boolean') return null
        fspl.enabled = s.fspl.enabled
      }
      if (s.fspl.measuredMhz != null) {
        const measuredMhz = asFiniteNumberOrUndefined(s.fspl.measuredMhz)
        if (measuredMhz == null) return null
        fspl.measuredMhz = measuredMhz
      }
      if (s.fspl.estimateMhz != null) {
        const estimateMhz = asFiniteNumberOrUndefined(s.fspl.estimateMhz)
        if (estimateMhz == null) return null
        fspl.estimateMhz = estimateMhz
      }
      out.fspl = fspl
    }

    settings = out
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
    ...(typeof o.rssiCsv === 'string' ? { rssiCsv: o.rssiCsv } : {}),
    ...(settings ? { settings } : {}),
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
