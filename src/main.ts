import './style.css'
import { clientToElementLocal, clientToImagePixel, imagePixelToElementLocal } from './coords'
import {
  fsplDisplayFrequencyOptionsMhz,
  fsplMeasuredFrequencyOptionsMhz,
  fsplPathLossDeltaDb,
  fsplPathLossNegativeConvention,
} from './fspl'
import {
  base64ToBlob,
  parseProcessConfigJson,
  parseProcessBundleJson,
  uint8ArrayToBase64,
  PROCESS_CONFIG_VERSION,
  PROCESS_BUNDLE_VERSION,
  type ProcessConfigV1,
  type ProcessBundleV1,
  type ProcessBundleSettingsV1,
} from './processBundle'
import {
  DEFAULT_MAX_MATCH_MS,
  extractWalkplotterTestDate,
  extractWalkplotterTimestampInfo,
  mergeByNearestTime,
  parseDurationHmsToMs,
  parsePathLossCsv,
  parseRssiCsv,
  parseWalkplotterEditable,
  serializeWalkplotterEditable,
} from './processMerge'
import type {
  EditableTrailRow,
  MergeTimeOptions,
  MergedPlotPoint,
  PathLossRow,
  UnmatchedTrailPoint,
  WalkplotterTrailRow,
} from './processMerge'
import { buildPoiOnlyCsv, formatDurationMsAsHMS, formatLocalTimeHMS, TrailModel } from './trail'
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
/** Trail samples with no path-loss row within the merge window (drawn as hollow rings when PL is plotted). */
let processUnmatchedTrailPoints: UnmatchedTrailPoint[] = []
/** Cached path-loss CSV text (set when a file is chosen or a bundle is loaded) for Plot / Save bundle. */
let processPathLossCsvText = ''
/** Cached RSSI CSV (`time` + `rssi` columns); merged like path loss but separate colour scale. */
let processRssiCsvText = ''
let processRssiMergedPoints: MergedPlotPoint[] = []
/** Unscaled RSSI merge result; FSPL UI derives `processRssiMergedPoints` from this. */
let processRssiMergedPointsRaw: MergedPlotPoint[] = []
let processRssiUnmatchedTrailPoints: UnmatchedTrailPoint[] = []
type ProcessPlotMetric = 'path_loss' | 'rssi'
let processPlotMetric: ProcessPlotMetric = 'rssi'
/** When set, file summary labels come from a loaded bundle until the user picks new files. */
let processBundleSummaryOverride: { plan: string; walk: string; pl: string; rssi: string } | null = null
/** Current loaded data-bundle filename (if loaded via Load data bundle). */
let loadedProcessDataBundleFilename: string | null = null
/** Current loaded process-config filename (if loaded via Load process config). */
let loadedProcessConfigFilename: string | null = null
/** Baseline signature captured when the current config file was loaded/applied. */
let loadedProcessConfigBaselineSig: string | null = null
/** Loaded bundle settings are applied after Process map image layout is ready. */
let pendingBundleSettings: ProcessBundleSettingsV1 | null = null
/** Walkplotter trail loaded in Process tab; x/y edits are saved via Save Walkplotter CSV. */
let processWalkPreamble = ''
let processWalkTail = ''
let processTrailEditable: EditableTrailRow[] = []
let processTrailOriginal: EditableTrailRow[] = []
let processWalkTestDate: string | null = null
let processTrailDragIndex: number | null = null
let currentTab: 'map' | 'controls' | 'process' | 'rssi_graph' = 'map'
let processRssiRollingEnabled = false
let processRssiRollingWindow = 5
let processRssiLeeEnabled = false
let processRssiLeeFreqMhz = 2640
let processRssiLeeSpeedMps = 1.4
let processRssiResampleHz: 0 | 1 | 2 = 0
let processRssiThresholdMinDb = -90
let processRssiThresholdMinPct = 95
let processRssiThresholdMaxDb = -25
let processRssiThresholdMaxPct = 100

const PROCESS_OVERLAY_SHIFT_STORAGE_KEY = 'walkplotter-process-overlay-shift-v1'
/** Draw trail and RF overlay at (x + Δx, y + Δy) in intrinsic image pixels (display-only until you nudge and save). */
let processOverlayShiftX = 0
let processOverlayShiftY = 0
const PROCESS_PLAN_FLIP_STORAGE_KEY = 'walkplotter-process-plan-flip-v1'
/** Process floor plan display orientation: mirror horizontally/vertically when an upload appears flipped. */
let processPlanFlipX = false
let processPlanFlipY = false

const PROCESS_DOT_SCALE_STORAGE_KEY = 'walkplotter-process-dot-scale-v1'
/** Scales Process overlay trail/RF dot radius (same range as Map pin size). */
let processDotScale = 1
const PROCESS_PALETTE_SAT_STORAGE_KEY = 'walkplotter-process-palette-sat-v1'
/** Saturation multiplier for Process metric palette (1 = original colors). */
let processPaletteSaturation = 1
const PROCESS_RSSI_OFFSET_STORAGE_KEY = 'walkplotter-process-rssi-offset-v1'
/** Applies a global dB offset to all RSSI samples before FSPL scaling (what-if calibration). */
let processRssiOffsetDb = 0
const PROCESS_RSSI_PALETTE_STORAGE_KEY = 'walkplotter-process-rssi-palette-v1'
type RssiPaletteName = 'legacy' | 'cividis' | 'viridis' | 'turbo' | 'jots'
let processRssiPalette: RssiPaletteName = 'jots'
const PROCESS_HEATMAP_STORAGE_KEY = 'walkplotter-process-heatmap-v1'
/** Distance-weighted heatmap controls for Process metric overlay. */
let processShowHeatmap = false
let processHeatmapRadiusPx = 90
let processHeatmapOpacity = 0.55
let processHeatmapWorkCanvas: HTMLCanvasElement | null = null
let processHeatmapUseBoundary = false
let processHeatmapDrawBoundary = false
let processHeatmapBoundaryClosed = false
let processHeatmapBoundaryPoints: { x: number; y: number }[] = []
let processHeatmapBoundaryDragIndex: number | null = null

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
const PROCESS_DOT_SCALE_MIN = 0.01
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
const DEFAULT_PROCESS_DATA_BUNDLE_FILENAME = 'walkplotter-process-bundle-2026-04-18-08-41-52.json'
const DEFAULT_PROCESS_CONFIG_FILENAME = 'walkplotter-process-config-2026-04-18-12-52-08.json'
const DEFAULT_PROCESS_DATA_BUNDLE = `${import.meta.env.BASE_URL}demo/${DEFAULT_PROCESS_DATA_BUNDLE_FILENAME}`
const DEFAULT_PROCESS_CONFIG = `${import.meta.env.BASE_URL}demo/${DEFAULT_PROCESS_CONFIG_FILENAME}`

function applyMapFloorPlanBlob(blob: Blob, fileName: string): void {
  if (!blob.type.startsWith('image/')) return
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  objectUrl = URL.createObjectURL(blob)
  resetMapView()
  img.src = objectUrl
  imageMeta = {
    fileName: fileName || 'unknown',
    widthPx: 0,
    heightPx: 0,
  }
  trail.clear()
  trail.clearSessionTimeZero()
  poiMarkers.length = 0
  recording = true
  setTab('map')
  redraw()
}

function setImageFromFile(file: File | null): void {
  if (!file || !file.type.startsWith('image/')) return
  applyMapFloorPlanBlob(file, file.name || 'unknown')
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
  trail.clearSessionTimeZero()
  poiMarkers.length = 0
  recording = true
  resetMapView()
  img.src = DEFAULT_FLOOR_IMAGE
  updateChrome()
  setTab('map')
}

async function loadDefaultProcessDataAndConfig(): Promise<void> {
  try {
    const bundleRes = await fetch(DEFAULT_PROCESS_DATA_BUNDLE)
    if (!bundleRes.ok) return
    const bundleText = await bundleRes.text()
    const bundle = parseProcessBundleJson(bundleText)
    if (!bundle) return
    await applyProcessBundle(bundle)
    loadedProcessDataBundleFilename = DEFAULT_PROCESS_DATA_BUNDLE_FILENAME

    const configRes = await fetch(DEFAULT_PROCESS_CONFIG)
    if (configRes.ok) {
      const configText = await configRes.text()
      const config = parseProcessConfigJson(configText)
      if (config) {
        applyProcessConfig(config)
        loadedProcessConfigFilename = DEFAULT_PROCESS_CONFIG_FILENAME
        loadedProcessConfigBaselineSig = buildCurrentProcessConfigComparableSig()
      }
    }

    updateProcessFileSummary()
    processStatus.textContent = 'Loaded default demo data bundle and process config.'
  } catch {
    /* ignore missing demo defaults */
  }
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
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  let x = hit.pixel.x
  let y = hit.pixel.y
  const snapVal = mapTrailSnap.value
  if (snapVal !== 'off') {
    const prev = trail.getLastUserAnchor()
    if (prev) {
      const deg = snapVal === '90' ? 90 : 45
      const snapped = nudgeSnapFromPrevOnly(prev, { x, y }, deg)
      const c = clampPixelToImage(snapped.x, snapped.y, iw, ih)
      x = c.x
      y = c.y
    }
  }
  trail.userTap(x, y, new Date())
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
    <button type="button" class="tab-btn" role="tab" id="tab-rssi-graph" aria-selected="false" aria-controls="panel-rssi-graph" tabindex="-1">RSSI pre-process filtering</button>
  </div>

  <div class="tab-panel tab-panel--map" id="panel-map" role="tabpanel" aria-labelledby="tab-map">
    <p class="hint hint-map" id="hint-map">Open the Controls tab to load a map.</p>
    <div class="map-quick-bar" id="map-quick-bar" hidden>
      <button type="button" class="btn" id="btn-pause" disabled>Pause</button>
      <button type="button" class="btn" id="btn-undo" disabled>Undo trail</button>
      <label class="map-snap-wrap" title="Snap each new trail segment to 90° or 45° steps from the previous pin (same idea as Process nudge snap)">
        <span class="map-snap-label">Snap angles</span>
        <select id="map-trail-snap" class="map-trail-snap" disabled>
          <option value="off" selected>Off</option>
          <option value="90">90°</option>
          <option value="45">45°</option>
        </select>
      </label>
    </div>
    <div class="map-session-bar" id="map-session-bar" hidden>
      <button type="button" class="btn btn-session-t0" id="btn-session-t0" disabled title="Press when you zero tester and transponder clocks; CSV timestamps export as elapsed time (H:MM:SS) from this instant">
        Session t = 0
      </button>
      <button type="button" class="btn" id="btn-session-t0-clear" hidden disabled title="Use local wall-clock times in CSV again">
        Wall clock
      </button>
      <span class="map-session-badge" id="map-session-badge" hidden aria-live="polite"
        >Timestamps: elapsed from session t&nbsp;= 0</span>
      <div class="map-clock" id="map-clock">
        <span class="map-clock-label" id="map-clock-label">Local time</span>
        <span class="map-clock-value" id="map-clock-value" aria-live="polite">--:--:--</span>
      </div>
    </div>
    <div class="stage-wrap">
      <div class="stage" id="stage">
        <div class="stage-inner" id="stage-inner">
          <img id="plan" alt="Map" />
          <canvas id="overlay" />
        </div>
      </div>
      <p class="empty" id="placeholder">Load an image to begin.</p>
    </div>
  </div>

  <div class="tab-panel tab-panel--controls" id="panel-controls" role="tabpanel" aria-labelledby="tab-controls" hidden>
    <div class="controls-title-bar" role="banner">
      <span class="controls-title-text">Walkplotter - version 2.7 April 2026</span>
      <a
        class="controls-title-link"
        href="https://github.com/Cloolalang/walkplotter#readme"
        target="_blank"
        rel="noopener noreferrer"
        >README on GitHub</a>
    </div>
    <header class="toolbar">
      <label class="btn btn-primary">
        Choose map
        <input id="file" type="file" accept="image/*" hidden />
      </label>
      <div class="mode-switch" role="group" aria-label="Placement mode">
        <button type="button" class="mode-btn active" id="mode-trail" disabled>Trail</button>
        <button type="button" class="mode-btn" id="mode-poi" disabled title="Points of interest">POI</button>
      </div>
      <button type="button" class="btn" id="btn-stop" disabled title="Save CSV (and optional JPG). Available while recording, or after Pause if you have trail or POI data.">Stop &amp; save…</button>
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
      Start by loading a <strong>data bundle</strong> or new data files, then either configure the Process UI manually or load a saved <strong>process config</strong> to apply those settings against the loaded data.
    </p>
    <div class="process-toolbar">
      <label class="btn btn-primary process-file-btn process-file-pick">
        Map
        <input id="process-file-plan" type="file" accept="image/*" class="process-file-input-overlay" />
      </label>
      <label class="btn btn-primary process-file-btn process-file-pick">
        Walkplotter CSV
        <input id="process-file-walk" type="file" class="process-file-input-overlay" />
      </label>
      <label class="btn btn-primary process-file-btn process-file-pick">
        Path loss CSV
        <input id="process-file-pl" type="file" class="process-file-input-overlay" />
      </label>
      <label class="btn btn-primary process-file-btn process-file-pick">
        RSSI CSV
        <input id="process-file-rssi" type="file" class="process-file-input-overlay" />
      </label>
      <label class="btn process-file-btn process-file-pick" title="Load a JSON data bundle from Save data bundle">
        Load data bundle
        <input id="process-file-bundle" type="file" class="process-file-input-overlay" />
      </label>
      <button type="button" class="btn" id="process-btn-save-bundle" disabled title="Download one JSON file with map + Walkplotter CSV + path loss and/or RSSI CSV">
        Save data bundle
      </button>
      <button type="button" class="btn" id="process-btn-save-config" title="Download Process settings only (no map/CSV data)">
        Save process config
      </button>
      <label class="btn process-file-btn process-file-pick" title="Load Process settings JSON and apply to the current data">
        Load process config
        <input id="process-file-config" type="file" class="process-file-input-overlay" />
      </label>
      <button type="button" class="btn btn-primary process-btn-run" id="process-btn-plot" title="Merge path loss and/or RSSI logs with the trail and draw">Plot overlay</button>
      <button type="button" class="btn" id="process-btn-clear-plot" disabled title="Remove path loss / RSSI overlay">
        Clear overlay
      </button>
      <label class="process-metric-wrap" id="process-metric-wrap" hidden>
        <span class="process-metric-label">Show</span>
        <select id="process-plot-metric" class="process-metric-select" aria-label="Overlay metric">
          <option value="rssi">RSSI</option>
          <option value="path_loss">Path loss</option>
        </select>
      </label>
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
      <div class="process-toolbar process-toolbar--rssi-adjust" id="process-rssi-adjust-wrap" hidden>
        <span
          class="process-shift-lead"
          title="Adds this offset to every plotted RSSI sample (dB) before FSPL scaling is applied."
          >RSSI offset</span
        >
        <label class="process-shift-field" for="process-rssi-offset"
          ><span class="process-shift-label">ΔRSSI dB</span>
          <input
            type="number"
            id="process-rssi-offset"
            class="process-shift-input"
            step="0.5"
            value="0"
            inputmode="decimal"
          />
        </label>
        <button type="button" class="btn" id="process-rssi-offset-reset" title="Set RSSI offset to 0 dB">
          Reset RSSI offset
        </button>
        <label class="process-shift-field" for="process-rssi-palette"
          ><span class="process-shift-label">Palette</span>
          <select id="process-rssi-palette" class="process-fspl-select" aria-label="RSSI palette">
            <option value="legacy">Legacy</option>
            <option value="cividis">Cividis</option>
            <option value="viridis">Viridis</option>
            <option value="turbo">Turbo</option>
            <option value="jots">JOTS</option>
          </select>
        </label>
      </div>
    </div>
    <div class="process-toolbar process-toolbar--fspl" id="process-fspl-wrap" hidden>
      <label class="toolbar-toggle process-toolbar-toggle process-fspl-toggle" title="Free-space frequency scaling. Positive PL (dB): add 20·log₁₀(f_est/f_meas). Negative PL values (some gear): correction is sign-flipped so lower frequency still shows less loss.">
        <input type="checkbox" id="process-fspl-enable" disabled />
        FSPL frequency estimate
      </label>
      <label class="process-fspl-field" for="process-fspl-target"
        ><span class="process-fspl-field-label">Estimate at</span>
        <select id="process-fspl-target" class="process-fspl-select" disabled aria-label="Frequency to estimate path loss at (MHz)"></select>
        <span class="process-fspl-unit">MHz</span></label
      >
      <label class="process-fspl-field" for="process-fspl-ref"
        ><span class="process-fspl-field-label">Measured at</span>
        <select id="process-fspl-ref" class="process-fspl-select" disabled aria-label="Actual walk test frequency in MHz"></select>
        <span class="process-fspl-unit">MHz</span></label
      >
      <span class="process-fspl-delta" id="process-fspl-delta" aria-live="polite"></span>
    </div>
    <div class="process-toolbar process-toolbar--heatmap" id="process-heatmap-wrap" hidden>
      <label class="toolbar-toggle process-toolbar-toggle" title="Distance-weighted heatmap based on nearby plotted sample values">
        <input type="checkbox" id="process-show-heatmap" />
        Heatmap
      </label>
      <label class="toolbar-toggle process-toolbar-toggle" title="Clip heatmap so it only appears inside the boundary polygon">
        <input type="checkbox" id="process-heatmap-use-boundary" />
        Use boundary
      </label>
      <label class="toolbar-toggle process-toolbar-toggle" title="Click map to add boundary vertices; drag vertices to edit">
        <input type="checkbox" id="process-heatmap-draw-boundary" />
        Draw boundary
      </label>
      <button type="button" class="btn" id="process-heatmap-close-boundary" title="Close polygon from last point to first">
        Close boundary
      </button>
      <button type="button" class="btn" id="process-heatmap-clear-boundary" title="Remove all boundary points">
        Clear boundary
      </button>
      <label class="process-shift-field" for="process-heatmap-radius"
        ><span class="process-shift-label">Radius</span>
        <input
          type="range"
          id="process-heatmap-radius"
          class="process-heatmap-range"
          min="20"
          max="1000"
          step="5"
          value="90"
          aria-label="Heatmap influence radius in pixels"
        />
        <span class="process-heatmap-value" id="process-heatmap-radius-value">90 px</span></label
      >
      <label class="process-shift-field" for="process-heatmap-opacity"
        ><span class="process-shift-label">Opacity</span>
        <input
          type="range"
          id="process-heatmap-opacity"
          class="process-heatmap-range"
          min="10"
          max="100"
          step="5"
          value="55"
          aria-label="Heatmap opacity percent"
        />
        <span class="process-heatmap-value" id="process-heatmap-opacity-value">55%</span></label
      >
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
    <div class="process-toolbar process-toolbar--shift" id="process-overlay-shift-wrap">
      <span
        class="process-shift-lead"
        title="Moves every trail dot and RF overlay marker together in image pixel space. Positive Δy draws lower on the plan. Does not change the CSV until you nudge points and save—useful when the same file looks misaligned on another device."
        >Overlay shift</span
      >
      <label class="process-shift-field" for="process-shift-x"
        ><span class="process-shift-label">Δx px</span>
        <input type="number" id="process-shift-x" class="process-shift-input" step="10" value="0" />
      </label>
      <label class="process-shift-field" for="process-shift-y"
        ><span class="process-shift-label">Δy px</span>
        <input type="number" id="process-shift-y" class="process-shift-input" step="10" value="0" />
      </label>
      <button type="button" class="btn" id="process-shift-reset" title="Clear overlay shift (0, 0)">Reset shift</button>
    </div>
    <div class="process-toolbar process-toolbar--flip" id="process-plan-flip-wrap">
      <span
        class="process-shift-lead"
        title="Mirror the Process map if it appears reversed on this device. This only changes display orientation; CSV coordinates are unchanged."
        >Map orientation</span
      >
      <label class="toolbar-toggle process-toolbar-toggle" title="Mirror the map left-to-right in the Process view">
        <input type="checkbox" id="process-flip-x" />
        Flip left/right
      </label>
      <label class="toolbar-toggle process-toolbar-toggle" title="Mirror the map top-to-bottom in the Process view">
        <input type="checkbox" id="process-flip-y" />
        Flip top/bottom
      </label>
      <button type="button" class="btn" id="process-flip-reset" title="Use the normal map orientation">
        Reset orientation
      </button>
    </div>
    <div class="process-files-summary" id="process-files-summary" aria-live="polite">
      <div class="process-file-row">
        <span class="process-file-kind">Map</span>
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
      <div class="process-file-row">
        <span class="process-file-kind">RSSI CSV</span>
        <span class="process-file-name" id="process-filename-rssi">—</span>
      </div>
      <div class="process-file-row">
        <span class="process-file-kind">Data bundle</span>
        <span class="process-file-name" id="process-filename-data-bundle">—</span>
      </div>
      <div class="process-file-row">
        <span class="process-file-kind">Process config</span>
        <span class="process-file-name" id="process-filename-config">—</span>
      </div>
    </div>
    <div class="map-zoom-bar process-zoom-bar" id="process-zoom-bar" hidden>
      <span>View</span>
      <button type="button" class="btn" id="process-btn-zoom-out" title="Zoom out">−</button>
      <span class="zoom-pct" id="process-zoom-pct">100%</span>
      <button type="button" class="btn" id="process-btn-zoom-in" title="Zoom in">+</button>
      <button type="button" class="btn" id="process-btn-zoom-reset" title="Reset pan and zoom">Reset view</button>
    </div>
    <div class="pin-size-bar process-dot-size-bar" id="process-dot-size-bar" hidden>
      <label class="pin-size-label" for="process-dot-size">Dot size</label>
      <input
        type="range"
        id="process-dot-size"
        min="1"
        max="250"
        step="5"
        value="100"
        disabled
        aria-label="Process overlay dot size"
      />
      <span class="pin-size-pct" id="process-dot-size-pct">100%</span>
      <label class="pin-size-label process-palette-sat-label" for="process-palette-sat">Palette saturation</label>
      <input
        type="range"
        id="process-palette-sat"
        min="0"
        max="200"
        step="5"
        value="100"
        disabled
        aria-label="Process palette saturation percent"
      />
      <span class="pin-size-pct" id="process-palette-sat-pct">100%</span>
    </div>
    <p class="hint process-status" id="process-status">Load map and Walkplotter CSV to begin.</p>
    <div class="process-legend" id="process-legend" hidden></div>
    <div class="process-histogram-wrap" id="process-histogram-wrap" hidden>
      <p class="process-histogram-title" id="process-histogram-title">Path loss histogram (20 dB bins, down to −120 dB)</p>
      <p class="process-histogram-meta" id="process-histogram-meta"></p>
      <div class="process-rssi-thresholds" id="process-rssi-thresholds" hidden>
        <p class="process-rssi-thresholds-title">RSSI threshold checks</p>
        <div class="process-rssi-thresholds-grid">
          <label class="rssi-graph-field process-rssi-threshold-field" for="process-rssi-threshold-min-db"
            ><span>Minimum RSSI (dBm)</span>
            <input type="number" id="process-rssi-threshold-min-db" min="-200" max="50" step="1" value="-90" inputmode="decimal" />
          </label>
          <label class="rssi-graph-field process-rssi-threshold-field" for="process-rssi-threshold-min-pct"
            ><span>Minimum bin %</span>
            <input type="number" id="process-rssi-threshold-min-pct" min="0" max="100" step="0.1" value="95" inputmode="decimal" />
          </label>
          <label class="rssi-graph-field process-rssi-threshold-field" for="process-rssi-threshold-max-db"
            ><span>Maximum RSSI (dBm)</span>
            <input type="number" id="process-rssi-threshold-max-db" min="-200" max="50" step="1" value="-25" inputmode="decimal" />
          </label>
          <label class="rssi-graph-field process-rssi-threshold-field" for="process-rssi-threshold-max-pct"
            ><span>Maximum bin %</span>
            <input type="number" id="process-rssi-threshold-max-pct" min="0" max="100" step="0.1" value="100" inputmode="decimal" />
          </label>
        </div>
        <p class="process-rssi-threshold-results" id="process-rssi-threshold-results"></p>
      </div>
      <details class="process-colour-scale" id="process-colour-scale">
        <summary class="process-colour-scale-summary">Bin &amp; map colour scale</summary>
        <p class="hint process-colour-scale-hint">
          Colours are interpolated between these path-loss stops (−120 dB weak → −30 dB strong). Adjust stops to change
          <strong>histogram</strong>, <strong>pie</strong>, and <strong>map</strong> markers together. Values outside −30…−120 dB stay clamped to the ends.
        </p>
        <div class="process-pl-stops-editor" id="process-pl-stops-editor"></div>
        <div class="process-colour-scale-actions">
          <button type="button" class="btn" id="process-pl-stops-reset">Reset to default</button>
        </div>
      </details>
      <div class="process-histogram-layout">
        <div class="process-histogram-pie-wrap">
          <svg
            class="process-histogram-pie-svg"
            id="process-histogram-pie"
            viewBox="0 0 100 100"
            role="img"
            aria-label="Path loss share by bin (same colors as map)"
          ></svg>
        </div>
        <div class="process-histogram-scroll">
          <table class="process-histogram-table">
            <thead>
              <tr>
                <th scope="col" class="process-hist-col-swatch" aria-label="Bin colour"></th>
                <th scope="col" id="process-histogram-range-th">Range (dB)</th>
                <th scope="col">Count</th>
                <th scope="col">Seconds</th>
                <th scope="col">%</th>
              </tr>
            </thead>
            <tbody id="process-histogram-body"></tbody>
          </table>
        </div>
      </div>
    </div>
    <p class="hint process-mouse-hint" id="process-mouse-hint" hidden>
      Mouse: wheel to zoom · drag empty area to pan · while nudging: <strong>left-drag</strong> on empty space, or <strong>middle-drag</strong> / <strong>Alt+drag</strong> anywhere, to pan the view.
    </p>
    <div class="process-stage-wrap">
      <div class="process-stage" id="process-stage">
        <div class="process-stage-inner" id="process-stage-inner">
          <img id="process-plan" alt="Map for processing" />
          <canvas id="process-overlay" />
        </div>
      </div>
      <p class="empty process-placeholder" id="process-placeholder">Load a map image to see the overlay.</p>
    </div>
  </div>
  <div class="tab-panel tab-panel--rssi-graph" id="panel-rssi-graph" role="tabpanel" aria-labelledby="tab-rssi-graph" hidden>
    <p class="hint">
      View the RSSI CSV as a time-series graph. Load an <strong>RSSI CSV</strong> in the <strong>Process</strong> tab first; this chart uses the same parser.
    </p>
    <div class="rssi-graph-toolbar">
      <label class="toolbar-toggle process-toolbar-toggle" title="Apply a simple rolling average to RSSI samples">
        <input type="checkbox" id="rssi-graph-rolling-enable" />
        Rolling average
      </label>
      <label class="rssi-graph-field" for="rssi-graph-rolling-window"
        ><span>Window (samples)</span>
        <input
          type="number"
          id="rssi-graph-rolling-window"
          min="2"
          max="5000"
          step="1"
          value="5"
          inputmode="numeric"
        />
      </label>
      <button
        type="button"
        class="btn"
        id="rssi-graph-save-filtered"
        title="Download filtered RSSI CSV for later re-load/bundle use"
        disabled
      >
        Save filtered RSSI CSV
      </button>
      <label class="toolbar-toggle process-toolbar-toggle" title="Lee criterion spatial averaging (window derived from frequency and walking speed)">
        <input type="checkbox" id="rssi-graph-lee-enable" />
        Lee criterion
      </label>
      <label class="rssi-graph-field" for="rssi-graph-lee-freq"
        ><span>Frequency (MHz)</span>
        <input
          type="number"
          id="rssi-graph-lee-freq"
          min="100"
          max="10000"
          step="1"
          value="2640"
          inputmode="decimal"
        />
      </label>
      <label class="rssi-graph-field" for="rssi-graph-lee-speed"
        ><span>Walking speed (m/s)</span>
        <input
          type="number"
          id="rssi-graph-lee-speed"
          min="0.05"
          max="5"
          step="0.05"
          value="1.4"
          inputmode="decimal"
        />
      </label>
      <label class="rssi-graph-field" for="rssi-graph-resample-hz"
        ><span>Resample</span>
        <select id="rssi-graph-resample-hz">
          <option value="0">Off (raw rate)</option>
          <option value="2">2 Hz</option>
          <option value="1">1 Hz</option>
        </select>
      </label>
      <span class="rssi-graph-note" id="rssi-graph-filter-note">Raw RSSI values (no filter).</span>
    </div>
    <p class="hint rssi-graph-status" id="rssi-graph-status">Load an RSSI CSV in Process to graph it here.</p>
    <div class="rssi-graph-wrap">
      <canvas id="rssi-graph-canvas" class="rssi-graph-canvas" aria-label="RSSI time series graph"></canvas>
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
        <span id="save-include-jpg-text">Also save a map snapshot (map + trail + POI markers) as JPG</span>
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
  <dialog class="save-dialog" id="bundle-save-dialog">
    <form id="bundle-save-form">
      <h2 class="save-dialog-title">Save data bundle</h2>
      <p class="save-dialog-desc">
        Choose a file name for the JSON data bundle (map + Walkplotter CSV + path loss and/or RSSI CSV). Use Save process config for settings-only snapshots.
        <code>.json</code> is added if missing.
      </p>
      <label class="save-dialog-label">
        File name
        <input
          type="text"
          id="bundle-filename"
          class="save-dialog-input"
          autocomplete="off"
          spellcheck="false"
          maxlength="200"
        />
      </label>
      <div class="save-dialog-actions">
        <button type="button" class="btn" id="bundle-save-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="bundle-save-confirm">Save</button>
      </div>
    </form>
  </dialog>
`

const img = document.querySelector<HTMLImageElement>('#plan')!
const canvas = document.querySelector<HTMLCanvasElement>('#overlay')!
const fileInput = document.querySelector<HTMLInputElement>('#file')!
const btnPause = document.querySelector<HTMLButtonElement>('#btn-pause')!
const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop')!
const btnDownload = document.querySelector<HTMLButtonElement>('#btn-download')!
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!
const placeholder = document.querySelector<HTMLParagraphElement>('#placeholder')!
const stage = document.querySelector<HTMLDivElement>('#stage')!
const stageInner = document.querySelector<HTMLDivElement>('#stage-inner')!
const mapQuickBar = document.querySelector<HTMLDivElement>('#map-quick-bar')!
const mapTrailSnap = document.querySelector<HTMLSelectElement>('#map-trail-snap')!
const mapSessionBar = document.querySelector<HTMLDivElement>('#map-session-bar')!
const btnSessionT0 = document.querySelector<HTMLButtonElement>('#btn-session-t0')!
const btnSessionT0Clear = document.querySelector<HTMLButtonElement>('#btn-session-t0-clear')!
const mapSessionBadge = document.querySelector<HTMLSpanElement>('#map-session-badge')!
const mapClockLabel = document.querySelector<HTMLSpanElement>('#map-clock-label')!
const mapClockValue = document.querySelector<HTMLSpanElement>('#map-clock-value')!
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
const tabRssiGraph = document.querySelector<HTMLButtonElement>('#tab-rssi-graph')!
const panelMap = document.querySelector<HTMLDivElement>('#panel-map')!
const panelControls = document.querySelector<HTMLDivElement>('#panel-controls')!
const panelProcess = document.querySelector<HTMLDivElement>('#panel-process')!
const panelRssiGraph = document.querySelector<HTMLDivElement>('#panel-rssi-graph')!
const rssiGraphStatus = document.querySelector<HTMLParagraphElement>('#rssi-graph-status')!
const rssiGraphCanvas = document.querySelector<HTMLCanvasElement>('#rssi-graph-canvas')!
const rssiGraphRollingEnable = document.querySelector<HTMLInputElement>('#rssi-graph-rolling-enable')!
const rssiGraphRollingWindowInput = document.querySelector<HTMLInputElement>('#rssi-graph-rolling-window')!
const rssiGraphSaveFilteredBtn = document.querySelector<HTMLButtonElement>('#rssi-graph-save-filtered')!
const rssiGraphLeeEnable = document.querySelector<HTMLInputElement>('#rssi-graph-lee-enable')!
const rssiGraphLeeFreqInput = document.querySelector<HTMLInputElement>('#rssi-graph-lee-freq')!
const rssiGraphLeeSpeedInput = document.querySelector<HTMLInputElement>('#rssi-graph-lee-speed')!
const rssiGraphResampleHzSelect = document.querySelector<HTMLSelectElement>('#rssi-graph-resample-hz')!
const rssiGraphFilterNote = document.querySelector<HTMLSpanElement>('#rssi-graph-filter-note')!
const processImg = document.querySelector<HTMLImageElement>('#process-plan')!
const processCanvas = document.querySelector<HTMLCanvasElement>('#process-overlay')!
const processStage = document.querySelector<HTMLDivElement>('#process-stage')!
const processStageInner = document.querySelector<HTMLDivElement>('#process-stage-inner')!
const processZoomBar = document.querySelector<HTMLDivElement>('#process-zoom-bar')!
const processDotSizeBar = document.querySelector<HTMLDivElement>('#process-dot-size-bar')!
const processDotSizeRange = document.querySelector<HTMLInputElement>('#process-dot-size')!
const processDotSizePctEl = document.querySelector<HTMLSpanElement>('#process-dot-size-pct')!
const processPaletteSatRange = document.querySelector<HTMLInputElement>('#process-palette-sat')!
const processPaletteSatPctEl = document.querySelector<HTMLSpanElement>('#process-palette-sat-pct')!
const processZoomPctEl = document.querySelector<HTMLSpanElement>('#process-zoom-pct')!
const processBtnZoomIn = document.querySelector<HTMLButtonElement>('#process-btn-zoom-in')!
const processBtnZoomOut = document.querySelector<HTMLButtonElement>('#process-btn-zoom-out')!
const processBtnZoomReset = document.querySelector<HTMLButtonElement>('#process-btn-zoom-reset')!
const processFilePlan = document.querySelector<HTMLInputElement>('#process-file-plan')!
const processFileWalk = document.querySelector<HTMLInputElement>('#process-file-walk')!
const processFilePl = document.querySelector<HTMLInputElement>('#process-file-pl')!
const processFileRssi = document.querySelector<HTMLInputElement>('#process-file-rssi')!
const processBtnPlot = document.querySelector<HTMLButtonElement>('#process-btn-plot')!
const processBtnClearPlot = document.querySelector<HTMLButtonElement>('#process-btn-clear-plot')!
const processBtnSaveBundle = document.querySelector<HTMLButtonElement>('#process-btn-save-bundle')!
const processFileBundle = document.querySelector<HTMLInputElement>('#process-file-bundle')!
const processBtnSaveConfig = document.querySelector<HTMLButtonElement>('#process-btn-save-config')!
const processFileConfig = document.querySelector<HTMLInputElement>('#process-file-config')!
const processShowPlLabels = document.querySelector<HTMLInputElement>('#process-show-pl-labels')!
const processShowPlRoute = document.querySelector<HTMLInputElement>('#process-show-pl-route')!
const processShowPlColoredTrail = document.querySelector<HTMLInputElement>('#process-show-pl-colored-trail')!
const processFsplWrap = document.querySelector<HTMLDivElement>('#process-fspl-wrap')!
const processFsplEnable = document.querySelector<HTMLInputElement>('#process-fspl-enable')!
const processFsplRef = document.querySelector<HTMLSelectElement>('#process-fspl-ref')!
const processFsplTarget = document.querySelector<HTMLSelectElement>('#process-fspl-target')!
const processFsplDelta = document.querySelector<HTMLSpanElement>('#process-fspl-delta')!
const processRssiAdjustWrap = document.querySelector<HTMLDivElement>('#process-rssi-adjust-wrap')!
const processRssiOffsetInput = document.querySelector<HTMLInputElement>('#process-rssi-offset')!
const processRssiOffsetReset = document.querySelector<HTMLButtonElement>('#process-rssi-offset-reset')!
const processRssiPaletteSelect = document.querySelector<HTMLSelectElement>('#process-rssi-palette')!
const processHeatmapWrap = document.querySelector<HTMLDivElement>('#process-heatmap-wrap')!
const processShowHeatmapInput = document.querySelector<HTMLInputElement>('#process-show-heatmap')!
const processHeatmapUseBoundaryInput = document.querySelector<HTMLInputElement>('#process-heatmap-use-boundary')!
const processHeatmapDrawBoundaryInput = document.querySelector<HTMLInputElement>('#process-heatmap-draw-boundary')!
const processHeatmapCloseBoundaryBtn = document.querySelector<HTMLButtonElement>('#process-heatmap-close-boundary')!
const processHeatmapClearBoundaryBtn = document.querySelector<HTMLButtonElement>('#process-heatmap-clear-boundary')!
const processHeatmapRadiusInput = document.querySelector<HTMLInputElement>('#process-heatmap-radius')!
const processHeatmapOpacityInput = document.querySelector<HTMLInputElement>('#process-heatmap-opacity')!
const processHeatmapRadiusValue = document.querySelector<HTMLSpanElement>('#process-heatmap-radius-value')!
const processHeatmapOpacityValue = document.querySelector<HTMLSpanElement>('#process-heatmap-opacity-value')!
const processNudgeTrail = document.querySelector<HTMLInputElement>('#process-nudge-trail')!
const processNudgeSnap = document.querySelector<HTMLSelectElement>('#process-nudge-snap')!
const processResetTrail = document.querySelector<HTMLButtonElement>('#process-reset-trail')!
const processSaveWalkEdited = document.querySelector<HTMLButtonElement>('#process-save-walk-edited')!
const processSaveWalkOriginal = document.querySelector<HTMLButtonElement>('#process-save-walk-original')!
const processShiftXInput = document.querySelector<HTMLInputElement>('#process-shift-x')!
const processShiftYInput = document.querySelector<HTMLInputElement>('#process-shift-y')!
const processShiftReset = document.querySelector<HTMLButtonElement>('#process-shift-reset')!
const processFlipXInput = document.querySelector<HTMLInputElement>('#process-flip-x')!
const processFlipYInput = document.querySelector<HTMLInputElement>('#process-flip-y')!
const processFlipReset = document.querySelector<HTMLButtonElement>('#process-flip-reset')!
const processStatus = document.querySelector<HTMLParagraphElement>('#process-status')!
const processFilenamePlan = document.querySelector<HTMLSpanElement>('#process-filename-plan')!
const processFilenameWalk = document.querySelector<HTMLSpanElement>('#process-filename-walk')!
const processFilenamePl = document.querySelector<HTMLSpanElement>('#process-filename-pl')!
const processFilenameRssi = document.querySelector<HTMLSpanElement>('#process-filename-rssi')!
const processFilenameDataBundle = document.querySelector<HTMLSpanElement>('#process-filename-data-bundle')!
const processFilenameConfig = document.querySelector<HTMLSpanElement>('#process-filename-config')!
const processMetricWrap = document.querySelector<HTMLLabelElement>('#process-metric-wrap')!
const processPlotMetricSelect = document.querySelector<HTMLSelectElement>('#process-plot-metric')!
const processLegend = document.querySelector<HTMLDivElement>('#process-legend')!
const processHistogramWrap = document.querySelector<HTMLDivElement>('#process-histogram-wrap')!
const processHistogramTitle = document.querySelector<HTMLParagraphElement>('#process-histogram-title')!
const processHistogramMeta = document.querySelector<HTMLParagraphElement>('#process-histogram-meta')!
const processRssiThresholds = document.querySelector<HTMLDivElement>('#process-rssi-thresholds')!
const processRssiThresholdMinDbInput = document.querySelector<HTMLInputElement>('#process-rssi-threshold-min-db')!
const processRssiThresholdMinPctInput = document.querySelector<HTMLInputElement>('#process-rssi-threshold-min-pct')!
const processRssiThresholdMaxDbInput = document.querySelector<HTMLInputElement>('#process-rssi-threshold-max-db')!
const processRssiThresholdMaxPctInput = document.querySelector<HTMLInputElement>('#process-rssi-threshold-max-pct')!
const processRssiThresholdResults = document.querySelector<HTMLParagraphElement>('#process-rssi-threshold-results')!
const processColourScale = document.querySelector<HTMLDetailsElement>('#process-colour-scale')!
const processHistogramRangeTh = document.querySelector<HTMLTableCellElement>('#process-histogram-range-th')!
const processHistogramBody = document.querySelector<HTMLTableSectionElement>('#process-histogram-body')!
const processHistogramPie = document.querySelector<SVGSVGElement>('#process-histogram-pie')!
const processPlStopsEditor = document.querySelector<HTMLDivElement>('#process-pl-stops-editor')!
const processPlStopsReset = document.querySelector<HTMLButtonElement>('#process-pl-stops-reset')!
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
const bundleSaveDialog = document.querySelector<HTMLDialogElement>('#bundle-save-dialog')!
const bundleSaveForm = document.querySelector<HTMLFormElement>('#bundle-save-form')!
const bundleFilenameInput = document.querySelector<HTMLInputElement>('#bundle-filename')!
const bundleSaveCancel = document.querySelector<HTMLButtonElement>('#bundle-save-cancel')!
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

/** Parse rgb()/rgba() color strings from metric palettes. */
function parseRgbLike(css: string): [number, number, number] | null {
  const m = css.trim().match(/^rgba?\(\s*([+\-]?\d+)\s*,\s*([+\-]?\d+)\s*,\s*([+\-]?\d+)/i)
  if (!m) return null
  const r = Number(m[1])
  const g = Number(m[2])
  const b = Number(m[3])
  if (![r, g, b].every((v) => Number.isFinite(v))) return null
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return [clamp(r), clamp(g), clamp(b)]
}

function pointInPolygon(
  x: number,
  y: number,
  poly: readonly { x: number; y: number }[]
): boolean {
  if (poly.length < 3) return false
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x
    const yi = poly[i]!.y
    const xj = poly[j]!.x
    const yj = poly[j]!.y
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi
    if (intersects) inside = !inside
  }
  return inside
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

function clampProcessDotScale(s: number): number {
  return Math.min(PIN_DOT_SCALE_MAX, Math.max(PROCESS_DOT_SCALE_MIN, s))
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
  if (processHeatmapDrawBoundary) return false
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

/** Fixed path-loss color scale for Process overlay (dB): −120 … −30, clamped outside. */
const PROCESS_PL_GOOD = -30
const PROCESS_PL_BAD = -120

type PlRgb = readonly [number, number, number]

/** Default stops: red → orange → yellow → green → cyan → blue → white (strong signal). */
const PL_COLOR_STOPS_DEFAULT: readonly { db: number; rgb: PlRgb }[] = [
  { db: -120, rgb: [136, 2, 2] },
  { db: -100, rgb: [244, 16, 16] },
  { db: -90, rgb: [255, 120, 31] },
  { db: -80, rgb: [255, 200, 0] },
  { db: -72, rgb: [255, 255, 0] },
  { db: -68, rgb: [64, 255, 26] },
  { db: -62, rgb: [0, 250, 142] },
  { db: -54, rgb: [4, 230, 246] },
  { db: -46, rgb: [42, 158, 246] },
  { db: -38, rgb: [148, 196, 255] },
  { db: -30, rgb: [255, 255, 255] },
]

const PL_STOPS_STORAGE_KEY = 'walkplotter-process-pl-stops-v3'

type PlColorStop = { db: number; rgb: [number, number, number] }

let plColorStops: PlColorStop[] = PL_COLOR_STOPS_DEFAULT.map((s) => ({
  db: s.db,
  rgb: [s.rgb[0], s.rgb[1], s.rgb[2]],
}))

function cloneDefaultPlStops(): PlColorStop[] {
  return PL_COLOR_STOPS_DEFAULT.map((s) => ({
    db: s.db,
    rgb: [s.rgb[0], s.rgb[1], s.rgb[2]],
  }))
}

function loadPlStopsFromStorage(): void {
  plColorStops = cloneDefaultPlStops()
  try {
    const raw = localStorage.getItem(PL_STOPS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length !== PL_COLOR_STOPS_DEFAULT.length) return
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i] as { db?: unknown; rgb?: unknown }
      const d = PL_COLOR_STOPS_DEFAULT[i]!
      if (row?.db !== d.db || !Array.isArray(row.rgb) || row.rgb.length !== 3) return
      const r = Number(row.rgb[0])
      const g = Number(row.rgb[1])
      const b = Number(row.rgb[2])
      if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return
      plColorStops[i] = { db: d.db, rgb: [r, g, b] }
    }
  } catch {
    plColorStops = cloneDefaultPlStops()
  }
}

function savePlStopsToStorage(): void {
  try {
    localStorage.setItem(PL_STOPS_STORAGE_KEY, JSON.stringify(plColorStops))
  } catch {
    /* ignore */
  }
}

function rgbToHex255(r: number, g: number, b: number): string {
  const x = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${x(r)}${x(g)}${x(b)}`
}

function hexToRgb255(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m?.[1]) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function applyPaletteSaturation(r: number, g: number, b: number): [number, number, number] {
  const s = Math.max(0, Math.min(2, processPaletteSaturation))
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const sat = (c: number) => Math.max(0, Math.min(255, Math.round(gray + (c - gray) * s)))
  return [sat(r), sat(g), sat(b)]
}

function rgbStringFromPalette(r: number, g: number, b: number): string {
  const c = applyPaletteSaturation(r, g, b)
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function pathLossToColor(pl: number): string {
  const x = Math.max(PROCESS_PL_BAD, Math.min(PROCESS_PL_GOOD, pl))
  const stops = plColorStops
  if (x <= stops[0]!.db) {
    const c = stops[0]!.rgb
    return rgbStringFromPalette(c[0], c[1], c[2])
  }
  if (x >= stops[stops.length - 1]!.db) {
    const c = stops[stops.length - 1]!.rgb
    return rgbStringFromPalette(c[0], c[1], c[2])
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i]!
    const hi = stops[i + 1]!
    if (x >= lo.db && x <= hi.db) {
      const t = (x - lo.db) / (hi.db - lo.db)
      return rgbStringFromPalette(
        lerpChannel(lo.rgb[0], hi.rgb[0], t),
        lerpChannel(lo.rgb[1], hi.rgb[1], t),
        lerpChannel(lo.rgb[2], hi.rgb[2], t)
      )
    }
  }
  const c = stops[stops.length - 1]!.rgb
  return rgbStringFromPalette(c[0], c[1], c[2])
}

function pathLossScaleGradientCss(): string {
  const pts = plColorStops.map((s) => ({
    pct: ((s.db - PROCESS_PL_GOOD) / (PROCESS_PL_BAD - PROCESS_PL_GOOD)) * 100,
    color: pathLossToColor(s.db),
  })).sort((a, b) => a.pct - b.pct)
  return `linear-gradient(90deg, ${pts.map((p) => `${p.color} ${p.pct.toFixed(2)}%`).join(', ')})`
}

/** One stop every 10 dBm from weak (−120) to strong (−25); map and histogram use the same scale. */
const RSSI_PALETTES: Record<RssiPaletteName, readonly { db: number; rgb: readonly [number, number, number] }[]> = {
  legacy: [
    { db: -120, rgb: [8, 8, 10] },
    { db: -110, rgb: [34, 12, 16] },
    { db: -100, rgb: [72, 20, 24] },
    { db: -90, rgb: [198, 44, 32] },
    { db: -80, rgb: [255, 130, 36] },
    { db: -70, rgb: [255, 215, 52] },
    { db: -60, rgb: [108, 198, 68] },
    { db: -50, rgb: [52, 136, 214] },
    { db: -40, rgb: [64, 138, 230] },
    { db: -30, rgb: [168, 208, 255] },
    { db: -25, rgb: [255, 255, 255] },
  ],
  cividis: [
    { db: -120, rgb: [0, 34, 77] },
    { db: -110, rgb: [12, 45, 95] },
    { db: -100, rgb: [28, 57, 112] },
    { db: -90, rgb: [43, 70, 122] },
    { db: -80, rgb: [62, 84, 128] },
    { db: -70, rgb: [85, 99, 129] },
    { db: -60, rgb: [112, 114, 125] },
    { db: -50, rgb: [140, 130, 118] },
    { db: -40, rgb: [171, 147, 106] },
    { db: -30, rgb: [203, 165, 90] },
    { db: -25, rgb: [234, 186, 71] },
  ],
  viridis: [
    { db: -120, rgb: [68, 1, 84] },
    { db: -110, rgb: [72, 27, 109] },
    { db: -100, rgb: [67, 55, 128] },
    { db: -90, rgb: [58, 82, 139] },
    { db: -80, rgb: [48, 103, 141] },
    { db: -70, rgb: [40, 124, 142] },
    { db: -60, rgb: [32, 144, 140] },
    { db: -50, rgb: [52, 163, 115] },
    { db: -40, rgb: [94, 201, 98] },
    { db: -30, rgb: [170, 220, 50] },
    { db: -25, rgb: [253, 231, 37] },
  ],
  turbo: [
    { db: -120, rgb: [48, 18, 59] },
    { db: -110, rgb: [65, 47, 128] },
    { db: -100, rgb: [60, 83, 196] },
    { db: -90, rgb: [43, 122, 224] },
    { db: -80, rgb: [29, 156, 193] },
    { db: -70, rgb: [58, 183, 125] },
    { db: -60, rgb: [121, 203, 66] },
    { db: -50, rgb: [190, 214, 49] },
    { db: -40, rgb: [241, 204, 65] },
    { db: -30, rgb: [252, 165, 53] },
    { db: -25, rgb: [227, 86, 42] },
  ],
  jots: [
    { db: -120, rgb: [48, 48, 48] },
    { db: -110, rgb: [255, 0, 0] },
    { db: -100, rgb: [255, 0, 255] },
    { db: -90, rgb: [255, 153, 0] },
    { db: -80, rgb: [255, 255, 0] },
    { db: -70, rgb: [0, 153, 0] },
    { db: -60, rgb: [0, 255, 0] },
    { db: -50, rgb: [0, 75, 224] },
    { db: -40, rgb: [0, 255, 255] },
    { db: -30, rgb: [176, 255, 255] },
    { db: -20, rgb: [255, 255, 255] },
  ],
}

function clampRssiPaletteName(v: unknown): RssiPaletteName {
  return v === 'cividis' || v === 'viridis' || v === 'turbo' || v === 'jots' ? v : 'legacy'
}

function currentRssiColorStops(): readonly { db: number; rgb: readonly [number, number, number] }[] {
  return RSSI_PALETTES[processRssiPalette]
}

function rssiToColor(rssi: number): string {
  const stops = currentRssiColorStops()
  const minDb = stops[0]!.db
  const maxDb = stops[stops.length - 1]!.db
  const x = Math.max(minDb, Math.min(maxDb, rssi))
  if (x <= stops[0]!.db) {
    const c = stops[0]!.rgb
    return rgbStringFromPalette(c[0], c[1], c[2])
  }
  if (x >= stops[stops.length - 1]!.db) {
    const c = stops[stops.length - 1]!.rgb
    return rgbStringFromPalette(c[0], c[1], c[2])
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i]!
    const hi = stops[i + 1]!
    if (x >= lo.db && x <= hi.db) {
      const t = (x - lo.db) / (hi.db - lo.db)
      return rgbStringFromPalette(
        lerpChannel(lo.rgb[0], hi.rgb[0], t),
        lerpChannel(lo.rgb[1], hi.rgb[1], t),
        lerpChannel(lo.rgb[2], hi.rgb[2], t)
      )
    }
  }
  const c = stops[stops.length - 1]!.rgb
  return rgbStringFromPalette(c[0], c[1], c[2])
}

function rssiScaleGradientCss(): string {
  const stops = currentRssiColorStops()
  const minDb = stops[0]!.db
  const maxDb = stops[stops.length - 1]!.db
  const den = Math.max(1e-9, maxDb - minDb)
  const pts = stops.map((s) => ({
    pct: ((s.db - minDb) / den) * 100,
    color: rssiToColor(s.db),
  })).sort((a, b) => a.pct - b.pct)
  return `linear-gradient(90deg, ${pts.map((p) => `${p.color} ${p.pct.toFixed(2)}%`).join(', ')})`
}

function rssiBinMidColor(low: number, high: number): string {
  return rssiToColor((low + high) / 2)
}

function processMetricIsRssiView(): boolean {
  return processPlotMetric === 'rssi' && processRssiMergedPoints.length > 0
}

function getActiveProcessMerged(): MergedPlotPoint[] {
  return processMetricIsRssiView() ? processRssiMergedPoints : processMergedPoints
}

function getActiveProcessUnmatched(): UnmatchedTrailPoint[] {
  return processMetricIsRssiView() ? processRssiUnmatchedTrailPoints : processUnmatchedTrailPoints
}

function metricValueToColor(v: number): string {
  return processMetricIsRssiView() ? rssiToColor(v) : pathLossToColor(v)
}

function metricScaleGradientCss(): string {
  return processMetricIsRssiView() ? rssiScaleGradientCss() : pathLossScaleGradientCss()
}

function processHasPlOverlay(): boolean {
  return processMergedPoints.length > 0 || processUnmatchedTrailPoints.length > 0
}

function processHasRssiOverlay(): boolean {
  return processRssiMergedPoints.length > 0 || processRssiUnmatchedTrailPoints.length > 0
}

function syncProcessPlotMetricAfterPlot(
  plMergedN: number,
  plUnmatchedN: number,
  rssiMergedN: number,
  rssiUnmatchedN: number
): void {
  const plAny = plMergedN + plUnmatchedN > 0
  const rssiAny = rssiMergedN + rssiUnmatchedN > 0
  if (!plAny && !rssiAny) return
  if (plAny && !rssiAny) {
    processPlotMetric = 'path_loss'
    return
  }
  if (!plAny && rssiAny) {
    processPlotMetric = 'rssi'
    return
  }
}

function updateProcessMetricWrapVisibility(): void {
  const show = processHasPlOverlay() && processHasRssiOverlay()
  processMetricWrap.hidden = !show
  if (show) {
    processPlotMetricSelect.value = processPlotMetric
  }
}

const PROCESS_HIST_BIN_WIDTH_DB = 20
/** RSSI histogram uses 10 dBm bins (finer than path loss). */
const PROCESS_HIST_RSSI_BIN_WIDTH_DB = 10
/** Histogram range always extends to this path loss (dB) so the weakest bin (label e.g. 100–120) exists for very weak samples. */
const PROCESS_HIST_PL_HISTOGRAM_MIN = -120
/** RSSI histogram includes strong-signal bins up to −25 dBm. */
const PROCESS_HIST_RSSI_HISTOGRAM_MAX = -25

type PathLossBinRow = { low: number; high: number; count: number; seconds: number }

type HistogramExtentOpts = { minFloor?: number; maxCeil?: number }

/**
 * Bins aligned to multiples of `binWidthDb` dB; half-open [low, high).
 * **Seconds:** each interval from sample `i` to `i+1` (from trail timestamps) is added to the bin
 * containing sample `i`'s path loss (time walking until the next plotted point).
 * The minimum extent includes **−120 dB** so a **−120…−100 dB** bin appears (alongside existing 20 dB bins).
 */
function pathLossHistogramBinsFromMerged(
  points: MergedPlotPoint[],
  binWidthDb: number,
  extent?: HistogramExtentOpts
): PathLossBinRow[] {
  if (points.length === 0) return []
  let minV = points[0]!.pathLoss
  let maxV = minV
  for (const p of points) {
    if (p.pathLoss < minV) minV = p.pathLoss
    if (p.pathLoss > maxV) maxV = p.pathLoss
  }
  const minFloor = extent?.minFloor ?? PROCESS_HIST_PL_HISTOGRAM_MIN
  minV = Math.min(minFloor, minV)
  if (extent?.maxCeil != null) {
    maxV = Math.max(extent.maxCeil, maxV)
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

/**
 * Human-readable bin label: positive **loss magnitude** (no minus signs).
 * For standard negative path-loss bins, signed half-open `[low, high)` maps to magnitude **(|high|, |low|]** so
 * adjacent bins do not repeat the same integer at both edges (e.g. **81–100** then **101–120**, not 80–100 and 100–120).
 */
function formatPathLossBinLabel(low: number, high: number): string {
  if (high <= 0 && low < high) {
    const magOpen = Math.abs(high)
    const magClose = Math.abs(low)
    const a = Math.floor(magOpen) + 1
    const b = Math.ceil(magClose)
    return `${a}-${b}`
  }
  const lo = Math.round(Math.abs(low))
  const hi = Math.round(Math.abs(high))
  return `${Math.min(lo, hi)}-${Math.max(lo, hi)}`
}

function formatRssiBinLabel(low: number, high: number): string {
  const a = Math.round(Math.min(low, high))
  const b = Math.round(Math.max(low, high))
  return `${a}–${b}`
}

/** Bin midpoint (dB) for palette — same `pathLossToColor` as the Process map overlay. */
function pathLossBinMidColor(low: number, high: number): string {
  return pathLossToColor((low + high) / 2)
}

function onProcessPlStopColorInput(e: Event): void {
  const t = e.target as HTMLInputElement
  const i = Number(t.dataset.index)
  if (!Number.isFinite(i) || i < 0 || i >= plColorStops.length) return
  const rgb = hexToRgb255(t.value)
  if (!rgb) return
  plColorStops[i] = { db: plColorStops[i]!.db, rgb }
  savePlStopsToStorage()
  drawProcessOverlay()
}

function buildProcessPlStopsEditor(): void {
  processPlStopsEditor.replaceChildren()
  for (let i = 0; i < plColorStops.length; i++) {
    const s = plColorStops[i]!
    const row = document.createElement('div')
    row.className = 'process-pl-stop-row'
    const lab = document.createElement('span')
    lab.className = 'process-pl-stop-db'
    lab.textContent = `${s.db} dB`
    const inp = document.createElement('input')
    inp.type = 'color'
    inp.className = 'process-pl-stop-color'
    inp.value = rgbToHex255(s.rgb[0], s.rgb[1], s.rgb[2])
    inp.title = `Colour at ${s.db} dB path loss`
    inp.dataset.index = String(i)
    inp.addEventListener('input', onProcessPlStopColorInput)
    row.appendChild(lab)
    row.appendChild(inp)
    processPlStopsEditor.appendChild(row)
  }
}

function initProcessPlColourScale(): void {
  loadPlStopsFromStorage()
  buildProcessPlStopsEditor()
  processPlStopsReset.addEventListener('click', () => {
    plColorStops = cloneDefaultPlStops()
    savePlStopsToStorage()
    buildProcessPlStopsEditor()
    drawProcessOverlay()
  })
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function updateProcessHistogramPie(
  rows: PathLossBinRow[],
  totalCount: number,
  binMidColor: (low: number, high: number) => string = pathLossBinMidColor
): void {
  const svg = processHistogramPie
  svg.replaceChildren()
  if (totalCount <= 0) return

  const slices = rows.filter((r) => r.count > 0)
  if (slices.length === 0) return

  const cx = 50
  const cy = 50
  const r = 42

  if (slices.length === 1) {
    const row = slices[0]!
    const fill = binMidColor(row.low, row.high)
    const c = document.createElementNS(SVG_NS, 'circle')
    c.setAttribute('cx', String(cx))
    c.setAttribute('cy', String(cy))
    c.setAttribute('r', String(r))
    c.setAttribute('fill', fill)
    c.setAttribute('stroke', 'rgba(0,0,0,0.22)')
    c.setAttribute('stroke-width', '0.75')
    const title = document.createElementNS(SVG_NS, 'title')
    const lab = processMetricIsRssiView() ? `${formatRssiBinLabel(row.low, row.high)} dBm` : formatPathLossBinLabel(row.low, row.high)
    title.textContent = `${lab}: ${row.count} (100%)`
    c.appendChild(title)
    svg.appendChild(c)
    return
  }

  let a0 = -Math.PI / 2
  for (const row of slices) {
    const frac = row.count / totalCount
    const delta = frac * 2 * Math.PI
    const a1 = a0 + delta
    const x0 = cx + r * Math.cos(a0)
    const y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1)
    const y1 = cy + r * Math.sin(a1)
    const largeArc = delta > Math.PI ? 1 : 0
    const fill = binMidColor(row.low, row.high)
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute(
      'd',
      `M ${cx} ${cy} L ${x0.toFixed(4)} ${y0.toFixed(4)} A ${r} ${r} 0 ${largeArc} 1 ${x1.toFixed(4)} ${y1.toFixed(4)} Z`,
    )
    path.setAttribute('fill', fill)
    path.setAttribute('stroke', 'rgba(0,0,0,0.22)')
    path.setAttribute('stroke-width', '0.75')
    const title = document.createElementNS(SVG_NS, 'title')
    const pct = (100 * row.count) / totalCount
    const lab2 = processMetricIsRssiView() ? `${formatRssiBinLabel(row.low, row.high)} dBm` : formatPathLossBinLabel(row.low, row.high)
    title.textContent = `${lab2}: ${row.count} (${pct.toFixed(1)}%)`
    path.appendChild(title)
    svg.appendChild(path)
    a0 = a1
  }
}

function updateProcessHistogramTable(): void {
  const merged = getActiveProcessMerged()
  const n = merged.length
  if (n === 0) {
    processHistogramWrap.hidden = true
    processHistogramBody.innerHTML = ''
    processHistogramPie.replaceChildren()
    processHistogramMeta.textContent = ''
    processRssiThresholdResults.textContent = ''
    processRssiThresholds.hidden = true
    processColourScale.hidden = false
    return
  }
  const rssiView = processMetricIsRssiView()
  const binW = rssiView ? PROCESS_HIST_RSSI_BIN_WIDTH_DB : PROCESS_HIST_BIN_WIDTH_DB
  const rows = pathLossHistogramBinsFromMerged(
    merged,
    binW,
    rssiView ? { minFloor: PROCESS_HIST_PL_HISTOGRAM_MIN, maxCeil: PROCESS_HIST_RSSI_HISTOGRAM_MAX } : undefined
  )
  const total = n
  const binMid = rssiView ? rssiBinMidColor : pathLossBinMidColor
  const rangeLabel = rssiView ? formatRssiBinLabel : formatPathLossBinLabel
  const rangeTh = rssiView ? 'Range (dBm)' : 'Range (dB)'
  const rssiDataSuffix = processRssiLeeEnabled
    ? `filtered data = Lee criterion<f=${clampRssiLeeFreqMhz(processRssiLeeFreqMhz).toFixed(0)} MHz, v=${clampRssiLeeSpeedMps(processRssiLeeSpeedMps).toFixed(2)} m/s>`
    : processRssiRollingEnabled
      ? `filtered data = rolling average<${processRssiRollingWindow}>`
      : 'Raw data'
  const rssiResampleSuffix =
    processRssiResampleHz > 0 ? `; resampled to ${processRssiResampleHz} Hz` : ''
  processHistogramTitle.textContent = rssiView
    ? `RSSI histogram (${PROCESS_HIST_RSSI_BIN_WIDTH_DB} dBm bins, −120…−25 dBm) ${rssiDataSuffix}${rssiResampleSuffix}`
    : `Path loss histogram (${PROCESS_HIST_BIN_WIDTH_DB} dB bins, down to −120 dB)`
  const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0)
  processHistogramMeta.textContent = rssiView
    ? `${total.toLocaleString()} samples (post-filter) · ${totalSeconds.toFixed(1)} total seconds`
    : `${total.toLocaleString()} samples · ${totalSeconds.toFixed(1)} total seconds`
  processHistogramRangeTh.textContent = rangeTh
  processHistogramPie.setAttribute(
    'aria-label',
    rssiView ? 'RSSI share by bin (same colors as map)' : 'Path loss share by bin (same colors as map)',
  )
  processColourScale.hidden = rssiView
  const parts: string[] = []
  for (const r of rows) {
    const pct = total > 0 ? (100 * r.count) / total : 0
    const sw = binMid(r.low, r.high)
    const cellRange = rssiView ? `${rangeLabel(r.low, r.high)} dBm` : rangeLabel(r.low, r.high)
    parts.push(
      `<tr><td class="process-hist-col-swatch"><span class="process-hist-swatch" style="background:${sw}" title="Mid-bin colour" role="presentation"></span></td><td>${cellRange}</td><td>${r.count}</td><td>${r.seconds.toFixed(1)}</td><td>${pct.toFixed(1)}</td></tr>`,
    )
  }
  processHistogramBody.innerHTML = parts.join('')
  updateProcessHistogramPie(rows, total, binMid)
  processRssiThresholds.hidden = !rssiView
  if (rssiView) {
    const minHitCount = merged.reduce((acc, pt) => acc + (pt.pathLoss >= processRssiThresholdMinDb ? 1 : 0), 0)
    const maxHitCount = merged.reduce((acc, pt) => acc + (pt.pathLoss <= processRssiThresholdMaxDb ? 1 : 0), 0)
    const minPct = total > 0 ? (100 * minHitCount) / total : 0
    const maxPct = total > 0 ? (100 * maxHitCount) / total : 0
    const minPass = minPct >= processRssiThresholdMinPct
    const maxPass = maxPct >= processRssiThresholdMaxPct
    const minStatusClass = minPass ? 'process-rssi-threshold-pass' : 'process-rssi-threshold-fail'
    const maxStatusClass = maxPass ? 'process-rssi-threshold-pass' : 'process-rssi-threshold-fail'
    processRssiThresholdResults.innerHTML =
      `<span class="${minStatusClass}">MIN >= ${processRssiThresholdMinDb.toFixed(0)} dBm: ${minPct.toFixed(1)}% (target ${processRssiThresholdMinPct.toFixed(1)}%)</span>` +
      ` · <span class="${maxStatusClass}">MAX <= ${processRssiThresholdMaxDb.toFixed(0)} dBm: ${maxPct.toFixed(1)}% (target ${processRssiThresholdMaxPct.toFixed(1)}%)</span>`
  } else {
    processRssiThresholdResults.textContent = ''
  }
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
  const hasPlRaw = processMergedPointsRaw.length > 0
  const hasRssiRaw = processRssiMergedPointsRaw.length > 0
  if (!hasPlRaw && !hasRssiRaw) {
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
  const rssiView = (processMetricIsRssiView() && hasRssiRaw) || (!hasPlRaw && hasRssiRaw)
  if (rssiView) {
    if (d < 0) {
      processFsplDelta.textContent = `At ${fEst} MHz, RSSI is ~${ad.toFixed(2)} dB higher than at ${fMeas} MHz (free space).`
    } else if (d > 0) {
      processFsplDelta.textContent = `At ${fEst} MHz, RSSI is ~${ad.toFixed(2)} dB lower than at ${fMeas} MHz (free space).`
    } else {
      processFsplDelta.textContent = 'Same frequency — no change.'
    }
    return
  }
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
  const hasPlRaw = processMergedPointsRaw.length > 0
  const hasRssiRaw = processRssiMergedPointsRaw.length > 0
  if (!hasPlRaw && !hasRssiRaw) {
    processMergedPoints = []
    processRssiMergedPoints = []
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
  if (hasPlRaw) {
    const negConv = fsplPathLossNegativeConvention(processMergedPointsRaw)
    const delta = negConv ? -deltaRaw : deltaRaw
    processMergedPoints = processMergedPointsRaw.map((p) => ({
      ...p,
      pathLoss: p.pathLoss + delta,
    }))
  } else {
    processMergedPoints = []
  }
  if (hasRssiRaw) {
    const deltaRssi = -deltaRaw
    const offsetRssi = processRssiOffsetDb
    processRssiMergedPoints = processRssiMergedPointsRaw.map((p) => ({
      ...p,
      pathLoss: p.pathLoss + offsetRssi + deltaRssi,
    }))
  } else {
    processRssiMergedPoints = []
  }
  updateProcessFsplDeltaLabel()
}

function updateProcessFsplChrome(): void {
  const has = processMergedPointsRaw.length > 0 || processRssiMergedPointsRaw.length > 0
  const hasRssi = processRssiMergedPointsRaw.length > 0
  const hasMetricOverlay = processHasPlOverlay() || processHasRssiOverlay()
  const hasMap = Boolean(processImg.naturalWidth)
  processFsplWrap.hidden = !has
  processFsplEnable.disabled = !has
  processFsplRef.disabled = !has
  processFsplTarget.disabled = !has
  processRssiAdjustWrap.hidden = !hasRssi
  processRssiOffsetInput.disabled = !hasRssi
  processRssiOffsetReset.disabled = !hasRssi
  processRssiPaletteSelect.disabled = !hasRssi
  processHeatmapWrap.hidden = !hasMetricOverlay
  processShowHeatmapInput.disabled = !hasMetricOverlay
  processHeatmapUseBoundaryInput.disabled = !hasMetricOverlay
  processHeatmapDrawBoundaryInput.disabled = !hasMap
  processHeatmapRadiusInput.disabled = !hasMetricOverlay || !processShowHeatmap
  processHeatmapOpacityInput.disabled = !hasMetricOverlay || !processShowHeatmap
  if (!hasMap) {
    processHeatmapDrawBoundary = false
    processHeatmapBoundaryDragIndex = null
  }
  syncProcessHeatmapControls()
  if (!has) {
    processFsplDelta.textContent = ''
  }
}

function updateProcessBundleButtons(): void {
  const hasPlan = Boolean(processImg.naturalWidth)
  const hasTrail = processTrailEditable.length > 0
  const hasPl =
    processPathLossCsvText.trim().length > 0 || Boolean(processFilePl.files?.[0])
  const hasRssi =
    processRssiCsvText.trim().length > 0 || Boolean(processFileRssi.files?.[0])
  processBtnSaveBundle.disabled = !(hasPlan && hasTrail && (hasPl || hasRssi))
}

function buildCurrentProcessConfigComparableSig(): string {
  const rssiFilterMode: 'raw' | 'rolling' | 'lee' = processRssiLeeEnabled
    ? 'lee'
    : processRssiRollingEnabled
      ? 'rolling'
      : 'raw'
  return JSON.stringify({
    settings: collectCurrentProcessBundleSettings(),
    rssiFilter: {
      mode: rssiFilterMode,
      rollingWindow: processRssiRollingWindow,
      leeFreqMhz: processRssiLeeFreqMhz,
      leeSpeedMps: processRssiLeeSpeedMps,
      resampleHz: processRssiResampleHz,
    },
    paletteSaturation: processPaletteSaturation,
    pathLossStops: plColorStops.map((s) => ({ db: s.db, rgb: [s.rgb[0], s.rgb[1], s.rgb[2]] })),
  })
}

function processConfigSummaryLabel(): string {
  if (!loadedProcessConfigFilename) return '—'
  if (!loadedProcessConfigBaselineSig) return loadedProcessConfigFilename
  const dirty = buildCurrentProcessConfigComparableSig() !== loadedProcessConfigBaselineSig
  return dirty ? `${loadedProcessConfigFilename} (modified)` : loadedProcessConfigFilename
}

function updateProcessBundleConfigSummaryLabels(): void {
  processFilenameDataBundle.textContent = loadedProcessDataBundleFilename ?? '—'
  processFilenameConfig.textContent = processConfigSummaryLabel()
}

function updateProcessFileSummary(): void {
  if (processBundleSummaryOverride) {
    processFilenamePlan.textContent = processBundleSummaryOverride.plan
    processFilenameWalk.textContent = processBundleSummaryOverride.walk
    processFilenamePl.textContent = processBundleSummaryOverride.pl
    processFilenameRssi.textContent = processBundleSummaryOverride.rssi
    updateProcessBundleConfigSummaryLabels()
    updateProcessBundleButtons()
    updateRssiGraphSaveButton()
    if (currentTab === 'rssi_graph') {
      drawRssiGraph()
    }
    return
  }
  const label = (f: File | undefined) => f?.name ?? '—'
  processFilenamePlan.textContent = label(processFilePlan.files?.[0])
  processFilenameWalk.textContent = label(processFileWalk.files?.[0])
  processFilenamePl.textContent = label(processFilePl.files?.[0])
  processFilenameRssi.textContent = label(processFileRssi.files?.[0])
  updateProcessBundleConfigSummaryLabels()
  updateProcessBundleButtons()
  updateRssiGraphSaveButton()
  if (currentTab === 'rssi_graph') {
    drawRssiGraph()
  }
}

function clearProcessTrailState(): void {
  processWalkPreamble = ''
  processWalkTail = ''
  processTrailEditable = []
  processTrailOriginal = []
  processWalkTestDate = null
  processMergedPoints = []
  processMergedPointsRaw = []
  processUnmatchedTrailPoints = []
  processPathLossCsvText = ''
  processRssiCsvText = ''
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
  processHeatmapBoundaryPoints = []
  processHeatmapBoundaryClosed = false
  processHeatmapDrawBoundary = false
  processHeatmapBoundaryDragIndex = null
  processHeatmapUseBoundary = false
  processPlotMetric = 'rssi'
  processBundleSummaryOverride = null
  loadedProcessDataBundleFilename = null
  pendingBundleSettings = null
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

/** Map intrinsic image pixels to overlay canvas coords, including user overlay shift. */
function processImgToOverlayLocal(ix: number, iy: number): { x: number; y: number } | null {
  if (!processImg.naturalWidth) return null
  return imagePixelToElementLocal(
    ix + processOverlayShiftX,
    iy + processOverlayShiftY,
    processImg
  )
}

/** Apply current Process flip orientation to the floor plan element. */
function applyProcessPlanFlipCss(): void {
  processImg.classList.toggle('process-plan--flip-x', processPlanFlipX)
  processImg.classList.toggle('process-plan--flip-y', processPlanFlipY)
}

function loadProcessOverlayShiftFromStorage(): void {
  processOverlayShiftX = 0
  processOverlayShiftY = 0
  try {
    const raw = localStorage.getItem(PROCESS_OVERLAY_SHIFT_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { x?: unknown; y?: unknown }
    const x = Number(o.x)
    const y = Number(o.y)
    if (Number.isFinite(x)) processOverlayShiftX = x
    if (Number.isFinite(y)) processOverlayShiftY = y
  } catch {
    /* ignore */
  }
}

function saveProcessOverlayShiftToStorage(): void {
  try {
    localStorage.setItem(
      PROCESS_OVERLAY_SHIFT_STORAGE_KEY,
      JSON.stringify({ x: processOverlayShiftX, y: processOverlayShiftY }),
    )
  } catch {
    /* ignore */
  }
}

function loadProcessPlanFlipFromStorage(): void {
  processPlanFlipX = false
  processPlanFlipY = false
  try {
    const raw = localStorage.getItem(PROCESS_PLAN_FLIP_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { flipX?: unknown; flipY?: unknown }
    processPlanFlipX = Boolean(o.flipX)
    processPlanFlipY = Boolean(o.flipY)
  } catch {
    /* ignore */
  }
}

function saveProcessPlanFlipToStorage(): void {
  try {
    localStorage.setItem(
      PROCESS_PLAN_FLIP_STORAGE_KEY,
      JSON.stringify({ flipX: processPlanFlipX, flipY: processPlanFlipY }),
    )
  } catch {
    /* ignore */
  }
}

function syncProcessPlanFlipInputs(): void {
  processFlipXInput.checked = processPlanFlipX
  processFlipYInput.checked = processPlanFlipY
}

function commitProcessPlanFlipFromInputs(): void {
  processPlanFlipX = processFlipXInput.checked
  processPlanFlipY = processFlipYInput.checked
  applyProcessPlanFlipCss()
  saveProcessPlanFlipToStorage()
  drawProcessOverlay()
}

function syncProcessOverlayShiftInputs(): void {
  processShiftXInput.value = String(processOverlayShiftX)
  processShiftYInput.value = String(processOverlayShiftY)
}

function snapShiftTo10Px(v: number): number {
  return Math.round(v / 10) * 10
}

function commitProcessOverlayShiftFromInputs(): void {
  const x = Number(processShiftXInput.value)
  const y = Number(processShiftYInput.value)
  processOverlayShiftX = Number.isFinite(x) ? snapShiftTo10Px(x) : 0
  processOverlayShiftY = Number.isFinite(y) ? snapShiftTo10Px(y) : 0
  syncProcessOverlayShiftInputs()
  saveProcessOverlayShiftToStorage()
  drawProcessOverlay()
}

function setSelectValueIfExists(sel: HTMLSelectElement, value: string): void {
  if ([...sel.options].some((o) => o.value === value)) {
    sel.value = value
  }
}

function collectCurrentProcessBundleSettings(): ProcessBundleSettingsV1 {
  return {
    overlayShiftPx: {
      x: processOverlayShiftX,
      y: processOverlayShiftY,
    },
    flip: {
      x: processPlanFlipX,
      y: processPlanFlipY,
    },
    dotScale: processDotScale,
    rssiOffsetDb: processRssiOffsetDb,
    rssiPalette: processRssiPalette,
    rssiHistogramThresholds: {
      minDb: processRssiThresholdMinDb,
      minPct: processRssiThresholdMinPct,
      maxDb: processRssiThresholdMaxDb,
      maxPct: processRssiThresholdMaxPct,
    },
    heatmap: {
      enabled: processShowHeatmap,
      useBoundary: processHeatmapUseBoundary,
      boundaryClosed: processHeatmapBoundaryClosed,
      boundaryPoints: processHeatmapBoundaryPoints.map((p) => ({ x: p.x, y: p.y })),
      radiusPx: processHeatmapRadiusPx,
      opacity: processHeatmapOpacity,
    },
    plotMetric: processPlotMetric,
    show: {
      pointLabels: processShowPlLabels.checked,
      route: processShowPlRoute.checked,
      colorTrail: processShowPlColoredTrail.checked,
    },
    fspl: {
      enabled: processFsplEnable.checked,
      measuredMhz: Number(processFsplRef.value),
      estimateMhz: Number(processFsplTarget.value),
    },
  }
}

function collectCurrentProcessConfig(): ProcessConfigV1 {
  const rssiFilterMode: 'raw' | 'rolling' | 'lee' = processRssiLeeEnabled
    ? 'lee'
    : processRssiRollingEnabled
      ? 'rolling'
      : 'raw'
  return {
    walkplotterProcessConfigVersion: PROCESS_CONFIG_VERSION,
    app: 'walkplotter',
    savedAt: new Date().toISOString(),
    settings: collectCurrentProcessBundleSettings(),
    rssiFilter: {
      mode: rssiFilterMode,
      rollingWindow: processRssiRollingWindow,
      leeFreqMhz: processRssiLeeFreqMhz,
      leeSpeedMps: processRssiLeeSpeedMps,
      resampleHz: processRssiResampleHz,
    },
    paletteSaturation: processPaletteSaturation,
    pathLossStops: plColorStops.map((s) => ({ db: s.db, rgb: [s.rgb[0], s.rgb[1], s.rgb[2]] })),
  }
}

function applyProcessBundleSettings(settings: ProcessBundleSettingsV1): void {
  if (settings.overlayShiftPx) {
    processOverlayShiftX = snapShiftTo10Px(settings.overlayShiftPx.x)
    processOverlayShiftY = snapShiftTo10Px(settings.overlayShiftPx.y)
    syncProcessOverlayShiftInputs()
    saveProcessOverlayShiftToStorage()
  }
  if (settings.flip) {
    processPlanFlipX = settings.flip.x
    processPlanFlipY = settings.flip.y
    syncProcessPlanFlipInputs()
    applyProcessPlanFlipCss()
    saveProcessPlanFlipToStorage()
  }
  if (typeof settings.dotScale === 'number' && Number.isFinite(settings.dotScale)) {
    processDotScale = clampProcessDotScale(settings.dotScale)
    syncProcessDotSizeControl()
    saveProcessDotScaleToStorage()
  }
  if (typeof settings.rssiOffsetDb === 'number' && Number.isFinite(settings.rssiOffsetDb)) {
    processRssiOffsetDb = settings.rssiOffsetDb
    syncProcessRssiOffsetInput()
    saveProcessRssiOffsetToStorage()
  }
  if (settings.rssiPalette) {
    processRssiPalette = clampRssiPaletteName(settings.rssiPalette)
    syncProcessRssiPaletteControl()
    saveProcessRssiPaletteToStorage()
  }
  if (settings.rssiHistogramThresholds) {
    if (typeof settings.rssiHistogramThresholds.minDb === 'number') {
      processRssiThresholdMinDb = clampRssiThresholdDb(
        settings.rssiHistogramThresholds.minDb,
        processRssiThresholdMinDb,
      )
    }
    if (typeof settings.rssiHistogramThresholds.minPct === 'number') {
      processRssiThresholdMinPct = clampRssiThresholdPct(
        settings.rssiHistogramThresholds.minPct,
        processRssiThresholdMinPct,
      )
    }
    if (typeof settings.rssiHistogramThresholds.maxDb === 'number') {
      processRssiThresholdMaxDb = clampRssiThresholdDb(
        settings.rssiHistogramThresholds.maxDb,
        processRssiThresholdMaxDb,
      )
    }
    if (typeof settings.rssiHistogramThresholds.maxPct === 'number') {
      processRssiThresholdMaxPct = clampRssiThresholdPct(
        settings.rssiHistogramThresholds.maxPct,
        processRssiThresholdMaxPct,
      )
    }
    syncRssiHistogramThresholdInputs()
  }
  if (settings.heatmap) {
    if (typeof settings.heatmap.enabled === 'boolean') {
      processShowHeatmap = settings.heatmap.enabled
    }
    if (typeof settings.heatmap.radiusPx === 'number' && Number.isFinite(settings.heatmap.radiusPx)) {
      processHeatmapRadiusPx = Math.max(20, Math.min(1000, settings.heatmap.radiusPx))
    }
    if (typeof settings.heatmap.opacity === 'number' && Number.isFinite(settings.heatmap.opacity)) {
      processHeatmapOpacity = Math.max(0.1, Math.min(1, settings.heatmap.opacity))
    }
    if (typeof settings.heatmap.useBoundary === 'boolean') {
      processHeatmapUseBoundary = settings.heatmap.useBoundary
    }
    if (typeof settings.heatmap.boundaryClosed === 'boolean') {
      processHeatmapBoundaryClosed = settings.heatmap.boundaryClosed
    }
    if (Array.isArray(settings.heatmap.boundaryPoints)) {
      processHeatmapBoundaryPoints = settings.heatmap.boundaryPoints.map((p) => ({ x: p.x, y: p.y }))
    }
    if (processHeatmapBoundaryPoints.length < 3) {
      processHeatmapBoundaryClosed = false
    }
    processHeatmapBoundaryDragIndex = null
    processHeatmapDrawBoundary = false
    syncProcessHeatmapControls()
    saveProcessHeatmapToStorage()
  }
  if (settings.plotMetric === 'path_loss' || settings.plotMetric === 'rssi') {
    processPlotMetric = settings.plotMetric
    processPlotMetricSelect.value = settings.plotMetric
  }
  if (settings.show) {
    if (typeof settings.show.pointLabels === 'boolean') {
      processShowPlLabels.checked = settings.show.pointLabels
    }
    if (typeof settings.show.route === 'boolean') {
      processShowPlRoute.checked = settings.show.route
    }
    if (typeof settings.show.colorTrail === 'boolean') {
      processShowPlColoredTrail.checked = settings.show.colorTrail
    }
  }
  if (settings.fspl) {
    if (typeof settings.fspl.enabled === 'boolean') {
      processFsplEnable.checked = settings.fspl.enabled
    }
    if (typeof settings.fspl.measuredMhz === 'number' && Number.isFinite(settings.fspl.measuredMhz)) {
      setSelectValueIfExists(processFsplRef, String(Math.round(settings.fspl.measuredMhz)))
    }
    if (typeof settings.fspl.estimateMhz === 'number' && Number.isFinite(settings.fspl.estimateMhz)) {
      setSelectValueIfExists(processFsplTarget, String(Math.round(settings.fspl.estimateMhz)))
    }
    updateProcessFsplDeltaLabel()
  }
}

function applyProcessConfig(config: ProcessConfigV1): void {
  applyProcessBundleSettings(config.settings)

  if (config.rssiFilter) {
    processRssiRollingWindow = clampRssiRollingWindow(
      Number(config.rssiFilter.rollingWindow ?? processRssiRollingWindow)
    )
    processRssiLeeFreqMhz = clampRssiLeeFreqMhz(
      Number(config.rssiFilter.leeFreqMhz ?? processRssiLeeFreqMhz)
    )
    processRssiLeeSpeedMps = clampRssiLeeSpeedMps(
      Number(config.rssiFilter.leeSpeedMps ?? processRssiLeeSpeedMps)
    )
    processRssiResampleHz = clampRssiResampleHz(
      Number(config.rssiFilter.resampleHz ?? processRssiResampleHz)
    )
    if (config.rssiFilter.mode === 'lee') {
      processRssiLeeEnabled = true
      processRssiRollingEnabled = false
    } else if (config.rssiFilter.mode === 'rolling') {
      processRssiRollingEnabled = true
      processRssiLeeEnabled = false
    } else {
      processRssiRollingEnabled = false
      processRssiLeeEnabled = false
    }
    syncRssiGraphFilterControls()
  }

  if (typeof config.paletteSaturation === 'number' && Number.isFinite(config.paletteSaturation)) {
    processPaletteSaturation = Math.max(0, Math.min(2, config.paletteSaturation))
    syncProcessDotSizeControl()
    saveProcessPaletteSaturationToStorage()
  }

  if (
    Array.isArray(config.pathLossStops) &&
    config.pathLossStops.length === plColorStops.length &&
    config.pathLossStops.every((stop, i) => stop.db === plColorStops[i]!.db)
  ) {
    plColorStops = config.pathLossStops.map((s) => ({
      db: s.db,
      rgb: [s.rgb[0], s.rgb[1], s.rgb[2]],
    }))
    savePlStopsToStorage()
    buildProcessPlStopsEditor()
  }

  const hasMap = Boolean(processImg.naturalWidth)
  const hasTrail = processTrailEditable.length > 0
  const hasOverlayInput = processPathLossCsvText.trim().length > 0 || processRssiCsvText.trim().length > 0
  if (hasMap && hasTrail && hasOverlayInput) {
    runProcessPlot()
  } else {
    rebuildProcessMergedFromFspl()
    drawProcessOverlay()
  }
}

function loadProcessDotScaleFromStorage(): void {
  processDotScale = 1
  try {
    const raw = localStorage.getItem(PROCESS_DOT_SCALE_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { scale?: unknown }
    const s = Number(o.scale)
    if (Number.isFinite(s)) processDotScale = clampProcessDotScale(s)
  } catch {
    /* ignore */
  }
}

function saveProcessDotScaleToStorage(): void {
  try {
    localStorage.setItem(PROCESS_DOT_SCALE_STORAGE_KEY, JSON.stringify({ scale: processDotScale }))
  } catch {
    /* ignore */
  }
}

function loadProcessPaletteSaturationFromStorage(): void {
  processPaletteSaturation = 1
  try {
    const raw = localStorage.getItem(PROCESS_PALETTE_SAT_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { saturation?: unknown }
    const s = Number(o.saturation)
    if (Number.isFinite(s)) processPaletteSaturation = Math.max(0, Math.min(2, s))
  } catch {
    /* ignore */
  }
}

function saveProcessPaletteSaturationToStorage(): void {
  try {
    localStorage.setItem(
      PROCESS_PALETTE_SAT_STORAGE_KEY,
      JSON.stringify({ saturation: processPaletteSaturation })
    )
  } catch {
    /* ignore */
  }
}

function loadProcessRssiOffsetFromStorage(): void {
  processRssiOffsetDb = 0
  try {
    const raw = localStorage.getItem(PROCESS_RSSI_OFFSET_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { offsetDb?: unknown }
    const v = Number(o.offsetDb)
    if (Number.isFinite(v)) processRssiOffsetDb = v
  } catch {
    /* ignore */
  }
}

function saveProcessRssiOffsetToStorage(): void {
  try {
    localStorage.setItem(PROCESS_RSSI_OFFSET_STORAGE_KEY, JSON.stringify({ offsetDb: processRssiOffsetDb }))
  } catch {
    /* ignore */
  }
}

function loadProcessRssiPaletteFromStorage(): void {
  processRssiPalette = 'jots'
  try {
    const raw = localStorage.getItem(PROCESS_RSSI_PALETTE_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { palette?: unknown }
    processRssiPalette = clampRssiPaletteName(o.palette)
  } catch {
    /* ignore */
  }
}

function saveProcessRssiPaletteToStorage(): void {
  try {
    localStorage.setItem(
      PROCESS_RSSI_PALETTE_STORAGE_KEY,
      JSON.stringify({ palette: processRssiPalette }),
    )
  } catch {
    /* ignore */
  }
}

function syncProcessRssiPaletteControl(): void {
  processRssiPaletteSelect.value = processRssiPalette
}

function syncProcessRssiOffsetInput(): void {
  processRssiOffsetInput.value = String(processRssiOffsetDb)
}

function commitProcessRssiOffsetFromInput(): void {
  const v = Number(processRssiOffsetInput.value)
  processRssiOffsetDb = Number.isFinite(v) ? v : 0
  syncProcessRssiOffsetInput()
  saveProcessRssiOffsetToStorage()
  rebuildProcessMergedFromFspl()
  drawProcessOverlay()
}

function loadProcessHeatmapFromStorage(): void {
  processShowHeatmap = false
  processHeatmapRadiusPx = 90
  processHeatmapOpacity = 0.55
  processHeatmapUseBoundary = false
  processHeatmapBoundaryClosed = false
  processHeatmapBoundaryPoints = []
  processHeatmapBoundaryDragIndex = null
  processHeatmapDrawBoundary = false
  try {
    const raw = localStorage.getItem(PROCESS_HEATMAP_STORAGE_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as {
      enabled?: unknown
      radiusPx?: unknown
      opacity?: unknown
      useBoundary?: unknown
      boundaryClosed?: unknown
      boundaryPoints?: unknown
    }
    processShowHeatmap = Boolean(o.enabled)
    const r = Number(o.radiusPx)
    const a = Number(o.opacity)
    if (Number.isFinite(r)) processHeatmapRadiusPx = Math.max(20, Math.min(1000, r))
    if (Number.isFinite(a)) processHeatmapOpacity = Math.max(0.1, Math.min(1, a))
    if (typeof o.useBoundary === 'boolean') processHeatmapUseBoundary = o.useBoundary
    if (typeof o.boundaryClosed === 'boolean') processHeatmapBoundaryClosed = o.boundaryClosed
    if (Array.isArray(o.boundaryPoints)) {
      processHeatmapBoundaryPoints = o.boundaryPoints
        .filter((p) => Boolean(p) && typeof p === 'object')
        .map((p) => {
          const rec = p as { x?: unknown; y?: unknown }
          const x = Number(rec.x)
          const y = Number(rec.y)
          return { x, y }
        })
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    }
    if (processHeatmapBoundaryPoints.length < 3) {
      processHeatmapBoundaryClosed = false
    }
  } catch {
    /* ignore */
  }
}

function saveProcessHeatmapToStorage(): void {
  try {
    localStorage.setItem(
      PROCESS_HEATMAP_STORAGE_KEY,
      JSON.stringify({
        enabled: processShowHeatmap,
        radiusPx: processHeatmapRadiusPx,
        opacity: processHeatmapOpacity,
        useBoundary: processHeatmapUseBoundary,
        boundaryClosed: processHeatmapBoundaryClosed,
        boundaryPoints: processHeatmapBoundaryPoints,
      }),
    )
  } catch {
    /* ignore */
  }
}

function syncProcessHeatmapControls(): void {
  processShowHeatmapInput.checked = processShowHeatmap
  processHeatmapUseBoundaryInput.checked = processHeatmapUseBoundary
  processHeatmapDrawBoundaryInput.checked = processHeatmapDrawBoundary
  processHeatmapRadiusInput.value = String(Math.round(processHeatmapRadiusPx))
  processHeatmapOpacityInput.value = String(Math.round(processHeatmapOpacity * 100))
  processHeatmapRadiusValue.textContent = `${Math.round(processHeatmapRadiusPx)} px`
  processHeatmapOpacityValue.textContent = `${Math.round(processHeatmapOpacity * 100)}%`
  processHeatmapCloseBoundaryBtn.disabled = processHeatmapBoundaryClosed || processHeatmapBoundaryPoints.length < 3
  processHeatmapClearBoundaryBtn.disabled = processHeatmapBoundaryPoints.length === 0
}

function updateProcessDotSizeLabel(): void {
  processDotSizePctEl.textContent = `${Math.round(processDotScale * 100)}%`
  processPaletteSatPctEl.textContent = `${Math.round(processPaletteSaturation * 100)}%`
}

function syncProcessDotSizeControl(): void {
  processDotSizeRange.value = String(Math.round(processDotScale * 100))
  processPaletteSatRange.value = String(Math.round(processPaletteSaturation * 100))
  updateProcessDotSizeLabel()
}

function processTrailDotRadius(): number {
  const w = processCanvas.width / (window.devicePixelRatio || 1)
  const h = processCanvas.height / (window.devicePixelRatio || 1)
  return Math.max(3, Math.min(w, h) / 80) * processDotScale
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
    const q = processImgToOverlayLocal(pt.x, pt.y)
    if (!q) continue
    const d = Math.hypot(lx - q.x, ly - q.y)
    if (d <= hitSlop && d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI
}

function clientToProcessBasePixel(clientX: number, clientY: number): { x: number; y: number } | null {
  if (!processImg.naturalWidth) return null
  const local = clientToElementLocal(clientX, clientY, processStageInner)
  if (!local) return null
  const imgLocalX = local.x - processImg.offsetLeft
  const imgLocalY = local.y - processImg.offsetTop
  const bw = processImg.offsetWidth
  const bh = processImg.offsetHeight
  const iw = processImg.naturalWidth
  const ih = processImg.naturalHeight
  if (bw <= 0 || bh <= 0 || iw <= 0 || ih <= 0) return null
  // Clamp into image bounds so edge clicks still resolve to valid pixels.
  const lx = Math.max(0, Math.min(bw, imgLocalX))
  const ly = Math.max(0, Math.min(bh, imgLocalY))
  const x = (lx / bw) * iw
  const y = (ly / bh) * ih
  return clampPixelToImage(
    x - processOverlayShiftX,
    y - processOverlayShiftY,
    processImg.naturalWidth,
    processImg.naturalHeight
  )
}

function handleBoundaryPointerDown(e: PointerEvent): boolean {
  if (!processHeatmapDrawBoundary || !processImg.naturalWidth) return false
  if (e.button !== 0 || e.altKey) return false
  const hitVertex = findBoundaryVertexHitIndex(e.clientX, e.clientY)
  if (!processHeatmapBoundaryClosed && hitVertex === 0 && processHeatmapBoundaryPoints.length >= 3) {
    processHeatmapBoundaryClosed = true
    processHeatmapUseBoundary = true
    syncProcessHeatmapControls()
    saveProcessHeatmapToStorage()
    drawProcessOverlay()
    e.preventDefault()
    return true
  }
  if (hitVertex !== null) {
    processHeatmapBoundaryDragIndex = hitVertex
    try {
      processCanvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore capture failures */
    }
    updateProcessTrailChrome()
    e.preventDefault()
    return true
  }
  if (processHeatmapBoundaryClosed) {
    e.preventDefault()
    return true
  }
  const px = clientToProcessBasePixel(e.clientX, e.clientY)
  if (!px) {
    e.preventDefault()
    return true
  }
  processHeatmapBoundaryPoints.push(px)
  if (processHeatmapBoundaryPoints.length >= 3) {
    processHeatmapUseBoundary = processHeatmapUseBoundaryInput.checked
  }
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
  e.preventDefault()
  return true
}

function findBoundaryVertexHitIndex(clientX: number, clientY: number, hitSlop = 12): number | null {
  if (!processHeatmapBoundaryPoints.length) return null
  const local = clientToElementLocal(clientX, clientY, processCanvas)
  if (!local) return null
  let bestI: number | null = null
  let bestD = Infinity
  for (let i = 0; i < processHeatmapBoundaryPoints.length; i++) {
    const p = processHeatmapBoundaryPoints[i]!
    const q = processImgToOverlayLocal(p.x, p.y)
    if (!q) continue
    const d = Math.hypot(local.x - q.x, local.y - q.y)
    if (d <= hitSlop && d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI
}

function drawHeatmapBoundaryOverlay(ctx: CanvasRenderingContext2D): void {
  if (!processHeatmapBoundaryPoints.length) return
  const pts = processHeatmapBoundaryPoints
    .map((p) => processImgToOverlayLocal(p.x, p.y))
    .filter((p): p is { x: number; y: number } => Boolean(p))
  if (!pts.length) return
  ctx.save()
  ctx.lineWidth = 2
  ctx.strokeStyle = processHeatmapUseBoundary && processHeatmapBoundaryClosed ? '#ffe082' : '#ffd54f'
  ctx.fillStyle = 'rgba(255, 213, 79, 0.18)'
  ctx.beginPath()
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x, pts[i]!.y)
  }
  if (processHeatmapBoundaryClosed && pts.length >= 3) {
    ctx.closePath()
    ctx.fill()
  }
  ctx.stroke()

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const isFirst = i === 0
    const r = isFirst ? 4.5 : 3.5
    ctx.beginPath()
    ctx.fillStyle = isFirst && !processHeatmapBoundaryClosed ? '#fff59d' : '#ffeb3b'
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#5d4037'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  ctx.restore()
}

function updateProcessTrailChrome(): void {
  const hasTrail = processTrailEditable.length > 0
  const hasMap = Boolean(processImg.naturalWidth)
  const hasAnyOverlay = processHasPlOverlay() || processHasRssiOverlay()
  const canNudge = hasTrail && hasMap
  processNudgeTrail.disabled = !canNudge
  if (!canNudge) {
    processNudgeTrail.checked = false
    processTrailDragIndex = null
  }
  processResetTrail.disabled = !hasTrail || !processTrailPixelsDirty()
  const saveDisabled = !hasTrail || !processTrailPixelsDirty()
  processSaveWalkEdited.disabled = saveDisabled
  processSaveWalkOriginal.disabled = saveDisabled
  processBtnClearPlot.disabled = !hasAnyOverlay
  processNudgeSnap.disabled = !canNudge || processTrailEditable.length < 2
  if (!canNudge || processTrailEditable.length < 2) {
    processNudgeSnap.value = 'off'
  }
  const allowNudge = canNudge && processNudgeTrail.checked
  const allowBoundaryDraw = hasMap && processHeatmapDrawBoundary
  const allowPointer = allowNudge || allowBoundaryDraw
  processCanvas.style.pointerEvents = allowPointer ? 'auto' : 'none'
  processCanvas.classList.toggle('process-overlay--adjust', allowPointer)
  if (allowPointer) {
    if (allowBoundaryDraw) {
      processCanvas.style.cursor = processHeatmapBoundaryDragIndex !== null ? 'grabbing' : 'crosshair'
    } else {
      processCanvas.style.cursor = processTrailDragIndex !== null ? 'grabbing' : 'grab'
    }
  } else {
    processCanvas.style.cursor = ''
  }
}

function onTrailPointerDown(e: PointerEvent): void {
  if (e.altKey && e.button === 0) return
  if (e.button !== 0) {
    return
  }
  if (handleBoundaryPointerDown(e)) return
  if (!processNudgeTrail.checked) return
  const i = findTrailHitIndex(e.clientX, e.clientY, processTrailDotRadius())
  if (i === null) return
  e.preventDefault()
  processMergedPoints = []
  processMergedPointsRaw = []
  processUnmatchedTrailPoints = []
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
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
  if (processHeatmapBoundaryDragIndex !== null && processImg.naturalWidth) {
    const px = clientToProcessBasePixel(e.clientX, e.clientY)
    if (!px) return
    processHeatmapBoundaryPoints[processHeatmapBoundaryDragIndex] = px
    drawProcessOverlay()
    e.preventDefault()
    return
  }
  if (processTrailDragIndex === null || !processImg.naturalWidth) return
  const iw = processImg.naturalWidth
  const ih = processImg.naturalHeight
  const basePx = clientToProcessBasePixel(e.clientX, e.clientY)
  if (!basePx) return
  let c = basePx
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
  processUnmatchedTrailPoints = []
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
  updateProcessFsplChrome()
  drawProcessOverlay()
  e.preventDefault()
}

function onTrailPointerUp(e: PointerEvent): void {
  if (processHeatmapBoundaryDragIndex !== null) {
    processHeatmapBoundaryDragIndex = null
    try {
      processCanvas.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    drawProcessOverlay()
    updateProcessTrailChrome()
    saveProcessHeatmapToStorage()
    return
  }
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
  processStatus.textContent = `Saved ${filename}.${hint} Plot overlay uses the trail currently in memory.`
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

function drawDistanceWeightedHeatmap(
  ctx: CanvasRenderingContext2D,
  merged: MergedPlotPoint[],
  w: number,
  h: number
): void {
  if (!processShowHeatmap || merged.length === 0 || w <= 1 || h <= 1) return
  const effectiveRadiusPx = processHeatmapRadiusPx * 0.94
  // Coarsen the working grid as radius grows to keep runtime practical.
  const ds = Math.max(4, Math.min(24, Math.round(effectiveRadiusPx / 120)))
  const gridW = Math.max(1, Math.ceil(w / ds))
  const gridH = Math.max(1, Math.ceil(h / ds))
  const n = gridW * gridH
  const valSum = new Float32Array(n)
  const wSum = new Float32Array(n)
  const radiusCells = Math.max(1, effectiveRadiusPx / ds)
  const radius2 = radiusCells * radiusCells
  const boundaryOverlay: { x: number; y: number }[] =
    processHeatmapUseBoundary && processHeatmapBoundaryClosed
      ? processHeatmapBoundaryPoints
          .map((p) => processImgToOverlayLocal(p.x, p.y))
          .filter((p): p is { x: number; y: number } => Boolean(p))
      : []
  const useBoundaryMask = boundaryOverlay.length >= 3

  for (const pt of merged) {
    const q = processImgToOverlayLocal(pt.x, pt.y)
    if (!q) continue
    const cx = q.x / ds
    const cy = q.y / ds
    const x0 = Math.max(0, Math.floor(cx - radiusCells))
    const x1 = Math.min(gridW - 1, Math.ceil(cx + radiusCells))
    const y0 = Math.max(0, Math.floor(cy - radiusCells))
    const y1 = Math.min(gridH - 1, Math.ceil(cy + radiusCells))
    for (let gy = y0; gy <= y1; gy++) {
      const dy = gy - cy
      const dy2 = dy * dy
      const row = gy * gridW
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx - cx
        const d2 = dx * dx + dy2
        if (d2 > radius2) continue
        // Polynomial kernel keeps stronger influence at distance than inverse-square.
        const t = 1 - d2 / radius2
        const weight = t * t
        const idx = row + gx
        valSum[idx] += pt.pathLoss * weight
        wSum[idx] += weight
      }
    }
  }

  if (!processHeatmapWorkCanvas) {
    processHeatmapWorkCanvas = document.createElement('canvas')
  }
  const heatCanvas = processHeatmapWorkCanvas
  heatCanvas.width = gridW
  heatCanvas.height = gridH
  const hctx = heatCanvas.getContext('2d')
  if (!hctx) return
  const imgData = hctx.createImageData(gridW, gridH)
  const data = imgData.data
  const baseAlpha = Math.max(0, Math.min(1, processHeatmapOpacity))

  for (let i = 0; i < n; i++) {
    const ws = wSum[i]!
    if (ws <= 0) continue
    if (useBoundaryMask) {
      const gx = i % gridW
      const gy = Math.floor(i / gridW)
      const cx = (gx + 0.5) * ds
      const cy = (gy + 0.5) * ds
      if (!pointInPolygon(cx, cy, boundaryOverlay)) continue
    }
    const v = valSum[i]! / ws
    const rgb = parseRgbLike(metricValueToColor(v))
    if (!rgb) continue
    const density = Math.min(1, Math.sqrt(ws) * 1.25)
    const a = Math.round(255 * baseAlpha * density)
    const p = i * 4
    data[p] = rgb[0]
    data[p + 1] = rgb[1]
    data[p + 2] = rgb[2]
    data[p + 3] = a
  }

  hctx.putImageData(imgData, 0, 0)
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(heatCanvas, 0, 0, gridW, gridH, 0, 0, w, h)
  ctx.restore()
}

function drawProcessOverlay(): void {
  updateProcessBundleConfigSummaryLabels()
  const ctx = processCanvas.getContext('2d')
  if (!ctx || !processImg.naturalWidth) {
    if (processLegend) processLegend.hidden = true
    processHistogramWrap.hidden = true
    processMetricWrap.hidden = true
    updateProcessTrailChrome()
    return
  }
  syncProcessOverlayCanvas()
  const w = processCanvas.width / (window.devicePixelRatio || 1)
  const h = processCanvas.height / (window.devicePixelRatio || 1)
  ctx.clearRect(0, 0, w, h)

  const showMetricOverlay = processHasPlOverlay() || processHasRssiOverlay()
  const hasTrail = processTrailEditable.length > 0
  const dotR = Math.max(3, Math.min(w, h) / 80) * processDotScale

  if (showMetricOverlay) {
    updateProcessMetricWrapVisibility()
    const merged = getActiveProcessMerged()
    const unmatched = getActiveProcessUnmatched()
    drawDistanceWeightedHeatmap(ctx, merged, w, h)
    const routeColors = getOverlayColors()
    const routePs = Math.min(1.2, Math.max(0.8, dotR / 5))
    const trailDiameter = 2 * dotR
    let minV = 0
    let maxV = 0
    if (merged.length > 0) {
      minV = merged[0]!.pathLoss
      maxV = minV
      for (const p of merged) {
        if (p.pathLoss < minV) minV = p.pathLoss
        if (p.pathLoss > maxV) maxV = p.pathLoss
      }
    }
    if (processShowPlColoredTrail.checked && merged.length > 1) {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.globalAlpha = 1
      for (let i = 0; i < merged.length - 1; i++) {
        const a = merged[i]!
        const b = merged[i + 1]!
        const q0 = processImgToOverlayLocal(a.x, a.y)
        const q1 = processImgToOverlayLocal(b.x, b.y)
        if (!q0 || !q1) continue
        const g = ctx.createLinearGradient(q0.x, q0.y, q1.x, q1.y)
        g.addColorStop(0, metricValueToColor(a.pathLoss))
        g.addColorStop(1, metricValueToColor(b.pathLoss))
        ctx.strokeStyle = g
        ctx.lineWidth = trailDiameter
        ctx.beginPath()
        ctx.moveTo(q0.x, q0.y)
        ctx.lineTo(q1.x, q1.y)
        ctx.stroke()
      }
    }
    if (processShowPlRoute.checked && merged.length > 1) {
      ctx.strokeStyle = routeColors.trailLine
      ctx.globalAlpha = 0.5
      ctx.lineWidth = Math.max(1.25, 2 * routePs)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      let first = true
      for (const pt of merged) {
        const q = processImgToOverlayLocal(pt.x, pt.y)
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
    const trailOnlyRibbon = processShowPlColoredTrail.checked && merged.length > 1
    if (!trailOnlyRibbon) {
      for (const pt of merged) {
        const q = processImgToOverlayLocal(pt.x, pt.y)
        if (!q) continue
        const isOriginalWalk = pt.source !== 'interpolated'
        ctx.fillStyle = metricValueToColor(pt.pathLoss)
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
    for (const pt of unmatched) {
      const q = processImgToOverlayLocal(pt.x, pt.y)
      if (!q) continue
      ctx.fillStyle = '#000000'
      ctx.beginPath()
      ctx.arc(q.x, q.y, dotR, 0, Math.PI * 2)
      ctx.fill()
    }
    if (processShowPlLabels.checked && merged.length > 0) {
      const fontPx = Math.max(11, Math.min(16, Math.min(w, h) / 48))
      ctx.font = `600 ${fontPx}px system-ui, Segoe UI, sans-serif`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      const labelDx = trailOnlyRibbon ? trailDiameter / 2 + 5 : dotR + 4
      const unit = processMetricIsRssiView() ? 'dBm' : 'dB'
      for (const pt of merged) {
        const q = processImgToOverlayLocal(pt.x, pt.y)
        if (!q) continue
        const text = `${pt.pathLoss.toFixed(1)} ${unit}`
        const lx = q.x + labelDx
        const ly = q.y
        ctx.lineWidth = Math.max(2, fontPx * 0.22)
        ctx.strokeStyle = 'rgba(0,0,0,0.82)'
        ctx.strokeText(text, lx, ly)
        ctx.fillStyle = 'rgba(255,255,255,0.96)'
        ctx.fillText(text, lx, ly)
      }
    }
    const nInterp = merged.filter((p) => p.source === 'interpolated').length
    const nUser = merged.length - nInterp
    const ringTitle = processMetricIsRssiView()
      ? 'Original (non-interpolated) points — grey ring; fill is RSSI (dBm).'
      : 'Original (non-interpolated) points — grey ring; fill is still path loss (dB).'
    const walkTypesLegend =
      merged.length > 0 && (nUser > 0 || nInterp > 0)
        ? `<span>Walk: <strong>${nUser}</strong> original <span class="process-legend-user-ring" title="${ringTitle}"></span> · <strong>${nInterp}</strong> interpolated (no ring)</span>`
        : ''
    const unmatchedLegend =
      unmatched.length > 0
        ? `<span><strong>${unmatched.length}</strong> trail pt(s): no RF within <strong>${DEFAULT_MAX_MATCH_MS / 1000}s</strong> — <span class="process-legend-unmatched" title="Nearest log sample was farther than this in time (common in weak areas with sparse logging)."></span> black dot</span>`
        : ''
    processLegend.hidden = false
    const fsplLegend =
      (processMergedPointsRaw.length > 0 || processRssiMergedPointsRaw.length > 0) &&
      processFsplEnable.checked
        ? `<span>FSPL: estimated at <strong>${processFsplTarget.value}</strong> MHz (walk at <strong>${processFsplRef.value}</strong> MHz, free space)</span>`
        : ''
    const rssiOffsetLegend =
      processRssiMergedPointsRaw.length > 0 && Math.abs(processRssiOffsetDb) > 1e-9
        ? `<span>RSSI offset: <strong>${processRssiOffsetDb.toFixed(1)}</strong> dB (applied before FSPL)</span>`
        : ''
    const heatmapLegend =
      processShowHeatmap && merged.length > 0
        ? `<span>Heatmap: distance-weighted, spread ≈ <strong>${Math.round(processHeatmapRadiusPx * 0.94)}</strong> px, opacity <strong>${Math.round(processHeatmapOpacity * 100)}%</strong>${processHeatmapUseBoundary && processHeatmapBoundaryClosed ? ' · boundary clip on' : ''}</span>`
        : ''
    const metricLabel = processMetricIsRssiView() ? 'RSSI' : 'PL'
    const metricUnit = processMetricIsRssiView() ? 'dBm' : 'dB'
    const dataRangeSpan =
      merged.length > 0
        ? `<span><strong>${merged.length}</strong> matched · ${metricLabel} <strong>${minV.toFixed(1)}</strong>–<strong>${maxV.toFixed(1)}</strong> ${metricUnit}</span>`
        : ''
    const scaleSpan =
      merged.length > 0
        ? processMetricIsRssiView()
          ? `<span>Color scale <strong>−25</strong> … <strong>−120</strong> dBm (outside range is clamped)</span>
    <span class="process-legend-gradient" style="background:${metricScaleGradientCss()}"></span>`
          : `<span>Color scale <strong>−30</strong> … <strong>−120</strong> dB (outside range is clamped)</span>
    <span class="process-legend-gradient" style="background:${metricScaleGradientCss()}"></span>`
        : ''
    processLegend.innerHTML = `<div class="process-legend-inner">
    ${scaleSpan}
    ${walkTypesLegend}
    ${unmatchedLegend}
    ${rssiOffsetLegend}
    ${heatmapLegend}
    ${fsplLegend}
    ${dataRangeSpan}
  </div>`
    drawHeatmapBoundaryOverlay(ctx)
    updateProcessHistogramTable()
    updateProcessFsplChrome()
    updateProcessTrailChrome()
    return
  }

  if (hasTrail) {
    const colors = getOverlayColors()
    const trailPs = Math.min(1.25, Math.max(0.85, dotR / 5.5))
    const nudgeOn = processNudgeTrail.checked

    if (processTrailEditable.length > 0) {
      ctx.strokeStyle = colors.trailLine
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(1, 2 * trailPs)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let i = 0; i < processTrailEditable.length; i++) {
        const pt = processTrailEditable[i]!
        const q = processImgToOverlayLocal(pt.x, pt.y)
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
      crossLocal = processImgToOverlayLocal(cpt.x, cpt.y)
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
      const q = processImgToOverlayLocal(pt.x, pt.y)
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
    drawHeatmapBoundaryOverlay(ctx)
    processHistogramWrap.hidden = true
    processHistogramBody.innerHTML = ''
    processColourScale.hidden = false
    processMetricWrap.hidden = true
    updateProcessTrailChrome()
    return
  }

  processLegend.hidden = true
  processHistogramWrap.hidden = true
  processHistogramBody.innerHTML = ''
  processColourScale.hidden = false
  processMetricWrap.hidden = true
  drawHeatmapBoundaryOverlay(ctx)
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

function downloadJsonFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function safeBundleDownloadFilename(raw: string): string {
  let s = raw.trim().replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '')
  if (!s) s = 'walkplotter-process-bundle'
  if (!s.toLowerCase().endsWith('.json')) s += '.json'
  return s.slice(0, 200)
}

function safeConfigDownloadFilename(raw: string): string {
  let s = raw.trim().replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '')
  if (!s) s = 'walkplotter-process-config'
  if (!s.toLowerCase().endsWith('.json')) s += '.json'
  return s.slice(0, 200)
}

function saveProcessConfig(downloadFilename: string): void {
  const config = collectCurrentProcessConfig()
  const json = JSON.stringify(config)
  downloadJsonFile(downloadFilename, json)
  processStatus.textContent = `Saved "${downloadFilename}" (~${(json.length / 1024).toFixed(0)} KB). Load process config to reapply these settings on another dataset.`
}

/** Build and download bundle; `downloadFilename` should already be sanitized (e.g. via `safeBundleDownloadFilename`). */
async function saveProcessBundle(downloadFilename: string): Promise<boolean> {
  if (!processImg.naturalWidth || !processTrailEditable.length) return false
  let plText = processPathLossCsvText.trim()
  let rssiText = processRssiCsvText.trim()
  const plFile = processFilePl.files?.[0]
  const rssiFile = processFileRssi.files?.[0]
  if (!plText && plFile) plText = await readFileAsText(plFile)
  if (!rssiText && rssiFile) rssiText = await readFileAsText(rssiFile)
  if (!plText && !rssiText) {
    processStatus.textContent =
      'Choose a path loss CSV and/or RSSI CSV (or load a bundle that includes one) before saving a bundle.'
    return false
  }
  const walkText = serializeWalkplotterEditable(
    processWalkPreamble,
    processTrailEditable,
    processWalkTail
  )
  const res = await fetch(processImg.src)
  const blob = await res.blob()
  const buf = await blob.arrayBuffer()
  const dataBase64 = uint8ArrayToBase64(new Uint8Array(buf))
  const planName =
    processFilePlan.files?.[0]?.name ?? processBundleSummaryOverride?.plan ?? 'floor-plan.png'
  const safePlan = planName.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').slice(0, 200)
  const bundle: ProcessBundleV1 = {
    walkplotterBundleVersion: PROCESS_BUNDLE_VERSION,
    app: 'walkplotter',
    savedAt: new Date().toISOString(),
    floorPlan: {
      fileName: safePlan || 'floor-plan.png',
      mimeType: blob.type || 'image/png',
      dataBase64,
    },
    walkplotterCsv: walkText.replace(/^\uFEFF/, ''),
    pathLossCsv: plText.replace(/^\uFEFF/, ''),
    ...(rssiText ? { rssiCsv: rssiText.replace(/^\uFEFF/, '') } : {}),
  }
  const json = JSON.stringify(bundle)
  downloadJsonFile(downloadFilename, json)
  processStatus.textContent = `Saved "${downloadFilename}" (~${(json.length / 1024).toFixed(0)} KB). Use Load data bundle to restore.`
  return true
}

async function applyProcessBundle(bundle: ProcessBundleV1): Promise<void> {
  if (processPlanObjectUrl) {
    URL.revokeObjectURL(processPlanObjectUrl)
    processPlanObjectUrl = null
  }
  processMergedPoints = []
  processMergedPointsRaw = []
  processUnmatchedTrailPoints = []
  processPathLossCsvText = bundle.pathLossCsv
  processRssiCsvText = bundle.rssiCsv ?? ''
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
  processPlotMetric = 'rssi'
  processFilePlan.value = ''
  processFileWalk.value = ''
  processFilePl.value = ''
  processFileRssi.value = ''
  pendingBundleSettings = null
  processNudgeTrail.checked = false
  processTrailDragIndex = null
  processFsplEnable.checked = false
  updateProcessFsplChrome()
  processFsplDelta.textContent = ''

  const imgBlob = base64ToBlob(bundle.floorPlan.dataBase64, bundle.floorPlan.mimeType)
  processPlanObjectUrl = URL.createObjectURL(imgBlob)
  processImg.src = processPlanObjectUrl

  const parsed = parseWalkplotterEditable(bundle.walkplotterCsv)
  if (!parsed || !parsed.trail.length) {
    processStatus.textContent = 'Bundle Walkplotter CSV could not be parsed.'
    return
  }
  processWalkPreamble = parsed.preamble
  processWalkTail = parsed.tail
  processTrailEditable = parsed.trail.map((r) => ({ ...r }))
  processTrailOriginal = parsed.trail.map((r) => ({ ...r }))
  processWalkTestDate = extractWalkplotterTestDate(bundle.walkplotterCsv)

  processBundleSummaryOverride = {
    plan: '(from data bundle)',
    walk: '(from data bundle)',
    pl: bundle.pathLossCsv.trim().length > 0 ? '(from data bundle)' : '—',
    rssi: bundle.rssiCsv?.trim().length ? '(from data bundle)' : '—',
  }
  updateProcessFileSummary()
  processStatus.textContent = `Loaded data bundle (saved ${bundle.savedAt.slice(0, 19)}). Tap Plot overlay to redraw.`
  drawProcessOverlay()
}

/** Process merge: use elapsed t=0 semantics from loaded Walkplotter CSV preamble. */
function mergeTimeOptsFromPreamble(): MergeTimeOptions | undefined {
  if (!processWalkPreamble) return undefined
  const info = extractWalkplotterTimestampInfo(processWalkPreamble)
  if (info.semantics !== 'elapsed_since_session_start') return undefined
  if (info.sessionEpochMs == null || !Number.isFinite(info.sessionEpochMs)) return undefined
  return {
    semantics: 'elapsed_since_session_start',
    sessionEpochMs: info.sessionEpochMs,
  }
}

function runProcessPlot(): void {
  const walkFile = processFileWalk.files?.[0]
  const plFile = processFilePl.files?.[0]
  const rssiFile = processFileRssi.files?.[0]
  const plFromMemory = processPathLossCsvText.trim().length > 0
  const rssiFromMemory = processRssiCsvText.trim().length > 0
  const wantPl = Boolean(plFile || plFromMemory)
  const wantRssi = Boolean(rssiFile || rssiFromMemory)
  if (!processImg.naturalWidth) {
    processStatus.textContent = 'Load a map image first.'
    return
  }
  if (!processTrailEditable.length) {
    processStatus.textContent = 'Load a Walkplotter CSV with trail rows first.'
    return
  }
  if (!wantPl && !wantRssi) {
    processStatus.textContent =
      'Choose a path loss CSV and/or an RSSI CSV (`time` + `rssi`), or load a data bundle with path loss and/or RSSI.'
    return
  }
  void (async () => {
    try {
      let testDate = processWalkTestDate
      if (!testDate && walkFile) {
        const walkText = await readFileAsText(walkFile)
        testDate = extractWalkplotterTestDate(walkText)
      }
      if (!testDate) {
        const wtxt = serializeWalkplotterEditable(
          processWalkPreamble,
          processTrailEditable,
          processWalkTail
        )
        testDate = extractWalkplotterTestDate(wtxt)
      }
      if (!testDate) {
        processStatus.textContent =
          'Walkplotter CSV has no # test_date_local: YYYY-MM-DD header — cannot align times.'
        processMergedPoints = []
        processMergedPointsRaw = []
        processUnmatchedTrailPoints = []
        processRssiMergedPoints = []
        processRssiMergedPointsRaw = []
        processRssiUnmatchedTrailPoints = []
        updateProcessFsplChrome()
        drawProcessOverlay()
        return
      }

      if (!wantPl) {
        processMergedPoints = []
        processMergedPointsRaw = []
        processUnmatchedTrailPoints = []
      }
      if (!wantRssi) {
        processRssiMergedPoints = []
        processRssiMergedPointsRaw = []
        processRssiUnmatchedTrailPoints = []
      }

      const trailForMerge: WalkplotterTrailRow[] = processTrailEditable
      const mergeOpts = mergeTimeOptsFromPreamble()
      const dtSec = DEFAULT_MAX_MATCH_MS / 1000
      let plMergedN = 0
      let plUnmatchedN = 0
      let rssiMergedN = 0
      let rssiUnmatchedN = 0
      const parts: string[] = []

      if (wantPl) {
        const plText = plFile ? await readFileAsText(plFile) : processPathLossCsvText
        const plRows = parsePathLossCsv(plText)
        if (!plRows.length) {
          processMergedPoints = []
          processMergedPointsRaw = []
          processUnmatchedTrailPoints = []
          parts.push('Path loss: no rows parsed (expect HH:MM:SS first field, 4th field = number).')
        } else {
          const { merged, unmatched } = mergeByNearestTime(
            testDate,
            trailForMerge,
            plRows,
            DEFAULT_MAX_MATCH_MS,
            mergeOpts
          )
          processUnmatchedTrailPoints = unmatched
          processMergedPointsRaw = merged.map((p) => ({ ...p }))
          plMergedN = merged.length
          plUnmatchedN = unmatched.length
          if (merged.length === 0) {
            parts.push(
              unmatched.length > 0
                ? `Path loss: no sample within ${dtSec}s — ${unmatched.length} black dot(s).`
                : `Path loss: no match within ${dtSec}s (check times for ${testDate}).`
            )
          } else {
            const uMsg =
              unmatched.length > 0
                ? ` ${unmatched.length} trail pt(s) had no path loss within ${dtSec}s (black dots).`
                : ''
            parts.push(
              `Path loss: matched ${merged.length} of ${processTrailEditable.length} trail samples.${uMsg}`,
            )
          }
        }
      }
      if (wantRssi) {
        const rssiText = rssiFile ? await readFileAsText(rssiFile) : processRssiCsvText
        const parsedRssi = getFilteredRssiRowsFromText(rssiText)
        const rssiRows = parsedRssi.rows
        if (!rssiRows.length) {
          processRssiMergedPoints = []
          processRssiMergedPointsRaw = []
          processRssiUnmatchedTrailPoints = []
          parts.push('RSSI: no rows parsed (expect `time` and `rssi` columns, or two columns time + dBm).')
        } else {
          const { merged: rm, unmatched: ru } = mergeByNearestTime(
            testDate,
            trailForMerge,
            rssiRows,
            DEFAULT_MAX_MATCH_MS,
            mergeOpts
          )
          processRssiMergedPointsRaw = rm.map((p) => ({ ...p }))
          processRssiUnmatchedTrailPoints = ru
          rssiMergedN = rm.length
          rssiUnmatchedN = ru.length
          if (rm.length === 0) {
            parts.push(
              ru.length > 0
                ? `RSSI: no sample within ${dtSec}s — ${ru.length} black dot(s).`
                : `RSSI: no match within ${dtSec}s (check times for ${testDate}).`
            )
          } else {
            const uMsg =
              ru.length > 0
                ? ` ${ru.length} trail pt(s) had no RSSI within ${dtSec}s (black dots).`
                : ''
            const fMsg = parsedRssi.filtered
              ? ` Filter applied: ${parsedRssi.detail}.`
              : ''
            parts.push(
              `RSSI: matched ${rm.length} of ${processTrailEditable.length} trail samples.${uMsg}${fMsg}`
            )
          }
        }
      }

      rebuildProcessMergedFromFspl()
      updateProcessFsplChrome()
      syncProcessPlotMetricAfterPlot(plMergedN, plUnmatchedN, rssiMergedN, rssiUnmatchedN)
      const anyOverlay = processHasPlOverlay() || processHasRssiOverlay()
      processStatus.textContent = anyOverlay
        ? `${parts.join(' ')} (date ${testDate}).`
        : parts.join(' ') || 'Nothing to plot for the chosen file(s).'
      drawProcessOverlay()
    } catch (e) {
      processStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`
      processMergedPoints = []
      processMergedPointsRaw = []
      processUnmatchedTrailPoints = []
      processRssiMergedPoints = []
      processRssiMergedPointsRaw = []
      processRssiUnmatchedTrailPoints = []
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

function updateSessionT0Chrome(): void {
  const hasMap = Boolean(img.naturalWidth)
  const on = trail.hasSessionTimeZero()
  const trailMode = placementMode === 'trail'
  btnSessionT0.disabled = !hasMap || !trailMode
  btnSessionT0.hidden = on
  btnSessionT0Clear.hidden = !on
  btnSessionT0Clear.disabled = !hasMap
  mapSessionBadge.hidden = !on
}

let mapClockInterval: ReturnType<typeof setInterval> | null = null

function updateMapClock(): void {
  if (!img.naturalWidth) return
  const t0 = trail.getSessionTimeZeroMs()
  if (t0 != null) {
    mapClockLabel.textContent = 'Elapsed'
    mapClockValue.textContent = formatDurationMsAsHMS(Date.now() - t0)
  } else {
    mapClockLabel.textContent = 'Local time'
    mapClockValue.textContent = formatLocalTimeHMS(new Date())
  }
}

function syncMapClock(): void {
  if (!img.naturalWidth) {
    if (mapClockInterval != null) {
      clearInterval(mapClockInterval)
      mapClockInterval = null
    }
    mapClockValue.textContent = '--:--:--'
    return
  }
  updateMapClock()
  if (mapClockInterval == null) {
    mapClockInterval = setInterval(updateMapClock, 1000)
  }
}

type RssiGraphAxisMode = 'index' | 'elapsed_ms'
const SPEED_OF_LIGHT_MPS = 299_792_458

type RssiGraphSample = {
  x: number
  y: number
}

function parseWallClockToMsOfDay(hms: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(hms.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const sec = Number(m[3])
  let ms = 0
  if (m[4]) {
    const frac = parseFloat(m[4]!)
    if (Number.isFinite(frac)) ms = Math.round(frac * 1000)
  }
  if (!Number.isFinite(h) || !Number.isFinite(mi) || !Number.isFinite(sec)) return null
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || sec < 0 || sec > 59) return null
  return ((h * 60 + mi) * 60 + sec) * 1000 + ms
}

function formatMsAsClockLike(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function clampRssiRollingWindow(v: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : 5
  return Math.max(2, Math.min(5000, n))
}

function clampRssiLeeFreqMhz(v: number): number {
  return Math.max(100, Math.min(10000, Number.isFinite(v) ? v : 2640))
}

function clampRssiLeeSpeedMps(v: number): number {
  return Math.max(0.05, Math.min(5, Number.isFinite(v) ? v : 1.4))
}

function clampRssiResampleHz(v: number): 0 | 1 | 2 {
  const n = Number.isFinite(v) ? Math.round(v) : 0
  if (n === 1) return 1
  if (n === 2) return 2
  return 0
}

function clampRssiThresholdDb(v: number, fallback: number): number {
  const n = Number.isFinite(v) ? v : fallback
  return Math.max(-200, Math.min(50, n))
}

function clampRssiThresholdPct(v: number, fallback: number): number {
  const n = Number.isFinite(v) ? v : fallback
  return Math.max(0, Math.min(100, n))
}

function syncRssiHistogramThresholdInputs(): void {
  processRssiThresholdMinDbInput.value = String(processRssiThresholdMinDb)
  processRssiThresholdMinPctInput.value = String(processRssiThresholdMinPct)
  processRssiThresholdMaxDbInput.value = String(processRssiThresholdMaxDb)
  processRssiThresholdMaxPctInput.value = String(processRssiThresholdMaxPct)
}

function commitRssiHistogramThresholdInputs(): void {
  processRssiThresholdMinDb = clampRssiThresholdDb(
    Number(processRssiThresholdMinDbInput.value),
    processRssiThresholdMinDb,
  )
  processRssiThresholdMinPct = clampRssiThresholdPct(
    Number(processRssiThresholdMinPctInput.value),
    processRssiThresholdMinPct,
  )
  processRssiThresholdMaxDb = clampRssiThresholdDb(
    Number(processRssiThresholdMaxDbInput.value),
    processRssiThresholdMaxDb,
  )
  processRssiThresholdMaxPct = clampRssiThresholdPct(
    Number(processRssiThresholdMaxPctInput.value),
    processRssiThresholdMaxPct,
  )
  syncRssiHistogramThresholdInputs()
  updateProcessHistogramTable()
}

function applyRssiRollingAverage(rows: PathLossRow[], windowSize: number): PathLossRow[] {
  if (rows.length <= 1 || windowSize <= 1) return rows.map((r) => ({ ...r }))
  const w = clampRssiRollingWindow(windowSize)
  const half = Math.floor(w / 2)
  const out: PathLossRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const i0 = Math.max(0, i - half)
    const i1 = Math.min(rows.length - 1, i + half)
    let sum = 0
    let cnt = 0
    for (let j = i0; j <= i1; j++) {
      sum += rows[j]!.pathLoss
      cnt++
    }
    out.push({
      ...rows[i]!,
      pathLoss: cnt > 0 ? sum / cnt : rows[i]!.pathLoss,
    })
  }
  return out
}

function estimateRssiSampleStepSec(rows: PathLossRow[]): number {
  if (rows.length < 2) return 1
  const built = buildRssiGraphSamples(rows)
  if (built.axisMode !== 'elapsed_ms' || built.samples.length < 2) return 1
  const diffsSec: number[] = []
  for (let i = 1; i < built.samples.length; i++) {
    const dtSec = (built.samples[i]!.x - built.samples[i - 1]!.x) / 1000
    if (Number.isFinite(dtSec) && dtSec > 0) diffsSec.push(dtSec)
  }
  if (!diffsSec.length) return 1
  diffsSec.sort((a, b) => a - b)
  const mid = Math.floor(diffsSec.length / 2)
  return diffsSec.length % 2 ? diffsSec[mid]! : (diffsSec[mid - 1]! + diffsSec[mid]!) / 2
}

function estimateLeeWindowSamples(rows: PathLossRow[]): number {
  const fMhz = clampRssiLeeFreqMhz(processRssiLeeFreqMhz)
  const speed = clampRssiLeeSpeedMps(processRssiLeeSpeedMps)
  const wavelengthM = SPEED_OF_LIGHT_MPS / (fMhz * 1_000_000)
  const leeDistanceM = 40 * wavelengthM
  const dtSec = Math.max(0.02, estimateRssiSampleStepSec(rows))
  const perSampleM = Math.max(1e-6, speed * dtSec)
  return clampRssiRollingWindow(Math.max(2, Math.round(leeDistanceM / perSampleM)))
}

function hasRssiCsvLoaded(): boolean {
  return processRssiCsvText.trim().length > 0 || Boolean(processFileRssi.files?.[0])
}

function updateRssiGraphSaveButton(): void {
  const hasProcessing = processRssiRollingEnabled || processRssiLeeEnabled || processRssiResampleHz > 0
  const canSave = hasProcessing && hasRssiCsvLoaded()
  rssiGraphSaveFilteredBtn.disabled = !canSave
  rssiGraphSaveFilteredBtn.title = canSave
    ? 'Download processed RSSI CSV (time,rssi) for re-load/bundle workflows'
    : 'Enable RSSI filtering or resampling and load an RSSI CSV to save processed output'
}

function maybeAutoReplotAfterRssiFilterChange(): void {
  const hasMap = Boolean(processImg.naturalWidth)
  const hasTrail = processTrailEditable.length > 0
  if (hasMap && hasTrail && hasRssiCsvLoaded()) {
    runProcessPlot()
  }
}

function defaultFilteredRssiFilename(): string {
  const src = processFileRssi.files?.[0]?.name ?? 'walkplotter-rssi'
  const stem = src.replace(/\.csv$/i, '')
  return safeCsvFilename(`${stem}-filtered.csv`)
}

function formatRssiCsvValue(v: number): string {
  const s = v.toFixed(3)
  return s.replace(/\.?0+$/, '')
}

function csvCellEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function buildFilteredRssiCsvText(rows: PathLossRow[]): string {
  const lines = ['time,rssi']
  for (const r of rows) {
    lines.push(`${csvCellEscape(r.time)},${formatRssiCsvValue(r.pathLoss)}`)
  }
  return `${lines.join('\r\n')}\r\n`
}

function stdDevAllSamples(rows: PathLossRow[]): number {
  if (!rows.length) return 0
  let sum = 0
  for (const r of rows) sum += r.pathLoss
  const mean = sum / rows.length
  let varSum = 0
  for (const r of rows) {
    const d = r.pathLoss - mean
    varSum += d * d
  }
  // Population standard deviation across all samples currently considered.
  return Math.sqrt(varSum / rows.length)
}

function buildRssiTimelineMs(rows: PathLossRow[]): number[] | null {
  if (!rows.length) return []
  if (rows.every((r) => typeof r.absoluteTimeMs === 'number' && Number.isFinite(r.absoluteTimeMs))) {
    return rows.map((r) => r.absoluteTimeMs as number)
  }
  const dur = rows.map((r) => parseDurationHmsToMs(r.time))
  if (dur.every((v) => v != null)) {
    return dur.map((v) => v as number)
  }
  const wall = rows.map((r) => parseWallClockToMsOfDay(r.time))
  if (wall.every((v) => v != null)) {
    const dayMs = 24 * 60 * 60 * 1000
    let dayOffset = 0
    let prev = wall[0] as number
    const unfolded: number[] = [prev]
    for (let i = 1; i < wall.length; i++) {
      let cur = wall[i] as number
      if (cur + dayOffset < prev - 12 * 60 * 60 * 1000) dayOffset += dayMs
      cur += dayOffset
      unfolded.push(cur)
      prev = cur
    }
    return unfolded
  }
  return null
}

function resampleRssiRows(rows: PathLossRow[], targetHz: 0 | 1 | 2): PathLossRow[] {
  if (!rows.length || targetHz <= 0) return rows.map((r) => ({ ...r }))
  const timelineMs = buildRssiTimelineMs(rows)
  if (!timelineMs || timelineMs.length !== rows.length) return rows.map((r) => ({ ...r }))
  const bucketMs = 1000 / targetHz
  const t0 = timelineMs[0]!
  const out: PathLossRow[] = []
  let i = 0
  while (i < rows.length) {
    const relMs = Math.max(0, timelineMs[i]! - t0)
    const bucketIdx = Math.floor(relMs / bucketMs)
    const bucketEnd = (bucketIdx + 1) * bucketMs
    let sum = 0
    let cnt = 0
    let absSum = 0
    let absCnt = 0
    const first = rows[i]!
    while (i < rows.length) {
      const rel = Math.max(0, timelineMs[i]! - t0)
      if (rel >= bucketEnd) break
      const row = rows[i]!
      sum += row.pathLoss
      cnt++
      if (typeof row.absoluteTimeMs === 'number' && Number.isFinite(row.absoluteTimeMs)) {
        absSum += row.absoluteTimeMs
        absCnt++
      }
      i++
    }
    if (cnt > 0) {
      const next: PathLossRow = { time: first.time, pathLoss: sum / cnt }
      if (absCnt > 0) next.absoluteTimeMs = absSum / absCnt
      out.push(next)
    } else {
      i++
    }
  }
  return out
}

function downloadFilteredRssiCsv(): void {
  const csv = processRssiCsvText.trim()
  if (!csv) {
    rssiGraphStatus.textContent = 'Load an RSSI CSV first.'
    return
  }
  if (!processRssiRollingEnabled && !processRssiLeeEnabled && processRssiResampleHz <= 0) {
    rssiGraphStatus.textContent =
      'Enable rolling average, Lee criterion, or resampling first, then save processed RSSI CSV.'
    return
  }
  const parsed = getFilteredRssiRowsFromText(csv)
  if (!parsed.rows.length) {
    rssiGraphStatus.textContent =
      'No RSSI rows parsed. Expected `time` and `rssi` columns, or first two columns as time + dBm.'
    return
  }
  const text = buildFilteredRssiCsvText(parsed.rows)
  const filename = defaultFilteredRssiFilename()
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  rssiGraphStatus.textContent = `Saved processed RSSI CSV: ${filename} (${parsed.rows.length} rows, ${parsed.detail}).`
}

function getFilteredRssiRowsFromText(text: string): {
  rows: PathLossRow[]
  rawCount: number
  postFilterCount: number
  postResampleCount: number
  rawStdDev: number
  outputStdDev: number
  filtered: boolean
  mode: 'raw' | 'rolling' | 'lee'
  resampleHz: 0 | 1 | 2
  detail: string
} {
  const rawRows = parseRssiCsv(text)
  if (!rawRows.length) {
    return {
      rows: [],
      rawCount: 0,
      postFilterCount: 0,
      postResampleCount: 0,
      rawStdDev: 0,
      outputStdDev: 0,
      filtered: false,
      mode: 'raw',
      resampleHz: processRssiResampleHz,
      detail: 'raw',
    }
  }
  let filteredRows: PathLossRow[] = rawRows
  let filtered = false
  let mode: 'raw' | 'rolling' | 'lee' = 'raw'
  let detail = 'raw'
  if (processRssiLeeEnabled) {
    const win = estimateLeeWindowSamples(rawRows)
    filteredRows = applyRssiRollingAverage(rawRows, win)
    filtered = true
    mode = 'lee'
    detail = `Lee criterion (f=${clampRssiLeeFreqMhz(processRssiLeeFreqMhz).toFixed(0)} MHz, v=${clampRssiLeeSpeedMps(processRssiLeeSpeedMps).toFixed(2)} m/s, window ${win})`
  } else if (processRssiRollingEnabled) {
    filteredRows = applyRssiRollingAverage(rawRows, processRssiRollingWindow)
    filtered = true
    mode = 'rolling'
    detail = `rolling average window ${processRssiRollingWindow}`
  }
  const postFilterCount = filteredRows.length
  const resampleHz = clampRssiResampleHz(processRssiResampleHz)
  const rows = resampleHz > 0 ? resampleRssiRows(filteredRows, resampleHz) : filteredRows
  const postResampleCount = rows.length
  const rawStdDev = stdDevAllSamples(rawRows)
  const outputStdDev = stdDevAllSamples(rows)
  if (resampleHz > 0) {
    const resamplePart = `resampled to ${resampleHz} Hz`
    detail = filtered ? `${detail}; ${resamplePart}` : resamplePart
  }
  return {
    rows,
    rawCount: rawRows.length,
    postFilterCount,
    postResampleCount,
    rawStdDev,
    outputStdDev,
    filtered,
    mode,
    resampleHz,
    detail,
  }
}

function syncRssiGraphFilterControls(): void {
  rssiGraphRollingEnable.checked = processRssiRollingEnabled
  rssiGraphLeeEnable.checked = processRssiLeeEnabled
  rssiGraphRollingWindowInput.value = String(processRssiRollingWindow)
  rssiGraphLeeFreqInput.value = String(clampRssiLeeFreqMhz(processRssiLeeFreqMhz))
  rssiGraphLeeSpeedInput.value = String(clampRssiLeeSpeedMps(processRssiLeeSpeedMps))
  rssiGraphResampleHzSelect.value = String(clampRssiResampleHz(processRssiResampleHz))
  rssiGraphRollingWindowInput.disabled = !processRssiRollingEnabled || processRssiLeeEnabled
  rssiGraphLeeFreqInput.disabled = !processRssiLeeEnabled
  rssiGraphLeeSpeedInput.disabled = !processRssiLeeEnabled
  const resampleNote =
    processRssiResampleHz > 0 ? ` Resample: ${processRssiResampleHz} Hz (shows raw -> output sample counts).` : ''
  if (processRssiLeeEnabled) {
    rssiGraphFilterNote.textContent =
      `Lee criterion enabled (f=${clampRssiLeeFreqMhz(processRssiLeeFreqMhz).toFixed(0)} MHz, v=${clampRssiLeeSpeedMps(processRssiLeeSpeedMps).toFixed(2)} m/s). Used by RSSI graph and Plot overlay.${resampleNote}`
  } else if (processRssiRollingEnabled) {
    rssiGraphFilterNote.textContent =
      `Rolling average enabled (window ${processRssiRollingWindow} samples). Used by RSSI graph and Plot overlay.${resampleNote}`
  } else {
    rssiGraphFilterNote.textContent = processRssiResampleHz > 0
      ? `Raw RSSI values with resample to ${processRssiResampleHz} Hz. Used by RSSI graph and Plot overlay.`
      : 'Raw RSSI values (no filter).'
  }
  updateProcessBundleConfigSummaryLabels()
  updateRssiGraphSaveButton()
}

function buildRssiGraphSamples(
  rows: ReturnType<typeof parseRssiCsv>
): { samples: RssiGraphSample[]; axisMode: RssiGraphAxisMode } {
  if (!rows.length) return { samples: [], axisMode: 'index' }
  if (rows.every((r) => typeof r.absoluteTimeMs === 'number' && Number.isFinite(r.absoluteTimeMs))) {
    const base = rows[0]!.absoluteTimeMs as number
    return {
      samples: rows.map((r) => ({
        x: (r.absoluteTimeMs as number) - base,
        y: r.pathLoss,
      })),
      axisMode: 'elapsed_ms',
    }
  }
  const dur = rows.map((r) => parseDurationHmsToMs(r.time))
  if (dur.every((v) => v != null)) {
    const base = dur[0] as number
    return {
      samples: rows.map((r, i) => ({
        x: (dur[i] as number) - base,
        y: r.pathLoss,
      })),
      axisMode: 'elapsed_ms',
    }
  }
  const wall = rows.map((r) => parseWallClockToMsOfDay(r.time))
  if (wall.every((v) => v != null)) {
    const dayMs = 24 * 60 * 60 * 1000
    let dayOffset = 0
    let prev = wall[0] as number
    const unfolded: number[] = [prev]
    for (let i = 1; i < wall.length; i++) {
      let cur = wall[i] as number
      if (cur + dayOffset < prev - 12 * 60 * 60 * 1000) {
        dayOffset += dayMs
      }
      cur += dayOffset
      unfolded.push(cur)
      prev = cur
    }
    const base = unfolded[0]!
    return {
      samples: rows.map((r, i) => ({
        x: unfolded[i]! - base,
        y: r.pathLoss,
      })),
      axisMode: 'elapsed_ms',
    }
  }
  return {
    samples: rows.map((r, i) => ({
      x: i,
      y: r.pathLoss,
    })),
    axisMode: 'index',
  }
}

function drawRssiGraph(): void {
  if (!rssiGraphCanvas) return
  const cw = Math.max(320, Math.round(rssiGraphCanvas.clientWidth || 0))
  const ch = Math.max(220, Math.round(rssiGraphCanvas.clientHeight || 0))
  const dpr = window.devicePixelRatio || 1
  rssiGraphCanvas.width = Math.round(cw * dpr)
  rssiGraphCanvas.height = Math.round(ch * dpr)
  const ctx = rssiGraphCanvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0f1c19'
  ctx.fillRect(0, 0, cw, ch)

  const csv = processRssiCsvText.trim()
  if (!csv) {
    rssiGraphStatus.textContent = 'Load an RSSI CSV in Process to graph it here.'
    return
  }
  const parsed = getFilteredRssiRowsFromText(csv)
  const rows = parsed.rows
  if (!rows.length) {
    rssiGraphStatus.textContent =
      'No RSSI rows parsed. Expected `time` and `rssi` columns, or first two columns as time + dBm.'
    return
  }
  const built = buildRssiGraphSamples(rows)
  const samples = built.samples
  if (!samples.length) {
    rssiGraphStatus.textContent = 'No graphable RSSI samples found.'
    return
  }
  let minY = samples[0]!.y
  let maxY = minY
  for (const s of samples) {
    if (s.y < minY) minY = s.y
    if (s.y > maxY) maxY = s.y
  }
  const rawMinY = minY
  const rawMaxY = maxY
  const yPad = Math.max(2, (maxY - minY) * 0.08)
  minY -= yPad
  maxY += yPad
  if (Math.abs(maxY - minY) < 1e-6) {
    minY -= 1
    maxY += 1
  }
  const minX = samples[0]!.x
  const maxX = samples[samples.length - 1]!.x
  const dx = Math.max(1e-6, maxX - minX)
  const left = 56
  const right = 14
  const top = 14
  const bottom = 34
  const pw = Math.max(20, cw - left - right)
  const ph = Math.max(20, ch - top - bottom)
  const xAt = (x: number) => left + ((x - minX) / dx) * pw
  const yAt = (y: number) => top + ((maxY - y) / (maxY - minY)) * ph

  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = top + (ph * i) / 4
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + pw, y)
    ctx.stroke()
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, top + ph)
  ctx.lineTo(left + pw, top + ph)
  ctx.stroke()

  ctx.font = '12px system-ui, Segoe UI, sans-serif'
  ctx.fillStyle = 'rgba(224,237,233,0.9)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    const v = maxY + (minY - maxY) * t
    ctx.fillText(`${v.toFixed(1)}`, left - 8, top + ph * t)
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    const xv = minX + dx * t
    const label = built.axisMode === 'elapsed_ms' ? formatMsAsClockLike(xv) : String(Math.round(xv))
    ctx.fillText(label, left + pw * t, top + ph + 8)
  }

  ctx.strokeStyle = '#4df0c4'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    const px = xAt(s.x)
    const py = yAt(s.y)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()

  const axisNote = built.axisMode === 'elapsed_ms' ? 'x-axis: elapsed time' : 'x-axis: sample index'
  const countNote =
    parsed.postFilterCount !== parsed.postResampleCount
      ? `samples raw ${parsed.rawCount.toLocaleString()} -> filtered ${parsed.postFilterCount.toLocaleString()} -> output ${parsed.postResampleCount.toLocaleString()}`
      : `samples raw ${parsed.rawCount.toLocaleString()} -> output ${parsed.postResampleCount.toLocaleString()}`
  const stdDevNote = `std dev σ raw ${parsed.rawStdDev.toFixed(2)} dB -> output ${parsed.outputStdDev.toFixed(2)} dB`
  rssiGraphStatus.textContent =
    `Parsed ${samples.length} samples (${rows[0]!.time} -> ${rows[rows.length - 1]!.time}), RSSI ${rawMinY.toFixed(1)} to ${rawMaxY.toFixed(1)} dBm, ${axisNote}, ${parsed.detail}, ${countNote}, ${stdDevNote}.`
}

function setTab(which: 'map' | 'controls' | 'process' | 'rssi_graph'): void {
  currentTab = which
  const mapActive = which === 'map'
  const controlsActive = which === 'controls'
  const processActive = which === 'process'
  const rssiGraphActive = which === 'rssi_graph'
  tabMap.setAttribute('aria-selected', String(mapActive))
  tabControls.setAttribute('aria-selected', String(controlsActive))
  tabProcess.setAttribute('aria-selected', String(processActive))
  tabRssiGraph.setAttribute('aria-selected', String(rssiGraphActive))
  tabMap.tabIndex = mapActive ? 0 : -1
  tabControls.tabIndex = controlsActive ? 0 : -1
  tabProcess.tabIndex = processActive ? 0 : -1
  tabRssiGraph.tabIndex = rssiGraphActive ? 0 : -1
  panelMap.hidden = !mapActive
  panelControls.hidden = !controlsActive
  panelProcess.hidden = !processActive
  panelRssiGraph.hidden = !rssiGraphActive
  redraw()
  if (processActive) {
    applyProcessViewTransform()
    syncProcessOverlayCanvas()
    drawProcessOverlay()
  } else if (rssiGraphActive) {
    drawRssiGraph()
  }
}

function updateChrome(): void {
  const hasMap = Boolean(img.naturalWidth)
  const hasPoints = trail.points.length > 0
  const hasPoi = poiMarkers.length > 0
  placeholder.hidden = hasMap
  mapQuickBar.hidden = !hasMap
  mapSessionBar.hidden = !hasMap
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

  btnPause.disabled = !hasMap || placementMode === 'poi'
  if (placementMode === 'trail') {
    btnPause.textContent = recording ? 'Pause' : 'Resume'
    btnPause.title = recording
      ? 'Pause trail recording (segment break until you resume)'
      : 'Resume trail recording'
  } else {
    btnPause.textContent = 'Pause'
    btnPause.title = 'Pause / Resume apply in Trail mode'
  }
  const hasExportableData = hasPoints || hasPoi
  btnStop.disabled = !hasMap || (!recording && !hasExportableData)

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
  mapTrailSnap.disabled = !hasMap || placementMode === 'poi'

  if (!hasMap) {
    hintMain.textContent =
      'Load a map. Trail mode records walk pins with timestamps; POI mode adds red labeled points of interest (not on the trail).'
    hintMap.textContent = 'Open the Controls tab to load a map.'
  } else if (placementMode === 'poi') {
    hintMain.textContent =
      'POI mode: tap to place a red marker, then enter a label. POI markers are not on the trail and have no timestamps. Switch to Trail to walk.'
    hintMap.textContent =
      'POI — tap to place · pinch zoom · drag to pan · Controls for mode & export'
  } else if (recording) {
    hintMain.textContent =
      'Trail mode: tap to drop pins. Pinch to zoom, drag to pan; zoom buttons are under Controls. Crosshairs on the last pin help align the next tap. Pause on the Map tab before walking elsewhere, then Resume there.'
    hintMap.textContent =
      'Trail — tap to pin · Pause/Resume on Map · pinch zoom · drag to pan · Controls for save, CSV'
  } else {
    hintMain.textContent =
      'Recording paused — tap Resume on the Map tab to continue the trail, switch to POI to add markers, or Stop & save… to export (POI-only is OK).'
    hintMap.textContent =
      'Trail paused — Resume on Map, change mode, or Stop & save…'
  }
  updateSessionT0Chrome()
  syncMapClock()
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
      'Also save a map snapshot (map + trail + POI markers) as JPG'
  } else if (hasPoints) {
    saveIncludeJpgText.textContent = 'Also save a map snapshot (map + trail) as JPG'
  } else {
    saveIncludeJpgText.textContent = 'Also save a map snapshot (map + POI markers) as JPG'
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
  if (currentTab === 'rssi_graph') drawRssiGraph()
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
tabRssiGraph.addEventListener('click', () => setTab('rssi_graph'))

processFilePlan.addEventListener('change', () => {
  processBundleSummaryOverride = null
  const f = processFilePlan.files?.[0]
  if (processPlanObjectUrl) {
    URL.revokeObjectURL(processPlanObjectUrl)
    processPlanObjectUrl = null
  }
  clearProcessTrailState()
  processFileWalk.value = ''
  processFilePl.value = ''
  processFileRssi.value = ''
  if (!f || !f.type.startsWith('image/')) {
    processImg.removeAttribute('src')
    processPlaceholder.hidden = false
    processStage.classList.remove('has-image')
    processZoomBar.hidden = true
    processDotSizeBar.hidden = true
    processDotSizeRange.disabled = true
    processPaletteSatRange.disabled = true
    processMouseHint.hidden = true
    resetProcessView()
    processStatus.textContent = 'Load map and Walkplotter CSV to begin.'
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
    processBundleSummaryOverride = null
    loadedProcessDataBundleFilename = null
    updateProcessFileSummary()
    processMergedPoints = []
    processMergedPointsRaw = []
    processUnmatchedTrailPoints = []
    processRssiMergedPoints = []
    processRssiMergedPointsRaw = []
    processRssiUnmatchedTrailPoints = []
    processRssiCsvText = ''
    processFileRssi.value = ''
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
      processStatus.textContent = 'Load map and Walkplotter CSV to begin.'
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
      processMergedPointsRaw = []
      processUnmatchedTrailPoints = []
      processRssiMergedPoints = []
      processRssiMergedPointsRaw = []
      processRssiUnmatchedTrailPoints = []
      processRssiCsvText = ''
      processFileRssi.value = ''
      const tsInfo = extractWalkplotterTimestampInfo(text)
      let tsNote = ''
      if (tsInfo.semantics === 'elapsed_since_session_start') {
        if (tsInfo.sessionEpochMs == null) {
          tsNote =
            ' Warning: elapsed timestamps but missing # session_epoch_ms — time alignment may be wrong.'
        } else {
          tsNote = ' Timestamps: elapsed from session t=0 (match path-loss log to same t=0).'
        }
      }
      if (!processWalkTestDate) {
        processStatus.textContent = `Loaded ${processTrailEditable.length} trail points. Add # test_date_local: YYYY-MM-DD for Plot overlay.${tsNote}`
      } else {
        processStatus.textContent = `Loaded ${processTrailEditable.length} trail points. Nudge and save if needed, then choose path loss and/or RSSI CSV and Plot overlay.${tsNote}`
      }
      drawProcessOverlay()
    } catch (e) {
      processStatus.textContent = `Error reading CSV: ${e instanceof Error ? e.message : String(e)}`
      clearProcessTrailState()
      drawProcessOverlay()
    }
  })()
})

processFilePl.addEventListener('change', () => {
  void (async () => {
    processBundleSummaryOverride = null
    loadedProcessDataBundleFilename = null
    const f = processFilePl.files?.[0]
    processPathLossCsvText = f ? await readFileAsText(f) : ''
    updateProcessFileSummary()
  })()
})

processFileRssi.addEventListener('change', () => {
  void (async () => {
    processBundleSummaryOverride = null
    loadedProcessDataBundleFilename = null
    const f = processFileRssi.files?.[0]
    processRssiCsvText = f ? await readFileAsText(f) : ''
    updateProcessFileSummary()
    if (currentTab === 'rssi_graph') drawRssiGraph()
  })()
})
rssiGraphRollingEnable.addEventListener('change', () => {
  processRssiRollingEnabled = rssiGraphRollingEnable.checked
  if (processRssiRollingEnabled) processRssiLeeEnabled = false
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphRollingWindowInput.addEventListener('change', () => {
  processRssiRollingWindow = clampRssiRollingWindow(Number(rssiGraphRollingWindowInput.value))
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphLeeEnable.addEventListener('change', () => {
  processRssiLeeEnabled = rssiGraphLeeEnable.checked
  if (processRssiLeeEnabled) processRssiRollingEnabled = false
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphLeeFreqInput.addEventListener('change', () => {
  processRssiLeeFreqMhz = clampRssiLeeFreqMhz(Number(rssiGraphLeeFreqInput.value))
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  if (processRssiLeeEnabled) maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphLeeSpeedInput.addEventListener('change', () => {
  processRssiLeeSpeedMps = clampRssiLeeSpeedMps(Number(rssiGraphLeeSpeedInput.value))
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  if (processRssiLeeEnabled) maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphResampleHzSelect.addEventListener('change', () => {
  processRssiResampleHz = clampRssiResampleHz(Number(rssiGraphResampleHzSelect.value))
  syncRssiGraphFilterControls()
  if (currentTab === 'rssi_graph') drawRssiGraph()
  maybeAutoReplotAfterRssiFilterChange()
})
rssiGraphSaveFilteredBtn.addEventListener('click', () => {
  downloadFilteredRssiCsv()
})
processRssiThresholdMinDbInput.addEventListener('input', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMinDbInput.addEventListener('change', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMinPctInput.addEventListener('input', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMinPctInput.addEventListener('change', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMaxDbInput.addEventListener('input', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMaxDbInput.addEventListener('change', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMaxPctInput.addEventListener('input', () => commitRssiHistogramThresholdInputs())
processRssiThresholdMaxPctInput.addEventListener('change', () => commitRssiHistogramThresholdInputs())

processBtnSaveBundle.addEventListener('click', () => {
  if (processBtnSaveBundle.disabled) return
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  bundleFilenameInput.value = `walkplotter-process-bundle-${stamp}`
  bundleSaveDialog.showModal()
  queueMicrotask(() => {
    bundleFilenameInput.focus()
    bundleFilenameInput.select()
  })
})

processBtnSaveConfig.addEventListener('click', () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = safeConfigDownloadFilename(`walkplotter-process-config-${stamp}`)
  saveProcessConfig(name)
})

bundleSaveCancel.addEventListener('click', () => {
  bundleSaveDialog.close()
})

bundleSaveForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = safeBundleDownloadFilename(bundleFilenameInput.value)
  void (async () => {
    const ok = await saveProcessBundle(name)
    if (ok) bundleSaveDialog.close()
  })()
})

processFileBundle.addEventListener('change', () => {
  void (async () => {
    const f = processFileBundle.files?.[0]
    processFileBundle.value = ''
    if (!f) return
    try {
      const text = await readFileAsText(f)
      const bundle = parseProcessBundleJson(text)
      if (!bundle) {
        processStatus.textContent =
          'Not a valid Walkplotter data bundle (expected version 1 JSON from Save data bundle).'
        return
      }
      await applyProcessBundle(bundle)
      loadedProcessDataBundleFilename = f.name
      updateProcessFileSummary()
    } catch (e) {
      processStatus.textContent = `Bundle load error: ${e instanceof Error ? e.message : String(e)}`
    }
  })()
})

processFileConfig.addEventListener('change', () => {
  void (async () => {
    const f = processFileConfig.files?.[0]
    processFileConfig.value = ''
    if (!f) return
    try {
      const text = await readFileAsText(f)
      const config = parseProcessConfigJson(text)
      if (!config) {
        processStatus.textContent =
          'Not a valid Walkplotter process config (expected version 1 JSON from Save process config).'
        return
      }
      applyProcessConfig(config)
      loadedProcessConfigFilename = f.name
      loadedProcessConfigBaselineSig = buildCurrentProcessConfigComparableSig()
      updateProcessFileSummary()
      processStatus.textContent = `Applied process config (saved ${config.savedAt.slice(0, 19)}).`
    } catch (e) {
      processStatus.textContent = `Config load error: ${e instanceof Error ? e.message : String(e)}`
    }
  })()
})

processImg.addEventListener('load', () => {
  processPlaceholder.hidden = true
  processStage.classList.add('has-image')
  processZoomBar.hidden = false
  processDotSizeBar.hidden = false
  processDotSizeRange.disabled = false
  processPaletteSatRange.disabled = false
  processMouseHint.hidden = false
  resetProcessView()
  if (pendingBundleSettings) {
    applyProcessBundleSettings(pendingBundleSettings)
    pendingBundleSettings = null
  }
  syncProcessOverlayCanvas()
  updateProcessBundleButtons()
  drawProcessOverlay()
})

processBtnPlot.addEventListener('click', () => runProcessPlot())
processBtnClearPlot.addEventListener('click', () => {
  processMergedPoints = []
  processMergedPointsRaw = []
  processUnmatchedTrailPoints = []
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
  updateProcessFsplChrome()
  processFsplDelta.textContent = ''
  drawProcessOverlay()
})

processPlotMetricSelect.addEventListener('change', () => {
  const v = processPlotMetricSelect.value
  processPlotMetric = v === 'rssi' ? 'rssi' : 'path_loss'
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
  if (processNudgeTrail.checked) {
    processHeatmapDrawBoundary = false
    processHeatmapBoundaryDragIndex = null
    syncProcessHeatmapControls()
  }
  processTrailDragIndex = null
  drawProcessOverlay()
})
processNudgeSnap.addEventListener('change', () => drawProcessOverlay())
processResetTrail.addEventListener('click', () => {
  processTrailEditable = processTrailOriginal.map((r) => ({ ...r }))
  processMergedPoints = []
  processMergedPointsRaw = []
  processUnmatchedTrailPoints = []
  processRssiMergedPoints = []
  processRssiMergedPointsRaw = []
  processRssiUnmatchedTrailPoints = []
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
loadProcessOverlayShiftFromStorage()
syncProcessOverlayShiftInputs()
loadProcessPlanFlipFromStorage()
syncProcessPlanFlipInputs()
applyProcessPlanFlipCss()
loadProcessDotScaleFromStorage()
loadProcessPaletteSaturationFromStorage()
syncProcessDotSizeControl()
loadProcessRssiOffsetFromStorage()
syncProcessRssiOffsetInput()
loadProcessRssiPaletteFromStorage()
syncProcessRssiPaletteControl()
loadProcessHeatmapFromStorage()
syncProcessHeatmapControls()
syncRssiGraphFilterControls()
syncRssiHistogramThresholdInputs()
processShiftXInput.addEventListener('change', () => commitProcessOverlayShiftFromInputs())
processShiftYInput.addEventListener('change', () => commitProcessOverlayShiftFromInputs())
processShiftReset.addEventListener('click', () => {
  processOverlayShiftX = 0
  processOverlayShiftY = 0
  syncProcessOverlayShiftInputs()
  saveProcessOverlayShiftToStorage()
  drawProcessOverlay()
})
processFlipXInput.addEventListener('change', () => commitProcessPlanFlipFromInputs())
processFlipYInput.addEventListener('change', () => commitProcessPlanFlipFromInputs())
processFlipReset.addEventListener('click', () => {
  processPlanFlipX = false
  processPlanFlipY = false
  syncProcessPlanFlipInputs()
  applyProcessPlanFlipCss()
  saveProcessPlanFlipToStorage()
  drawProcessOverlay()
})
processRssiOffsetInput.addEventListener('input', () => commitProcessRssiOffsetFromInput())
processRssiOffsetInput.addEventListener('change', () => commitProcessRssiOffsetFromInput())
processRssiOffsetReset.addEventListener('click', () => {
  processRssiOffsetDb = 0
  syncProcessRssiOffsetInput()
  saveProcessRssiOffsetToStorage()
  rebuildProcessMergedFromFspl()
  drawProcessOverlay()
})
processRssiPaletteSelect.addEventListener('change', () => {
  processRssiPalette = clampRssiPaletteName(processRssiPaletteSelect.value)
  syncProcessRssiPaletteControl()
  saveProcessRssiPaletteToStorage()
  drawProcessOverlay()
})
processShowHeatmapInput.addEventListener('change', () => {
  processShowHeatmap = processShowHeatmapInput.checked
  syncProcessHeatmapControls()
  updateProcessTrailChrome()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapUseBoundaryInput.addEventListener('change', () => {
  processHeatmapUseBoundary = processHeatmapUseBoundaryInput.checked
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapDrawBoundaryInput.addEventListener('change', () => {
  processHeatmapDrawBoundary = processHeatmapDrawBoundaryInput.checked
  if (processHeatmapDrawBoundary) {
    processNudgeTrail.checked = false
    processTrailDragIndex = null
  } else {
    processHeatmapBoundaryDragIndex = null
  }
  syncProcessHeatmapControls()
  updateProcessTrailChrome()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapCloseBoundaryBtn.addEventListener('click', () => {
  if (processHeatmapBoundaryPoints.length < 3) return
  processHeatmapBoundaryClosed = true
  processHeatmapUseBoundary = true
  processHeatmapBoundaryDragIndex = null
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapClearBoundaryBtn.addEventListener('click', () => {
  processHeatmapBoundaryPoints = []
  processHeatmapBoundaryClosed = false
  processHeatmapBoundaryDragIndex = null
  processHeatmapUseBoundary = false
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapRadiusInput.addEventListener('input', () => {
  const v = Number(processHeatmapRadiusInput.value)
  processHeatmapRadiusPx = Number.isFinite(v) ? Math.max(20, Math.min(1000, v)) : 90
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processHeatmapOpacityInput.addEventListener('input', () => {
  const v = Number(processHeatmapOpacityInput.value)
  processHeatmapOpacity = Number.isFinite(v) ? Math.max(0.1, Math.min(1, v / 100)) : 0.55
  syncProcessHeatmapControls()
  saveProcessHeatmapToStorage()
  drawProcessOverlay()
})
processDotSizeRange.addEventListener('input', () => {
  processDotScale = clampProcessDotScale(Number(processDotSizeRange.value) / 100)
  updateProcessDotSizeLabel()
  saveProcessDotScaleToStorage()
  drawProcessOverlay()
})
processPaletteSatRange.addEventListener('input', () => {
  processPaletteSaturation = Math.max(0, Math.min(2, Number(processPaletteSatRange.value) / 100))
  updateProcessDotSizeLabel()
  saveProcessPaletteSaturationToStorage()
  drawProcessOverlay()
})
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
  if (handleBoundaryPointerDown(e)) {
    e.stopPropagation()
    return
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
  if (!img.naturalWidth || placementMode === 'poi') return
  if (recording) {
    recording = false
    trail.breakSegment()
  } else {
    recording = true
  }
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
  if (!confirm('Clear all pins on this map?')) return
  trail.clear()
  redraw()
  updateChrome()
})

btnSessionT0.addEventListener('click', () => {
  if (!img.naturalWidth || placementMode !== 'trail') return
  if (trail.points.length > 0) {
    if (
      !confirm(
        'Clear the current trail and start session t = 0 now? Press when your tester and transponder clocks are zeroed together.'
      )
    ) {
      return
    }
    trail.clear()
  }
  trail.setSessionTimeZero(new Date())
  redraw()
  updateChrome()
})

btnSessionT0Clear.addEventListener('click', () => {
  if (!img.naturalWidth) return
  trail.clearSessionTimeZero()
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
initProcessPlColourScale()
updateChrome()
void loadDefaultFloorPlan()
void loadDefaultProcessDataAndConfig()
