import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatCard } from "../components/StatCard";
import { CoreStatCard } from "../components/CoreStatCard";
import { ApproachDistributionPopout } from "../components/ApproachDistributionPopout";
import { ApproachDieSizeControl } from "../components/ApproachDieSizeControl";
import type { ApproachStats, CollapseModifiers, CoreStats } from "../../types/chud";
import type { DieSides } from "../../domain/approachDice";
import { rollFlatDice } from "../../domain/approachDice";
import { createLongPressHandlers } from "../../utils/createLongPressHandlers";
import { CORE_APPROACH_MAP, APPROACH_LABELS, CORE_LABELS } from "../../domain/coreApproachMap";
import { DEFAULT_COLLAPSE_MODIFIERS, formatStatWithModifier } from "../../domain/chudStats";

// Matches ApproachDie.tsx's Method-roll tumble animation timing exactly, so
// the Readiness roll "feels" like the same dice engine rather than a
// separate, instant number.
const READINESS_ROLL_ANIM_TICKS = 8;
const READINESS_ROLL_ANIM_INTERVAL_MS = 60;

// Page 2 (AAG): —
//   1. Readyness | MGR button
//   2. WT | Damage die
//   3. Capacity | Inventory Slots
//   4. Core Stats (long-press opens the Approach distribution popout)
// The Approach dice cards (tap-arm / hold-roll) and the Dig Deep / Full
// Rest stack live elsewhere now — Approach moved to the HUD, Rest moved to
// the bottom of this page (see RestWidget below).
export function Page2Panel({
  onOpenMgr,
  readyness,
  isOverEncumbered,
  wt,
  onWtIncr,
  onWtDecr,
  capacity,
  inventorySlots,
  skillCount,
  fumbleNumber,
  core,
  onCoreChange,
  approach,
  onApproachChange,
  damageDieSize,
  onDamageDieSizeIncrease,
  onDamageDieSizeReset,
  restWidget,
  collapseModifiers = DEFAULT_COLLAPSE_MODIFIERS,
}: {
  onOpenMgr: () => void;
  readyness: number;
  isOverEncumbered: boolean;
  wt: number;
  onWtIncr: () => void;
  onWtDecr: () => void;
  capacity: number;
  inventorySlots: number;
  skillCount: number;
  fumbleNumber: number;
  core: CoreStats;
  onCoreChange: (field: keyof CoreStats, updater: (v: number) => number) => void;
  approach: ApproachStats;
  onApproachChange: (field: keyof ApproachStats, updater: (v: number) => number) => void;
  damageDieSize: DieSides;
  onDamageDieSizeIncrease: () => DieSides;
  onDamageDieSizeReset: () => DieSides;
  restWidget?: ReactNode;
  /** Permanent Collapse Table ± adjustments, shown as "(±N)" badges next
   * to the stats they affect (WT, Capacity, Inventory Slots). */
  collapseModifiers?: CollapseModifiers;
}) {
  const [openDistribution, setOpenDistribution] = useState<keyof CoreStats | null>(null);
  const [readinessRolling, setReadinessRolling] = useState(false);
  const [readinessRollPreview, setReadinessRollPreview] = useState(1);
  const [readinessRoll, setReadinessRoll] = useState<{ die: number; lastDisplay: boolean } | null>(null);
  const readinessTimerRef = useRef<number | null>(null);
  const readinessFiredRef = useRef(false);
  const readinessRollAnimTimer = useRef<number | null>(null);
  const readinessPopupRef = useRef<HTMLDivElement>(null);
  const readinessChipRef = useRef<HTMLDivElement>(null);

  const closeReadinessRoll = () => {
    if (readinessRollAnimTimer.current !== null) {
      window.clearInterval(readinessRollAnimTimer.current);
      readinessRollAnimTimer.current = null;
    }
    setReadinessRolling(false);
    setReadinessRoll(null);
  };

  const readinessPressHandlers = createLongPressHandlers(
    readinessTimerRef,
    readinessFiredRef,
    () => {}, // tap does nothing — only the long-press rolls
    () => {
      if (isOverEncumbered) {
        setReadinessRoll({ die: 0, lastDisplay: true });
        return;
      }
      // "Numbers rolling" tumble, same timing/visual as a Method roll's
      // popup, before settling on the real face.
      setReadinessRoll(null);
      setReadinessRolling(true);
      setReadinessRollPreview(Math.floor(Math.random() * 10) + 1);
      let ticks = 0;
      readinessRollAnimTimer.current = window.setInterval(() => {
        ticks += 1;
        if (ticks >= READINESS_ROLL_ANIM_TICKS) {
          if (readinessRollAnimTimer.current !== null) {
            window.clearInterval(readinessRollAnimTimer.current);
            readinessRollAnimTimer.current = null;
          }
          setReadinessRolling(false);
          const [die] = rollFlatDice(1, 10);
          setReadinessRoll({ die, lastDisplay: false });
          return;
        }
        setReadinessRollPreview(Math.floor(Math.random() * 10) + 1);
      }, READINESS_ROLL_ANIM_INTERVAL_MS);
    }
  );

  // Tap-outside-to-close — same pattern as ApproachDie.tsx's Method roll
  // popup: a document-level listener rather than a full-screen backdrop,
  // ignoring taps that land on the popup itself or on the chip that opened it.
  useEffect(() => {
    if (!readinessRolling && !readinessRoll) return;
    const handleOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (readinessChipRef.current?.contains(event.target)) return
      if (readinessPopupRef.current?.contains(event.target)) return
      closeReadinessRoll();
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [readinessRolling, readinessRoll]);

  useEffect(() => () => {
    if (readinessRollAnimTimer.current !== null) window.clearInterval(readinessRollAnimTimer.current);
  }, []);

  const coreStats = useMemo<Array<[keyof CoreStats, string]>>(
    () => [
      ["vigor", CORE_LABELS.vigor],
      ["inference", CORE_LABELS.inference],
      ["personality", CORE_LABELS.personality],
    ],
    []
  );

  return (
    <div className="mods">
      {/* Row 1: Readyness | MGR button */}
      <div className="row-rdy-mgr">
        <div
          ref={readinessChipRef}
          className="chip"
          {...readinessPressHandlers}
          style={{ cursor: "pointer", touchAction: "manipulation" }}
          aria-label={
            isOverEncumbered
              ? "Readiness: Last (over-encumbered). Long-press to roll."
              : `Readiness ${readyness}. Long-press to roll 1d10 plus Readiness.`
          }
        >
          <span>READINESS</span>
          <strong style={isOverEncumbered ? { color: 'rgba(255,100,100,0.95)', fontStyle: 'italic' } : undefined}>
            {isOverEncumbered ? 'Last' : formatStatWithModifier(readyness, collapseModifiers.readiness)}
          </strong>
        </div>
        <button className="topbar-square-btn" onClick={onOpenMgr}>
          MGR
        </button>
      </div>
      {(readinessRolling || readinessRoll) && (
        <div ref={readinessPopupRef} className="approach-die-popup">
          <button
            type="button"
            className="approach-die-popup-close"
            onClick={closeReadinessRoll}
            aria-label="Close roll result"
          >
            X
          </button>
          <div className="approach-die-popup-label">Readiness</div>

          {readinessRolling && (
            <div className="approach-die-popup-die">
              <span className="approach-die-chip rolling top" aria-hidden="true">
                {readinessRollPreview}
              </span>
            </div>
          )}

          {!readinessRolling && readinessRoll && (
            readinessRoll.lastDisplay ? (
              <div className="approach-die-popup-die">
                <span className="approach-die-chip top">Last</span>
              </div>
            ) : (
              <>
                <div className="approach-die-popup-die">
                  <span className="approach-die-chip top">{readinessRoll.die}</span>
                </div>
                <div className="approach-die-popup-swipe-hint">
                  1d10 ({readinessRoll.die}) + Readiness ({readyness}) = {readinessRoll.die + readyness}
                </div>
              </>
            )
          )}
        </div>
      )}

      {/* Row 2: WT | Damage die */}
      <div className="row-wt-dmg">
        <StatCard label="WT" value={wt} onIncr={onWtIncr} onDecr={onWtDecr} modifier={collapseModifiers.wt} />
        <ApproachDieSizeControl
          die={damageDieSize}
          onIncrease={onDamageDieSizeIncrease}
          onReset={onDamageDieSizeReset}
          label="QUALITY"
        />
      </div>

      {/* Row 3: Capacity | Inventory Slots (25% smaller, 2-across on mobile).
          Inventory Slots is derived (Vigor), not separately set. */}
      <div className="core-grid row-compact-3">
        <div className="chip">
          <span>Capacity</span>
          <strong>{formatStatWithModifier(capacity, collapseModifiers.capacity)}</strong>
        </div>
        <div className="chip">
          <span>Inv Slots</span>
          <strong>{formatStatWithModifier(inventorySlots, collapseModifiers.inventorySlots)}</strong>
        </div>
      </div>

      {/* Row 4: Skills | Fumble Number — derived from Core stats
          (Inference, V+I+P respectively). Ganbare! Charges moved to the
          HUD, rendered to the right of HP. */}
      <div className="core-grid row-vitals-2">
        <div className="chip">
          <span>Skills</span>
          <strong>{skillCount}</strong>
        </div>
        <div className="chip">
          <span>Fumble</span>
          <strong>{fumbleNumber > 0 ? -fumbleNumber : fumbleNumber}</strong>
        </div>
      </div>

      {/* Row 5: Core Stats */}
      <div className="mods">
        <h3>Core Stats</h3>
        <div className="core-grid">
          {coreStats.map(([field, label]) => (
            <CoreStatCard
              key={field}
              label={label}
              value={core[field]}
              onIncr={() => onCoreChange(field, (v) => v + 1)}
              onDecr={() => onCoreChange(field, (v) => Math.max(0, v - 1))}
              onOpenDistribution={() => setOpenDistribution(field)}
            />
          ))}
        </div>
      </div>

      {openDistribution && (() => {
        const [a, b] = CORE_APPROACH_MAP[openDistribution];
        return (
          <ApproachDistributionPopout
            coreLabel={CORE_LABELS[openDistribution]}
            poolTotal={core[openDistribution]}
            approachA={a}
            approachALabel={APPROACH_LABELS[a]}
            approachAValue={approach[a]}
            onApproachAChange={(updater) => onApproachChange(a, updater)}
            approachB={b}
            approachBLabel={APPROACH_LABELS[b]}
            approachBValue={approach[b]}
            onApproachBChange={(updater) => onApproachChange(b, updater)}
            onClose={() => setOpenDistribution(null)}
          />
        );
      })()}

      {restWidget}
    </div>
  );
}
