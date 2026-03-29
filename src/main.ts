import './style.css'
import { clientToElementLocal, clientToImagePixel, imagePixelToElementLocal } from './coords'
import {
  fsplDisplayFrequencyOptionsMhz,
  fsplMeasuredFrequencyOptionsMhz,
  fsplPathLossDeltaDb,
  fsplPathLossNegativeConvention,
} from './fspl'
import {
  DEFAULT_MAX_MATCH_MS,
  extractWalkplotterTestDate,
  mergeByNearestTime,
  parsePathLossCsv,
  parseWalkplotterEditable,
  serializeWalkplotterEditable,
} from './processMerge'
import type { EditableTrailRow, MergedPlotPoint, WalkplotterTrailRow } from './processMerge'
import { buildPoiOnlyCsv, TrailModel } from './trail'
import type { ImageMeta } from './trail'
import type { PoiMarker, TrailPoint } from './types'

/** Resolved from CSS variables on the overlay canvas (trail, pins, POI, crosshairs). */
interface OverlayColors {
  trailLine: string
  pinUser: string
  pinInterp: string
  poi: string
  poiLabelBg: string
  crosshair: string
  crosshairRing: string
}

const trail = new TrailModel()

let imageMeta: ImageMeta | null = null
let objectUrl: string | null = null
let recording = false
let crosshairsEnabled = true
let placementMode: 'trail' | 'poi' = 'trail'
const poiMarkers: PoiMarker[] = []
let pendingPoi: { x: number; y: number } | null = null

let processPlanObjectUrl: string | null = null
let processMergedPoints: MergedPlotPoint[] = []
/** Unscaled merge result; FSPL UI derives `processMergedPoints` from this. */
let processMergedPointsRaw: MergedPlotPoint[] = []
/** Walkplotter trail loaded in Process tab; x/y edits are saved via Save Walkplotter CSV. */
let processWalkPreamble = ''
let processWalkTail = ''
let processTrailEditable: EditableTrailRow[] = []
let processTrailOriginal: EditableTrailRow[] = []
let processWalkTestDate: string | null = null
let processTrailDragIndex: number | null = null

/** Pan (px) and scale for the floor plan; CSS transform on #stage-inner. */
let mapPanX = 0
let mapPanY = 0
let mapZoom = 1
/** Process tab floor plan view; CSS transform on #process-stage-inner. */
let processPanX = 0
let processPanY = 0
let processZoom = 1
const MAP_ZOOM_MIN = 0.35
const MAP_ZOOM_MAX = 8
const PIN_DOT_SCALE_MIN = 0.25
const PIN_DOT_SCALE_MAX = 2.5
/** Multiplier for on-screen pins, trail stroke, POI markers (1 = default). */
let pinDotScale = 1
/** Mouse / stylus: small threshold. Touch screens report more finger jitter before lift. */
const TAP_MAX_MOVE_MOUSE_PX = 14
const TAP_MAX_MOVE_TOUCH_PX = 42
const ZOOM_BTN_FACTOR = 1.2

const pointerPositions = new Map<number, { clientX: number; clientY: number }>()
let gestureKind: 'idle' | 'tap-pending' | 'pan' | 'pinch' = 'idle'
let tapStartX = 0
let tapStartY = 0
let tapPointerId = -1
/** Slop for classifying tap vs pan (set from pointer type on pointerdown). */
let tapSlopPx = TAP_MAX_MOVE_MOUSE_PX
/** Prevents double commit if both pointerup and pointercancel fire (some touch stacks). */
let tapCommitLocked = false
let panStartClientX = 0
let panStartClientY = 0
let panStartMapX = 0
let panStartMapY = 0
let pinchStartDist = 0
let pinchStartZoom = 1
let hadMultiTouch = false

const processPointerPositions = new Map<number, { clientX: number; clientY: number }>()
let processGestureKind: 'idle' | 'pan-pending' | 'pan' | 'pinch' = 'idle'
let processPanStartClientX = 0
let processPanStartClientY = 0
let processPanStartPanX = 0
let processPanStartPanY = 0
let processPinchStartDist = 0
let processPinchStartZoom = 1
let processPanPointerId = -1
let processPanSlopPx = TAP_MAX_MOVE_MOUSE_PX

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`Missing ${sel}`)
  return el as HTMLElement
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function downloadFilename(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  return `walkplotter-${stamp}.csv`
}

function safeCsvFilename(input: string): string {
  let s = input.trim() || downloadFilename()
  s = s.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '')
  if (!s.toLowerCase().endsWith('.csv')) s += '.csv'
  return s.slice(0, 200)
}

function downloadCsvAs(filename: string): void {
  const text = trail.buildCsv(imageMeta, poiMarkers)
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function safePoiCsvFilename(input: string, fallbackStem: string): string {
  let s = input.trim() || `${fallbackStem}-poi.csv`
  s = s.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '')
  if (!s.toLowerCase().endsWith('.csv')) s += '.csv'
  return s.slice(0, 200)
}

function downloadPoiCsvAs(filename: string): void {
  const text = buildPoiOnlyCsv(poiMarkers, imageMeta)
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function poiCsvDownloadFilename(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  return `walkplotter-poi-${stamp}.csv`
}

function safeJpgFilename(input: string, fallbackStem: string): string {
  let s = input.trim() || `${fallbackStem}.jpg`
  s = s.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '')
  if (!s.toLowerCase().endsWith('.jpg') && !s.toLowerCase().endsWith('.jpeg')) s += '.jpg'
  return s.slice(0, 200)
}

function drawTrailOverlayImageSpace(
  ctx: CanvasRenderingContext2D,
  iw: number,
  pinScale: number,
  colors: OverlayColors
): void {
  const pts = trail.points
  const ps = pinScale
  const dotR = Math.max(4, iw / 200) * ps
  const interpR = Math.max(3, iw / 280) * ps
  const lineW = Math.max(2, iw / 500) * ps

  if (pts.length >= 2) {
    ctx.strokeStyle = colors.trailLine
    ctx.lineWidth = lineW
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      if (i === 0 || p.segmentBreak) {
        ctx.moveTo(p.x, p.y)
      } else {
        ctx.lineTo(p.x, p.y)
      }
    }
    ctx.stroke()
  }

  for (const p of pts) {
    if (p.source === 'user') {
      ctx.fillStyle = colors.pinUser
      ctx.beginPath()
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
    } else {
      ctx.strokeStyle = colors.pinInterp
      ctx.lineWidth = Math.max(1, lineW * 0.75)
      ctx.beginPath()
      ctx.arc(p.x, p.y, interpR, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

function drawPoiOverlayImageSpace(
  ctx: CanvasRenderingContext2D,
  iw: number,
  pinScale: number,
  colors: OverlayColors
): void {
  const ps = pinScale
  const r = Math.max(6, iw / 140) * ps
  const fontSize = Math.max(8, Math.round(Math.max(13, iw / 52) * ps))
  ctx.font = `600 ${fontSize}px system-ui,Segoe UI,sans-serif`
  ctx.textBaseline = 'bottom'

  for (const m of poiMarkers) {
    ctx.fillStyle = colors.poi
    ctx.beginPath()
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = Math.max(1.5, iw / 600) * ps
    ctx.stroke()

    const text = m.label || '—'
    const pad = Math.max(4, fontSize * 0.3)
    const tw = ctx.measureText(text).width
    const bx = m.x + r + 3
    const by = m.y - fontSize - pad * 2
    ctx.fillStyle = colors.poiLabelBg
    ctx.fillRect(bx, by, tw + pad * 2, fontSize + pad * 2)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.fillText(text, bx + pad, m.y - pad)
  }
}

function exportMapSnapshotJpeg(filename: string): void {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return

  const c = document.createElement('canvas')
  c.width = iw
  c.height = ih
  const ctx = c.getContext('2d')
  if (!ctx) return

  ctx.drawImage(img, 0, 0, iw, ih)
  const snapColors = getOverlayColors()
  drawTrailOverlayImageSpace(ctx, iw, pinDotScale, snapColors)
  drawPoiOverlayImageSpace(ctx, iw, pinDotScale, snapColors)

  c.toBlob(
    (blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    },
    'image/jpeg',
    0.92
  )
}

/** Bundled test plan: place or replace `public/floorimage.jpg` (e.g. copy your `test floorimage.jpg` there). */
const DEFAULT_FLOOR_IMAGE = `${import.meta.env.BASE_URL}floorimage.jpg`

function setImageFromFile(file: File | null): void {
  if (!file || !file.type.startsWith('image/')) return
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  objectUrl = URL.createObjectURL(file)
  resetMapView()
  img.src = objectUrl
  imageMeta = {
    fileName: file.name || 'unknown',
    widthPx: 0,
    heightPx: 0,
  }
  trail.clear()
  poiMarkers.length = 0
  recording = true
  setTab('map')
  redraw()
}

async function loadDefaultFloorPlan(): Promise<void> {
  try {
    const res = await fetch(DEFAULT_FLOOR_IMAGE)
    if (!res.ok) return
  } catch {
    return
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  imageMeta = {
    fileName: 'floorimage.jpg',
    widthPx: 0,
    heightPx: 0,
  }
  trail.clear()
  poiMarkers.length = 0
  recording = true
  resetMapView()
  img.src = DEFAULT_FLOOR_IMAGE
  updateChrome()
  setTab('map')
}

function clampMapZoom(z: number): number {
  return Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z))
}

function toLocalPoint(p: TrailPoint): { x: number; y: number } | null {
  return imagePixelToElementLocal(p.x, p.y, img)
}

function getLastUserPin(): TrailPoint | null {
  for (let i = trail.points.length - 1; i >= 0; i--) {
    const p = trail.points[i]!
    if (p.source === 'user') return p
  }
  return null
}

function redraw(): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  syncCanvasSize()
  const w = canvas.width / (window.devicePixelRatio || 1)
  const h = canvas.height / (window.devicePixelRatio || 1)
  ctx.clearRect(0, 0, w, h)
  const ps = pinDotScale
  const colors = getOverlayColors()

  const locals: { x: number; y: number; p: TrailPoint }[] = []
  for (const p of trail.points) {
    const q = toLocalPoint(p)
    if (q) locals.push({ ...q, p })
  }

  const lastUser = crosshairsEnabled ? getLastUserPin() : null
  const lastUserLocal = lastUser ? toLocalPoint(lastUser) : null
  if (lastUserLocal && img.naturalWidth) {
    ctx.save()
    ctx.strokeStyle = colors.crosshair
    ctx.lineWidth = Math.max(0.5, 1 * ps)
    ctx.setLineDash([7, 5])
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(0, lastUserLocal.y)
    ctx.lineTo(w, lastUserLocal.y)
    ctx.moveTo(lastUserLocal.x, 0)
    ctx.lineTo(lastUserLocal.x, h)
    ctx.stroke()
    ctx.restore()
  }

  if (locals.length >= 2) {
    ctx.strokeStyle = colors.trailLine
    ctx.lineWidth = Math.max(1, 2 * ps)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 0; i < locals.length; i++) {
      const { x, y, p } = locals[i]!
      if (i === 0 || p.segmentBreak) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.stroke()
  }

  const userFill = colors.pinUser
  const interpStroke = colors.pinInterp

  for (const { x, y, p } of locals) {
    if (p.source === 'user') {
      const isLastUser = lastUser !== null && p === lastUser
      if (isLastUser && crosshairsEnabled) {
        ctx.strokeStyle = colors.crosshairRing
        ctx.lineWidth = Math.max(1, 2 * ps)
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(x, y, Math.max(3, 11 * ps), 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = userFill
      ctx.beginPath()
      ctx.arc(x, y, Math.max(2, 6 * ps), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = Math.max(0.5, 1 * ps)
      ctx.setLineDash([])
      ctx.stroke()
    } else {
      ctx.strokeStyle = interpStroke
      ctx.lineWidth = Math.max(1, 2 * ps)
      ctx.beginPath()
      ctx.arc(x, y, Math.max(1.5, 4 * ps), 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  const repFill = colors.poi
  const repLabelBg = colors.poiLabelBg
  const fontPx = Math.max(9, Math.min(22, (w / 42) * ps))

  ctx.font = `600 ${fontPx}px system-ui,Segoe UI,sans-serif`
  ctx.textBaseline = 'bottom'

  for (const m of poiMarkers) {
    const q = imagePixelToElementLocal(m.x, m.y, img)
    if (!q) continue
    const repR = Math.max(3, 8 * ps)
    ctx.fillStyle = repFill
    ctx.beginPath()
    ctx.arc(q.x, q.y, repR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1, 2 * ps)
    ctx.stroke()

    const text = m.label || '—'
    const pad = Math.max(2, 4 * ps)
    const tw = ctx.measureText(text).width
    const bx = q.x + repR + Math.max(4, 10 * ps)
    const by = q.y - fontPx - pad * 2
    ctx.fillStyle = repLabelBg
    ctx.fillRect(bx, by, tw + pad * 2, fontPx + pad * 2)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.fillText(text, bx + pad, q.y - pad)
  }
}

function onPointerTapTrail(clientX: number, clientY: number): void {
  if (!img.naturalWidth || !recording) return
  const hit = clientToImagePixel(clientX, clientY, img)
  if (!hit.ok) return
  trail.userTap(hit.pixel.x, hit.pixel.y, new Date())
  redraw()
}

function onPointerTapPoi(clientX: number, clientY: number): void {
  if (!img.naturalWidth) return
  const hit = clientToImagePixel(clientX, clientY, img)
  if (!hit.ok) return
  pendingPoi = { x: hit.pixel.x, y: hit.pixel.y }
  openPoiDialog()
}

/* --- DOM --- */
const app = $('#app')
app.innerHTML = `
  <div class="tablist" role="tablist" aria-label="Walkplotter">
    <button type="button" class="tab-btn" role="tab" id="tab-map" aria-selected="true" aria-controls="panel-map">Map</button>
    <button type="button" class="tab-btn" role="tab" id="tab-controls" aria-selected="false" aria-controls="panel-controls" tabindex="-1">Controls</button>
    <button type="button" class="tab-btn" role="tab" id="tab-process" aria-selected="false" aria-controls="panel-process" tabindex="-1">Process</button>
  </div>

  <div class="tab-panel tab-panel--map" id="panel-map" role="tabpanel" aria-labelledby="tab-map">
    <p class="hint hint-map" id="hint-map">Open the Controls tab to load a floor plan.</p>
    <div class="map-quick-bar" id="map-quick-bar" hidden>
      <button type="button" class="btn" id="btn-pause" disabled>Pause</button>
      <button type="button" class="btn" id="btn-undo" disabled>Undo trail</button>
    </div>
    <div class="stage-wrap">
      <div class="stage" id="stage">
        <div class="stage-inner" id="stage-inner">
          <img id="plan" alt="Floor plan" />
          <canvas id="overlay" />
        </div>
      </div>
      <p class="empty" id="placeholder">Load an image to begin.</p>
    </div>
  </div>

  <div class="tab-panel tab-panel--controls" id="panel-controls" role="tabpanel" aria-labelledby="tab-controls" hidden>
    <div class="controls-title-bar" role="banner">
      <span class="controls-title-text">Walkplotter - version 2.0 March 2026</span>
      <a
        class="controls-title-link"
        href="https://github.com/Cloolalang/walkplotter#readme"
        target="_blank"
        rel="noopener noreferrer"
        >README on GitHub</a>
    </div>
    <header class="toolbar">
      <label class="btn btn-primary">
        Choose floor plan
        <input id="file" type="file" accept="image/*" hidden />
      </label>
      <div class="mode-switch" role="group" aria-label="Placement mode">
        <button type="button" class="mode-btn active" id="mode-trail" disabled>Trail</button>
        <button type="button" class="mode-btn" id="mode-poi" disabled title="Points of interest">POI</button>
      </div>
      <button type="button" class="btn" id="btn-stop" disabled title="Save CSV (and optional JPG). Available while recording, or after Pause if you have trail or POI data.">Stop &amp; save…</button>
      <button type="button" class="btn" id="btn-resume" disabled hidden>Resume recording</button>
      <button type="button" class="btn" id="btn-download" disabled>Download CSV</button>
      <button type="button" class="btn" id="btn-download-poi-csv" disabled title="POI markers: pixels only, no timestamps">POI CSV</button>
      <button type="button" class="btn" id="btn-undo-poi" disabled>Undo POI</button>
      <button type="button" class="btn btn-danger" id="btn-clear" disabled>Clear trail</button>
      <button type="button" class="btn btn-danger" id="btn-clear-poi" disabled>Clear POI</button>
      <label class="toolbar-toggle" title="Guide lines through last pin for 0° / 90° / 180° / 270°">
        <input type="checkbox" id="crosshairs-toggle" checked />
        Crosshairs
      </label>
    </header>
    <div class="interp-bar" id="interp-bar">
      <label class="interp-label" for="interp-step">Interpolation step (seconds)</label>
      <input
        type="text"
        id="interp-step"
        class="interp-step-input"
        value="1"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        disabled
      />
      <p class="interp-hint">When two taps are over 1s apart, synthetic points are spaced along the straight segment at this interval (0.1s–30s).</p>
    </div>
    <p class="hint" id="hint-main">Tap the plan to drop pins. CSV uses local time as HH:MM:SS; the test date is in the file header. Spacing over 1s between taps fills a straight path at the step below.</p>
    <div class="map-zoom-bar" id="map-zoom-bar" hidden>
      <span>Map</span>
      <button type="button" class="btn" id="btn-zoom-out" title="Zoom out">−</button>
      <span class="zoom-pct" id="zoom-pct">100%</span>
      <button type="button" class="btn" id="btn-zoom-in" title="Zoom in">+</button>
      <button type="button" class="btn" id="btn-zoom-reset" title="Reset pan and zoom">Reset view</button>
    </div>
    <div class="pin-size-bar" id="pin-size-bar" hidden>
      <label class="pin-size-label" for="pin-size">Pin size</label>
      <input type="range" id="pin-size" min="25" max="250" step="5" value="100" disabled />
      <span class="pin-size-pct" id="pin-size-pct">100%</span>
      <label class="pin-color-label" for="color-trail">Trail color</label>
      <input
        type="color"
        id="color-trail"
        class="pin-color-input"
        value="#2ee6a6"
        disabled
        title="Polyline between trail pins"
      />
      <label class="pin-color-label" for="color-pin">Pin color</label>
      <input
        type="color"
        id="color-pin"
        class="pin-color-input"
        value="#2ee6a6"
        disabled
        title="User pins, interpolated points, and crosshairs"
      />
    </div>
  </div>

  <div class="tab-panel tab-panel--process" id="panel-process" role="tabpanel" aria-labelledby="tab-process" hidden>
    <p class="hint process-hint">
      Load the <strong>floor plan</strong> and <strong>Walkplotter CSV</strong>. Optionally <strong>nudge</strong> trail dots and <strong>save</strong> the CSV so pixel columns match your plan. Then load <strong>path loss</strong> CSV (4th field = path loss in <strong>dB</strong>, 1st = HH:MM:SS) and <strong>Plot path loss</strong>. Nearest-time match within
      ${DEFAULT_MAX_MATCH_MS / 1000}s using <code>test_date_local</code>.
    </p>
    <div class="process-toolbar">
      <label class="btn btn-primary process-file-btn">
        Floor plan
        <input id="process-file-plan" type="file" accept="image/*" hidden />
      </label>
      <label class="btn btn-primary process-file-btn">
        Walkplotter CSV
        <input id="process-file-walk" type="file" accept=".csv,text/csv,text/plain,*/*" hidden />
      </label>
      <label class="btn btn-primary process-file-btn">
        Path loss CSV
        <input id="process-file-pl" type="file" accept=".csv,text/csv,text/plain,*/*" hidden />
      </label>
      <button type="button" class="btn btn-primary process-btn-run" id="process-btn-plot" title="Merge path loss log with current trail and draw">Plot path loss</button>
      <button type="button" class="btn" id="process-btn-clear-plot" disabled title="Remove path loss overlay to edit the trail again">
        Clear path loss plot
      </button>
      <label class="toolbar-toggle process-toolbar-toggle" title="Show path loss (dB) next to each point">
        <input type="checkbox" id="process-show-pl-labels" />
        Point labels
      </label>
      <label class="toolbar-toggle process-toolbar-toggle" title="Draw lines between plotted points in walk order (matched samples only)">
        <input type="checkbox" id="process-show-pl-route" />
        Show route
      </label>
      <label class="toolbar-toggle process-toolbar-toggle" title="Continuous path-loss–colored ribbon (same width as points); hides plot disks while on (2+ points). Segment blends between samples.">
        <input type="checkbox" id="process-show-pl-colored-trail" />
        Color-coded trail
      </label>
    </div>
    <div class="process-toolbar process-toolbar--fspl" id="process-fspl-wrap" hidden>
      <label class="toolbar-toggle process-toolbar-toggle process-fspl-toggle" title="Free space vs 2.4 GHz measurement. Positive PL (dB): add 20·log₁₀(f_est/f_meas). Negative PL values (some gear): correction is sign-flipped so lower frequency still shows less loss.">
        <input type="checkbox" id="process-fspl-enable" disabled />
        FSPL frequency estimate
      </label>
      <label class="process-fspl-field" for="process-fspl-target"
        ><span class="process-fspl-field-label">Estimate at</span>
        <select id="process-fspl-target" class="process-fspl-select" disabled aria-label="Frequency to estimate path loss at (MHz)"></select>
        <span class="process-fspl-unit">MHz</span></label
      >
      <label class="process-fspl-field" for="process-fspl-ref"
        ><span class="process-fspl-field-label">Measured at (2.4 GHz)</span>
        <select id="process-fspl-ref" class="process-fspl-select" disabled aria-label="Actual walk test frequency in MHz"></select>
        <span class="process-fspl-unit">MHz</span></label
      >
      <span class="process-fspl-delta" id="process-fspl-delta" aria-live="polite"></span>
    </div>
    <div class="process-toolbar process-toolbar--adjust">
      <label class="toolbar-toggle process-toolbar-toggle" title="Drag trail dots to adjust image pixel coordinates; use Save when ready">
        <input type="checkbox" id="process-nudge-trail" disabled />
        Nudge trail
      </label>
      <label class="process-snap-wrap" for="process-nudge-snap">
        <span class="process-snap-label">Snap angles</span>
        <select id="process-nudge-snap" class="process-nudge-snap" disabled title="While dragging: snap using the segment from the previous point, from the next point, or both (middle points)">
          <option value="off">Off</option>
          <option value="90">90° H/V</option>
          <option value="45">45° 8-way</option>
        </select>
      </label>
      <button type="button" class="btn" id="process-reset-trail" disabled title="Restore trail pixels from when the CSV was loaded">
        Reset trail
      </button>
      <button type="button" class="btn btn-primary" id="process-save-walk-edited" disabled title="Download as a new file (name-edited.csv)">
        Save as edited copy
      </button>
      <button type="button" class="btn" id="process-save-walk-original" disabled title="Download using the loaded file’s name—choose the same folder in the save dialog to replace it">
        Save (original name)
      </button>
    </div>
    <div class="process-files-summary" id="process-files-summary" aria-live="polite">
      <div class="process-file-row">
        <span class="process-file-kind">Floor plan</span>
        <span class="process-file-name" id="process-filename-plan">—</span>
      </div>
      <div class="process-file-row">
        <span class="process-file-kind">Walkplotter CSV</span>
        <span class="process-file-name" id="process-filename-walk">—</span>
      </div>
      <div class="process-file-row">
        <span class="process-file-kind">Path loss CSV</span>
        <span class="process-file-name" id="process-filename-pl">—</span>
      </div>
    </div>
    <p class="hint process-status" id="process-status">Load floor plan and Walkplotter CSV to begin.</p>
    <div class="process-legend" id="process-legend" hidden></div>
    <div class="process-histogram-wrap" id="process-histogram-wrap" hidden>
      <p class="process-histogram-title">Path loss histogram (20 dB bins)</p>
      <div class="process-histogram-scroll">
        <table class="process-histogram-table">
          <thead>
            <tr>
              <th scope="col">Bin (dB)</th>
              <th scope="col">Count</th>
              <th scope="col">Seconds</th>
              <th scope="col">%</th>
            </tr>
          </thead>
          <tbody id="process-histogram-body"></tbody>
        </table>
      </div>
    </div>
    <div class="map-zoom-bar process-zoom-bar" id="process-zoom-bar" hidden>
      <span>View</span>
      <button type="button" class="btn" id="process-btn-zoom-out" title="Zoom out">−</button>
      <span class="zoom-pct" id="process-zoom-pct">100%</span>
      <button type="button" class="btn" id="process-btn-zoom-in" title="Zoom in">+</button>
      <button type="button" class="btn" id="process-btn-zoom-reset" title="Reset pan and zoom">Reset view</button>
    </div>
    <p class="hint process-mouse-hint" id="process-mouse-hint" hidden>
      Mouse: wheel to zoom · drag empty area to pan · while nudging: <strong>left-drag</strong> on empty space, or <strong>middle-drag</strong> / <strong>Alt+drag</strong> anywhere, to pan the view.
    </p>
    <div class="process-stage-wrap">
      <div class="process-stage" id="process-stage">
        <div class="process-stage-inner" id="process-stage-inner">
          <img id="process-plan" alt="Floor plan for processing" />
          <canvas id="process-overlay" />
        </div>
      </div>
      <p class="empty process-placeholder" id="process-placeholder">Load a floor plan image to see the overlay.</p>
    </div>
  </div>

  <dialog class="save-dialog" id="save-dialog">
    <form id="save-form">
      <h2 class="save-dialog-title">Save</h2>
      <p class="save-dialog-desc" id="save-dialog-desc">Choose a CSV file name. Trail points and POI markers are included in one file.</p>
      <div id="save-trail-csv-wrap">
        <label class="save-dialog-label">
          Trail CSV file name
          <input type="text" id="save-filename" name="filename" class="save-dialog-input" autocomplete="off" spellcheck="false" />
        </label>
      </div>
      <label class="save-dialog-check">
        <input type="checkbox" id="save-include-jpg" />
        <span id="save-include-jpg-text">Also save a map snapshot (floor plan + trail + POI markers) as JPG</span>
      </label>
      <label class="save-dialog-label" id="jpg-filename-wrap" hidden>
        JPG file name
        <input type="text" id="save-jpg-filename" class="save-dialog-input" autocomplete="off" spellcheck="false" placeholder="Matches CSV name if left blank" />
      </label>
      <div id="save-poi-extra-wrap">
        <label class="save-dialog-check" id="save-poi-csv-check-wrap">
          <input type="checkbox" id="save-poi-csv" />
          <span id="save-poi-csv-check-text">Also save POI markers only in a separate CSV (label + x,y pixels, no timestamps)</span>
        </label>
      </div>
      <label class="save-dialog-label" id="poi-csv-filename-wrap" hidden>
        <span id="poi-csv-filename-label">Separate POI CSV file name</span>
        <input type="text" id="save-poi-filename" class="save-dialog-input" autocomplete="off" spellcheck="false" placeholder="e.g. myplan-poi.csv" />
      </label>
      <div class="save-dialog-actions">
        <button type="button" class="btn" id="save-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="save-confirm">Save</button>
      </div>
    </form>
  </dialog>
  <dialog class="save-dialog" id="poi-dialog">
    <form id="poi-form">
      <h2 class="save-dialog-title">POI marker</h2>
      <p class="save-dialog-desc">Enter a label (e.g. room or feature). This pin is not part of the walked trail.</p>
      <label class="save-dialog-label">
        Label
        <input type="text" id="poi-label" class="save-dialog-input" autocomplete="off" spellcheck="false" placeholder="North POI" />
      </label>
      <div class="save-dialog-actions">
        <button type="button" class="btn" id="poi-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Place</button>
      </div>
    </form>
  </dialog>
`

const img = document.querySelector<HTMLImageElement>('#plan')!
const canvas = document.querySelector<HTMLCanvasElement>('#overlay')!
const fileInput = document.querySelector<HTMLInputElement>('#file')!
const btnPause = document.querySelector<HTMLButtonElement>('#btn-pause')!
const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop')!
const btnResume = document.querySelector<HTMLButtonElement>('#btn-resume')!
const btnDownload = document.querySelector<HTMLButtonElement>('#btn-download')!
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!
const placeholder = document.querySelector<HTMLParagraphElement>('#placeholder')!
const stage = document.querySelector<HTMLDivElement>('#stage')!
const stageInner = document.querySelector<HTMLDivElement>('#stage-inner')!
const mapQuickBar = document.querySelector<HTMLDivElement>('#map-quick-bar')!
const mapZoomBar = document.querySelector<HTMLDivElement>('#map-zoom-bar')!
const pinSizeBar = document.querySelector<HTMLDivElement>('#pin-size-bar')!
const pinSizeRange = document.querySelector<HTMLInputElement>('#pin-size')!
const pinSizePctEl = document.querySelector<HTMLSpanElement>('#pin-size-pct')!
const zoomPctEl = document.querySelector<HTMLSpanElement>('#zoom-pct')!
const btnZoomIn = document.querySelector<HTMLButtonElement>('#btn-zoom-in')!
const btnZoomOut = document.querySelector<HTMLButtonElement>('#btn-zoom-out')!
const btnZoomReset = document.querySelector<HTMLButtonElement>('#btn-zoom-reset')!
const hintMain = document.querySelector<HTMLParagraphElement>('#hint-main')!
const hintMap = document.querySelector<HTMLParagraphElement>('#hint-map')!
const tabMap = document.querySelector<HTMLButtonElement>('#tab-map')!
const tabControls = document.querySelector<HTMLButtonElement>('#tab-controls')!
const tabProcess = document.querySelector<HTMLButtonElement>('#tab-process')!
const panelMap = document.querySelector<HTMLDivElement>('#panel-map')!
const panelControls = document.querySelector<HTMLDivElement>('#panel-controls')!
const panelProcess = document.querySelector<HTMLDivElement>('#panel-process')!
const processImg = document.querySelector<HTMLImageElement>('#process-plan')!
const processCanvas = document.querySelector<HTMLCanvasElement>('#process-overlay')!
const processStage = document.querySelector<HTMLDivElement>('#process-stage')!
const processStageInner = document.querySelector<HTMLDivElement>('#process-stage-inner')!
const processZoomBar = document.querySelector<HTMLDivElement>('#process-zoom-bar')!
const processZoomPctEl = document.querySelector<HTMLSpanElement>('#process-zoom-pct')!
const processBtnZoomIn = document.querySelector<HTMLButtonElement>('#process-btn-zoom-in')!
const processBtnZoomOut = document.querySelector<HTMLButtonElement>('#process-btn-zoom-out')!
const processBtnZoomReset = document.querySelector<HTMLButtonElement>('#process-btn-zoom-reset')!
const processFilePlan = document.querySelector<HTMLInputElement>('#process-file-plan')!
const processFileWalk = document.querySelector<HTMLInputElement>('#process-file-walk')!
const processFilePl = document.querySelector<HTMLInputElement>('#process-file-pl')!
const processBtnPlot = document.querySelector<HTMLButtonElement>('#process-btn-plot')!
const processBtnClearPlot = document.querySelector<HTMLButtonElement>('#process-btn-clear-plot')!
const processShowPlLabels = document.querySelector<HTMLInputElement>('#process-show-pl-labels')!
const processShowPlRoute = document.querySelector<HTMLInputElement>('#process-show-pl-route')!
const processShowPlColoredTrail = document.querySelector<HTMLInputElement>('#process-show-pl-colored-trail')!
const processFsplWrap = document.querySelector<HTMLDivElement>('#process-fspl-wrap')!
const processFsplEnable = document.querySelector<HTMLInputElement>('#process-fspl-enable')!
const processFsplRef = document.querySelector<HTMLSelectElement>('#process-fspl-ref')!
const processFsplTarget = document.querySelector<HTMLSelectElement>('#process-fspl-target')!
const processFsplDelta = document.querySelector<HTMLSpanElement>('#process-fspl-delta')!
const processNudgeTrail = document.querySelector<HTMLInputElement>('#process-nudge-trail')!
const processNudgeSnap = document.querySelector<HTMLSelectElement>('#process-nudge-snap')!
const processResetTrail = document.querySelector<HTMLButtonElement>('#process-reset-trail')!
const processSaveWalkEdited = document.querySelector<HTMLButtonElement>('#process-save-walk-edited')!
const processSaveWalkOriginal = document.querySelector<HTMLButtonElement>('#process-save-walk-original')!
const processStatus = document.querySelector<HTMLParagraphElement>('#process-status')!
const processFilenamePlan = document.querySelector<HTMLSpanElement>('#process-filename-plan')!
const processFilenameWalk = document.querySelector<HTMLSpanElement>('#process-filename-walk')!
const processFilenamePl = document.querySelector<HTMLSpanElement>('#process-filename-pl')!
const processLegend = document.querySelector<HTMLDivElement>('#process-legend')!
const processHistogramWrap = document.querySelector<HTMLDivElement>('#process-histogram-wrap')!
const processHistogramBody = document.querySelector<HTMLTableSectionElement>('#process-histogram-body')!
const processPlaceholder = document.querySelector<HTMLParagraphElement>('#process-placeholder')!
const processMouseHint = document.querySelector<HTMLParagraphElement>('#process-mouse-hint')!
const saveDialog = document.querySelector<HTMLDialogElement>('#save-dialog')!
const saveForm = document.querySelector<HTMLFormElement>('#save-form')!
const saveDialogDesc = document.querySelector<HTMLParagraphElement>('#save-dialog-desc')!
const saveTrailCsvWrap = document.querySelector<HTMLDivElement>('#save-trail-csv-wrap')!
const savePoiExtraWrap = document.querySelector<HTMLDivElement>('#save-poi-extra-wrap')!
const saveIncludeJpgText = document.querySelector<HTMLSpanElement>('#save-include-jpg-text')!
const poiCsvFilenameLabel = document.querySelector<HTMLSpanElement>('#poi-csv-filename-label')!
const savePoiCsvCheckText = document.querySelector<HTMLSpanElement>('#save-poi-csv-check-text')!
const saveFilenameInput = document.querySelector<HTMLInputElement>('#save-filename')!
const saveCancel = document.querySelector<HTMLButtonElement>('#save-cancel')!
const saveIncludeJpg = document.querySelector<HTMLInputElement>('#save-include-jpg')!
const jpgFilenameWrap = document.querySelector<HTMLLabelElement>('#jpg-filename-wrap')!
const saveJpgFilename = document.querySelector<HTMLInputElement>('#save-jpg-filename')!
const savePoiCsv = document.querySelector<HTMLInputElement>('#save-poi-csv')!
const poiCsvFilenameWrap = document.querySelector<HTMLLabelElement>('#poi-csv-filename-wrap')!
const savePoiFilename = document.querySelector<HTMLInputElement>('#save-poi-filename')!
const btnDownloadPoiCsv = document.querySelector<HTMLButtonElement>('#btn-download-poi-csv')!
const modeTrail = document.querySelector<HTMLButtonElement>('#mode-trail')!
const modePoi = document.querySelector<HTMLButtonElement>('#mode-poi')!
const btnUndoPoi = document.querySelector<HTMLButtonElement>('#btn-undo-poi')!
const btnClearPoi = document.querySelector<HTMLButtonElement>('#btn-clear-poi')!
const poiDialog = document.querySelector<HTMLDialogElement>('#poi-dialog')!
const poiForm = document.querySelector<HTMLFormElement>('#poi-form')!
const poiLabelInput = document.querySelector<HTMLInputElement>('#poi-label')!
const poiCancel = document.querySelector<HTMLButtonElement>('#poi-cancel')!
const crosshairsToggle = document.querySelector<HTMLInputElement>('#crosshairs-toggle')!
const interpStep = document.querySelector<HTMLInputElement>('#interp-step')!
const colorTrail = document.querySelector<HTMLInputElement>('#color-trail')!
const colorPin = document.querySelector<HTMLInputElement>('#color-pin')!

const rootStyle = document.documentElement.style

function mixHexWithWhite(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#8af5d4'
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const rr = Math.round(r + (255 - r) * t)
  const gg = Math.round(g + (255 - g) * t)
  const bb = Math.round(b + (255 - b) * t)
  return `#${[rr, gg, bb].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(46, 230, 166, ${alpha})`
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

function getOverlayColors(): OverlayColors {
  const s = getComputedStyle(canvas)
  return {
    trailLine: s.getPropertyValue('--trail-line').trim() || '#2ee6a6',
    pinUser: s.getPropertyValue('--pin-user').trim() || '#2ee6a6',
    pinInterp: s.getPropertyValue('--pin-interp').trim() || '#8af5d4',
    poi: s.getPropertyValue('--poi').trim() || '#e53935',
    poiLabelBg: s.getPropertyValue('--poi-label-bg').trim() || 'rgba(0,0,0,0.72)',
    crosshair: s.getPropertyValue('--crosshair').trim() || 'rgba(46, 230, 166, 0.65)',
    crosshairRing: s.getPropertyValue('--crosshair-ring').trim() || 'rgba(46, 230, 166, 0.9)',
  }
}

function applyTrailColorFromPicker(): void {
  rootStyle.setProperty('--trail-line', colorTrail.value)
}

function applyPinColorFromPicker(): void {
  const v = colorPin.value
  rootStyle.setProperty('--pin-user', v)
  rootStyle.setProperty('--pin-interp', mixHexWithWhite(v, 0.38))
  rootStyle.setProperty('--crosshair', hexToRgba(v, 0.65))
  rootStyle.setProperty('--crosshair-ring', hexToRgba(v, 0.9))
}

function syncColorPickersFromCss(): void {
  const c = getOverlayColors()
  colorTrail.value = rgbLikeToHexForInput(c.trailLine, '#2ee6a6')
  colorPin.value = rgbLikeToHexForInput(c.pinUser, '#2ee6a6')
}

/** Normalize CSS color to #rrggbb for type=color (best effort). */
function rgbLikeToHexForInput(css: string, fallback: string): string {
  const s = css.trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  const m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) {
    const x = m[1]!
    return `#${x[0]}${x[0]}${x[1]}${x[1]}${x[2]}${x[2]}`.toLowerCase()
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgb) {
    const r = Number(rgb[1])
    const g = Number(rgb[2])
    const b = Number(rgb[3])
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  }
  return fallback
}

function applyViewTransform(): void {
  stageInner.style.setProperty('--map-pan-x', `${mapPanX}px`)
  stageInner.style.setProperty('--map-pan-y', `${mapPanY}px`)
  stageInner.style.setProperty('--map-zoom', String(mapZoom))
}

/**
 * CSS transform is translate(pan) then scale(z) with origin 0,0, so a point at local (lx,ly)
 * maps to stage (base+pan+z*lx). When z changes, adjust pan so the same stage point (fx,fy)
 * stays on the same content pixel (pinch zoom toward fingers, wheel toward cursor).
 */
function zoomAroundStagePoint(zNew: number, fx: number, fy: number, zOld: number): void {
  const baseX = stageInner.offsetLeft
  const baseY = stageInner.offsetTop
  if (zOld <= 0 || !Number.isFinite(zOld)) {
    mapZoom = zNew
    return
  }
  const ratio = zNew / zOld
  if (!Number.isFinite(ratio)) {
    mapZoom = zNew
    return
  }
  mapPanX += (fx - baseX) * (1 - ratio)
  mapPanY += (fy - baseY) * (1 - ratio)
  mapZoom = zNew
}

function applyZoomFactor(factor: number): void {
  const rect = stage.getBoundingClientRect()
  const fx = rect.width / 2
  const fy = rect.height / 2
  const zOld = mapZoom
  const zNew = clampMapZoom(mapZoom * factor)
  zoomAroundStagePoint(zNew, fx, fy, zOld)
  applyViewTransform()
  updateZoomPctLabel()
  redraw()
}

function updateZoomPctLabel(): void {
  zoomPctEl.textContent = `${Math.round(mapZoom * 100)}%`
}

function clampPinDotScale(s: number): number {
  return Math.min(PIN_DOT_SCALE_MAX, Math.max(PIN_DOT_SCALE_MIN, s))
}

function updatePinSizeLabel(): void {
  pinSizePctEl.textContent = `${Math.round(pinDotScale * 100)}%`
}

function syncPinSizeControl(): void {
  pinSizeRange.value = String(Math.round(pinDotScale * 100))
  updatePinSizeLabel()
}

function resetMapView(): void {
  mapPanX = 0
  mapPanY = 0
  mapZoom = 1
  applyViewTransform()
  updateZoomPctLabel()
}

function applyProcessViewTransform(): void {
  processStageInner.style.setProperty('--process-pan-x', `${processPanX}px`)
  processStageInner.style.setProperty('--process-pan-y', `${processPanY}px`)
  processStageInner.style.setProperty('--process-zoom', String(processZoom))
}

function zoomAroundProcessPoint(zNew: number, fx: number, fy: number, zOld: number): void {
  const baseX = processStageInner.offsetLeft
  const baseY = processStageInner.offsetTop
  if (zOld <= 0 || !Number.isFinite(zOld)) {
    processZoom = zNew
    return
  }
  const ratio = zNew / zOld
  if (!Number.isFinite(ratio)) {
    processZoom = zNew
    return
  }
  processPanX += (fx - baseX) * (1 - ratio)
  processPanY += (fy - baseY) * (1 - ratio)
  processZoom = zNew
}

function applyProcessZoomFactor(factor: number): void {
  const rect = processStage.getBoundingClientRect()
  const fx = rect.width / 2
  const fy = rect.height / 2
  const zOld = processZoom
  const zNew = clampMapZoom(processZoom * factor)
  zoomAroundProcessPoint(zNew, fx, fy, zOld)
  applyProcessViewTransform()
  updateProcessZoomPctLabel()
  drawProcessOverlay()
}

function updateProcessZoomPctLabel(): void {
  processZoomPctEl.textContent = `${Math.round(processZoom * 100)}%`
}

function resetProcessView(): void {
  processPanX = 0
  processPanY = 0
  processZoom = 1
  applyProcessViewTransform()
  updateProcessZoomPctLabel()
}

function processCanvasBlocksStageGestures(): boolean {
  return getComputedStyle(processCanvas).pointerEvents === 'auto'
}

/**
 * Desktop: immediate pan (no slop) — middle button, Alt+left, or **left on empty overlay**
 * while nudging (same as middle; left on a trail dot still nudges).
 */
function processMouseViewPanAllowed(e: PointerEvent): boolean {
  if (e.pointerType !== 'mouse') return false
  if (e.button === 1) return true
  if (e.button === 0 && e.altKey) return true
  if (
    e.button === 0 &&
    !e.altKey &&
    processCanvasBlocksStageGestures()
  ) {
    const t = e.target as Node
    if (t === processCanvas || processCanvas.contains(t)) {
      if (findTrailHitIndex(e.clientX, e.clientY, processTrailDotRadius()) === null) {
        return true
      }
    }
  }
  return false
}

/** Single-finger pan is disabled over the trail overlay while nudging; pinch/wheel/buttons still zoom. */
function processSingleFingerPanBlocked(e: PointerEvent): boolean {
  if (processMouseViewPanAllowed(e)) return false
  if (!processCanvasBlocksStageGestures()) return false
  const t = e.target as Node
  return t === processCanvas || processCanvas.contains(t)
}

function syncCanvasSize(): void {
  // Layout coords relative to stage-inner (untransformed). Viewport deltas (ir − inner)
  // are wrong here because stage-inner uses transform: scale(mapZoom).
  const left = img.offsetLeft
  const top = img.offsetTop
  const w = Math.max(1, img.offsetWidth)
  const h = Math.max(1, img.offsetHeight)
  canvas.style.left = `${left}px`
  canvas.style.top = `${top}px`
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}

/** Fixed path-loss color scale for Process overlay (dB): −30 (light blue) → −100 (dark grey). */
const PROCESS_PL_GOOD = -30
const PROCESS_PL_BAD = -100

type PlRgb = readonly [number, number, number]

/** Stops from weak (−100) to strong (−30); greys below −90, warm colors toward −70, cool palette toward −30. */
const PL_COLOR_STOPS: readonly { db: number; rgb: PlRgb }[] = [
  { db: -100, rgb: [44, 44, 48] },
  { db: -90, rgb: [125, 125, 128] },
  { db: -80, rgb: [155, 85, 82] },
  { db: -72, rgb: [210, 42, 38] },
  { db: -68, rgb: [255, 118, 28] },
  { db: -62, rgb: [255, 205, 45] },
  { db: -54, rgb: [48, 155, 88] },
  { db: -46, rgb: [28, 78, 168] },
  { db: -38, rgb: [72, 138, 215] },
  { db: -30, rgb: [186, 228, 255] },
]

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function pathLossToColor(pl: number): string {
  const x = Math.max(PROCESS_PL_BAD, Math.min(PROCESS_PL_GOOD, pl))
  const stops = PL_COLOR_STOPS
  if (x <= stops[0]!.db) {
    const c = stops[0]!.rgb
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  }
  if (x >= stops[stops.length - 1]!.db) {
    const c = stops[stops.length - 1]!.rgb
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i]!
    const hi = stops[i + 1]!
    if (x >= lo.db && x <= hi.db) {
      const t = (x - lo.db) / (hi.db - lo.db)
      return `rgb(${lerpChannel(lo.rgb[0], hi.rgb[0], t)}, ${lerpChannel(lo.rgb[1], hi.rgb[1], t)}, ${lerpChannel(lo.rgb[2], hi.rgb[2], t)})`
    }
  }
  const c = stops[stops.length - 1]!.rgb
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function pathLossScaleGradientCss(): string {
  const pts = PL_COLOR_STOPS.map((s) => ({
    pct: ((s.db - PROCESS_PL_GOOD) / (PROCESS_PL_BAD - PROCESS_PL_GOOD)) * 100,
    color: pathLossToColor(s.db),
  })).sort((a, b) => a.pct - b.pct)
  return `linear-gradient(90deg, ${pts.map((p) => `${p.color} ${p.pct.toFixed(2)}%`).join(', ')})`
}

const PROCESS_HIST_BIN_WIDTH_DB = 20

type PathLossBinRow = { low: number; high: number; count: number; seconds: number }

/**
 * Bins aligned to multiples of `binWidthDb` dB; half-open [low, high).
 * **Seconds:** each interval from sample `i` to `i+1` (from trail timestamps) is added to the bin
 * containing sample `i`'s path loss (time walking until the next plotted point).
 */
function pathLossHistogramBinsFromMerged(points: MergedPlotPoint[], binWidthDb: number): PathLossBinRow[] {
  if (points.length === 0) return []
  let minV = points[0]!.pathLoss
  let maxV = minV
  for (const p of points) {
    if (p.pathLoss < minV) minV = p.pathLoss
    if (p.pathLoss > maxV) maxV = p.pathLoss
  }
  const w = binWidthDb
  const start = Math.floor(minV / w) * w
  const endExclusive = Math.floor(maxV / w) * w + w
  const nBins = Math.max(1, Math.round((endExclusive - start) / w))
  const counts = new Array<number>(nBins).fill(0)
  const seconds = new Array<number>(nBins).fill(0)
  for (const p of points) {
    const v = p.pathLoss
    let i = Math.floor((v - start) / w)
    if (i < 0) i = 0
    else if (i >= nBins) i = nBins - 1
    counts[i]!++
  }
  for (let i = 0; i < points.length - 1; i++) {
    const dtSec = Math.max(0, (points[i + 1]!.timeMs - points[i]!.timeMs) / 1000)
    const v = points[i]!.pathLoss
    let bi = Math.floor((v - start) / w)
    if (bi < 0) bi = 0
    else if (bi >= nBins) bi = nBins - 1
    seconds[bi]! += dtSec
  }
  const rows: PathLossBinRow[] = []
  for (let i = 0; i < nBins; i++) {
    const low = start + i * w
    rows.push({ low, high: low + w, count: counts[i]!, seconds: seconds[i]! })
  }
  return rows
}

function formatPathLossBinLabel(low: number, high: number): string {
  const a = low.toFixed(0)
  const b = high.toFixed(0)
  return `[${a}, ${b})`
}

function updateProcessHistogramTable(): void {
  const n = processMergedPoints.length
  if (n === 0) {
    processHistogramWrap.hidden = true
    processHistogramBody.innerHTML = ''
    return
  }
  const rows = pathLossHistogramBinsFromMerged(processMergedPoints, PROCESS_HIST_BIN_WIDTH_DB)
  const total = n
  const parts: string[] = []
  for (const r of rows) {
    const pct = total > 0 ? (100 * r.count) / total : 0
    parts.push(
      `<tr><td>${formatPathLossBinLabel(r.low, r.high)}</td><td>${r.count}</td><td>${r.seconds.toFixed(1)}</td><td>${pct.toFixed(1)}</td></tr>`,
    )
  }
  processHistogramBody.innerHTML = parts.join('')
  processHistogramWrap.hidden = false
}

function fillFsplSelectOptions(): void {
  processFsplRef.innerHTML = ''
  for (const m of fsplMeasuredFrequencyOptionsMhz()) {
    const opt = document.createElement('option')
    opt.value = String(m)
    opt.textContent = m === 2474 ? `${m} (≈ ch 14)` : String(m)
    processFsplRef.appendChild(opt)
  }
  processFsplTarget.innerHTML = ''
  for (const m of fsplDisplayFrequencyOptionsMhz()) {
    const opt = document.createElement('option')
    opt.value = String(m)
    opt.textContent = String(m)
    processFsplTarget.appendChild(opt)
  }
  processFsplRef.value = '2474'
  processFsplTarget.value = '1800'
}

function updateProcessFsplDeltaLabel(): void {
  if (processMergedPointsRaw.length === 0) {
    processFsplDelta.textContent = ''
    return
  }
  const fMeas = Number(processFsplRef.value)
  const fEst = Number(processFsplTarget.value)
  if (!processFsplEnable.checked) {
    processFsplDelta.textContent = 'Scaling off — measured values as in CSV.'
    return
  }
  if (!Number.isFinite(fMeas) || !Number.isFinite(fEst) || fMeas <= 0 || fEst <= 0) {
    processFsplDelta.textContent = ''
    return
  }
  const d = fsplPathLossDeltaDb(fEst, fMeas)
  const ad = Math.abs(d)
  const neg = fsplPathLossNegativeConvention(processMergedPointsRaw)
  const negNote = neg ? ' CSV uses negative path loss — scaled so lower f → less loss (less negative).' : ''
  if (d < 0) {
    processFsplDelta.textContent = `At ${fEst} MHz, PL is ~${ad.toFixed(2)} dB lower than at ${fMeas} MHz (free space).${negNote}`
  } else if (d > 0) {
    processFsplDelta.textContent = `At ${fEst} MHz, PL is ~${ad.toFixed(2)} dB higher than at ${fMeas} MHz (free space).${negNote}`
  } else {
    processFsplDelta.textContent = 'Same frequency — no change.'
  }
}

function rebuildProcessMergedFromFspl(): void {
  if (processMergedPointsRaw.length === 0) {
    processMergedPoints = []
    updateProcessFsplDeltaLabel()
    return
  }
  const fMeas = Number(processFsplRef.value)
  const fEst = Number(processFsplTarget.value)
  const use =
    processFsplEnable.checked &&
    Number.isFinite(fMeas) &&
    Number.isFinite(fEst) &&
    fMeas > 0 &&
    fEst > 0
  const deltaRaw = use ? fsplPathLossDeltaDb(fEst, fMeas) : 0
  const negConv = fsplPathLossNegativeConvention(processMergedPointsRaw)
  const delta = negConv ? -deltaRaw : deltaRaw
  processMergedPoints = processMergedPointsRaw.map((p) => ({
    ...p,
    pathLoss: p.pathLoss + delta,
  }))
  updateProcessFsplDeltaLabel()
}

function updateProcessFsplChrome(): void {
  const has = processMergedPointsRaw.length > 0
  processFsplWrap.hidden = !has
  processFsplEnable.disabled = !has
  processFsplRef.disabled = !has
  processFsplTarget.disabled = !has
  if (!has) {
    processFsplDelta.textContent = ''
  }
}

function updateProcessFileSummary(): void {
  const label = (f: File | undefined) => f?.name ?? '—'
  processFilenamePlan.textContent = label(processFilePlan.files?.[0])
  processFilenameWalk.textContent = label(processFileWalk.files?.[0])
  processFilenamePl.textContent = label(processFilePl.files?.[0])
}

function clearProcessTrailState(): void {
  processWalkPreamble = ''
  processWalkTail = ''
  processTrailEditable = []
  processTrailOriginal = []
  processWalkTestDate = null
  processMergedPoints = []
  processMergedPointsRaw = []
  processTrailDragIndex = null
  processNudgeTrail.checked = false
  processNudgeSnap.value = 'off'
  updateProcessFsplChrome()
  processFsplDelta.textContent = ''
}

function processTrailPixelsDirty(): boolean {
  if (processTrailEditable.length !== processTrailOriginal.length) return true
  for (let i = 0; i < processTrailEditable.length; i++) {
    const a = processTrailEditable[i]!
    const b = processTrailOriginal[i]!
    if (a.x !== b.x || a.y !== b.y) return true
  }
  return false
}

function clampPixelToImage(x: number, y: number, iw: number, ih: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(iw - 1, x)),
    y: Math.max(0, Math.min(ih - 1, y)),
  }
}

function processTrailDotRadius(): number {
  const w = processCanvas.width / (window.devicePixelRatio || 1)
  const h = processCanvas.height / (window.devicePixelRatio || 1)
  return Math.max(3, Math.min(w, h) / 80)
}

function findTrailHitIndex(clientX: number, clientY: number, dotR: number): number | null {
  if (!processImg.naturalWidth || processTrailEditable.length === 0) return null
  const local = clientToElementLocal(clientX, clientY, processCanvas)
  if (!local) return null
  const lx = local.x
  const ly = local.y
  const hitSlop = dotR + 14
  let bestI: number | null = null
  let bestD = Infinity
  for (let i = 0; i < processTrailEditable.length; i++) {
    const pt = processTrailEditable[i]!
    const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
    if (!q) continue
    const d = Math.hypot(lx - q.x, ly - q.y)
    if (d <= hitSlop && d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI
}

function updateProcessTrailChrome(): void {
  const hasTrail = processTrailEditable.length > 0
  const hasMap = Boolean(processImg.naturalWidth)
  const hasPlotted = processMergedPoints.length > 0
  const canNudge = hasTrail && hasMap && !hasPlotted
  processNudgeTrail.disabled = !canNudge
  if (!canNudge) {
    processNudgeTrail.checked = false
    processTrailDragIndex = null
  }
  processResetTrail.disabled = !hasTrail || !processTrailPixelsDirty() || hasPlotted
  const saveDisabled = !hasTrail || !processTrailPixelsDirty()
  processSaveWalkEdited.disabled = saveDisabled
  processSaveWalkOriginal.disabled = saveDisabled
  processBtnClearPlot.disabled = !hasPlotted
  processNudgeSnap.disabled = !canNudge || processTrailEditable.length < 2
  if (!canNudge || processTrailEditable.length < 2) {
    processNudgeSnap.value = 'off'
  }
  const allowPointer = canNudge && processNudgeTrail.checked
  processCanvas.style.pointerEvents = allowPointer ? 'auto' : 'none'
  processCanvas.classList.toggle('process-overlay--adjust', allowPointer)
  if (allowPointer) {
    processCanvas.style.cursor = processTrailDragIndex !== null ? 'grabbing' : 'grab'
  } else {
    processCanvas.style.cursor = ''
  }
}

function onTrailPointerDown(e: PointerEvent): void {
  if (e.altKey && e.button === 0) return
  if (e.button !== 0 || !processNudgeTrail.checked || processMergedPoints.length > 0) return
  const i = findTrailHitIndex(e.clientX, e.clientY, processTrailDotRadius())
  if (i === null) return
  e.preventDefault()
  processMergedPoints = []
  processMergedPointsRaw = []
  updateProcessFsplChrome()
  processTrailDragIndex = i
  processCanvas.setPointerCapture(e.pointerId)
  updateProcessTrailChrome()
}

function snapAngleToStep(ang: number, snapDeg: number): number {
  const stepRad = (snapDeg * Math.PI) / 180
  return Math.round(ang / stepRad) * stepRad
}

/** Snap incoming segment only (last point, or single-neighbor cases handled elsewhere). */
function nudgeSnapFromPrevOnly(
  prev: { x: number; y: number },
  raw: { x: number; y: number },
  snapDeg: number
): { x: number; y: number } {
  const dx = raw.x - prev.x
  const dy = raw.y - prev.y
  const len = Math.hypot(dx, dy)
  if (len < 0.25) return raw
  const ang = snapAngleToStep(Math.atan2(dy, dx), snapDeg)
  return {
    x: prev.x + Math.cos(ang) * len,
    y: prev.y + Math.sin(ang) * len,
  }
}

/** Snap outgoing segment only (first point): curr→next direction snapped. */
function nudgeSnapToNextOnly(
  raw: { x: number; y: number },
  next: { x: number; y: number },
  snapDeg: number
): { x: number; y: number } {
  const dx = next.x - raw.x
  const dy = next.y - raw.y
  const len = Math.hypot(dx, dy)
  if (len < 0.25) return raw
  const ang = snapAngleToStep(Math.atan2(dy, dx), snapDeg)
  return {
    x: next.x - Math.cos(ang) * len,
    y: next.y - Math.sin(ang) * len,
  }
}

/**
 * Snap nudged point using previous and/or next anchors. Middle points: intersect
 * ray from prev (snapped incoming) with ray toward next (snapped outgoing).
 */
function applyNudgeAngleSnap(
  raw: { x: number; y: number },
  prev: { x: number; y: number } | null,
  next: { x: number; y: number } | null,
  snapDeg: number
): { x: number; y: number } {
  const unit = (a: number) => ({ x: Math.cos(a), y: Math.sin(a) })

  if (prev && next) {
    const dInX = raw.x - prev.x
    const dInY = raw.y - prev.y
    const lenIn = Math.hypot(dInX, dInY)
    const dOutX = next.x - raw.x
    const dOutY = next.y - raw.y
    const lenOut = Math.hypot(dOutX, dOutY)
    if (lenIn < 1e-6 && lenOut < 1e-6) return raw

    const aInS = snapAngleToStep(Math.atan2(dInY, dInX), snapDeg)
    const uIn = unit(aInS)
    const aOutS = snapAngleToStep(Math.atan2(dOutY, dOutX), snapDeg)
    const uOut = unit(aOutS)

    const cIn = {
      x: prev.x + uIn.x * lenIn,
      y: prev.y + uIn.y * lenIn,
    }
    const cOut = {
      x: next.x - uOut.x * lenOut,
      y: next.y - uOut.y * lenOut,
    }

    const bx = next.x - prev.x
    const by = next.y - prev.y
    const det = uIn.x * uOut.y - uIn.y * uOut.x
    if (Math.abs(det) < 1e-5) {
      return { x: (cIn.x + cOut.x) / 2, y: (cIn.y + cOut.y) / 2 }
    }

    const s = (bx * uOut.y - by * uOut.x) / det
    const t = (uIn.x * by - uIn.y * bx) / det
    let cx = prev.x + s * uIn.x
    let cy = prev.y + s * uIn.y
    if (s < -0.5 || t < -0.5) {
      cx = (cIn.x + cOut.x) / 2
      cy = (cIn.y + cOut.y) / 2
    }
    return { x: cx, y: cy }
  }

  if (prev && !next) {
    return nudgeSnapFromPrevOnly(prev, raw, snapDeg)
  }
  if (!prev && next) {
    return nudgeSnapToNextOnly(raw, next, snapDeg)
  }
  return raw
}

function onTrailPointerMove(e: PointerEvent): void {
  if (processTrailDragIndex === null || !processImg.naturalWidth) return
  const hit = clientToImagePixel(e.clientX, e.clientY, processImg)
  if (!hit.ok) return
  const iw = processImg.naturalWidth
  const ih = processImg.naturalHeight
  let c = clampPixelToImage(hit.pixel.x, hit.pixel.y, iw, ih)
  const idx = processTrailDragIndex
  const snapVal = processNudgeSnap.value
  if (snapVal !== 'off') {
    const deg = snapVal === '90' ? 90 : 45
    const prev = idx > 0 ? processTrailEditable[idx - 1]! : null
    const next =
      idx < processTrailEditable.length - 1 ? processTrailEditable[idx + 1]! : null
    const snapped = applyNudgeAngleSnap(c, prev, next, deg)
    c = clampPixelToImage(snapped.x, snapped.y, iw, ih)
  }
  const cur = processTrailEditable[idx]!
  processTrailEditable[idx] = { ...cur, x: c.x, y: c.y }
  processMergedPoints = []
  processMergedPointsRaw = []
  updateProcessFsplChrome()
  drawProcessOverlay()
  e.preventDefault()
}

function onTrailPointerUp(e: PointerEvent): void {
  if (processTrailDragIndex === null) return
  processTrailDragIndex = null
  try {
    processCanvas.releasePointerCapture(e.pointerId)
  } catch {
    /* already released */
  }
  drawProcessOverlay()
}

function downloadProcessWalkCsv(mode: 'edited' | 'original'): void {
  if (!processWalkPreamble || !processTrailEditable.length) return
  const text = serializeWalkplotterEditable(processWalkPreamble, processTrailEditable, processWalkTail)
  const f = processFileWalk.files?.[0]
  let filename: string
  if (mode === 'edited') {
    const stem = (f?.name.replace(/\.csv$/i, '') ?? 'walkplotter-trail').replace(/[/\\?%*:|"<>]/g, '-')
    filename = `${stem}-edited.csv`.replace(/\s+/g, ' ').slice(0, 200)
  } else {
    filename = (f?.name ?? 'walkplotter-trail.csv').replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').slice(0, 200)
  }
  if (!filename.toLowerCase().endsWith('.csv')) filename += '.csv'
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  processTrailOriginal = processTrailEditable.map((r) => ({ ...r }))
  const hint =
    mode === 'original'
      ? ' If you pick the same folder and filename in the save dialog, you can replace the existing file.'
      : ''
  processStatus.textContent = `Saved ${filename}.${hint} Plot path loss uses the trail currently in memory.`
  drawProcessOverlay()
}

function syncProcessOverlayCanvas(): void {
  const left = processImg.offsetLeft
  const top = processImg.offsetTop
  const w = Math.max(1, processImg.offsetWidth)
  const h = Math.max(1, processImg.offsetHeight)
  processCanvas.style.left = `${left}px`
  processCanvas.style.top = `${top}px`
  processCanvas.style.width = `${w}px`
  processCanvas.style.height = `${h}px`
  const dpr = window.devicePixelRatio || 1
  processCanvas.width = Math.round(w * dpr)
  processCanvas.height = Math.round(h * dpr)
  const ctx = processCanvas.getContext('2d')
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}

function drawProcessOverlay(): void {
  const ctx = processCanvas.getContext('2d')
  if (!ctx || !processImg.naturalWidth) {
    if (processLegend) processLegend.hidden = true
    processHistogramWrap.hidden = true
    updateProcessTrailChrome()
    return
  }
  syncProcessOverlayCanvas()
  const w = processCanvas.width / (window.devicePixelRatio || 1)
  const h = processCanvas.height / (window.devicePixelRatio || 1)
  ctx.clearRect(0, 0, w, h)

  const hasPlotted = processMergedPoints.length > 0
  const hasTrail = processTrailEditable.length > 0
  const dotR = Math.max(3, Math.min(w, h) / 80)

  if (hasPlotted) {
    let minPl = processMergedPoints[0]!.pathLoss
    let maxPl = minPl
    for (const p of processMergedPoints) {
      if (p.pathLoss < minPl) minPl = p.pathLoss
      if (p.pathLoss > maxPl) maxPl = p.pathLoss
    }
    const routeColors = getOverlayColors()
    const routePs = Math.min(1.2, Math.max(0.8, dotR / 5))
    const trailDiameter = 2 * dotR
    if (processShowPlColoredTrail.checked && processMergedPoints.length > 1) {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.globalAlpha = 1
      for (let i = 0; i < processMergedPoints.length - 1; i++) {
        const a = processMergedPoints[i]!
        const b = processMergedPoints[i + 1]!
        const q0 = imagePixelToElementLocal(a.x, a.y, processImg)
        const q1 = imagePixelToElementLocal(b.x, b.y, processImg)
        if (!q0 || !q1) continue
        const g = ctx.createLinearGradient(q0.x, q0.y, q1.x, q1.y)
        g.addColorStop(0, pathLossToColor(a.pathLoss))
        g.addColorStop(1, pathLossToColor(b.pathLoss))
        ctx.strokeStyle = g
        ctx.lineWidth = trailDiameter
        ctx.beginPath()
        ctx.moveTo(q0.x, q0.y)
        ctx.lineTo(q1.x, q1.y)
        ctx.stroke()
      }
    }
    if (processShowPlRoute.checked && processMergedPoints.length > 1) {
      ctx.strokeStyle = routeColors.trailLine
      ctx.globalAlpha = 0.5
      ctx.lineWidth = Math.max(1.25, 2 * routePs)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      let first = true
      for (const pt of processMergedPoints) {
        const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
        if (!q) continue
        if (first) {
          ctx.moveTo(q.x, q.y)
          first = false
        } else {
          ctx.lineTo(q.x, q.y)
        }
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    const trailOnlyRibbon =
      processShowPlColoredTrail.checked && processMergedPoints.length > 1
    if (!trailOnlyRibbon) {
      for (const pt of processMergedPoints) {
        const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
        if (!q) continue
        const isOriginalWalk = pt.source !== 'interpolated'
        ctx.fillStyle = pathLossToColor(pt.pathLoss)
        ctx.beginPath()
        ctx.arc(q.x, q.y, dotR, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.45)'
        ctx.lineWidth = 1
        ctx.stroke()
        if (isOriginalWalk) {
          ctx.strokeStyle = 'rgba(168, 174, 184, 0.95)'
          ctx.lineWidth = Math.max(1.5, 2 * routePs)
          ctx.beginPath()
          ctx.arc(q.x, q.y, dotR + 2.5, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }
    if (processShowPlLabels.checked) {
      const fontPx = Math.max(11, Math.min(16, Math.min(w, h) / 48))
      ctx.font = `600 ${fontPx}px system-ui, Segoe UI, sans-serif`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      const labelDx = trailOnlyRibbon ? trailDiameter / 2 + 5 : dotR + 4
      for (const pt of processMergedPoints) {
        const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
        if (!q) continue
        const text = `${pt.pathLoss.toFixed(1)} dB`
        const lx = q.x + labelDx
        const ly = q.y
        ctx.lineWidth = Math.max(2, fontPx * 0.22)
        ctx.strokeStyle = 'rgba(0,0,0,0.82)'
        ctx.strokeText(text, lx, ly)
        ctx.fillStyle = 'rgba(255,255,255,0.96)'
        ctx.fillText(text, lx, ly)
      }
    }
    const nInterp = processMergedPoints.filter((p) => p.source === 'interpolated').length
    const nUser = processMergedPoints.length - nInterp
    const walkTypesLegend =
      nUser > 0 || nInterp > 0
        ? `<span>Walk: <strong>${nUser}</strong> original <span class="process-legend-user-ring" title="Original (non-interpolated) points — grey ring; fill is still path loss (dB)."></span> · <strong>${nInterp}</strong> interpolated (no ring)</span>`
        : ''
    processLegend.hidden = false
    const fsplLegend =
      processMergedPointsRaw.length > 0 && processFsplEnable.checked
        ? `<span>FSPL: estimated at <strong>${processFsplTarget.value}</strong> MHz (walk at <strong>${processFsplRef.value}</strong> MHz, free space)</span>`
        : ''
    processLegend.innerHTML = `<div class="process-legend-inner">
    <span>Color scale <strong>−30</strong> … <strong>−100</strong> dB (outside range is clamped)</span>
    <span class="process-legend-gradient" style="background:${pathLossScaleGradientCss()}"></span>
    ${walkTypesLegend}
    ${fsplLegend}
    <span>${processMergedPoints.length} pts · data <strong>${minPl.toFixed(1)}</strong>–<strong>${maxPl.toFixed(1)}</strong> dB</span>
  </div>`
    updateProcessHistogramTable()
    updateProcessTrailChrome()
    return
  }

  if (hasTrail) {
    const colors = getOverlayColors()
    const trailPs = Math.min(1.25, Math.max(0.85, dotR / 5.5))
    const nudgeOn = processNudgeTrail.checked && processMergedPoints.length === 0

    if (processTrailEditable.length > 0) {
      ctx.strokeStyle = colors.trailLine
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(1, 2 * trailPs)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let i = 0; i < processTrailEditable.length; i++) {
        const pt = processTrailEditable[i]!
        const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
        if (!q) continue
        if (i === 0 || pt.newSegment === '1') {
          ctx.moveTo(q.x, q.y)
        } else {
          ctx.lineTo(q.x, q.y)
        }
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    let crossLocal: { x: number; y: number } | null = null
    let crossIdx: number | null = null
    if (nudgeOn && processTrailEditable.length > 0) {
      const idx =
        processTrailDragIndex !== null
          ? processTrailDragIndex
          : processTrailEditable.length - 1
      const cpt = processTrailEditable[idx]!
      crossLocal = imagePixelToElementLocal(cpt.x, cpt.y, processImg)
      crossIdx = idx
    }

    if (crossLocal) {
      ctx.save()
      ctx.strokeStyle = colors.crosshair
      ctx.lineWidth = Math.max(0.5, 1 * trailPs)
      ctx.setLineDash([7, 5])
      ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.moveTo(0, crossLocal.y)
      ctx.lineTo(w, crossLocal.y)
      ctx.moveTo(crossLocal.x, 0)
      ctx.lineTo(crossLocal.x, h)
      ctx.stroke()
      ctx.restore()
    }

    for (let i = 0; i < processTrailEditable.length; i++) {
      const pt = processTrailEditable[i]!
      const q = imagePixelToElementLocal(pt.x, pt.y, processImg)
      if (!q) continue
      const showRing = nudgeOn && crossIdx !== null && i === crossIdx
      if (showRing) {
        ctx.strokeStyle = colors.crosshairRing
        ctx.lineWidth = Math.max(1, 2 * trailPs)
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(q.x, q.y, Math.max(3, 11 * trailPs), 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(46, 230, 166, 0.92)'
      ctx.beginPath()
      ctx.arc(q.x, q.y, dotR, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.stroke()
      if (pt.source !== 'interpolated') {
        ctx.strokeStyle = 'rgba(168, 174, 184, 0.95)'
        ctx.lineWidth = Math.max(1.5, 2 * trailPs)
        ctx.beginPath()
        ctx.arc(q.x, q.y, dotR + 2.5, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    const nInterpTrail = processTrailEditable.filter((p) => p.source === 'interpolated').length
    const nUserTrail = processTrailEditable.length - nInterpTrail
    processLegend.hidden = false
    processLegend.innerHTML = `<div class="process-legend-inner process-legend-inner--trail-preview">
    <span>Trail preview — <strong>${nUserTrail}</strong> original <span class="process-legend-user-ring" title="Original (non-interpolated) points — grey ring."></span> · <strong>${nInterpTrail}</strong> interpolated (no ring)</span>
  </div>`
    processHistogramWrap.hidden = true
    processHistogramBody.innerHTML = ''
    updateProcessTrailChrome()
    return
  }

  processLegend.hidden = true
  processHistogramWrap.hidden = true
  processHistogramBody.innerHTML = ''
  updateProcessTrailChrome()
}

function readFileAsText(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error)
    r.readAsText(f)
  })
}

function runProcessPlot(): void {
  const walkFile = processFileWalk.files?.[0]
  const plFile = processFilePl.files?.[0]
  if (!processImg.naturalWidth) {
    processStatus.textContent = 'Load a floor plan image first.'
    return
  }
  if (!processTrailEditable.length) {
    processStatus.textContent = 'Load a Walkplotter CSV with trail rows first.'
    return
  }
  if (!plFile) {
    processStatus.textContent = 'Choose a path loss CSV.'
    return
  }
  void (async () => {
    try {
      const plText = await readFileAsText(plFile)
      let testDate = processWalkTestDate
      if (!testDate && walkFile) {
        const walkText = await readFileAsText(walkFile)
        testDate = extractWalkplotterTestDate(walkText)
      }
      if (!testDate) {
        processStatus.textContent =
          'Walkplotter CSV has no # test_date_local: YYYY-MM-DD header — cannot align times.'
        processMergedPoints = []
        processMergedPointsRaw = []
        updateProcessFsplChrome()
        drawProcessOverlay()
        return
      }
      const plRows = parsePathLossCsv(plText)
      if (!plRows.length) {
        processStatus.textContent =
          'No path loss rows found (expect HH:MM:SS first field, 4th field = number).'
        processMergedPoints = []
        processMergedPointsRaw = []
        updateProcessFsplChrome()
        drawProcessOverlay()
        return
      }
      const trailForMerge: WalkplotterTrailRow[] = processTrailEditable
      const merged = mergeByNearestTime(testDate, trailForMerge, plRows, DEFAULT_MAX_MATCH_MS)
      if (!merged.length) {
        processMergedPoints = []
        processMergedPointsRaw = []
        updateProcessFsplChrome()
        processStatus.textContent = `No points matched within ${DEFAULT_MAX_MATCH_MS / 1000}s — check times and date (${testDate}).`
        drawProcessOverlay()
        return
      }
      processMergedPointsRaw = merged.map((p) => ({ ...p }))
      rebuildProcessMergedFromFspl()
      updateProcessFsplChrome()
      processStatus.textContent = `Matched ${processMergedPoints.length} of ${processTrailEditable.length} trail samples to nearest RF reading (date ${testDate}).`
      drawProcessOverlay()
    } catch (e) {
      processStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`
      processMergedPoints = []
      processMergedPointsRaw = []
      updateProcessFsplChrome()
      drawProcessOverlay()
    }
  })()
}

function pointerDist(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number }
): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/** Display ms as seconds in the text field (default scale: 1 not 1.000). */
function formatSecondsInputFromMs(ms: number): string {
  const s = ms / 1000
  if (Number.isInteger(s)) return String(s)
  return String(s)
}

function syncInterpControl(): void {
  interpStep.value = formatSecondsInputFromMs(trail.getInterpolationStepMs())
}

function commitInterpStepFromInput(): void {
  const raw = interpStep.value.trim().replace(/,/g, '.')
  const sec = Number(raw)
  if (!Number.isFinite(sec) || sec <= 0) {
    syncInterpControl()
    return
  }
  trail.setInterpolationStepMs(Math.round(sec * 1000))
  syncInterpControl()
}

function setTab(which: 'map' | 'controls' | 'process'): void {
  const mapActive = which === 'map'
  const controlsActive = which === 'controls'
  const processActive = which === 'process'
  tabMap.setAttribute('aria-selected', String(mapActive))
  tabControls.setAttribute('aria-selected', String(controlsActive))
  tabProcess.setAttribute('aria-selected', String(processActive))
  tabMap.tabIndex = mapActive ? 0 : -1
  tabControls.tabIndex = controlsActive ? 0 : -1
  tabProcess.tabIndex = processActive ? 0 : -1
  panelMap.hidden = !mapActive
  panelControls.hidden = !controlsActive
  panelProcess.hidden = !processActive
  redraw()
  if (processActive) {
    applyProcessViewTransform()
    syncProcessOverlayCanvas()
    drawProcessOverlay()
  }
}

function updateChrome(): void {
  const hasMap = Boolean(img.naturalWidth)
  const hasPoints = trail.points.length > 0
  const hasPoi = poiMarkers.length > 0
  placeholder.hidden = hasMap
  mapQuickBar.hidden = !hasMap
  mapZoomBar.hidden = !hasMap
  pinSizeBar.hidden = !hasMap
  stage.classList.toggle('has-image', hasMap)
  const dimForTrailPause = hasMap && !recording && placementMode === 'trail'
  stage.classList.toggle('recording-off', dimForTrailPause)
  canvas.classList.toggle('recording-off', dimForTrailPause)

  modeTrail.disabled = !hasMap
  modePoi.disabled = !hasMap
  modeTrail.classList.toggle('active', placementMode === 'trail')
  modePoi.classList.toggle('active', placementMode === 'poi')

  btnPause.disabled = !hasMap || !recording || placementMode === 'poi'
  const hasExportableData = hasPoints || hasPoi
  btnStop.disabled = !hasMap || (!recording && !hasExportableData)
  const showResume = hasMap && !recording
  btnResume.hidden = !showResume
  btnResume.disabled = !showResume

  btnDownload.disabled = !hasPoints && !hasPoi
  btnDownloadPoiCsv.disabled = !hasPoi
  btnUndo.disabled = !hasPoints
  btnClear.disabled = !hasPoints
  btnUndoPoi.disabled = !hasPoi
  btnClearPoi.disabled = !hasPoi
  crosshairsToggle.disabled = !hasMap
  interpStep.disabled = !hasMap
  pinSizeRange.disabled = !hasMap
  colorTrail.disabled = !hasMap
  colorPin.disabled = !hasMap

  if (!hasMap) {
    hintMain.textContent =
      'Load a floor plan. Trail mode records walk pins with timestamps; POI mode adds red labeled points of interest (not on the trail).'
    hintMap.textContent = 'Open the Controls tab to load a floor plan.'
  } else if (placementMode === 'poi') {
    hintMain.textContent =
      'POI mode: tap to place a red marker, then enter a label. POI markers are not on the trail and have no timestamps. Switch to Trail to walk.'
    hintMap.textContent =
      'POI — tap to place · pinch zoom · drag to pan · Controls for mode & export'
  } else if (recording) {
    hintMain.textContent =
      'Trail mode: tap to drop pins. Pinch to zoom, drag to pan; zoom buttons are under Controls. Crosshairs on the last pin help align the next tap. Pause before walking elsewhere, then Resume.'
    hintMap.textContent =
      'Trail — tap to pin · pinch zoom · drag to pan · Controls for pause, save, CSV'
  } else {
    hintMain.textContent =
      'Recording paused — Resume to continue the trail, switch to POI to add markers, or Stop & save… to export (POI-only is OK).'
    hintMap.textContent = 'Trail paused — Resume, change mode, or Stop & save…'
  }
}

function openSaveDialog(): void {
  const hasPoints = trail.points.length > 0
  const hasPoi = poiMarkers.length > 0
  const poiOnly = !hasPoints && hasPoi

  if (hasPoints && hasPoi) {
    saveDialogDesc.textContent =
      'Choose a trail CSV file name. Trail points and POI markers are included in that file. You can also save a separate POI-only CSV below.'
  } else if (hasPoints) {
    saveDialogDesc.textContent = 'Choose a file name for the trail CSV export.'
  } else {
    saveDialogDesc.textContent =
      'There is no walked trail. Choose a file name for the POI CSV (label + x,y pixels). You can also save a map snapshot as JPG.'
  }

  saveTrailCsvWrap.hidden = !hasPoints

  if (hasPoints && hasPoi) {
    saveIncludeJpgText.textContent =
      'Also save a map snapshot (floor plan + trail + POI markers) as JPG'
  } else if (hasPoints) {
    saveIncludeJpgText.textContent = 'Also save a map snapshot (floor plan + trail) as JPG'
  } else {
    saveIncludeJpgText.textContent = 'Also save a map snapshot (floor plan + POI markers) as JPG'
  }

  saveFilenameInput.value = downloadFilename()
  saveIncludeJpg.checked = false
  saveJpgFilename.value = ''
  saveJpgFilename.placeholder = poiOnly
    ? 'Matches POI CSV name if left blank'
    : 'Matches CSV name if left blank'
  jpgFilenameWrap.hidden = true

  if (poiOnly) {
    savePoiExtraWrap.hidden = false
    savePoiCsvCheckText.textContent =
      'Save POI markers as CSV (label + x,y pixels, no timestamps)'
    savePoiCsv.checked = false
    savePoiCsv.disabled = false
    savePoiFilename.value = ''
    poiCsvFilenameWrap.hidden = true
    poiCsvFilenameLabel.textContent = 'POI CSV file name'
  } else {
    savePoiExtraWrap.hidden = false
    savePoiCsvCheckText.textContent =
      'Also save POI markers only in a separate CSV (label + x,y pixels, no timestamps)'
    savePoiCsv.checked = false
    savePoiCsv.disabled = !hasPoi
    savePoiFilename.value = ''
    poiCsvFilenameWrap.hidden = !savePoiCsv.checked
    poiCsvFilenameLabel.textContent = 'Separate POI CSV file name'
  }

  saveDialog.showModal()
  queueMicrotask(() => {
    if (poiOnly) {
      savePoiCsv.focus()
    } else {
      saveFilenameInput.focus()
      saveFilenameInput.select()
    }
  })
}

function commitNamedSave(): void {
  const hasPoints = trail.points.length > 0
  const hasPoi = poiMarkers.length > 0

  let stemForJpg: string

  if (hasPoints) {
    const csvName = safeCsvFilename(saveFilenameInput.value)
    downloadCsvAs(csvName)
    stemForJpg = csvName.replace(/\.csv$/i, '')
    if (savePoiCsv.checked && hasPoi) {
      const repName = safePoiCsvFilename(savePoiFilename.value, stemForJpg)
      downloadPoiCsvAs(repName)
    }
  } else if (hasPoi) {
    const fallbackStem = downloadFilename().replace(/\.csv$/i, '')
    if (savePoiCsv.checked) {
      const poiName = safePoiCsvFilename(savePoiFilename.value, fallbackStem)
      downloadPoiCsvAs(poiName)
      stemForJpg = poiName.replace(/\.csv$/i, '')
    } else {
      stemForJpg = fallbackStem
    }
    if (!savePoiCsv.checked && !saveIncludeJpg.checked) {
      alert('Turn on Save POI markers as CSV and/or map snapshot JPG, or press Cancel.')
      return
    }
  } else {
    saveDialog.close()
    updateChrome()
    return
  }

  if (saveIncludeJpg.checked) {
    const jpgName = safeJpgFilename(saveJpgFilename.value, stemForJpg)
    exportMapSnapshotJpeg(jpgName)
  }

  saveDialog.close()
  updateChrome()
}

function openPoiDialog(): void {
  poiLabelInput.value = ''
  poiDialog.showModal()
  queueMicrotask(() => {
    poiLabelInput.focus()
  })
}

img.addEventListener('load', () => {
  if (imageMeta) {
    imageMeta = {
      ...imageMeta,
      widthPx: img.naturalWidth,
      heightPx: img.naturalHeight,
    }
  }
  recording = true
  syncColorPickersFromCss()
  updateChrome()
  redraw()
})

window.addEventListener('resize', () => {
  redraw()
  syncProcessOverlayCanvas()
  drawProcessOverlay()
})

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0] ?? null
  setImageFromFile(f)
  fileInput.value = ''
  updateChrome()
})

;['dragenter', 'dragover'].forEach((ev) => {
  stage.addEventListener(ev, (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
})

stage.addEventListener('drop', (e) => {
  e.preventDefault()
  const f = e.dataTransfer?.files?.[0]
  if (f) setImageFromFile(f)
  updateChrome()
})

tabMap.addEventListener('click', () => setTab('map'))
tabControls.addEventListener('click', () => setTab('controls'))
tabProcess.addEventListener('click', () => setTab('process'))

processFilePlan.addEventListener('change', () => {
  const f = processFilePlan.files?.[0]
  if (processPlanObjectUrl) {
    URL.revokeObjectURL(processPlanObjectUrl)
    processPlanObjectUrl = null
  }
  clearProcessTrailState()
  processFileWalk.value = ''
  processFilePl.value = ''
  if (!f || !f.type.startsWith('image/')) {
    processImg.removeAttribute('src')
    processPlaceholder.hidden = false
    processStage.classList.remove('has-image')
    processZoomBar.hidden = true
    processMouseHint.hidden = true
    resetProcessView()
    processStatus.textContent = 'Load floor plan and Walkplotter CSV to begin.'
    drawProcessOverlay()
    updateProcessFileSummary()
    return
  }
  processPlanObjectUrl = URL.createObjectURL(f)
  processImg.src = processPlanObjectUrl
  updateProcessFileSummary()
})

processFileWalk.addEventListener('change', () => {
  void (async () => {
    updateProcessFileSummary()
    processMergedPoints = []
    processMergedPointsRaw = []
    updateProcessFsplChrome()
    processTrailDragIndex = null
    processNudgeTrail.checked = false
    const f = processFileWalk.files?.[0]
    if (!f) {
      processWalkPreamble = ''
      processWalkTail = ''
      processTrailEditable = []
      processTrailOriginal = []
      processWalkTestDate = null
      processStatus.textContent = 'Load floor plan and Walkplotter CSV to begin.'
      drawProcessOverlay()
      return
    }
    try {
      const text = await readFileAsText(f)
      const parsed = parseWalkplotterEditable(text)
      if (!parsed || !parsed.trail.length) {
        processWalkPreamble = ''
        processWalkTail = ''
        processTrailEditable = []
        processTrailOriginal = []
        processWalkTestDate = null
        processStatus.textContent =
          'Could not parse trail rows (need a header line starting with timestamp,x,y,…).'
        drawProcessOverlay()
        return
      }
      processWalkPreamble = parsed.preamble
      processWalkTail = parsed.tail
      processTrailEditable = parsed.trail.map((r) => ({ ...r }))
      processTrailOriginal = parsed.trail.map((r) => ({ ...r }))
      processWalkTestDate = extractWalkplotterTestDate(text)
      processMergedPoints = []
      if (!processWalkTestDate) {
        processStatus.textContent = `Loaded ${processTrailEditable.length} trail points. Add # test_date_local: YYYY-MM-DD for Plot path loss.`
      } else {
        processStatus.textContent = `Loaded ${processTrailEditable.length} trail points. Nudge and save if needed, then choose path loss CSV and Plot path loss.`
      }
      drawProcessOverlay()
    } catch (e) {
      processStatus.textContent = `Error reading CSV: ${e instanceof Error ? e.message : String(e)}`
      clearProcessTrailState()
      drawProcessOverlay()
    }
  })()
})

processFilePl.addEventListener('change', updateProcessFileSummary)

processImg.addEventListener('load', () => {
  processPlaceholder.hidden = true
  processStage.classList.add('has-image')
  processZoomBar.hidden = false
  processMouseHint.hidden = false
  resetProcessView()
  syncProcessOverlayCanvas()
  drawProcessOverlay()
})

processBtnPlot.addEventListener('click', () => runProcessPlot())
processBtnClearPlot.addEventListener('click', () => {
  processMergedPoints = []
  processMergedPointsRaw = []
  updateProcessFsplChrome()
  processFsplDelta.textContent = ''
  drawProcessOverlay()
})
processFsplEnable.addEventListener('change', () => {
  rebuildProcessMergedFromFspl()
  drawProcessOverlay()
})
processFsplRef.addEventListener('change', () => {
  rebuildProcessMergedFromFspl()
  drawProcessOverlay()
})
processFsplTarget.addEventListener('change', () => {
  rebuildProcessMergedFromFspl()
  drawProcessOverlay()
})
processShowPlLabels.addEventListener('change', () => drawProcessOverlay())
processShowPlRoute.addEventListener('change', () => drawProcessOverlay())
processShowPlColoredTrail.addEventListener('change', () => drawProcessOverlay())
processNudgeTrail.addEventListener('change', () => {
  processTrailDragIndex = null
  drawProcessOverlay()
})
processNudgeSnap.addEventListener('change', () => drawProcessOverlay())
processResetTrail.addEventListener('click', () => {
  processTrailEditable = processTrailOriginal.map((r) => ({ ...r }))
  processMergedPoints = []
  processMergedPointsRaw = []
  updateProcessFsplChrome()
  processFsplDelta.textContent = ''
  drawProcessOverlay()
})
processSaveWalkEdited.addEventListener('click', () => downloadProcessWalkCsv('edited'))
processSaveWalkOriginal.addEventListener('click', () => downloadProcessWalkCsv('original'))
processCanvas.addEventListener('pointerdown', onTrailPointerDown)
processCanvas.addEventListener('pointermove', onTrailPointerMove)
processCanvas.addEventListener('pointerup', onTrailPointerUp)
processCanvas.addEventListener('pointercancel', onTrailPointerUp)
updateProcessFileSummary()

function commitTapIfPending(e: PointerEvent, wasTapPending: boolean): void {
  if (!wasTapPending || tapCommitLocked || hadMultiTouch || !img.naturalWidth) return
  const moved = Math.hypot(e.clientX - tapStartX, e.clientY - tapStartY)
  if (moved > tapSlopPx) return
  if (placementMode === 'trail' && !recording) return
  tapCommitLocked = true
  if (placementMode === 'poi') {
    onPointerTapPoi(e.clientX, e.clientY)
  } else {
    onPointerTapTrail(e.clientX, e.clientY)
  }
  updateChrome()
}

stage.addEventListener('pointerdown', (e) => {
  if (!img.naturalWidth) return
  // Reduce browser gesture stealing (scroll, delayed synthetic clicks) on touch devices.
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    e.preventDefault()
  }
  pointerPositions.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
  if (pointerPositions.size >= 2) {
    hadMultiTouch = true
    const pts = [...pointerPositions.values()]
    const p0 = pts[0]!
    const p1 = pts[1]!
    pinchStartDist = pointerDist(p0, p1)
    pinchStartZoom = mapZoom
    gestureKind = 'pinch'
    return
  }
  gestureKind = 'tap-pending'
  tapCommitLocked = false
  tapSlopPx = e.pointerType === 'touch' ? TAP_MAX_MOVE_TOUCH_PX : TAP_MAX_MOVE_MOUSE_PX
  tapStartX = e.clientX
  tapStartY = e.clientY
  tapPointerId = e.pointerId
  try {
    stage.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
})

stage.addEventListener('pointermove', (e) => {
  if (!pointerPositions.has(e.pointerId)) return
  pointerPositions.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })

  if (gestureKind === 'pinch' && pointerPositions.size >= 2) {
    const pts = [...pointerPositions.values()]
    const p0 = pts[0]!
    const p1 = pts[1]!
    const d = pointerDist(p0, p1)
    if (pinchStartDist > 1e-6) {
      const zOld = mapZoom
      const zNew = clampMapZoom(pinchStartZoom * (d / pinchStartDist))
      const rect = stage.getBoundingClientRect()
      const mx = (p0.clientX + p1.clientX) / 2 - rect.left
      const my = (p0.clientY + p1.clientY) / 2 - rect.top
      zoomAroundStagePoint(zNew, mx, my, zOld)
      applyViewTransform()
      updateZoomPctLabel()
      redraw()
    }
    return
  }

  if (gestureKind === 'tap-pending' && e.pointerId === tapPointerId) {
    const moved = Math.hypot(e.clientX - tapStartX, e.clientY - tapStartY)
    if (moved > tapSlopPx) {
      gestureKind = 'pan'
      panStartClientX = e.clientX
      panStartClientY = e.clientY
      panStartMapX = mapPanX
      panStartMapY = mapPanY
    }
  }

  if (gestureKind === 'pan' && e.pointerId === tapPointerId && pointerPositions.size === 1) {
    mapPanX = panStartMapX + (e.clientX - panStartClientX)
    mapPanY = panStartMapY + (e.clientY - panStartClientY)
    applyViewTransform()
    redraw()
  }
})

stage.addEventListener('pointerup', (e) => {
  const wasTapPending = gestureKind === 'tap-pending' && e.pointerId === tapPointerId
  pointerPositions.delete(e.pointerId)
  commitTapIfPending(e, wasTapPending)

  if (pointerPositions.size === 0) {
    gestureKind = 'idle'
    hadMultiTouch = false
  } else if (pointerPositions.size === 1 && gestureKind === 'pinch') {
    gestureKind = 'idle'
  }
})

stage.addEventListener('pointercancel', (e) => {
  const wasTapPending = gestureKind === 'tap-pending' && e.pointerId === tapPointerId
  pointerPositions.delete(e.pointerId)
  // Touch browsers often fire cancel instead of up when the OS briefly takes the stream.
  commitTapIfPending(e, wasTapPending)

  if (pointerPositions.size === 0) {
    gestureKind = 'idle'
    hadMultiTouch = false
  }
})

stage.addEventListener(
  'wheel',
  (e) => {
    if (!img.naturalWidth) return
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.08 : 0.92
    const rect = stage.getBoundingClientRect()
    const fx = e.clientX - rect.left
    const fy = e.clientY - rect.top
    const zOld = mapZoom
    const zNew = clampMapZoom(mapZoom * factor)
    zoomAroundStagePoint(zNew, fx, fy, zOld)
    applyViewTransform()
    updateZoomPctLabel()
    redraw()
  },
  { passive: false }
)

btnZoomIn.addEventListener('click', () => {
  if (!img.naturalWidth) return
  applyZoomFactor(ZOOM_BTN_FACTOR)
})

btnZoomOut.addEventListener('click', () => {
  if (!img.naturalWidth) return
  applyZoomFactor(1 / ZOOM_BTN_FACTOR)
})

btnZoomReset.addEventListener('click', () => {
  if (!img.naturalWidth) return
  resetMapView()
  redraw()
})

function onProcessStagePointerDown(e: PointerEvent): void {
  if (!processImg.naturalWidth) return
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    e.preventDefault()
  }
  if (e.pointerType === 'mouse' && e.button === 1) {
    e.preventDefault()
  }
  processPointerPositions.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
  if (processPointerPositions.size >= 2) {
    const pts = [...processPointerPositions.values()]
    const p0 = pts[0]!
    const p1 = pts[1]!
    processPinchStartDist = pointerDist(p0, p1)
    processPinchStartZoom = processZoom
    processGestureKind = 'pinch'
    return
  }
  if (processSingleFingerPanBlocked(e)) return
  processPanSlopPx = e.pointerType === 'touch' ? TAP_MAX_MOVE_TOUCH_PX : TAP_MAX_MOVE_MOUSE_PX
  processPanStartClientX = e.clientX
  processPanStartClientY = e.clientY
  processPanPointerId = e.pointerId
  try {
    processStage.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  if (processMouseViewPanAllowed(e)) {
    processGestureKind = 'pan'
    processPanStartPanX = processPanX
    processPanStartPanY = processPanY
  } else {
    processGestureKind = 'pan-pending'
  }
}

/** Capture so a second finger still registers for pinch while the overlay is receiving the first (nudge). */
processStage.addEventListener('pointerdown', onProcessStagePointerDown, { capture: true })

processStage.addEventListener('pointermove', (e) => {
  if (!processPointerPositions.has(e.pointerId)) return
  processPointerPositions.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })

  if (processGestureKind === 'pinch' && processPointerPositions.size >= 2) {
    const pts = [...processPointerPositions.values()]
    const p0 = pts[0]!
    const p1 = pts[1]!
    const d = pointerDist(p0, p1)
    if (processPinchStartDist > 1e-6) {
      const zOld = processZoom
      const zNew = clampMapZoom(processPinchStartZoom * (d / processPinchStartDist))
      const rect = processStage.getBoundingClientRect()
      const mx = (p0.clientX + p1.clientX) / 2 - rect.left
      const my = (p0.clientY + p1.clientY) / 2 - rect.top
      zoomAroundProcessPoint(zNew, mx, my, zOld)
      applyProcessViewTransform()
      updateProcessZoomPctLabel()
      drawProcessOverlay()
    }
    return
  }

  if (processGestureKind === 'pan-pending' && e.pointerId === processPanPointerId) {
    const moved = Math.hypot(e.clientX - processPanStartClientX, e.clientY - processPanStartClientY)
    if (moved > processPanSlopPx) {
      processGestureKind = 'pan'
      processPanStartClientX = e.clientX
      processPanStartClientY = e.clientY
      processPanStartPanX = processPanX
      processPanStartPanY = processPanY
    }
  }

  if (
    processGestureKind === 'pan' &&
    e.pointerId === processPanPointerId &&
    processPointerPositions.size === 1
  ) {
    processPanX = processPanStartPanX + (e.clientX - processPanStartClientX)
    processPanY = processPanStartPanY + (e.clientY - processPanStartClientY)
    applyProcessViewTransform()
    drawProcessOverlay()
  }
})

processStage.addEventListener('pointerup', (e) => {
  processPointerPositions.delete(e.pointerId)
  if (processPointerPositions.size === 0) {
    processGestureKind = 'idle'
  } else if (processPointerPositions.size === 1 && processGestureKind === 'pinch') {
    processGestureKind = 'idle'
  }
})

processStage.addEventListener('pointercancel', (e) => {
  processPointerPositions.delete(e.pointerId)
  if (processPointerPositions.size === 0) {
    processGestureKind = 'idle'
  }
})

processStage.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault()
})

function onProcessWheel(e: WheelEvent): void {
  if (!processImg.naturalWidth) return
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.08 : 0.92
  const rect = processStage.getBoundingClientRect()
  const fx = e.clientX - rect.left
  const fy = e.clientY - rect.top
  const zOld = processZoom
  const zNew = clampMapZoom(processZoom * factor)
  zoomAroundProcessPoint(zNew, fx, fy, zOld)
  applyProcessViewTransform()
  updateProcessZoomPctLabel()
  drawProcessOverlay()
}

processStage.addEventListener('wheel', onProcessWheel, { passive: false })
processCanvas.addEventListener(
  'wheel',
  (e) => {
    onProcessWheel(e)
    e.stopPropagation()
  },
  { passive: false }
)

processBtnZoomIn.addEventListener('click', () => {
  if (!processImg.naturalWidth) return
  applyProcessZoomFactor(ZOOM_BTN_FACTOR)
})

processBtnZoomOut.addEventListener('click', () => {
  if (!processImg.naturalWidth) return
  applyProcessZoomFactor(1 / ZOOM_BTN_FACTOR)
})

processBtnZoomReset.addEventListener('click', () => {
  if (!processImg.naturalWidth) return
  resetProcessView()
  drawProcessOverlay()
})

pinSizeRange.addEventListener('input', () => {
  pinDotScale = clampPinDotScale(Number(pinSizeRange.value) / 100)
  updatePinSizeLabel()
  redraw()
})

colorTrail.addEventListener('input', () => {
  applyTrailColorFromPicker()
  redraw()
})

colorPin.addEventListener('input', () => {
  applyPinColorFromPicker()
  redraw()
})

btnPause.addEventListener('click', () => {
  if (!img.naturalWidth || !recording) return
  recording = false
  trail.breakSegment()
  redraw()
  updateChrome()
})

btnStop.addEventListener('click', () => {
  if (!img.naturalWidth) return
  const hasExportableData = trail.points.length > 0 || poiMarkers.length > 0
  if (!recording && !hasExportableData) return
  recording = false
  updateChrome()
  if (hasExportableData) openSaveDialog()
})

btnResume.addEventListener('click', () => {
  if (!img.naturalWidth) return
  recording = true
  updateChrome()
})

saveForm.addEventListener('submit', (e) => {
  e.preventDefault()
  commitNamedSave()
})

saveCancel.addEventListener('click', () => {
  saveDialog.close()
})

saveIncludeJpg.addEventListener('change', () => {
  jpgFilenameWrap.hidden = !saveIncludeJpg.checked
})

savePoiCsv.addEventListener('change', () => {
  poiCsvFilenameWrap.hidden = !savePoiCsv.checked
})

modeTrail.addEventListener('click', () => {
  placementMode = 'trail'
  updateChrome()
  redraw()
})

modePoi.addEventListener('click', () => {
  placementMode = 'poi'
  updateChrome()
  redraw()
})

poiForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (!pendingPoi) {
    poiDialog.close()
    return
  }
  const label = poiLabelInput.value.trim() || 'POI'
  const pt = pendingPoi
  poiMarkers.push({ x: pt.x, y: pt.y, label })
  poiDialog.close()
  redraw()
  updateChrome()
})

poiCancel.addEventListener('click', () => {
  pendingPoi = null
  poiDialog.close()
})

poiDialog.addEventListener('close', () => {
  pendingPoi = null
})

btnUndoPoi.addEventListener('click', () => {
  poiMarkers.pop()
  redraw()
  updateChrome()
})

btnClearPoi.addEventListener('click', () => {
  if (!poiMarkers.length) return
  if (!confirm('Remove all POI markers?')) return
  poiMarkers.length = 0
  redraw()
  updateChrome()
})

btnUndo.addEventListener('click', () => {
  trail.undo()
  redraw()
  updateChrome()
})

btnClear.addEventListener('click', () => {
  if (!trail.points.length) return
  if (!confirm('Clear all pins on this floor plan?')) return
  trail.clear()
  redraw()
  updateChrome()
})

btnDownload.addEventListener('click', () => {
  downloadCsvAs(downloadFilename())
})

btnDownloadPoiCsv.addEventListener('click', () => {
  if (!poiMarkers.length) return
  downloadPoiCsvAs(poiCsvDownloadFilename())
})

crosshairsToggle.addEventListener('change', () => {
  crosshairsEnabled = crosshairsToggle.checked
  redraw()
})

interpStep.addEventListener('change', () => {
  commitInterpStepFromInput()
})
interpStep.addEventListener('blur', () => {
  commitInterpStepFromInput()
})

const ro = new ResizeObserver(() => redraw())
ro.observe(stage)
ro.observe(stageInner)

syncInterpControl()
syncPinSizeControl()
syncColorPickersFromCss()
fillFsplSelectOptions()
updateChrome()
void loadDefaultFloorPlan()
