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

const DATE_RE = /^#\s*test_date_local:\s*(\d{4}-\d{2}-\d{2})\s*$/i
const POI_SECTION = /^#\s*section:\s*poi/i

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

/** Extract `YYYY-MM-DD` from `# test_date_local:` header. */
export function extractWalkplotterTestDate(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = DATE_RE.exec(line.trim())
    if (m) return m[1]!
  }
  return null
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
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(ts)) continue
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
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(ts)) continue
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
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(time)) continue
    out.push({ time, pathLoss: pl })
  }
  return out
}

function localMs(dateYmd: string, hms: string): number {
  const [y, mo, d] = dateYmd.split('-').map(Number)
  const [h, mi, s] = hms.split(':').map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** Default: match RF sample within 3s of each trail timestamp. */
export const DEFAULT_MAX_MATCH_MS = 3000

/**
 * For each trail row, attach path loss from the nearest RF sample in time (same calendar day as `testDateYmd`).
 * Drops trail points with no RF sample within `maxDeltaMs`.
 */
export function mergeByNearestTime(
  testDateYmd: string,
  trail: WalkplotterTrailRow[],
  rf: PathLossRow[],
  maxDeltaMs: number
): MergedPlotPoint[] {
  if (!trail.length || !rf.length) return []

  const rfMs = rf.map((r) => ({
    t: localMs(testDateYmd, r.time),
    pl: r.pathLoss,
  }))

  const out: MergedPlotPoint[] = []
  for (const row of trail) {
    const t = localMs(testDateYmd, row.timestamp)
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
    }
  }
  return out
}
