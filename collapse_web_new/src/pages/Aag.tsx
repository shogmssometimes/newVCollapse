import { useCallback, useEffect, useState } from "react";
import type { ApproachStats, CollapseModifiers, CollapseResultEntry, CoreStats } from "../types/chud";
import {
  DEFAULT_APPROACH,
  computeDerived,
  computeFumbleNumber,
  computeInventorySlots,
  computeSkillCount,
  computeWtBase,
  countActiveCollapseModifiers,
  withCollapseModifiers,
} from "../domain/chudStats";
import { isDieSides, stepUp, type DieSides } from "../domain/approachDice";
import { clampApproachToCore, clampCore, STAT_AND_METHOD_MAX } from "../domain/coreApproachMap";
import { loadState, readGearData } from "../utils/chudPersistence";
import { Page2Panel } from "../chud/panels/Page2Panel";
import { RestWidget } from "../chud/components/RestWidget";
import "./aagPage2.css";

const DEFAULT_DAMAGE_DIE_SIZE: DieSides = 6;

// AAG page: hosts the Page 2 box (moved out of the CHUD iframe). Reads and
// writes the same persisted cHUD state so the two stay in sync.
export default function AagPage({
  chudStateStorageKey,
  gearSlotsStorageKey,
  deckBuilderStorageKey,
  onOpenMgr,
  onOpenCollapse,
}: {
  chudStateStorageKey: string;
  gearSlotsStorageKey: string;
  deckBuilderStorageKey: string;
  onOpenMgr: () => void;
  onOpenCollapse: () => void;
}) {
  const saved = loadState(chudStateStorageKey);

  const [core, setCore] = useState<CoreStats>(clampCore(saved?.core ?? { vigor: 0, inference: 0, personality: 0 }));
  const [approach, setApproach] = useState<ApproachStats>(() => clampApproachToCore(saved?.approach ?? DEFAULT_APPROACH, clampCore(saved?.core ?? { vigor: 0, inference: 0, personality: 0 })));
  const [damageDieSize, setDamageDieSize] = useState<DieSides>(
    isDieSides(saved?.damageDieSize) ? saved.damageDieSize : DEFAULT_DAMAGE_DIE_SIZE
  );
  const [collapseModifiers, setCollapseModifiers] = useState<CollapseModifiers>(() =>
    withCollapseModifiers(saved?.collapseModifiers)
  );
  const [collapseResults, setCollapseResults] = useState<CollapseResultEntry[]>(saved?.collapseResults ?? []);
  // WT is the one stat that's "base + modifier, plus temporary changes on
  // top" (handbook statuses like Exposed) rather than a pure derived value
  // — `wt` is the actual displayed/stored number (as it always has been;
  // the WT StatCard's tap/hold gestures still edit this directly), while
  // the Collapse Modifiers panel only shifts the *base* a status sits on
  // top of. Changing the modifier re-bases `wt` by the same delta so the
  // temporary offset already applied survives untouched.
  const [wt, setWtRaw] = useState<number>(saved?.wt ?? computeWtBase(withCollapseModifiers(saved?.collapseModifiers)));
  const [gearSlotsUsed, setGearSlotsUsed] = useState<number>(() =>
    typeof window !== "undefined" ? (readGearData(gearSlotsStorageKey)?.slotsUsed ?? 0) : 0
  );

  const setWt = useCallback((v: number) => setWtRaw(Math.max(1, v)), []);
  const setCollapseModifiersField = useCallback((next: CollapseModifiers) => {
    setCollapseModifiers((prev) => {
      if (next.wt !== prev.wt) {
        const delta = next.wt - prev.wt;
        setWtRaw((w) => Math.max(1, w + delta));
      }
      return next;
    });
  }, []);


  // A Core stat's value is the total pool its two linked Approaches draw
  // from (see CORE_APPROACH_MAP). If the Core stat is lowered below what's
  // already distributed, trim the overflow back out of those Approaches so
  // the total distributed can never exceed the available pool. Stats and
  // Methods all max out at 6 per the handbook, so clamp the upper bound too.
  const setCoreField = useCallback(
    (field: keyof CoreStats, updater: (v: number) => number) =>
      setCore((prev) => {
        const nextValue = Math.min(STAT_AND_METHOD_MAX, Math.max(0, updater(prev[field])));
        const next = { ...prev, [field]: nextValue };
        setApproach((prevApproach) => clampApproachToCore(prevApproach, next));
        return next;
      }),
    []
  );
  const setApproachField = useCallback(
    (field: keyof ApproachStats, updater: (v: number) => number) =>
      setApproach((prev) => ({ ...prev, [field]: updater(prev[field]) })),
    []
  );

  const increaseDamageDieSize = useCallback((): DieSides => {
    const nextDie = stepUp(damageDieSize);
    setDamageDieSize(nextDie);
    return nextDie;
  }, [damageDieSize]);

  const resetDamageDieSize = useCallback((): DieSides => {
    setDamageDieSize(DEFAULT_DAMAGE_DIE_SIZE);
    return DEFAULT_DAMAGE_DIE_SIZE;
  }, []);

  const derived = computeDerived(core, collapseModifiers);
  const inventorySlots = computeInventorySlots(core, collapseModifiers);
  const isOverEncumbered = gearSlotsUsed > inventorySlots;
  const skillCount = computeSkillCount(core);
  const fumbleNumber = computeFumbleNumber(core);

  // "3 active · 1 result" / "None" — shown on the AAG's Collapse Modifiers
  // button so players can tell at a glance whether anything is set without
  // opening the page.
  const activeModifierCount = countActiveCollapseModifiers(collapseModifiers);
  const collapseModifiersSummary = (() => {
    const parts: string[] = [];
    if (activeModifierCount > 0) parts.push(`${activeModifierCount} active`);
    if (collapseResults.length > 0) parts.push(`${collapseResults.length} result${collapseResults.length === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(" · ") : "None";
  })();

  // Persist the fields this page owns, merging with whatever the CHUD iframe
  // has saved for the fields it owns (hpCounter, secondary, ganbareSpent,
  // etc.) so neither side clobbers the other.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(chudStateStorageKey);
      const prev = raw ? JSON.parse(raw) : {};
      // Strip legacy fields no longer part of SaveState (ap, draw,
      // approachDieSize — Method dice are always d10 now) so they don't
      // keep getting echoed back into storage forever via the spread.
      delete prev.ap;
      delete prev.draw;
      delete prev.approachDieSize;
      const merged = { ...prev, core, approach, damageDieSize, wt, inventorySlots, collapseModifiers, collapseResults };
      delete merged.approachDice;
      window.localStorage.setItem(chudStateStorageKey, JSON.stringify(merged));
    } catch {
      // storage unavailable — ignore
    }
  }, [chudStateStorageKey, core, approach, damageDieSize, wt, inventorySlots, collapseModifiers, collapseResults]);

  // Cross-tab / cross-iframe sync for these fields.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === chudStateStorageKey && e.newValue) {
        try {
          const s = JSON.parse(e.newValue);
          if (s.core) setCore(clampCore(s.core));
          if (s.approach) setApproach(clampApproachToCore(s.approach, clampCore(s.core ?? core)));
          if (isDieSides(s.damageDieSize)) setDamageDieSize(s.damageDieSize);
          if (typeof s.wt === "number") setWtRaw(Math.max(1, s.wt));
          if (s.collapseModifiers) setCollapseModifiers(withCollapseModifiers(s.collapseModifiers));
          if (Array.isArray(s.collapseResults)) setCollapseResults(s.collapseResults);
        } catch {
          // malformed storage — ignore
        }
      }
      if (e.key === gearSlotsStorageKey) {
        const data = readGearData(gearSlotsStorageKey);
        setGearSlotsUsed(data?.slotsUsed ?? 0);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [chudStateStorageKey, gearSlotsStorageKey]);

  return (
    <div className="page">
      <div className="aag-page2">
        <Page2Panel
          onOpenMgr={onOpenMgr}
          readyness={derived.readyness}
          isOverEncumbered={isOverEncumbered}
          wt={wt}
          onWtIncr={() => setWt(wt + 1)}
          onWtDecr={() => setWt(wt - 1)}
          capacity={derived.capacity}
          inventorySlots={inventorySlots}
          skillCount={skillCount}
          fumbleNumber={fumbleNumber}
          collapseModifiers={collapseModifiers}
          core={core}
          onCoreChange={setCoreField}
          approach={approach}
          onApproachChange={setApproachField}
          damageDieSize={damageDieSize}
          onDamageDieSizeIncrease={increaseDamageDieSize}
          onDamageDieSizeReset={resetDamageDieSize}
          restWidget={
            <RestWidget
              storageKey={chudStateStorageKey}
              deckBuilderStorageKey={deckBuilderStorageKey}
              core={core}
              collapseModifiers={collapseModifiers}
            />
          }
          collapseModifiersWidget={
            <button type="button" className="collapse-modifiers-open-btn" onClick={onOpenCollapse}>
              <span>Collapse Modifiers</span>
              <span className="collapse-modifiers-open-summary">{collapseModifiersSummary}</span>
            </button>
          }
        />
      </div>
    </div>
  );
}
