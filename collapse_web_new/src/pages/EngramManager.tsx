import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_CORE, computeDerived } from "../domain/chudStats";
import { loadState } from "../utils/chudPersistence";
import { engramCatalog } from "../data/handbook/engramCatalog";
import {
  readEngramState,
  setEngramCopies,
  type EngramManagerState,
} from "../utils/engramState";
import { EngramBriefWidget } from "../chud/components/EngramBriefWidget";

// Player-facing Engram Manager: spell-slot style — equip copies of an
// Engram (capped by Capacity), one row per Engram, spread however many
// copies across however many different Engrams the player wants. Equipping
// a copy locks it straight into the HUD's Engram queue — there's no
// separate "select" step here; spending/recovering a charge day-to-day
// happens from the queue widget (swipe to cycle, tap to top up a charge,
// long-press to spend one), mirrored here at the top of the page as a live
// preview of that same queue.
export default function EngramManager({
  storageKey,
  chudStateStorageKey,
}: {
  storageKey: string;
  chudStateStorageKey: string;
}) {
  const [state, setState] = useState<EngramManagerState>(() => readEngramState(storageKey));
  const [core, setCore] = useState(() => loadState(chudStateStorageKey)?.core ?? DEFAULT_CORE);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === storageKey) setState(readEngramState(storageKey));
      if (e.key === chudStateStorageKey) {
        const saved = loadState(chudStateStorageKey)?.core;
        if (saved) setCore(saved);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey, chudStateStorageKey]);

  const refresh = useCallback(() => setState(readEngramState(storageKey)), [storageKey]);

  const capacity = computeDerived(core).capacity;
  const capacityUsed = useMemo(
    () =>
      Object.entries(state.equipped).reduce((sum, [id, e]) => {
        const def = engramCatalog.find((entry) => entry.id === id);
        return sum + (def ? def.level * e.copies : 0);
      }, 0),
    [state.equipped]
  );
  const capacityRemaining = Math.max(0, capacity - capacityUsed);
  // Lowering Inference/Personality (via the AAG page) after Engrams are
  // already equipped can leave capacityUsed above the new, lower capacity —
  // the book only allows Engram edits at a Full Rest, so there's no way to
  // silently re-clamp this; surface it instead (B6).
  const isOverCapacity = capacityUsed > capacity;

  const changeCopies = useCallback(
    (id: string, level: number, delta: number) => {
      const current = state.equipped[id]?.copies ?? 0;
      const next = current + delta;
      if (next < 0) return;
      if (delta > 0 && level * delta > capacityRemaining) return; // not enough Capacity left
      setEngramCopies(storageKey, id, next);
      refresh();
    },
    [state.equipped, capacityRemaining, storageKey, refresh]
  );

  return (
    <div className="page engram-manager">
      <div className="engram-manager-header">
        <h2>Engrams</h2>
        <div className={`engram-capacity-readout${isOverCapacity ? " over-capacity" : ""}`}>
          Capacity: <strong>{capacityUsed}</strong> / {capacity}
        </div>
        {isOverCapacity && (
          <div className="engram-over-capacity-banner" role="alert">
            <span className="engram-over-capacity-icon">⚠</span>
            <div>
              <div className="engram-over-capacity-title">Over Capacity</div>
              <div className="engram-over-capacity-detail">
                Equipped Engrams exceed Capacity by {capacityUsed - capacity} — unequip copies to fix this. Engrams
                can only be changed at a Full Rest.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="engram-manager-queue-preview">
        <EngramBriefWidget state={state} storageKey={storageKey} />
      </div>

      <div className="engram-catalog-list">
        {engramCatalog.map((def) => {
          const equipped = state.equipped[def.id];
          const copies = equipped?.copies ?? 0;
          const charges = equipped?.charges ?? 0;
          const canAddCopy = def.level <= capacityRemaining;
          return (
            <div key={def.id} className="engram-row">
              <div className="engram-row-main">
                <div className="engram-row-title">
                  <span className="engram-name">{def.name}</span>
                  <span className="engram-level-badge">LVL {def.level}</span>
                </div>
                {def.effect && <div className="engram-effect">{def.effect}</div>}
                {def.note && <div className="engram-note muted">{def.note}</div>}
              </div>
              <div className="engram-row-controls">
                <div className="engram-copies-stepper" role="group" aria-label={`${def.name} copies owned`}>
                  <button type="button" onClick={() => changeCopies(def.id, def.level, -1)} disabled={copies <= 0}>
                    −
                  </button>
                  <span className="engram-copies-count">{copies}</span>
                  <button type="button" onClick={() => changeCopies(def.id, def.level, 1)} disabled={!canAddCopy}>
                    +
                  </button>
                </div>
                {copies > 0 && (
                  <div className="engram-charges-readout">
                    {charges} / {copies} charges
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

