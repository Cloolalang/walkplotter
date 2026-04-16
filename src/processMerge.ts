/**
 * Parse Walkplotter combined CSV and path-loss logs, join by local time, for Process tab overlay.
 */

export type WalkplotterTrailRow = {
  timestamp: string
  x: number
  y: number
  source: string
}

/** Trail row including `new_segment` for round-trip CSV edit/save. */
export type EditableTrailRow = WalkplotterTrailRow & {
  newSegment: string
}

export type PathLossRow = {
  time: string
  pathLoss: number
  /** When set (e.g. RSSI CSV with `YYYY-M-D H:MM:SS` in the time column), merge uses this instead of trail test date + time-of-day. */
  absoluteTimeMs?: number
}

export type MergedPlotPoint = {
  x: number
  y: number
  pathLoss: number
  /** Walkplotter trail `source` column (e.g. `user` vs `interpolated`). */
  source: string
  /** Local time for this sample (ms since epoch), for histogram time-in-bin. */
  timeMs: number
}

/** Trail sample with no path-loss row within the merge time window (still drawn on the Process map). */
export type UnmatchedTrailPoint = {
  x: number
  y: number
  source: string
  timeMs: number
}

export type MergeByNearestTimeResult = {
  merged: MergedPlotPoint[]
  unmatched: UnmatchedTrailPoint[]
}

const DATE_RE = /^#\s*test_date_local:\s*(\d{4}-\d{2}-\d{2})\s*$/i
const POI_SECTION = /^#\s*section:\s*poi/i
const SEMANTICS_RE = /^#\s*timestamp_semantics:\s*(.+)$/i
const SESSION_EPOCH_RE = /^#\s*session_epoch_ms:\s*(\d+)\s*$/i

/** How timestamps in column 1 are interpreted for Process merge. */
export type TimestampSemantics = 'wall_clock' | 'elapsed_since_session_start'

const HMS_DURATION_RE = /^\d+:\d{2}:\d{2}$/
/** Wall-clock time: H:MM:SS with optional fractional seconds (e.g. `15:43:58.783`). */
const HMS_WALL_RE = /^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/
/** Local wall date + time, e.g. `2026-4-15 15:41:58.783` (month/day need not be zero-padded). */
const LOCAL_DT_WALL_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/

/** Parse local calendar date + time-of-day to epoch ms; returns null if the string does not match. */
export function parseLocalDateTimeWallMs(s: string): number | null {
  const m = LOCAL_DT_WALL_RE.exec(s.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const secInt = Number(m[6])
  let fracMs = 0
  if (m[7]) {
    const frac = parseFloat(m[7]!)
    if (Number.isFinite(frac)) fracMs = Math.round(frac * 1000)
  }
  if (![y, mo, d, h, mi, secInt].every(Number.isFinite)) return null
  const t = new Date(y, mo - 1, d, h, mi, secInt, fracMs).getTime()
  return Number.isFinite(t) ? t : null
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let i = 0
  let inQ = false
  while (i < line.length) {
    const c = line[i]!
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 2
          continue
        }
        inQ = false
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === '"') {
      inQ = true
      i++
      continue
    }
    if (c === ',') {
      cells.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  cells.push(cur)
  return cells
}

/**
 * Split one data line from metric logs: tab-heavy exports (Time / RSSI) or plain CSV.
 * If the line contains a tab, split on runs of tabs and/or commas so `15:44:01.001,\t-70.8\t52…` works;
 * otherwise use CSV-aware splitting for quoted commas.
 */
function splitMetricLogLine(line: string): string[] {
  const trimmed = line.trim()
  if (trimmed.includes('\t')) {
    return trimmed
      .split(/[\t,]+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
  }
  return parseCsvLine(trimmed).map((c) => c.trim())
}

/** Extract `YYYY-MM-DD` from `# test_date_local:` header. */
export function extractWalkplotterTestDate(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = DATE_RE.exec(line.trim())
    if (m) return m[1]!
  }
  return null
}

/** Parse `# timestamp_semantics` and `# session_epoch_ms` for elapsed session exports. */
export function extractWalkplotterTimestampInfo(text: string): {
  semantics: TimestampSemantics
  sessionEpochMs: number | null
} {
  let semantics: TimestampSemantics = 'wall_clock'
  let sessionEpochMs: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const sm = SEMANTICS_RE.exec(line)
    if (sm) {
      const v = sm[1]!.trim().toLowerCase()
      if (v.includes('elapsed')) semantics = 'elapsed_since_session_start'
      else semantics = 'wall_clock'
    }
    const em = SESSION_EPOCH_RE.exec(line)
    if (em) {
      const n = Number(em[1])
      if (Number.isFinite(n)) sessionEpochMs = n
    }
  }
  return { semantics, sessionEpochMs }
}

/**
 * Parse H:MM:SS as a **duration** (hours may be > 23). Used for elapsed_since_session_start CSVs.
 */
export function parseDurationHmsToMs(hms: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(hms.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3])
  if (!Number.isFinite(h) || mi > 59 || s > 59) return null
  return ((h * 60 + mi) * 60 + s) * 1000
}

/**
 * Data rows: timestamp,x,y,source,new_segment — stops before POI section or non-data lines.
 */
export function parseWalkplotterTrailRows(text: string): WalkplotterTrailRow[] {
  const rows: WalkplotterTrailRow[] = []
  let inPoi = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (POI_SECTION.test(line)) {
      inPoi = true
      break
    }
    if (line.startsWith('#')) continue
    if (inPoi) break

    const cells = parseCsvLine(line)
    if (cells.length < 4) continue
    const ts = cells[0]!.trim()
    if (ts === 'timestamp') continue
    const x = Number(cells[1])
    const y = Number(cells[2])
    const source = (cells[3] ?? 'user').trim()
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (!HMS_WALL_RE.test(ts) && !HMS_DURATION_RE.test(ts)) continue
    rows.push({ timestamp: ts, x, y, source })
  }
  return rows
}

const TRAIL_HEADER_RE = /^timestamp\s*,/i

function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function csvRowFromCells(cells: string[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * Split a Walkplotter export into preamble (headers + column title line), editable trail rows, and tail (POI section etc.).
 */
export function parseWalkplotterEditable(text: string): {
  preamble: string
  trail: EditableTrailRow[]
  tail: string
} | null {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (TRAIL_HEADER_RE.test(t)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) return null

  const preamble = lines.slice(0, headerIdx + 1).join('\r\n')
  const trail: EditableTrailRow[] = []
  let tailStart = lines.length

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (!line) continue
    if (POI_SECTION.test(line)) {
      tailStart = i
      break
    }
    if (line.startsWith('#')) continue
    const cells = parseCsvLine(line)
    if (cells.length < 4) continue
    const ts = cells[0]!.trim()
    if (ts === 'timestamp') continue
    const x = Number(cells[1])
    const y = Number(cells[2])
    const source = (cells[3] ?? 'user').trim()
    const newSegment = (cells[4] ?? '0').trim()
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (!HMS_WALL_RE.test(ts) && !HMS_DURATION_RE.test(ts)) continue
    trail.push({ timestamp: ts, x, y, source, newSegment })
  }

  const tail = tailStart < lines.length ? lines.slice(tailStart).join('\r\n') : ''
  return { preamble, trail, tail }
}

/** Rebuild Walkplotter CSV with updated pixel columns; POI tail preserved. */
export function serializeWalkplotterEditable(
  preamble: string,
  trail: EditableTrailRow[],
  tail: string
): string {
  const body = trail.map((r) =>
    csvRowFromCells([
      r.timestamp,
      String(Math.round(r.x * 1000) / 1000),
      String(Math.round(r.y * 1000) / 1000),
      r.source,
      r.newSegment,
    ])
  )
  const parts: string[] = [preamble]
  if (body.length > 0) {
    parts.push(body.join('\r\n'))
  }
  if (tail.length > 0) {
    parts.push(tail)
  }
  return '\uFEFF' + parts.join('\r\n') + '\r\n'
}

/**
 * Comma-separated; 4th field (index 3) is path loss. First field is HH:MM:SS.
 */
export function parsePathLossCsv(text: string): PathLossRow[] {
  const out: PathLossRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(',')
    if (parts.length < 4) continue
    const time = parts[0]!.trim()
    const pl = Number(parts[3]!.trim())
    if (!Number.isFinite(pl)) continue
    if (!HMS_WALL_RE.test(time) && !HMS_DURATION_RE.test(time)) continue
    out.push({ time, pathLoss: pl })
  }
  return out
}

/**
 * RSSI log: header row with `time` / `rssi` (or `Time` / `RSSI`) columns (case-insensitive), or first two
 * columns as time then RSSI (dBm). Tab- or comma-separated; extra columns (e.g. lat/lon) are ignored.
 * Time column may be time-of-day only (`15:43:58.783`) or full local date+time (`2026-4-15 15:41:58.783`).
 * Reuses `PathLossRow` with `pathLoss` holding RSSI in dBm for merge.
 */
export function parseRssiCsv(text: string): PathLossRow[] {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  let timeIdx = 0
  let rssiIdx = 1
  let dataStart = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (!raw || raw.startsWith('#')) continue
    const parts = splitMetricLogLine(raw)
    const lower = parts.map((c) => c.toLowerCase())
    const ti = lower.indexOf('time')
    let ri = lower.indexOf('rssi')
    if (ri < 0) ri = lower.indexOf('dbm')
    if (ti >= 0 && ri >= 0 && ti !== ri) {
      timeIdx = ti
      rssiIdx = ri
      dataStart = i + 1
      break
    }
    dataStart = i
    break
  }
  const out: PathLossRow[] = []
  for (let i = dataStart; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (!raw || raw.startsWith('#')) continue
    const parts = splitMetricLogLine(raw)
    if (parts.length <= Math.max(timeIdx, rssiIdx)) continue
    const time = parts[timeIdx]!
    const rssi = Number(parts[rssiIdx])
    if (!Number.isFinite(rssi)) continue
    const abs = parseLocalDateTimeWallMs(time)
    if (abs != null) {
      out.push({ time, pathLoss: rssi, absoluteTimeMs: abs })
      continue
    }
    if (!HMS_WALL_RE.test(time) && !HMS_DURATION_RE.test(time)) continue
    out.push({ time, pathLoss: rssi })
  }
  return out
}

function localMs(dateYmd: string, hms: string): number {
  const [y, mo, d] = dateYmd.split('-').map(Number)
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(hms.trim())
  if (!m) return NaN
  const h = Number(m[1])
  const mi = Number(m[2])
  const secInt = Number(m[3])
  let ms = 0
  if (m[4]) {
    const frac = parseFloat(m[4]!)
    if (Number.isFinite(frac)) ms = Math.round(frac * 1000)
  }
  return new Date(y, mo - 1, d, h, mi, secInt, ms).getTime()
}

/** Default: match RF sample within 3s of each trail timestamp. */
export const DEFAULT_MAX_MATCH_MS = 3000

export type MergeTimeOptions = {
  semantics: TimestampSemantics
  sessionEpochMs: number | null
}

function rowTimeMs(
  testDateYmd: string,
  hms: string,
  opts: MergeTimeOptions | undefined
): number {
  const useElapsed =
    opts?.semantics === 'elapsed_since_session_start' &&
    opts.sessionEpochMs != null &&
    Number.isFinite(opts.sessionEpochMs)
  if (useElapsed) {
    const d = parseDurationHmsToMs(hms)
    if (d === null) return NaN
    return opts!.sessionEpochMs! + d
  }
  return localMs(testDateYmd, hms)
}

/**
 * For each trail row, attach path loss from the nearest RF sample in time (same calendar day as `testDateYmd`).
 * Trail rows with no RF sample within `maxDeltaMs` appear in `unmatched` (for drawing) instead of being dropped.
 * When `timeOpts` indicates elapsed session timestamps, `sessionEpochMs` + duration (H:MM:SS) is used for both trail and RF rows.
 */
export function mergeByNearestTime(
  testDateYmd: string,
  trail: WalkplotterTrailRow[],
  rf: PathLossRow[],
  maxDeltaMs: number,
  timeOpts?: MergeTimeOptions
): MergeByNearestTimeResult {
  if (!trail.length || !rf.length) return { merged: [], unmatched: [] }

  const rfMs = rf
    .map((r) => ({
      t:
        r.absoluteTimeMs != null && Number.isFinite(r.absoluteTimeMs)
          ? r.absoluteTimeMs
          : rowTimeMs(testDateYmd, r.time, timeOpts),
      pl: r.pathLoss,
    }))
    .filter((x) => Number.isFinite(x.t))
  if (!rfMs.length) return { merged: [], unmatched: [] }

  const out: MergedPlotPoint[] = []
  const unmatched: UnmatchedTrailPoint[] = []
  for (const row of trail) {
    const t = rowTimeMs(testDateYmd, row.timestamp, timeOpts)
    if (!Number.isFinite(t)) continue
    let best = rfMs[0]!
    let bestD = Math.abs(t - best.t)
    for (let i = 1; i < rfMs.length; i++) {
      const r = rfMs[i]!
      const d = Math.abs(t - r.t)
      if (d < bestD) {
        bestD = d
        best = r
      }
    }
    if (bestD <= maxDeltaMs) {
      out.push({ x: row.x, y: row.y, pathLoss: best.pl, source: row.source, timeMs: t })
    } else {
      unmatched.push({ x: row.x, y: row.y, source: row.source, timeMs: t })
    }
  }
  return { merged: out, unmatched }
}
