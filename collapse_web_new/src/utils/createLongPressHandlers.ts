import type { MouseEvent } from 'react'
import { STANDARD_LONG_PRESS_MS } from './gestureConstants'
import { lockScroll, unlockScroll } from './scrollLock'

type TimerRef = { current: number | null }
type FiredRef = { current: boolean }

// Non-hook factory for tap-to-increment / long-press-or-right-click-to-decrement
// pointer handlers. Callers own the timer/fired refs (typically shared across a
// whole grid of cards, matching the pre-refactor behavior where only one
// long-press could be "in flight" at a time within a given card grid).
export function createLongPressHandlers(
  timerRef: TimerRef,
  firedRef: FiredRef,
  onTap: () => void,
  onLongPress: () => void,
  options?: { delay?: number; disabled?: boolean }
) {
  const delay = options?.delay ?? STANDARD_LONG_PRESS_MS
  const disabled = options?.disabled ?? false

  const start = () => {
    if (disabled) return
    firedRef.current = false
    lockScroll()
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true
      onLongPress()
    }, delay)
  }

  // `timerRef.current` is non-null exactly when `start` locked scroll and
  // hasn't yet been paired with a cancel/end — including after the
  // long-press has fired (the timeout callback above never nulls it
  // itself) — so checking it here (this factory is re-created fresh every
  // render, while timerRef is a ref the caller keeps stable across
  // renders) is what lets the unlock reliably pair with the lock even
  // though `start` and `cancel` may belong to different render's closures.
  const cancel = () => {
    const wasLocked = timerRef.current !== null
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    firedRef.current = false
    if (wasLocked) unlockScroll()
  }

  const end = () => {
    const fired = firedRef.current
    cancel()
    if (!fired) onTap()
  }

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    const wasLocked = timerRef.current !== null
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    firedRef.current = true
    if (wasLocked) unlockScroll()
    onLongPress()
  }

  return {
    onPointerDown: start,
    onPointerUp: end,
    onPointerLeave: cancel,
    onContextMenu,
  }
}
