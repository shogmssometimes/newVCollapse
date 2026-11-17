// Shared page-scroll lock for the cHUD's hold-then-swipe gestures. While a
// long-press/swipe is in flight, the page scrolling underneath the thumb
// can fight the gesture's own pointermove tracking, making swipe detection
// feel unreliable. Call `lockScroll()` the moment a gesture arms (starts
// tracking movement) and `unlockScroll()` the moment it ends (release,
// cancel, or commit) — reference-counted so overlapping/nested callers
// (e.g. a die-pickup hold started while the Method row was still relaxing
// its own lock) can't unlock the page out from under each other.
let lockCount = 0
let savedOverflow = ''
let savedTouchAction = ''

export function lockScroll(): void {
  if (typeof document === 'undefined') return
  lockCount += 1
  if (lockCount > 1) return
  const style = document.body.style
  savedOverflow = style.overflow
  savedTouchAction = style.touchAction
  style.overflow = 'hidden'
  style.touchAction = 'none'
}

export function unlockScroll(): void {
  if (typeof document === 'undefined') return
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount > 0) return
  const style = document.body.style
  style.overflow = savedOverflow
  style.touchAction = savedTouchAction
}
