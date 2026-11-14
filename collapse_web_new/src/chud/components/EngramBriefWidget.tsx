import { useRef, useState } from "react";
import { engramCatalogById } from "../../data/handbook/engramCatalog";
import { addEngramCharge, spendEngramCharges, type EngramManagerState } from "../../utils/engramState";
import { STANDARD_LONG_PRESS_MS } from "../../utils/gestureConstants";

const SWIPE_THRESHOLD_PX = 30;

// Swipeable Engram queue widget — mirrors GearBriefWidget's layout, but with
// its own gesture set: swipe left/right to cycle through every *equipped*
// Engram (not just ones with charges left); a tap adds back one charge
// (manual stack top-up), cycling back to 0 if it's already at max; a
// long-press opens an info popup for the Engram on screen.
export function EngramBriefWidget({
  state,
  storageKey,
}: {
  state: EngramManagerState;
  storageKey: string;
}) {
  const [idx, setIdx] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0); // 0–100
  const [flashIn, setFlashIn] = useState(false);
  const [popupEntry, setPopupEntry] = useState<{ id: string; name: string } | null>(null);
  const touchStartX = useRef<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isHolding = useRef(false);
  const holdFired = useRef(false);

  // Show every equipped Engram (copies > 0), regardless of current charge
  // count — a depleted Engram still needs to appear so its charge can be
  // topped back up with a tap.
  const activeEntries = Object.entries(state.equipped)
    .filter(([, e]) => e.copies > 0)
    .map(([id, e]) => ({ id, ...e, name: engramCatalogById[id]?.name ?? id }));
  const activeCount = activeEntries.length;

  const safeIdx = activeCount > 0 ? idx % activeCount : 0;

  const prev = () => setIdx(i => (activeCount > 0 ? (i - 1 + activeCount) % activeCount : 0));
  const next = () => setIdx(i => (activeCount > 0 ? (i + 1) % activeCount : 0));

  const entry = activeCount > 0 ? (activeEntries[safeIdx] ?? null) : null;
  const nameText = entry?.name.trim() || '—';
  const chargesText = entry ? `${entry.charges}/${entry.copies}` : '0';
  const hasContent = !!entry;

  const cancelHold = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (holdInterval.current) { clearInterval(holdInterval.current); holdInterval.current = null; }
    isHolding.current = false;
    setHoldProgress(0);
  };

  const startHold = () => {
    if (!entry) return;
    isHolding.current = true;
    const start = Date.now();
    holdInterval.current = setInterval(() => {
      setHoldProgress(Math.min(((Date.now() - start) / STANDARD_LONG_PRESS_MS) * 100, 100));
    }, 30);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      cancelHold();
      setPopupEntry({ id: entry.id, name: entry.name });
    }, STANDARD_LONG_PRESS_MS);
  };

  // border/shadow driven by hold progress — same accent as Gear's widget,
  // so the two queues read as a matched pair.
  const holdGlow = holdProgress / 100;
  const accentR = 15; const accentG = 246; const accentB = 255;
  const borderColor = holdProgress > 0
    ? `rgba(${accentR},${accentG},${accentB},${0.15 + 0.85 * holdGlow})`
    : 'rgba(255,255,255,0.1)';
  const boxShadow = holdProgress > 0
    ? `0 0 ${8 + 24 * holdGlow}px rgba(${accentR},${accentG},${accentB},${0.15 + 0.55 * holdGlow})`
    : flashIn
    ? '0 0 28px rgba(120,220,140,0.6)'
    : 'none';

  if (activeCount === 0) {
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
            fontSize: "0.58rem",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--muted, #9aa0a6)",
            textAlign: "center",
          }}
        >
          Engrams
        </span>
        <span
          style={{
            fontStyle: "italic",
            color: "rgba(248,250,252,0.25)",
            fontSize: "0.78rem",
            textAlign: "center",
          }}
        >
          no engrams
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: '7 1 0',
        background: 'rgba(8,13,23,0.92)',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
        cursor: entry ? 'pointer' : 'default',
        boxShadow,
        transition: holdProgress > 0 ? 'none' : 'background 0.3s, border-color 0.4s, box-shadow 0.4s',
      }}
      onPointerDown={e => {
        touchStartX.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
        startHold();
      }}
      onPointerUp={e => {
        const dx = touchStartX.current !== null ? e.clientX - touchStartX.current : 0;
        const fired = holdFired.current;
        cancelHold();
        holdFired.current = false;
        touchStartX.current = null;
        if (fired) return;
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
          // Swipe left reveals the next Engram (drag finger left), swipe
          // right goes back to the previous one — same direction mapping
          // as a photo-gallery carousel.
          if (dx < 0) next(); else prev();
          return;
        }
        // A tap (no drag, no hold) adds one charge; at max, a tap cycles
        // back down to 0 instead of being a no-op.
        if (entry) {
          if (entry.charges < entry.copies) {
            addEngramCharge(storageKey, entry.id);
          } else if (entry.charges > 0) {
            spendEngramCharges(storageKey, entry.id, entry.charges);
          }
          setFlashIn(true);
          setTimeout(() => setFlashIn(false), 300);
        }
      }}
      onPointerLeave={() => { cancelHold(); touchStartX.current = null; }}
      onPointerCancel={() => { cancelHold(); touchStartX.current = null; }}
      onContextMenu={e => e.preventDefault()}
    >
      <span
        style={{
          fontSize: '0.58rem',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--muted, #9aa0a6)',
          textAlign: 'center',
        }}
      >
        Engrams
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
            {chargesText}
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        <span
          style={{
            fontSize: '0.6rem',
            color: 'rgba(255,255,255,0.35)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {safeIdx + 1} / {activeCount}
        </span>
      </div>
      {popupEntry && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close"
          onPointerDown={e => { e.stopPropagation(); setPopupEntry(null); }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 500,
            background: 'rgba(5,8,14,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              background: 'rgba(10,16,28,0.97)',
              border: '1px solid rgba(15,246,255,0.3)',
              borderRadius: 10,
              padding: '16px 20px',
              minWidth: 220,
              maxWidth: '80vw',
              boxShadow: '0 0 28px rgba(15,246,255,0.2)',
            }}
          >
            <div
              style={{
                fontSize: '0.7rem',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--accent, #0ff6ff)',
                marginBottom: 8,
              }}
            >
              {popupEntry.name}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'rgba(248,250,252,0.5)', fontStyle: 'italic' }}>
              Nothing here yet.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
