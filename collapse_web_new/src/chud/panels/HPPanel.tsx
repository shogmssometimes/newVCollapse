import { useState, type ReactNode } from "react";
import { useGesture } from "../../hooks/useGesture";
import { GearPanel } from "./GearPanel";
import { EngramPanel } from "./EngramPanel";
import type { GearSlotEntry } from "../../types/chud";
import type { EngramManagerState } from "../../utils/engramState";

// HP section: HP bar, then Methods, then nested Set Rolls, Gear queue,
// Engram queue, Grit/Collapse meter, and (last) Chip Sync. Plain section
// (no accordion).
// Order on screen: HP, Methods, Sets, Gear Queue, Engram Queue, Grit/Collapse, Sync.
export function HPPanel({
  hpCounter,
  hpMax,
  hpMaxModifier = 0,
  collapseLocked,
  onHpIncr,
  onHpDecr,
  onHpSet,
  ganbareRemaining,
  ganbareMax,
  onSpendGanbare,
  gearEntries,
  gearSlotsUsed,
  gearSlotsKey,
  inventorySlots,
  engramState,
  engramStorageKey,
  onStageForRoller,
  methods,
  noDiceMode,
}: {
  hpCounter: number;
  hpMax: number;
  /** Permanent Collapse Table ± adjustment already baked into hpMax, shown as a "(±N)" badge next to it. */
  hpMaxModifier?: number;
  collapseLocked: boolean;
  onHpIncr: () => void;
  onHpDecr: () => void;
  /** Types a new HP value directly (tap the HP number) — clamped to [0, hpMax] by the caller. */
  onHpSet: (next: number) => void;
  /** Ganbare! Charges (the friend-assistance economy) — rendered to the right of HP. */
  ganbareRemaining: number;
  ganbareMax: number;
  onSpendGanbare: () => void;
  gearEntries: GearSlotEntry[] | null;
  gearSlotsUsed: number;
  gearSlotsKey: string;
  inventorySlots: number;
  engramState: EngramManagerState;
  engramStorageKey: string;
  /** Stages a roll-type Engram's charge count as the shared standby chip in every Method roll popup. */
  onStageForRoller: (id: string, name: string, charges: number) => void;
  /** The Methods (ApproachPanel) section, rendered directly below HP. */
  methods: ReactNode;
  noDiceMode?: boolean;
}) {
  // HP is inverted relative to every other stat card: a tap removes 1 HP
  // (the common case — taking damage), a 500ms hold adds 1 HP (healing —
  // deliberately slower/rarer to avoid accidental taps undoing damage).
  const hpHandlers = useGesture(onHpDecr, onHpIncr);
  const hpFillPct = Math.max(0, Math.min(100, (hpCounter / hpMax) * 100));
  // Tapping the HP number itself (instead of the rest of the card) opens a
  // direct-entry field — a separate gesture from the card's own tap/hold,
  // so stopPropagation on this span keeps the two from firing together.
  const [editingHp, setEditingHp] = useState(false);
  const [hpInput, setHpInput] = useState("");

  const commitHpInput = () => {
    const n = Math.round(Number(hpInput));
    if (Number.isFinite(n)) onHpSet(Math.min(Math.max(n, 0), hpMax));
    setEditingHp(false);
  };

  return (
    <div className="mods">
      <div className="hp-row">
        <div
          className="stat-card hp-card interactive"
          role="button"
          aria-disabled={collapseLocked ? "true" : "false"}
          tabIndex={collapseLocked ? -1 : 0}
          data-hp-state={hpFillPct <= 30 ? "critical" : hpFillPct <= 60 ? "warning" : "normal"}
          {...(collapseLocked ? {} : hpHandlers)}
        >
          <div className="stat-label">
            <strong>HP</strong>
            {editingHp ? (
              <input
                type="number"
                inputMode="numeric"
                className="hp-direct-input"
                autoFocus
                defaultValue={hpCounter}
                min={0}
                max={hpMax}
                onChange={(e) => setHpInput(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitHpInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHpInput();
                  if (e.key === "Escape") setEditingHp(false);
                }}
              />
            ) : (
              <span
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (collapseLocked) return;
                  setHpInput(String(hpCounter));
                  setEditingHp(true);
                }}
              >
                {hpCounter} / {hpMax}
                {hpMaxModifier !== 0 && (
                  <span className="hp-max-modifier">
                    {" "}({hpMaxModifier > 0 ? "+" : "−"}{Math.abs(hpMaxModifier)})
                  </span>
                )}
              </span>
            )}
          </div>
          <div
            className="stat-bar"
            role="img"
            aria-label={`HP ${hpCounter} of ${hpMax}`}
          >
            <div className="bar-fill" style={{ width: `${hpFillPct}%` }} />
          </div>
        </div>
        <button
          type="button"
          className="chip chip-spendable ganbare-charges-chip"
          onClick={onSpendGanbare}
          disabled={ganbareRemaining <= 0}
          aria-label={`Ganbare! ${ganbareRemaining} of ${ganbareMax} remaining. Tap to spend a Charge.`}
        >
          <span>Ganbare!</span>
          <strong>
            {ganbareRemaining}/{ganbareMax}
          </strong>
        </button>
      </div>
      {methods}
      {/* Set Rolls (Status Effects, vanilla widget from meter-bridge.js)
          mounts here, directly below Methods. */}
      <div id="chud-setrolls-anchor" />
      <GearPanel
        gearEntries={gearEntries}
        gearSlotsUsed={gearSlotsUsed}
        gearSlotsKey={gearSlotsKey}
        inventorySlots={inventorySlots}
      />
      <EngramPanel
        engramState={engramState}
        engramStorageKey={engramStorageKey}
        onStageForRoller={onStageForRoller}
        noDiceMode={noDiceMode}
      />
      {/* Grit/Collapse meter vanilla widget from meter-bridge.js mounts here,
          directly below the gear queue. */}
      <div id="chud-gcm-anchor" />
      {/* Chip Sync (vanilla widget from meter-bridge.js) mounts here, last,
          directly below the Grit/Collapse meter. */}
      <div id="chud-hp-queue-anchor" />
    </div>
  );
}

