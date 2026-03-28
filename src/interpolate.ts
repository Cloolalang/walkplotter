import type { TrailPoint, TrailSource } from './types'

export type UserAnchor = {
  x: number
  y: number
  t: number
}

/** Minimum time between user taps before straight-line interpolation runs. */
export const DEFAULT_GAP_THRESHOLD_MS = 1000

export function interpolateSegment(
  prev: UserAnchor,
  next: UserAnchor,
  gapThresholdMs: number = DEFAULT_GAP_THRESHOLD_MS,
  stepMs: number = 1000
): TrailPoint[] {
  const dt = next.t - prev.t
  if (dt <= gapThresholdMs) return []

  const out: TrailPoint[] = []
  for (let k = 1; ; k++) {
    const t = prev.t + k * stepMs
    if (t >= next.t) break
    const alpha = (t - prev.t) / dt
    out.push({
      x: prev.x + alpha * (next.x - prev.x),
      y: prev.y + alpha * (next.y - prev.y),
      t,
      source: 'interpolated' as TrailSource,
    })
  }
  return out
}

export function interpolationMeta(
  timeStepMs: number,
  gapThresholdMs: number = DEFAULT_GAP_THRESHOLD_MS
) {
  return {
    gapThresholdMs,
    timeStepMs,
    model: 'straight_line_uniform_speed',
  } as const
}
