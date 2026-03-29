import {
  DEFAULT_GAP_THRESHOLD_MS,
  interpolateSegment,
  interpolationMeta,
} from './interpolate'
import type { PoiMarker, TrailPoint } from './types'
import type { UserAnchor } from './interpolate'

export type { TrailPoint } from './types'
export type ImageMeta = {
  fileName: string
  widthPx: number
  heightPx: number
}

const APP_NAME = 'walkplotter'
const EXPORT_VERSION = 2

/** Calendar date in local timezone: YYYY-MM-DD */
export function formatLocalDateYMD(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local time of day only: HH:MM:SS (device timezone). */
export function formatLocalTimeHMS(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Elapsed duration as H+:MM:SS (for session t=0 exports; hours may exceed 23). */
export function formatDurationMsAsHMS(ms: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  let sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  sec %= 3600
  const m = Math.floor(sec / 60)
  sec %= 60
  return `${h}:${pad(m)}:${pad(sec)}`
}

function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',')
}

const INTERP_STEP_MIN = 100
const INTERP_STEP_MAX = 30000

export class TrailModel {
  readonly points: TrailPoint[] = []
  private readonly commitStack: TrailPoint[][] = []
  private lastUser: UserAnchor | null = null
  private interpolationStepMs = 1000
  /** Wall-clock epoch ms when user pressed “session t = 0”; CSV exports elapsed time from this instant. */
  private sessionT0Ms: number | null = null

  /** Call when pausing: next user tap will not interpolate from the previous pin (jump elsewhere on the plan). */
  breakSegment(): void {
    this.lastUser = null
  }

  /** Previous user anchor in the current segment (for map snap); null after a break or before any tap. */
  getLastUserAnchor(): { x: number; y: number } | null {
    return this.lastUser ? { x: this.lastUser.x, y: this.lastUser.y } : null
  }

  getInterpolationStepMs(): number {
    return this.interpolationStepMs
  }

  setInterpolationStepMs(ms: number): void {
    const v = Math.round(ms)
    this.interpolationStepMs = Math.min(INTERP_STEP_MAX, Math.max(INTERP_STEP_MIN, v))
  }

  /** Elapsed-time export from this instant (sync with hardware clocks). Trail should be empty or cleared first. */
  setSessionTimeZero(at: Date): void {
    this.sessionT0Ms = at.getTime()
  }

  clearSessionTimeZero(): void {
    this.sessionT0Ms = null
  }

  getSessionTimeZeroMs(): number | null {
    return this.sessionT0Ms
  }

  hasSessionTimeZero(): boolean {
    return this.sessionT0Ms !== null
  }

  userTap(x: number, y: number, when: Date): void {
    const t = when.getTime()
    const newSegment = !this.lastUser && this.points.length > 0
    const userPoint: TrailPoint = {
      x,
      y,
      t,
      source: 'user',
      ...(newSegment ? { segmentBreak: true } : {}),
    }
    const batch: TrailPoint[] = []

    if (this.lastUser) {
      const interp = interpolateSegment(
        this.lastUser,
        { x, y, t },
        DEFAULT_GAP_THRESHOLD_MS,
        this.interpolationStepMs
      )
      batch.push(...interp)
    }
    batch.push(userPoint)

    this.points.push(...batch)
    this.commitStack.push(batch)
    this.lastUser = { x, y, t }
  }

  undo(): boolean {
    const batch = this.commitStack.pop()
    if (!batch?.length) return false

    const n = batch.length
    this.points.splice(this.points.length - n, n)

    this.lastUser = null
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i]!.source === 'user') {
        const p = this.points[i]!
        this.lastUser = { x: p.x, y: p.y, t: p.t }
        break
      }
    }
    return true
  }

  clear(): void {
    this.points.length = 0
    this.commitStack.length = 0
    this.lastUser = null
  }

  buildCsv(image: ImageMeta | null, poiMarkers: PoiMarker[] = []): string {
    const meta = interpolationMeta(
      this.interpolationStepMs,
      DEFAULT_GAP_THRESHOLD_MS
    )
    const now = new Date()
    const useElapsed = this.sessionT0Ms !== null
    const testDateSource = useElapsed
      ? new Date(this.sessionT0Ms!)
      : this.points.length > 0
        ? new Date(this.points[0]!.t)
        : now
    const lines: string[] = []

    lines.push(
      `# walkplotter_export_version: ${EXPORT_VERSION}`,
      `# app: ${APP_NAME} 1`,
      `# image_file: ${image?.fileName ?? 'unknown'}`,
      `# image_width_px: ${image?.widthPx ?? 0}`,
      `# image_height_px: ${image?.heightPx ?? 0}`,
      `# test_date_local: ${formatLocalDateYMD(testDateSource)}`,
      `# export_date_local: ${formatLocalDateYMD(now)}`,
      `# export_time_local: ${formatLocalTimeHMS(now)}`,
      `# coordinate_space: image_pixels_top_left`
    )
    if (useElapsed) {
      lines.push(
        `# timestamp_semantics: elapsed_since_session_start`,
        `# session_epoch_ms: ${this.sessionT0Ms}`,
        `# timestamp_format: H:MM:SS elapsed since session t=0 (pair with path-loss log from same t=0)`
      )
    } else {
      lines.push(`# timestamp_format: HH:MM:SS local wall time (calendar date: test_date_local)`)
    }
    lines.push(
      `# interpolation_gap_threshold_ms: ${meta.gapThresholdMs}`,
      `# interpolation_time_step_ms: ${meta.timeStepMs}`,
      `# interpolation_model: ${meta.model}`
    )

    lines.push(csvRow(['timestamp', 'x', 'y', 'source', 'new_segment']))

    for (const p of this.points) {
      const ts = useElapsed
        ? formatDurationMsAsHMS(p.t - this.sessionT0Ms!)
        : formatLocalTimeHMS(new Date(p.t))
      const ns = p.segmentBreak ? '1' : '0'
      lines.push(
        csvRow([
          ts,
          String(Math.round(p.x * 1000) / 1000),
          String(Math.round(p.y * 1000) / 1000),
          p.source,
          ns,
        ])
      )
    }

    if (poiMarkers.length > 0) {
      lines.push('')
      lines.push('# section: poi_markers (no timestamps; image pixel coordinates)')
      lines.push(csvRow(['label', 'x', 'y']))
      for (const r of poiMarkers) {
        lines.push(
          csvRow([
            r.label,
            String(Math.round(r.x * 1000) / 1000),
            String(Math.round(r.y * 1000) / 1000),
          ])
        )
      }
    }

    return '\uFEFF' + lines.join('\r\n') + '\r\n'
  }
}

/** Standalone POI export: labels and image pixel coordinates only (no timestamps). */
export function buildPoiOnlyCsv(poiMarkers: PoiMarker[], image: ImageMeta | null): string {
  const now = new Date()
  const lines: string[] = [
    `# walkplotter_poi_export: 1`,
    `# app: ${APP_NAME} 1`,
    `# image_file: ${image?.fileName ?? 'unknown'}`,
    `# image_width_px: ${image?.widthPx ?? 0}`,
    `# image_height_px: ${image?.heightPx ?? 0}`,
    `# export_date_local: ${formatLocalDateYMD(now)}`,
    `# coordinate_space: image_pixels_top_left`,
    `# data_columns: label, x, y (pixels, no timestamps)`,
  ]

  lines.push(csvRow(['label', 'x', 'y']))
  for (const r of poiMarkers) {
    lines.push(
      csvRow([
        r.label,
        String(Math.round(r.x * 1000) / 1000),
        String(Math.round(r.y * 1000) / 1000),
      ])
    )
  }

  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
