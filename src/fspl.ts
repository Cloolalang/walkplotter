/**
 * Free-space: path loss at `fEstimate` vs `fMeasured` (same distance, no clutter):
 * PL_est = PL_meas + 20·log₁₀(f_estimate / f_measured).
 * If f_estimate < f_measured, the delta is negative → **lower** path loss at the lower frequency.
 */
export function fsplPathLossDeltaDb(fEstimateMhz: number, fMeasuredMhz: number): number {
  if (!(fEstimateMhz > 0) || !(fMeasuredMhz > 0)) return 0
  return 20 * Math.log10(fEstimateMhz / fMeasuredMhz)
}

/**
 * Some test gear reports path loss as **negative** dB (e.g. −51). For those, the same free-space
 * frequency step must be applied with **opposite sign** vs classical positive PL so that a **lower**
 * estimate frequency still shows **less** loss (values move **less negative**).
 */
export function fsplPathLossNegativeConvention(samples: readonly { pathLoss: number }[]): boolean {
  if (samples.length === 0) return false
  let sum = 0
  for (const s of samples) sum += s.pathLoss
  return sum / samples.length < 0
}

/** 700 … 2300 MHz in 50 MHz steps (inclusive). */
export function fsplDisplayFrequencyOptionsMhz(): number[] {
  const out: number[] = []
  for (let m = 700; m <= 2300; m += 50) out.push(m)
  return out
}

/** Walk test is always at 2.4 GHz; pick the center you use (ISM / ch 14). */
export function fsplMeasuredFrequencyOptionsMhz(): number[] {
  return [2400, 2474]
}
