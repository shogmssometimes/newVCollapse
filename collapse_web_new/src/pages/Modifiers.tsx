import { useEffect, useState } from "react";
import type { CollapseModifiers, CollapseResultEntry, CoreStats, SkillEntry } from "../types/chud";
import { clampCore } from "../domain/coreApproachMap";
import { computeWtBase, withCollapseModifiers } from "../domain/chudStats";
import { loadState } from "../utils/chudPersistence";
import { CollapseModifiersPanel } from "../chud/panels/CollapseModifiersPanel";
import { SkillsPanel } from "../chud/panels/SkillsPanel";
import "./aagPage2.css";

// Modifiers page (formerly "Collapse"): Skills, then Collapse Modifiers
// (Stats / Method Dice / Totals), then Results — moved off the AAG onto its
// own page (one place for every permanent Collapse Table result, plus the
// Skills known list). Saves the same collapseModifiers/collapseResults
// fields the AAG used to own directly, plus the new skills list. WT is
// "base + modifier, plus temporary changes on top" (handbook statuses like
// Exposed) — changing the WT modifier here re-bases the persisted `wt` by
// the same delta, exactly like the AAG's WT card did before this section
// moved, so any temporary offset already applied survives untouched.
export default function ModifiersPage({ chudStateStorageKey }: { chudStateStorageKey: string }) {
  const saved = loadState(chudStateStorageKey);

  const [core, setCore] = useState<CoreStats>(clampCore(saved?.core ?? { vigor: 0, inference: 0, personality: 0 }));
  const [skills, setSkills] = useState<SkillEntry[]>(saved?.skills ?? []);
  const [modifiers, setModifiers] = useState<CollapseModifiers>(() =>
    withCollapseModifiers(saved?.collapseModifiers)
  );
  const [results, setResults] = useState<CollapseResultEntry[]>(saved?.collapseResults ?? []);

  const setModifiersField = (next: CollapseModifiers) => {
    setModifiers((prev) => {
      if (next.wt !== prev.wt) {
        const delta = next.wt - prev.wt;
        try {
          const raw = window.localStorage.getItem(chudStateStorageKey);
          const prevStorage = raw ? JSON.parse(raw) : {};
          const currentWt = typeof prevStorage.wt === "number" ? prevStorage.wt : computeWtBase(prev);
          const merged = { ...prevStorage, wt: Math.max(1, currentWt + delta) };
          window.localStorage.setItem(chudStateStorageKey, JSON.stringify(merged));
        } catch {
          // storage unavailable — ignore
        }
      }
      return next;
    });
  };

  // Persist — read-merge-write so fields owned by the AAG/CHUD (core, wt,
  // inventorySlots, etc.) aren't clobbered. `core` itself is read-only here
  // (the AAG/CHUD own it) — never written back by this page.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(chudStateStorageKey);
      const prev = raw ? JSON.parse(raw) : {};
      const merged = { ...prev, collapseModifiers: modifiers, collapseResults: results, skills };
      window.localStorage.setItem(chudStateStorageKey, JSON.stringify(merged));
    } catch {
      // storage unavailable — ignore
    }
  }, [chudStateStorageKey, modifiers, results, skills]);

  // Cross-tab / cross-iframe sync, same pattern as the AAG.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === chudStateStorageKey && e.newValue) {
        try {
          const s = JSON.parse(e.newValue);
          if (s.core) setCore(clampCore(s.core));
          if (s.collapseModifiers) setModifiers(withCollapseModifiers(s.collapseModifiers));
          if (Array.isArray(s.collapseResults)) setResults(s.collapseResults);
          if (Array.isArray(s.skills)) setSkills(s.skills);
        } catch {
          // malformed storage — ignore
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [chudStateStorageKey]);

  return (
    <div className="page">
      <div className="aag-page2">
        <SkillsPanel skills={skills} onChange={setSkills} inference={core.inference} />
        <CollapseModifiersPanel
          modifiers={modifiers}
          onChange={setModifiersField}
          results={results}
          onResultsChange={setResults}
        />
      </div>
    </div>
  );
}
