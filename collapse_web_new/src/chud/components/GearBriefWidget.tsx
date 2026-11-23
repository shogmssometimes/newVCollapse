import { useEffect, useRef, useState } from "react";
import type { GearSlotEntry } from "../../types/chud";
import { STANDARD_LONG_PRESS_MS } from "../../utils/gestureConstants";
import { lockScroll, unlockScroll } from "../../utils/scrollLock";

// Mirrors Gear.tsx's parseNonNegativeInt — defensive parse for entries that
// may hold a negative/fractional/non-numeric string.
function parseNonNegativeInt(raw: string): number {
  const n = Math.floor(Math.abs(parseFloat(raw)));
  return Number.isFinite(n) ? n : 0;
}

// Movement past this, before a long-press is decided, cancels an in-flight
// hold timer — a scroll/drag that happens to start on this widget
// shouldn't also fire a tap-to-charge once the finger lifts.
const MOVE_CANCEL_PX = 10;

// Gear queue widget — mirrors EngramBriefWidget's layout and gestures: the
// dedicated tap-to-cycle zone on the right advances through every entry
// with QTY > 0; a tap anywhere on the main body builds up one more "charge"
// (capped at the entry's remaining QTY); a long-press on the main body
// consumes every currently-built-up charge at once, decrementing QTY by
// that amount (and clearing the slot entirely if it hits 0). Cycling to a
// different entry resets any unspent charge back to 0 — it's scoped to
// whichever item is on screen, not carried to the next one.
export function GearBriefWidget({
  entries,
  count,
  isOverEncumbered,
  gearSlotsKey,
}: {
  entries: GearSlotEntry[];
  count: number;
  isOverEncumbered: boolean;
  gearSlotsKey: string;
}) {
  const [idx, setIdx] = useState(0);
  const [chargeCount, setChargeCount] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0); // 0–100
  const [flashOut, setFlashOut] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isHolding = useRef(false);
  const holdFired = useRef(false);

  // Only show entries with QTY > 0. Scan the full entries array (not just
  // the first `count` slots) — Gear.tsx intentionally allows items to be
  // stashed in slots beyond the Vigor-derived visible count (so an
  // Over-Encumbered stash is still tracked), and those items are still
  // genuinely equipped/stocked, so the HUD queue must still surface them.
  const activeEntries = entries.filter(e => {
    const q = parseFloat(e.qty);
    return !isNaN(q) && q > 0;
  });
  const activeCount = activeEntries.length;

  const safeIdx = activeCount > 0 ? idx % activeCount : 0;

  const next = () => setIdx(i => (activeCount > 0 ? (i + 1) % activeCount : 0));

  const entry = activeCount > 0 ? (activeEntries[safeIdx] ?? null) : null;
  const nameText = entry?.name.trim() || '—';
  const qtyText = entry?.qty.trim() || '0';
  const hasContent = entry?.name.trim() || entry?.qty.trim();

  // we need the original index in `entries` to write back on use
  const entryOriginalIdx = entry ? entries.findIndex(e => e === entry) : -1;

  const canUse = entry !== null && (() => { const q = parseFloat(entry.qty); return !isNaN(q) && q > 0; })();
  const availableQty = entry ? (() => { const q = parseFloat(entry.qty); return isNaN(q) ? 0 : q; })() : 0;

  // A different entry on screen means a different item's charge — reset so
  // taps never silently carry a build-up over to an unrelated item.
  useEffect(() => { setChargeCount(0); }, [entryOriginalIdx]);

  const cancelHold = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (holdInterval.current) { clearInterval(holdInterval.current); holdInterval.current = null; }
    isHolding.current = false;
    setHoldProgress(0);
  };

  const startHold = () => {
    if (!canUse) return;
    isHolding.current = true;
    const start = Date.now();
    holdInterval.current = setInterval(() => {
      setHoldProgress(Math.min(((Date.now() - start) / STANDARD_LONG_PRESS_MS) * 100, 100));
    }, 30);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      cancelHold();
      // Long-press only spends charges that were actually built up by
      // tapping first — same rule as the Engram queue's long-press.
      if (chargeCount <= 0) return;
      const spend = chargeCount;
      setChargeCount(0);
      // decrement qty in localStorage
      try {
        const raw = window.localStorage.getItem(gearSlotsKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          const arr: GearSlotEntry[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
          const updated = arr.map((e, i) => {
            if (i !== entryOriginalIdx) return e;
            const q = parseFloat(e.qty);
            const next = isNaN(q) || q <= 0 ? 0 : Math.max(0, q - spend);
            // Using the last unit(s) clears the slot entirely instead of
            // leaving a stale qty-0 row behind.
            return next > 0 ? { ...e, qty: String(next) } : { name: '', units: '', qty: '' };
          });
          // Recompute slotsUsed from the updated entries (same formula as
          // Gear.tsx) instead of carrying the stale saved total forward —
          // otherwise Over-Encumbered stayed on until the Gear page was
          // reopened and recalculated it.
          const slotsUsed = updated.reduce((total, e) => total + parseNonNegativeInt(e.units) * parseNonNegativeInt(e.qty), 0);
          window.localStorage.setItem(gearSlotsKey, JSON.stringify({ entries: updated, slotsUsed }));
          // trigger storage event for Gear page
          window.dispatchEvent(new StorageEvent('storage', { key: gearSlotsKey, newValue: JSON.stringify({ entries: updated, slotsUsed }), storageArea: window.localStorage }));
        }
      } catch {}
      setFlashOut(true);
      setTimeout(() => setFlashOut(false), 600);
    }, STANDARD_LONG_PRESS_MS);
  };

  // border/shadow driven by hold progress
  const holdGlow = holdProgress / 100;
  const accentR = 15; const accentG = 246; const accentB = 255;
  const borderColor = holdProgress > 0
    ? `rgba(${accentR},${accentG},${accentB},${0.15 + 0.85 * holdGlow})`
    : isOverEncumbered ? 'rgba(212,43,43,0.55)' : 'rgba(255,255,255,0.1)';
  const boxShadow = holdProgress > 0
    ? `0 0 ${8 + 24 * holdGlow}px rgba(${accentR},${accentG},${accentB},${0.15 + 0.55 * holdGlow})`
    : flashOut
    ? `0 0 28px rgba(${accentR},${accentG},${accentB},0.6)`
    : isOverEncumbered ? '0 0 12px rgba(212,43,43,0.2)' : 'none';

  if (count === 0 || activeCount === 0) {
    return (
      <div
        style={{
          flex: "7 1 0",
          background: "rgba(8,13,23,0.92)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 0,
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <span
          style={{
            fontSize: "0.8rem",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--muted, #9aa0a6)",
            textAlign: "center",
          }}
        >
          In Brief
        </span>
        <span
          style={{
            fontStyle: "italic",
            color: "rgba(248,250,252,0.25)",
            fontSize: "0.78rem",
            textAlign: "center",
          }}
        >
          no inventory
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: '7 1 0',
        background: isOverEncumbered
          ? 'linear-gradient(135deg, rgba(212,43,43,0.18), rgba(180,20,20,0.10))'
          : 'rgba(8,13,23,0.92)',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'row',
        minWidth: 0,
        boxShadow,
        transition: holdProgress > 0 ? 'none' : 'background 0.3s, border-color 0.4s, box-shadow 0.4s',
      }}
    >
      <div
        style={{
          flex: 1,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          touchAction: 'none',
          cursor: canUse ? 'pointer' : 'default',
        }}
        onPointerDown={e => {
          touchStart.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
          lockScroll();
          startHold();
        }}
        onPointerMove={e => {
          if (!touchStart.current || !isHolding.current) return;
          const dx = e.clientX - touchStart.current.x;
          const dy = e.clientY - touchStart.current.y;
          if (Math.abs(dx) > MOVE_CANCEL_PX || Math.abs(dy) > MOVE_CANCEL_PX) {
            cancelHold();
          }
        }}
        onPointerUp={e => {
          const start = touchStart.current;
          const fired = holdFired.current;
          cancelHold();
          holdFired.current = false;
          if (touchStart.current) unlockScroll();
          touchStart.current = null;
          if (fired || start === null) return;
          // Cycling now lives entirely in the dedicated zone on the right —
          // every release here that wasn't a long-press is a tap, and a tap
          // always builds up one more charge, capped at the QTY actually
          // on hand.
          if (entry) {
            setChargeCount(c => (c + 1 >= availableQty ? availableQty : c + 1));
          }
        }}
        onPointerLeave={() => { cancelHold(); if (touchStart.current) unlockScroll(); touchStart.current = null; }}
        onPointerCancel={() => { cancelHold(); if (touchStart.current) unlockScroll(); touchStart.current = null; }}
        onContextMenu={e => e.preventDefault()}
      >
        <span
          style={{
            fontSize: '0.8rem',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: isOverEncumbered ? 'rgba(255,100,100,0.9)' : 'var(--muted, #9aa0a6)',
            textAlign: 'center',
          }}
        >
          {isOverEncumbered ? '⚠ Over-Encumbered' : 'In Brief'}
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'center',
            gap: 6,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '0.88rem',
              fontWeight: 600,
              textAlign: 'center',
              color: hasContent ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)',
            }}
          >
            {nameText}
          </span>
          {hasContent && (
            <span
              style={{
                fontSize: '0.75rem',
                color: 'var(--accent, #0ff6ff)',
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0,
              }}
            >
              ×{qtyText}
            </span>
          )}
          {hasContent && chargeCount > 0 && (
            <span
              style={{
                fontSize: '0.68rem',
                color: 'rgba(120,220,140,0.9)',
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              ({chargeCount} built up)
            </span>
          )}
        </div>
      </div>
      {/* Dedicated cycle zone — a plain tap always just advances to the
          next stocked Gear item, visually set apart from the charge/use
          body by a divider and dimmer background so it reads as its own
          control rather than part of the tap-to-charge gesture area. */}
      <button
        type="button"
        onClick={() => next()}
        aria-label={`Next Gear item (${safeIdx + 1} of ${activeCount})`}
        style={{
          flexShrink: 0,
          width: 34,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          background: 'rgba(255,255,255,0.03)',
          border: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '0 7px 7px 0',
          color: 'rgba(255,255,255,0.55)',
          cursor: 'pointer',
          touchAction: 'manipulation',
          padding: 0,
        }}
      >
        <span style={{ fontSize: '1.05rem', lineHeight: 1 }} aria-hidden="true">›</span>
        <span style={{ fontSize: '0.62rem', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
          {safeIdx + 1}/{activeCount}
        </span>
      </button>
    </div>
  );
}
