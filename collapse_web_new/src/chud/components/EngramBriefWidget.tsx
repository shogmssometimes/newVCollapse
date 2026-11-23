import { useEffect, useRef, useState } from "react";
import { engramCatalogById } from "../../data/handbook/engramCatalog";
import { addEngramCharge, spendAllEngramCharges, type EngramManagerState } from "../../utils/engramState";
import { STANDARD_LONG_PRESS_MS } from "../../utils/gestureConstants";
import { lockScroll, unlockScroll } from "../../utils/scrollLock";
import { addSetRollRow } from "../../utils/chudVanillaBridge";

// Mirrors MOVE_CANCEL_PX below exactly — no dead zone in between. The old
// 18px swipe threshold (itself already lowered from a 30px original) left
// a gap between "moved enough to cancel the long-press hold" (10px) and
// "moved enough to count as a swipe" (18px), where a release did nothing
// at all; that gap read as Engram Q being less responsive than Gear Q's
// equivalent widget (which has no deliberate-swipe-distance requirement:
// any release that isn't a long-press and stayed within 30px just cycles).
// Once a release has moved past the point where the hold timer already
// gave up on it being a stationary tap, it's a swipe — there's nothing
// else it could be.
const SWIPE_THRESHOLD_PX = 10;
// Movement past this, before a swipe/tap is decided, cancels an in-flight
// long-press hold — otherwise a deliberate swipe-to-cycle gesture could
// accidentally also fire the long-press activation partway through.
const MOVE_CANCEL_PX = 10;

type ActivatePopup =
  | { kind: "staged"; name: string; charges: number }
  | { kind: "effect"; name: string; text: string }
  | { kind: "played"; name: string; text: string };

// Swipeable Engram queue widget — mirrors GearBriefWidget's layout. Gestures:
// swipe left/right cycles through every *equipped* Engram (copies > 0,
// regardless of current charge); a tap charges/preps one more stack (+1,
// wrapping back to 0 once at max copies — charges never refund for free,
// only Full Rest or an explicit refund does that); a long-press spends
// every currently-charged stack at once. For an Engram that rolls into a
// Method (handbook catalog's rollsIntoMethod), this only STAGES it — the
// charge count is handed to the globally-shared `onStageForRoller` slot,
// and the actual dice are rolled later when a Method roll popup activates
// that staged chip (see ApproachDie's engramStack). For an Engram that
// doesn't roll into a Method (heals, etc. — never enters a roller), the
// long-press resolves immediately and shows its effect text.
export function EngramBriefWidget({
  state,
  storageKey,
  onStageForRoller,
  noDiceMode = false,
}: {
  state: EngramManagerState;
  storageKey: string;
  /** Stages a roll-type Engram's charge count as the shared standby chip in every Method roll popup. Omitted on the Engram Manager's equip-screen preview, where there's no roller to stage into. */
  onStageForRoller?: (id: string, name: string, charges: number) => void;
  /** No Dice Mode (C2): there's no roller to stage into, so both the
   * long-press gesture and the visible "Play ×N" button spend an
   * Engram's charges immediately and show a toast instead of staging a
   * roll. Swipe-to-cycle and tap-to-charge are unchanged. */
  noDiceMode?: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0); // 0–100
  const [flashIn, setFlashIn] = useState(false);
  const [popup, setPopup] = useState<ActivatePopup | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isHolding = useRef(false);
  const holdFired = useRef(false);

  // No Dice Mode "Engram Played" toast auto-dismisses after ~3.5s — unlike
  // the staged/effect popups (which the player explicitly taps to close
  // before continuing), it previously stayed up and could cover the new
  // Set Rolls row that playEngram() just opened under it.
  useEffect(() => {
    if (popup?.kind !== "played") return;
    const t = setTimeout(() => setPopup(null), 3500);
    return () => clearTimeout(t);
  }, [popup]);

  // Show every equipped Engram (copies > 0), regardless of current charge
  // count — a depleted Engram still needs to appear in the cycle, it just
  // can't be spent again until recharged by a Full Rest.
  const activeEntries = Object.entries(state.equipped)
    .filter(([, e]) => e.copies > 0)
    .map(([id, e]) => ({ id, ...e, name: engramCatalogById[id]?.name ?? id }));
  const activeCount = activeEntries.length;

  const safeIdx = activeCount > 0 ? idx % activeCount : 0;

  const prev = () => setIdx(i => (activeCount > 0 ? (i - 1 + activeCount) % activeCount : 0));
  const next = () => setIdx(i => (activeCount > 0 ? (i + 1) % activeCount : 0));

  const entry = activeCount > 0 ? (activeEntries[safeIdx] ?? null) : null;
  const nameText = entry?.name.trim() || '—';
  // Gear-style countdown of uses actually remaining before a Rest (like
  // Gear's "×N" qty), not "currently charged / copies owned" — the old
  // "charges/copies" text (e.g. "0/4") never moved when a stack was spent,
  // since spending zeroes `charges` right back to the same number a fresh,
  // never-tapped Engram also shows at — it read as "nothing happened."
  const usesLeftText = entry ? `${entry.usesLeft}` : '0';
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
      // No Dice Mode: long-press also spends charges immediately (same as
      // the visible "Play ×N" button) instead of staging a roll — there's
      // no roller to stage into here.
      if (noDiceMode) playEngram(); else activate();
    }, STANDARD_LONG_PRESS_MS);
  };

  const activate = () => {
    if (!entry || entry.charges <= 0) return;
    const def = engramCatalogById[entry.id];
    const spent = spendAllEngramCharges(storageKey, entry.id);
    if (spent <= 0) return;
    if (def?.rollsIntoMethod) {
      onStageForRoller?.(entry.id, entry.name, spent);
      setPopup({ kind: "staged", name: entry.name, charges: spent });
    } else {
      setPopup({ kind: "effect", name: entry.name, text: def?.effect ?? "" });
    }
  };

  // No Dice Mode (C2): there's no roller to stage into, so "Play" spends
  // charges immediately. The toast names the dice the player now rolls by
  // hand ("xd4" in the handbook note scales with charges spent; a fixed
  // note like "Roll 1d10" doesn't). Engrams with no dice notation at all
  // just show their effect text, same as the Dice Mode long-press popup.
  // Engrams whose note contains "; Set" (Distract, Stun, Shield, Fortify,
  // etc.) also open a pre-filled, value-editable Set Rolls row.
  const playEngram = () => {
    if (!entry || entry.charges <= 0) return;
    const def = engramCatalogById[entry.id];
    const spent = spendAllEngramCharges(storageKey, entry.id);
    if (spent <= 0) return;
    const note = def?.note ?? "";
    const diceMatch = note.match(/Roll\s+(x|\d+)\s*d\s*(\d+)/i);
    const diceText = diceMatch
      ? diceMatch[1].toLowerCase() === "x"
        ? `${spent}d${diceMatch[2]}`
        : `${diceMatch[1]}d${diceMatch[2]}`
      : null;
    const toastText = diceText
      ? `${entry.name} ×${spent} played — roll ${diceText}.`
      : `${entry.name} ×${spent} played — ${def?.effect ?? ""}`;
    setPopup({ kind: "played", name: entry.name, text: toastText });
    if (note.includes("; Set")) {
      addSetRollRow(0, { name: entry.name, effect: def?.effect ?? "", openValueEntry: true });
    }
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
            fontSize: "0.8rem",
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
        touchStart.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
        // Lock page scroll for this gesture — an underlying scroll
        // fighting the same finger movement makes the swipe-to-cycle and
        // long-press-to-activate gestures here harder to land.
        lockScroll();
        // Long-press activates in both modes: Dice Mode stages the roll,
        // No Dice Mode plays immediately (same effect as the Play button).
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
        // Defensive guard: if a child element (e.g. the No Dice Mode Play
        // button) stopped propagation on pointerdown but this pointerup
        // still bubbles up, touchStart.current never got set for this
        // gesture — bail instead of falling through to the tap-charges branch.
        if (start === null) return;
        const dx = e.clientX - start.x;
        const fired = holdFired.current;
        cancelHold();
        holdFired.current = false;
        if (touchStart.current) unlockScroll();
        touchStart.current = null;
        if (fired) return;
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
          // Swipe left reveals the next Engram (drag finger left), swipe
          // right goes back to the previous one — same direction mapping
          // as a photo-gallery carousel.
          if (dx < 0) next(); else prev();
          return;
        }
        // A tap charges/preps one more stack, wrapping back to 0 once at
        // max copies — a tap never spends anything, that's long-press's job.
        // Reaching here means |dx| <= SWIPE_THRESHOLD_PX (checked above),
        // which is itself equal to MOVE_CANCEL_PX, so every release that
        // isn't a swipe is already a near-stationary tap — no separate
        // movement check needed.
        if (entry) {
          addEngramCharge(storageKey, entry.id);
          setFlashIn(true);
          setTimeout(() => setFlashIn(false), 300);
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
            ×{usesLeftText}
          </span>
        )}
        {hasContent && entry && entry.charges > 0 && (
          <span
            style={{
              fontSize: '0.68rem',
              color: 'rgba(120,220,140,0.9)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            ({entry.charges} charged)
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
            fontSize: '0.8rem',
            color: 'rgba(255,255,255,0.35)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {safeIdx + 1} / {activeCount}
        </span>
      </div>
      {noDiceMode && entry && entry.charges > 0 && (
        <button
          type="button"
          onPointerDown={e => e.stopPropagation()}
          onPointerUp={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); playEngram(); }}
          style={{
            marginTop: 2,
            padding: '4px 8px',
            fontSize: '0.75rem',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: '#04161a',
            background: 'var(--accent, #0ff6ff)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Play ×{entry.charges}
        </button>
      )}
      {popup && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close"
          onPointerDown={e => { e.stopPropagation(); setPopup(null); }}
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
              {popup.kind === "played" ? "Engram Played" : "Engrams Charged to Roll"}
            </div>
            {popup.kind !== "played" && (
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'rgba(248,250,252,0.85)',
                  marginBottom: popup.kind === "staged" ? 8 : 0,
                }}
              >
                {popup.name}
              </div>
            )}
            {popup.kind === "staged" ? (
              <div style={{ fontSize: '0.78rem', color: 'rgba(248,250,252,0.6)' }}>
                Staged × {popup.charges} — tap the standby chip in any Method's roll popup to roll it in.
              </div>
            ) : (
              <div style={{ fontSize: '0.78rem', color: 'rgba(248,250,252,0.6)', fontStyle: popup.kind === "effect" ? 'italic' : 'normal' }}>
                {popup.text}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
