import { useCallback, useEffect, useState } from "react";
import type { CollapseModifiers, CoreStats } from "../../types/chud";
import { computeDerived, DEFAULT_COLLAPSE_MODIFIERS } from "../../domain/chudStats";
import { isNoDiceMode, subscribeNoDiceMode } from "../../utils/noDiceMode";

// Matches Chud.tsx's real pre-save default (an unset character has no Core
// points yet) — falling back to DEFAULT_CORE's 3/2/2 here disagreed with
// what a brand-new HUD actually starts at.
const ZERO_CORE: CoreStats = { vigor: 0, inference: 0, personality: 0 };
import {
  getNotificationsStorageKey,
  hasPendingNotification,
  pushNotification,
} from "../../domain/notifications";
import {
  readGlobalMeters,
  readHpCounter,
  readCore,
  readCollapseModifiers,
  maxGritForCollapse,
} from "../../utils/chudVanillaBridge";

// Dig Deep / Full Rest, rendered at the bottom of the AAG page. Every Rest
// effect is rolled up-front and queued as a notification — nothing applies
// automatically.
//   - Full Rest: Grit restored by rolling 1d6, capped so Grit cannot exceed
//     (6 − current Collapse); HP to max; Overload dice (Method dice) fully
//     reset; all Engram charges refilled; all Ganbare! Charges refilled
//     (handbook v12 p42: "A Full Rest restores all of them.").
export function RestWidget({
  storageKey,
  deckBuilderStorageKey,
  core,
  collapseModifiers,
}: {
  storageKey: string;
  deckBuilderStorageKey: string;
  core?: CoreStats;
  collapseModifiers?: CollapseModifiers;
}) {
  const [digDeepPending, setDigDeepPending] = useState<boolean>(() =>
    typeof window !== "undefined" ? hasPendingNotification("dig-deep") : false
  );
  const [fullRestPending, setFullRestPending] = useState<boolean>(() =>
    typeof window !== "undefined" ? hasPendingNotification("full-rest") : false
  );
  const [noDiceMode, setNoDiceModeState] = useState<boolean>(() => isNoDiceMode());
  useEffect(() => subscribeNoDiceMode(() => setNoDiceModeState(isNoDiceMode())), []);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== getNotificationsStorageKey()) return;
      setDigDeepPending(hasPendingNotification("dig-deep"));
      setFullRestPending(hasPendingNotification("full-rest"));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const onDigDeep = useCallback(() => {
    if (hasPendingNotification("dig-deep")) return;
    const d1 = 1 + Math.floor(Math.random() * 4);
    const d2 = 1 + Math.floor(Math.random() * 4);
    const lose = Math.max(d1, d2);
    const gain = Math.min(d1, d2);
    // Max Grit is 6 - Collapse — show the Grit gain that will actually land,
    // not the raw roll, so "accept" never silently falls short of the promise.
    const { grit: currentGrit, collapse } = readGlobalMeters();
    const maxGrit = maxGritForCollapse(collapse);
    const actualGain = Math.min(maxGrit, currentGrit + gain) - currentGrit;
    const capNote = actualGain < gain ? ` (Grit capped at ${maxGrit} by Collapse)` : "";
    const created = pushNotification(
      "dig-deep",
      "Dig Deep",
      `Rolled ${d1}, ${d2}. Accept to lose ${lose} HP and gain ${actualGain} Grit${capNote}.`,
      { hp: -lose, grit: gain }
    );
    if (created) setDigDeepPending(true);
  }, []);

  const onFullRest = useCallback(() => {
    if (hasPendingNotification("full-rest")) return;
    // Grit restores by rolling 1d6, capped so Grit cannot exceed (6 − current
    // Collapse) — Full Rest also refills Ganbare! Charges (handbook v12
    // p42) alongside HP, Engram charges, and Method dice. No Dice Mode (C5)
    // restores everything EXCEPT Grit — the player rerolls 1d6 themselves
    // at the table and sets it on the bar, so no Grit delta is attached.
    const activeCore = core ?? readCore(storageKey) ?? ZERO_CORE;
    const activeModifiers = collapseModifiers ?? readCollapseModifiers(storageKey) ?? DEFAULT_COLLAPSE_MODIFIERS;
    const hpMax = computeDerived(activeCore, activeModifiers).hp;
    const hpDelta = hpMax - readHpCounter(storageKey);
    if (noDiceMode) {
      const created = pushNotification(
        "full-rest",
        "Full Rest",
        "Roll 1d6 and set Grit on the bar. Accept to restore HP to full, refill all Engram charges, refill all Ganbare! Charges, and reset Method dice.",
        { hp: hpDelta, restoreOverload: true, fullEngramRestore: true }
      );
      if (created) setFullRestPending(true);
      return;
    }
    const roll = 1 + Math.floor(Math.random() * 6);
    const { grit: currentGrit, collapse } = readGlobalMeters();
    const maxGrit = maxGritForCollapse(collapse);
    const targetGrit = Math.min(maxGrit, roll);
    const gritDelta = targetGrit - currentGrit;
    const capNote = roll > maxGrit ? ` (max Grit is ${maxGrit} with current Collapse)` : "";
    const created = pushNotification(
      "full-rest",
      "Full Rest",
      `Rolled ${roll} for Grit${capNote}. Accept to set Grit to ${targetGrit}, restore HP to full, refill all Engram charges, refill all Ganbare! Charges, and reset Method dice.`,
      { grit: gritDelta, hp: hpDelta, restoreOverload: true, fullEngramRestore: true },
      { roll: { die: 6, value: roll } }
    );
    if (created) setFullRestPending(true);
  }, [core, storageKey, collapseModifiers, noDiceMode]);

  return (
    <div className="mods rest-widget">
      <h3>Rest</h3>

      <div className="rest-stack">
        {!noDiceMode && (
          <button
            type="button"
            className="rest-stack-btn digdeep"
            onClick={onDigDeep}
            disabled={digDeepPending}
            title={digDeepPending ? "Resolve the pending Dig Deep notification first" : undefined}
          >
            {digDeepPending ? "Dig Deep (pending…)" : "Dig Deep"}
          </button>
        )}
        <button
          type="button"
          className="rest-stack-btn fullrest"
          onClick={onFullRest}
          disabled={fullRestPending}
          title={fullRestPending ? "Resolve the pending Full Rest notification first" : undefined}
        >
          {fullRestPending ? "Full Rest (pending…)" : "Full Rest"}
        </button>
      </div>
    </div>
  );
}
