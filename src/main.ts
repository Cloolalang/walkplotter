import './style.css'
import { clientToImagePixel, imagePixelToElementLocal } from './coords'
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

/** Pan (px) and scale for the floor plan; CSS transform on #stage-inner. */
let mapPanX = 0
let mapPanY = 0
let mapZoom = 1
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
  </div>

  <div class="tab-panel tab-panel--map" id="panel-map" role="tabpanel" aria-labelledby="tab-map">
    <p class="hint hint-map" id="hint-map">Open the Controls tab to load a floor plan.</p>
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
      <span class="controls-title-text">Walkplotter - version 1.2 March 2026</span>
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
      <button type="button" class="btn" id="btn-pause" disabled>Pause</button>
      <button type="button" class="btn" id="btn-stop" disabled title="Save CSV (and optional JPG). Available while recording, or after Pause if you have trail or POI data.">Stop &amp; save…</button>
      <button type="button" class="btn" id="btn-resume" disabled hidden>Resume recording</button>
      <button type="button" class="btn" id="btn-download" disabled>Download CSV</button>
      <button type="button" class="btn" id="btn-download-poi-csv" disabled title="POI markers: pixels only, no timestamps">POI CSV</button>
      <button type="button" class="btn" id="btn-undo" disabled>Undo trail</button>
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
const panelMap = document.querySelector<HTMLDivElement>('#panel-map')!
const panelControls = document.querySelector<HTMLDivElement>('#panel-controls')!
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

function setTab(which: 'map' | 'controls'): void {
  const mapActive = which === 'map'
  tabMap.setAttribute('aria-selected', String(mapActive))
  tabControls.setAttribute('aria-selected', String(!mapActive))
  tabMap.tabIndex = mapActive ? 0 : -1
  tabControls.tabIndex = mapActive ? -1 : 0
  panelMap.hidden = !mapActive
  panelControls.hidden = mapActive
  redraw()
}

function updateChrome(): void {
  const hasMap = Boolean(img.naturalWidth)
  const hasPoints = trail.points.length > 0
  const hasPoi = poiMarkers.length > 0
  placeholder.hidden = hasMap
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
updateChrome()
void loadDefaultFloorPlan()
