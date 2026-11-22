import { useEffect, useState } from "react";
import type { CollapseModifiers, CollapseResultEntry } from "../types/chud";
import { computeWtBase, withCollapseModifiers } from "../domain/chudStats";
import { loadState } from "../utils/chudPersistence";
import { CollapseModifiersPanel } from "../chud/panels/CollapseModifiersPanel";
import "./aagPage2.css";

// Collapse page: the "Collapse Modifiers" section, moved off the AAG onto
// its own page (one place for every permanent Collapse Table result). Saves
// the same collapseModifiers/collapseResults fields the AAG used to own
// directly. WT is "base + modifier, plus temporary changes on top"
// (handbook statuses like Exposed) — changing the WT modifier here re-bases
// the persisted `wt` by the same delta, exactly like the AAG's WT card did
// before this section moved, so any temporary offset already applied
// survives untouched.
export default function CollapsePage({ chudStateStorageKey }: { chudStateStorageKey: string }) {
  const saved = loadState(chudStateStorageKey);

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
  // inventorySlots, etc.) aren't clobbered.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(chudStateStorageKey);
      const prev = raw ? JSON.parse(raw) : {};
      const merged = { ...prev, collapseModifiers: modifiers, collapseResults: results };
      window.localStorage.setItem(chudStateStorageKey, JSON.stringify(merged));
    } catch {
      // storage unavailable — ignore
    }
  }, [chudStateStorageKey, modifiers, results]);

  // Cross-tab / cross-iframe sync, same pattern as the AAG.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === chudStateStorageKey && e.newValue) {
        try {
          const s = JSON.parse(e.newValue);
          if (s.collapseModifiers) setModifiers(withCollapseModifiers(s.collapseModifiers));
          if (Array.isArray(s.collapseResults)) setResults(s.collapseResults);
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
