import { useEffect, useRef, useState, type CSSProperties } from "react";
import { lockScroll, unlockScroll } from "../../utils/scrollLock";
import { STANDARD_LONG_PRESS_MS } from "../../utils/gestureConstants";

// How far (px) the pointer must move down before a touch counts as a
// swipe-to-lower instead of a long-press/tap. Matches CoreStatCard's
// swipe-commit threshold so every stat card's swipe feel stays consistent.
const SWIPE_COMMIT_PX = 28;
// Moving more than this before the long-press timer fires cancels the
// hold outright — same deadzone used by the Method row's hold-then-swipe.
const MOVE_CANCEL_PX = 8;

export function StatCard({
  label,
  value,
  onIncr,
  onDecr,
  modifier = 0,
}: {
  label: string;
  value: number;
  onIncr: () => void;
  onDecr: () => void;
  /** A Collapse Table ± adjustment already baked into `value` — shown as a
   * "(+N)"/"(−N)" suffix next to the value so the player can see how much
   * of it came from a permanent Collapse result. */
  modifier?: number;
}) {
  // WT previously had tap raise / long-press lower, then briefly had tap
  // lower / long-press raise — both let a single stray tap change the
  // value. Plain tap now does nothing: only a long-press (raise, with the
  // same rising-glow effect used elsewhere) or a swipe down (lower) commit
  // anything, so an accidental tap is always a no-op.
  const [holding, setHolding] = useState(false);
  const [swipingDown, setSwipingDown] = useState(false);
  const [commitFlash, setCommitFlash] = useState<null | "add" | "remove">(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const pressing = useRef(false);
  const firedRef = useRef(false);
  const lockedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const commitFlashTimer = useRef<number | null>(null);

  const flashCommit = (kind: "add" | "remove") => {
    if (commitFlashTimer.current !== null) window.clearTimeout(commitFlashTimer.current);
    setCommitFlash(kind);
    commitFlashTimer.current = window.setTimeout(() => {
      commitFlashTimer.current = null;
      setCommitFlash(null);
    }, 320);
  };

  const unlock = () => {
    if (lockedRef.current) {
      lockedRef.current = false;
      unlockScroll();
    }
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearTimer();
      unlock();
      if (commitFlashTimer.current !== null) window.clearTimeout(commitFlashTimer.current);
    },
    []
  );

  const reset = () => {
    pressing.current = false;
    clearTimer();
    setHolding(false);
    setSwipingDown(false);
    unlock();
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    pressing.current = true;
    firedRef.current = false;
    startX.current = event.clientX;
    startY.current = event.clientY;
    lockedRef.current = true;
    lockScroll();
    setHolding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      onIncr();
      flashCommit("add");
      reset();
    }, STANDARD_LONG_PRESS_MS);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!pressing.current) return;
    const dx = event.clientX - startX.current;
    const dy = event.clientY - startY.current;
    if (Math.abs(dx) > Math.abs(dy) || Math.abs(dy) < MOVE_CANCEL_PX) {
      setSwipingDown(false);
      return;
    }
    // Any meaningful movement cancels the long-press-to-raise — it's
    // either turning into a swipe-down-to-lower, or an aimless drag.
    clearTimer();
    setHolding(false);
    setSwipingDown(dy > 0);
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (!pressing.current) return;
    const dy = event.clientY - startY.current;
    const dx = event.clientX - startX.current;
    const swipedDown = dy >= SWIPE_COMMIT_PX && dy > Math.abs(dx);
    const alreadyFired = firedRef.current;
    reset();
    if (alreadyFired) return; // long-press already raised it
    if (swipedDown) {
      onDecr();
      flashCommit("remove");
    }
    // Anything short of a full swipe down, and a plain tap, does nothing.
  };

  return (
    <div
      className={`core-card interactive${swipingDown ? " tap-pending-remove" : ""}${commitFlash ? ` tap-flash-${commitFlash}` : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${label} ${value}. Long-press to increase, swipe down to decrease.`}
      style={{ touchAction: "manipulation", position: "relative", overflow: "hidden" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={reset}
      onPointerCancel={reset}
      onContextMenu={(event) => event.preventDefault()}
    >
      {holding && (
        <span
          className="rising-progress-fill timed active"
          style={{ ["--hold-progress-ms" as string]: `${STANDARD_LONG_PRESS_MS}ms` } as CSSProperties}
          aria-hidden="true"
        />
      )}
      <span className="core-label">{label}</span>
      <div className="core-controls">
        <span className="core-value">{value}</span>
        {modifier !== 0 && (
          <span className="core-value-modifier">
            ({modifier > 0 ? "+" : "−"}{Math.abs(modifier)})
          </span>
        )}
      </div>
    </div>
  );
}
