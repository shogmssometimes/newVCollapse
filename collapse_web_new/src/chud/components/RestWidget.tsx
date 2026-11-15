import { useCallback, useEffect, useState } from "react";
import type { CoreStats } from "../../types/chud";
import { DEFAULT_CORE, computeDerived } from "../../domain/chudStats";
import {
  getNotificationsStorageKey,
  hasPendingNotification,
  pushNotification,
} from "../../domain/notifications";
import {
  readGlobalMeters,
  readHpCounter,
  readCore,
  maxGritForCollapse,
  resetApproachOverload,
  resetGanbareCharges,
} from "../../utils/chudVanillaBridge";
import { fullRestEngrams } from "../../utils/engramState";

function readState(storageKey: string): Record<string, unknown> {
  try {
    return JSON.parse(window.localStorage.getItem(storageKey) || "{}");
  } catch {
    return {};
  }
}

function writeState(storageKey: string, patch: Record<string, unknown>) {
  try {
    const next = { ...readState(storageKey), ...patch };
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // storage unavailable — ignore
  }
}

// Dig Deep / Full Rest, rendered at the bottom of the AAG page. Every Rest
// effect is rolled up-front and queued as a notification — nothing applies
// automatically.
//   - Full Rest: Grit set to 1d6 + Rest Bonus (max 6), HP to max, Overload
//     dice (Method dice) fully reset, all Engram charges refilled, and
//     Ganbare! Charges restored to max.
export function RestWidget({
  storageKey,
  deckBuilderStorageKey,
  core,
}: {
  storageKey: string;
  deckBuilderStorageKey: string;
  core?: CoreStats;
}) {
  const [digDeepPending, setDigDeepPending] = useState<boolean>(() =>
    typeof window !== "undefined" ? hasPendingNotification("dig-deep") : false
  );
  const [fullRestPending, setFullRestPending] = useState<boolean>(() =>
    typeof window !== "undefined" ? hasPendingNotification("full-rest") : false
  );
  const [restBonus, setRestBonus] = useState<number>(() => {
    const v = readState(storageKey).restBonus;
    return typeof v === "number" ? v : 0;
  });

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
    const roll = 1 + Math.floor(Math.random() * 6);
    const { grit: currentGrit, collapse } = readGlobalMeters();
    const maxGrit = maxGritForCollapse(collapse);
    const targetGrit = Math.min(maxGrit, roll + restBonus);
    const gritDelta = targetGrit - currentGrit;
    const activeCore = core ?? readCore(storageKey) ?? DEFAULT_CORE;
    const hpMax = computeDerived(activeCore).hp;
    const hpDelta = hpMax - readHpCounter(storageKey);
    const bonusText = restBonus ? ` + ${restBonus} Rest Bonus` : "";
    const capNote = roll + restBonus > maxGrit ? ` (max Grit is ${maxGrit} with current Collapse)` : "";
    const created = pushNotification(
      "full-rest",
      "Full Rest",
      `Rolled ${roll}${bonusText} for Grit${capNote}. Accept to set Grit to ${targetGrit}, restore HP to full, refill all Engram charges, reset Method dice, and restore all Ganbare! Charges.`,
      { grit: gritDelta, hp: hpDelta, restoreOverload: true, fullEngramRestore: true },
      { roll: { die: 6, value: roll } }
    );
    if (created) setFullRestPending(true);
  }, [core, storageKey, restBonus]);

  const changeRestBonus = useCallback(
    (delta: number) => {
      setRestBonus((prev) => {
        const next = Math.max(0, prev + delta);
        writeState(storageKey, { restBonus: next });
        return next;
      });
    },
    [storageKey]
  );

  return (
    <div className="mods rest-widget">
      <h3>Rest</h3>

      <div className="rest-stack">
        <button
          type="button"
          className="rest-stack-btn digdeep"
          onClick={onDigDeep}
          disabled={digDeepPending}
          title={digDeepPending ? "Resolve the pending Dig Deep notification first" : undefined}
        >
          {digDeepPending ? "Dig Deep (pending…)" : "Dig Deep"}
        </button>
        <div className="full-rest-row">
          <button
            type="button"
            className="rest-stack-btn fullrest"
            onClick={onFullRest}
            disabled={fullRestPending}
            title={fullRestPending ? "Resolve the pending Full Rest notification first" : undefined}
          >
            {fullRestPending ? "Full Rest (pending…)" : "Full Rest"}
          </button>
          <div className="rest-bonus-stepper" title="GM-set Rest Bonus added to the Full Rest Grit roll">
            <span>Rest Bonus</span>
            <button type="button" onClick={() => changeRestBonus(-1)} disabled={restBonus <= 0}>
              −
            </button>
            <span className="rest-bonus-value">{restBonus}</span>
            <button type="button" onClick={() => changeRestBonus(1)}>
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Applies an accepted "full-rest" notification's Engram/Method-dice side
// effects (the Grit/HP deltas go through the normal effect-application path
// already shared by every notification kind). Exported so the header bell
// and Chud.tsx's resolver can call it without duplicating the logic.
export function applyFullRestExtras(chudStateKey: string, deckBuilderStorageKey: string): void {
  resetApproachOverload(chudStateKey);
  resetGanbareCharges(chudStateKey);
  fullRestEngrams(deckBuilderStorageKey);
}
