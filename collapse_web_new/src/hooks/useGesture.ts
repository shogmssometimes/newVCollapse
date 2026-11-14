import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

// Stable gesture hook — returns event handler objects whose callbacks always
// reflect the latest onIncr/onDecr without recreating the handlers on each
// render. Tap = increment, 500ms hold or right-click = decrement.
//
// Tap vs. long-press is decided entirely from pointer events, directly in
// onPointerUp — there's no separate onClick. Relying on the browser's own
// synthesized click event (as this used to) meant the actual +1 fired on
// a *second*, independently-timed event after pointerup; on touch devices
// that gap could let a long-press-triggered decrement get immediately
// followed by a ghost tap-increment, undoing it. Every other hold/swipe
// control in the app (CoreStatCard, ApproachDie, etc.) already decides tap
// vs. hold purely off pointer events for the same reason.
export function useGesture(onIncr: () => void, onDecr: () => void) {
  const incrRef = useRef(onIncr);
  const decrRef = useRef(onDecr);
  incrRef.current = onIncr;
  decrRef.current = onDecr;

  const box = useRef({ timer: null as ReturnType<typeof setTimeout> | null, didLong: false });

  return useMemo(() => {
    const b = box.current;
    const clear = () => {
      if (b.timer) {
        clearTimeout(b.timer);
        b.timer = null;
      }
    };
    return {
      onPointerDown(e: ReactPointerEvent) {
        if (e.button === 2) return;
        b.didLong = false;
        clear();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture isn't critical — up/leave still fire on this
          // element for mouse, and most touch browsers grant it anyway.
        }
        b.timer = setTimeout(() => {
          b.timer = null;
          b.didLong = true;
          decrRef.current();
        }, 500);
      },
      onPointerUp(e: ReactPointerEvent) {
        if (e.button === 2) return;
        const wasLong = b.didLong;
        clear();
        b.didLong = false;
        if (!wasLong) incrRef.current();
      },
      onPointerLeave() {
        clear();
        b.didLong = false;
      },
      onPointerCancel() {
        clear();
        b.didLong = false;
      },
      onContextMenu(e: ReactMouseEvent) {
        e.preventDefault();
        clear();
        b.didLong = false;
        decrRef.current();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable by design — callbacks routed through mutable refs
}
