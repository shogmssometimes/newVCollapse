import { useEffect, useMemo, useRef, useState } from "react";
import { ApproachDie, type ApproachDieRollResult } from "./ApproachDie";
import type { ApproachStats, CoreStats } from "../../types/chud";
import type { DieSides } from "../../domain/approachDice";
import { APPROACH_LABELS, CORE_APPROACH_MAP, CORE_LABELS } from "../../domain/coreApproachMap";
import { computeFumbleNumber } from "../../domain/chudStats";
import { hideUnusedMethodsKey } from "../../utils/slotKeys";

// ApproachPanel only ever renders inside the CHUD iframe, whose own URL
// carries ?slot=N (passed by the outer app when building the iframe src),
// so it's safe to self-resolve the active slot here (B2) rather than
// threading it down as a prop from Chud.tsx.
const _hideUnusedMethodsKey = (() => {
  if (typeof window === "undefined") return hideUnusedMethodsKey(1);
  const n = parseInt(new URLSearchParams(window.location.search).get("slot") ?? "1", 10);
  return hideUnusedMethodsKey(isNaN(n) || n < 1 || n > 3 ? 1 : n);
})();

const GANBARE_METHOD_ORDER: Array<keyof ApproachStats> = ["force", "finesse", "guts", "logic", "show", "tell"];
// 6 taps unlocks the frosted glass cover — it cracks visibly every 1-2
// taps. Unlocking doesn't fire the gift by itself: it uncovers the
// Ganbare! button, which then glows until *either* it's tapped (firing
// the gift and instantly re-covering) or GANBARE_UNLOCKED_TIMEOUT_MS
// passes with no tap (the cover silently reforms, nothing fires).
const GANBARE_TAPS_TO_UNLOCK = 6;
const GANBARE_UNLOCKED_TIMEOUT_MS = 60_000;
const GANBARE_FIRED_FLASH_MS = 450;
// Deadzone/commit distances (px) for the Method header's horizontal
// hide-0s swipe — same two-stage "pending, then commit" pattern used by
// every other swipe in the app.
const HEADER_SWIPE_DEADZONE_PX = 8;
const HEADER_SWIPE_COMMIT_PX = 40;

// "Receive Ganbare!" — handbook: a friend can spend one of *their* own
// Ganbare! Charges to return one of your Overloaded dice to its Method
// pool ("or until a friend gives you Ganbare! for it"). This control
// models receiving that gift on your own sheet: cycle the method-symbol
// box to the Method that should get its die back, then tap the frosted
// glass cover over the Ganbare! box 6 times to unlock it. Unlocking
// uncovers a glowing button — tapping *that* is the actual confirm step
// that restores the die and instantly re-covers the glass; leaving it
// unlocked for a minute without tapping just lets the cover silently
// reform instead (no restore, no re-count needed — next attempt starts
// a fresh 6 taps).
function GanbareControl({
  onReceiveGanbare,
}: {
  onReceiveGanbare: (field: keyof ApproachStats) => void;
}) {
  const [index, setIndex] = useState(0);
  const [taps, setTaps] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  const [justFired, setJustFired] = useState(false);
  const unlockTimeoutRef = useRef<number | null>(null);

  const field = GANBARE_METHOD_ORDER[index];

  const cycle = () => setIndex((i) => (i + 1) % GANBARE_METHOD_ORDER.length);

  const clearUnlockTimeout = () => {
    if (unlockTimeoutRef.current !== null) {
      window.clearTimeout(unlockTimeoutRef.current);
      unlockTimeoutRef.current = null;
    }
  };

  useEffect(() => clearUnlockTimeout, []);

  const handleTap = () => {
    if (unlocked) {
      // Confirm tap: fire the gift and re-cover instantly.
      clearUnlockTimeout();
      setUnlocked(false);
      setJustFired(true);
      window.setTimeout(() => setJustFired(false), GANBARE_FIRED_FLASH_MS);
      onReceiveGanbare(field);
      return;
    }
    // Reads `taps` directly rather than using the setState-updater form,
    // same reasoning as elsewhere in this file — avoids a double side
    // effect if React invokes the updater twice.
    const next = taps + 1;
    if (next >= GANBARE_TAPS_TO_UNLOCK) {
      setTaps(0);
      setUnlocked(true);
      clearUnlockTimeout();
      unlockTimeoutRef.current = window.setTimeout(() => {
        unlockTimeoutRef.current = null;
        setUnlocked(false);
      }, GANBARE_UNLOCKED_TIMEOUT_MS);
    } else {
      setTaps(next);
    }
  };

  // 4 crack stages (0 = intact): spread evenly over the taps-to-unlock.
  const crackStage = Math.min(4, Math.floor((taps * 4) / GANBARE_TAPS_TO_UNLOCK));

  return (
    <div className="ganbare-control">
      <button
        type="button"
        className="ganbare-method-box"
        onClick={cycle}
        aria-label={`Ganbare! target Method: ${APPROACH_LABELS[field]}. Tap to cycle.`}
      >
        {APPROACH_LABELS[field]}
      </button>
      <button
        type="button"
        className={`ganbare-receive-box${unlocked ? " unlocked" : ` crack-${crackStage}`}${justFired ? " fired" : ""}`}
        onClick={handleTap}
        aria-label={
          unlocked
            ? `Ganbare! unlocked for ${APPROACH_LABELS[field]}. Tap to restore 1 die, or wait a minute for the cover to reform.`
            : `Receive Ganbare! on ${APPROACH_LABELS[field]}. Tap the frosted glass cover ${GANBARE_TAPS_TO_UNLOCK - taps} more time${GANBARE_TAPS_TO_UNLOCK - taps === 1 ? "" : "s"} to unlock it.`
        }
      >
        {!unlocked && <span className="ganbare-glass-cover" aria-hidden="true" />}
        Ganbare!
      </button>
    </div>
  );
}

// Method rows — printed-sheet style, grouped under their linked Core stat
// (VIGOR / INFER / PERSO), two Methods each, lives in the HUD so the player
// can roll directly off the compact view. Ratings/distribution still live
// on the AAG page's Core Stats section; this panel only reads `approach`
// and `core`.
export function ApproachPanel({
  core,
  approach,
  damageDieSize,
  onRollApproachDie,
  approachOverloadSpent,
  approachWardrobeOverloadSpent,
  onOverloadApproachDie,
  onReceiveGanbare,
  approachWardrobeBonus,
  approachWardrobeItems,
  stagedEngram,
  onConsumeStagedEngram,
  onRefundEngram,
}: {
  core: CoreStats;
  approach: ApproachStats;
  damageDieSize: DieSides;
  onRollApproachDie: (field: keyof ApproachStats, count: number) => ApproachDieRollResult;
  approachOverloadSpent: Partial<Record<keyof ApproachStats, number>>;
  /** Overload spend tracked separately for each Method's Wardrobe bonus dice. */
  approachWardrobeOverloadSpent: Partial<Record<keyof ApproachStats, number>>;
  onOverloadApproachDie: (field: keyof ApproachStats, baseCount: number, wardrobeCount: number) => boolean;
  /** Restores 1 die to the chosen Method's pool (a friend's Ganbare!, tap to unlock the glass + confirm). */
  onReceiveGanbare: (field: keyof ApproachStats) => void;
  /** Extra dice granted by Wardrobe items assigned to each Method (on top of the Core-distributed rating). Always rolled; Overload-spendable as its own pool. */
  approachWardrobeBonus: Partial<Record<keyof ApproachStats, number>>;
  /** Wardrobe item names/bonuses contributing to each Method's bonus, for a tooltip. */
  approachWardrobeItems: Partial<Record<keyof ApproachStats, string[]>>;
  /** The single globally-staged Engram (from the HUD's Engram Q long-press), if any — shared by every Method roll popup as a standby chip. */
  stagedEngram: { id: string; name: string; charges: number } | null;
  /** Clears the global staged Engram once a popup activates it into its own Stack. */
  onConsumeStagedEngram: () => void;
  /** Refunds an already-activated Engram Stack's charges back to the Q — used when swapping Stacks. */
  onRefundEngram: (engramId: string, amount: number) => void;
}) {
  const coreGroups = useMemo<Array<keyof CoreStats>>(() => ["vigor", "inference", "personality"], []);
  const fumbleNumber = useMemo(() => computeFumbleNumber(core), [core]);
  const [hideUnused, setHideUnused] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(_hideUnusedMethodsKey) === "1";
    } catch {
      return false;
    }
  });

  const applyHideUnused = (next: boolean) => {
    setHideUnused(next);
    try {
      window.localStorage.setItem(_hideUnusedMethodsKey, next ? "1" : "0");
    } catch {
      // storage unavailable — ignore
    }
  };

  // Swipe left-to-right across the Method header hides the 0-dice rows;
  // swipe right-to-left restores them — replaces the old "Hide 0s" pill
  // button, which took up header width better spent on the title. Mirrors
  // the deadzone/commit-distance pattern used by every other swipe in the
  // app (e.g. CoreStatCard): short/vertical drags do nothing.
  const headerDragStartX = useRef(0);
  const headerDragStartY = useRef(0);
  const headerDragging = useRef(false);
  const [headerDragState, setHeaderDragState] = useState<null | "hide" | "show">(null);

  const handleHeaderPointerDown = (event: React.PointerEvent) => {
    headerDragging.current = true;
    headerDragStartX.current = event.clientX;
    headerDragStartY.current = event.clientY;
    setHeaderDragState(null);
  };

  const handleHeaderPointerMove = (event: React.PointerEvent) => {
    if (!headerDragging.current) return;
    const dx = event.clientX - headerDragStartX.current;
    const dy = event.clientY - headerDragStartY.current;
    if (Math.abs(dx) < HEADER_SWIPE_DEADZONE_PX || Math.abs(dx) < Math.abs(dy)) {
      setHeaderDragState(null);
      return;
    }
    setHeaderDragState(dx > 0 ? "hide" : "show");
  };

  const endHeaderDrag = () => {
    headerDragging.current = false;
    setHeaderDragState(null);
  };

  const handleHeaderPointerUp = (event: React.PointerEvent) => {
    if (!headerDragging.current) return;
    const dx = event.clientX - headerDragStartX.current;
    const dy = event.clientY - headerDragStartY.current;
    const swipedFar = Math.abs(dx) >= HEADER_SWIPE_COMMIT_PX && Math.abs(dx) >= Math.abs(dy);
    endHeaderDrag();
    if (!swipedFar) return;
    applyHideUnused(dx > 0);
  };

  return (
    <div className="mods">
      <div
        className={`approach-panel-header${headerDragState ? ` method-header-swipe-${headerDragState}` : ""}`}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
        onPointerLeave={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        aria-label={`Method${hideUnused ? ", Methods with no dice hidden" : ""}. Swipe right to hide Methods with no dice, swipe left to show them again.`}
      >
        <h3>Method</h3>
        {hideUnused && <span className="method-hide-unused-badge">0s hidden</span>}
      </div>
      <div className="method-groups">
        {coreGroups.map((coreField) => {
          const [a, b] = CORE_APPROACH_MAP[coreField];
          const fields = [a, b].filter((field) => {
            if (!hideUnused) return true;
            const totalDice = approach[field] + (approachWardrobeBonus[field] ?? 0);
            return totalDice > 0;
          });
          if (fields.length === 0) return null;
          return (
            <div className="method-group" key={coreField}>
              <div className="method-group-header">
                <span>{CORE_LABELS[coreField]}</span>
                <span className="method-group-stat-box" aria-label={`${CORE_LABELS[coreField]} Stat: ${core[coreField]}, shared across ${APPROACH_LABELS[a]} and ${APPROACH_LABELS[b]}`}>
                  {core[coreField]}
                </span>
              </div>
              {fields.map((field) => {
                const baseRating = approach[field];
                const wardrobeBonus = approachWardrobeBonus[field] ?? 0;
                const spent = approachOverloadSpent[field] ?? 0;
                const available = Math.max(0, baseRating - Math.min(Math.max(spent, 0), baseRating));
                const wardrobeSpent = approachWardrobeOverloadSpent[field] ?? 0;
                const wardrobeAvailable = Math.max(0, wardrobeBonus - Math.min(Math.max(wardrobeSpent, 0), wardrobeBonus));
                return (
                  <ApproachDie
                    key={field}
                    label={APPROACH_LABELS[field]}
                    baseRating={baseRating}
                    wardrobeBonus={wardrobeBonus}
                    wardrobeAvailable={wardrobeAvailable}
                    wardrobeItems={approachWardrobeItems[field] ?? []}
                    available={available}
                    damageDie={damageDieSize}
                    fumbleNumber={fumbleNumber}
                    onRoll={(count) => onRollApproachDie(field, count)}
                    onOverload={(baseCount, wardrobeCount) => onOverloadApproachDie(field, baseCount, wardrobeCount)}
                    stagedEngram={stagedEngram}
                    onConsumeStagedEngram={onConsumeStagedEngram}
                    onRefundEngram={onRefundEngram}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <GanbareControl onReceiveGanbare={onReceiveGanbare} />
    </div>
  );
}
