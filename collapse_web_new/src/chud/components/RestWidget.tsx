import { useCallback, useEffect, useState } from "react";
import { isNoDiceMode, subscribeNoDiceMode } from "../../utils/noDiceMode";
import {
  getNotificationsStorageKey,
  hasPendingNotification,
  pushNotification,
} from "../../domain/notifications";
import { readGlobalMeters, maxGritForCollapse } from "../../utils/chudVanillaBridge";

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
}: {
  storageKey: string;
  deckBuilderStorageKey: string;
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
    // Preview only — the actual cap (and the Grit this adds) is resolved
    // fresh against live Grit/Collapse when the notification is accepted,
    // not baked in here at press time (see gritGainRaw in notifications.ts
    // — a Full Rest or another Dig Deep accepted first would otherwise make
    // a precomputed amount stale).
    const { grit: currentGrit, collapse } = readGlobalMeters();
    const maxGrit = maxGritForCollapse(collapse);
    const previewGain = Math.min(maxGrit, currentGrit + gain) - currentGrit;
    const capNote = previewGain < gain ? ` (Grit capped at ${maxGrit} by Collapse)` : "";
    const created = pushNotification(
      "dig-deep",
      "Dig Deep",
      `Rolled ${d1}, ${d2}. Accept to lose ${lose} HP and gain up to ${gain} Grit${capNote}.`,
      { hp: -lose, gritGainRaw: gain }
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
    // HP and Grit are both resolved live at accept time (setHpToMax /
    // gritSetRaw below) rather than as deltas baked in now — a Dig Deep or
    // another notification accepted while this one sits pending would
    // otherwise leave a stale precomputed delta that overshoots or
    // undershoots the actual max/target.
    if (noDiceMode) {
      const created = pushNotification(
        "full-rest",
        "Full Rest",
        "Roll 1d6 and set Grit on the bar. Accept to restore HP to full, refill all Engram charges, refill all Ganbare! Charges, and reset Method dice.",
        { setHpToMax: true, restoreOverload: true, fullEngramRestore: true }
      );
      if (created) setFullRestPending(true);
      return;
    }
    const roll = 1 + Math.floor(Math.random() * 6);
    const { collapse } = readGlobalMeters();
    const maxGrit = maxGritForCollapse(collapse);
    const targetGrit = Math.min(maxGrit, roll);
    const capNote = roll > maxGrit ? ` (max Grit is ${maxGrit} with current Collapse)` : "";
    const created = pushNotification(
      "full-rest",
      "Full Rest",
      `Rolled ${roll} for Grit${capNote}. Accept to set Grit to ${targetGrit}, restore HP to full, refill all Engram charges, refill all Ganbare! Charges, and reset Method dice.`,
      { gritSetRaw: roll, setHpToMax: true, restoreOverload: true, fullEngramRestore: true },
      { roll: { die: 6, value: roll } }
    );
    if (created) setFullRestPending(true);
  }, [noDiceMode]);

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
