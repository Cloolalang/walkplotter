export type TrailSource = 'user' | 'interpolated'

export type TrailPoint = {
  x: number
  y: number
  t: number
  source: TrailSource
  /** If true (user pins only), the polyline starts a new stroke here after Pause → Resume elsewhere. */
  segmentBreak?: boolean
}

/** Point-of-interest markers: labeled pins not part of the walked trail or timestamps. */
export type PoiMarker = {
  x: number
  y: number
  label: string
}
