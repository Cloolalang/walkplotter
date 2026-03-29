export type ImagePixel = { x: number; y: number }

/**
 * Maps a viewport point (clientX/clientY) into intrinsic image pixels for an <img>
 * using object-fit: contain in the element's **layout** box.
 *
 * Uses offsetWidth/Height for letterboxing math (unscaled CSS px) and maps the tap
 * from viewport space into that box via the rendered rect, so ancestor transforms
 * (e.g. scale on a parent) stay consistent without tracking zoom separately.
 */
export function clientToImagePixel(
  clientX: number,
  clientY: number,
  img: HTMLImageElement
): { ok: true; pixel: ImagePixel } | OutsideReason {
  if (!img.naturalWidth || !img.naturalHeight) {
    return { ok: false, reason: 'no_intrinsic_size' }
  }
  const rect = img.getBoundingClientRect()
  const bw = img.offsetWidth
  const bh = img.offsetHeight
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (bw <= 0 || bh <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, reason: 'zero_box' }
  }

  const vx = clientX - rect.left
  const vy = clientY - rect.top
  const lx = (vx * bw) / rect.width
  const ly = (vy * bh) / rect.height

  const scale = Math.min(bw / iw, bh / ih)
  const dw = iw * scale
  const dh = ih * scale
  const ox = (bw - dw) / 2
  const oy = (bh - dh) / 2

  if (lx < ox || lx > ox + dw || ly < oy || ly > oy + dh) {
    return { ok: false, reason: 'outside_drawn_image' }
  }

  const x = (lx - ox) / scale
  const y = (ly - oy) / scale
  return { ok: true, pixel: { x, y } }
}

type OutsideReason =
  | { ok: false; reason: 'no_intrinsic_size' | 'zero_box' | 'outside_drawn_image' }

/**
 * Maps a viewport point into an element’s **layout** CSS pixel space (`offsetWidth`/`offsetHeight`),
 * consistent with drawing and with `imagePixelToElementLocal` when the element is inside a transformed
 * ancestor (e.g. pan/zoom on a parent).
 */
export function clientToElementLocal(
  clientX: number,
  clientY: number,
  el: HTMLElement
): { x: number; y: number } | null {
  const rect = el.getBoundingClientRect()
  const lw = el.offsetWidth
  const lh = el.offsetHeight
  if (rect.width <= 0 || rect.height <= 0 || lw <= 0 || lh <= 0) return null
  return {
    x: ((clientX - rect.left) * lw) / rect.width,
    y: ((clientY - rect.top) * lh) / rect.height,
  }
}

/**
 * Maps intrinsic image pixels to coordinates in the element's **layout** box
 * (same space as the overlay canvas placed with offsetLeft/offsetTop/offsetWidth).
 */
export function imagePixelToElementLocal(
  x: number,
  y: number,
  img: HTMLImageElement
): { x: number; y: number } | null {
  if (!img.naturalWidth || !img.naturalHeight) return null
  const bw = img.offsetWidth
  const bh = img.offsetHeight
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (bw <= 0 || bh <= 0) return null

  const scale = Math.min(bw / iw, bh / ih)
  const dw = iw * scale
  const dh = ih * scale
  const ox = (bw - dw) / 2
  const oy = (bh - dh) / 2

  return {
    x: ox + x * scale,
    y: oy + y * scale,
  }
}
