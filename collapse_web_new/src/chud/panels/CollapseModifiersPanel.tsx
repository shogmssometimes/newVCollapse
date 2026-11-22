import { useState } from "react";
import type { ApproachStats, CollapseModifiers, CollapseResultEntry } from "../../types/chud";
import { APPROACH_LABELS } from "../../domain/coreApproachMap";

const METHOD_FIELDS: Array<keyof ApproachStats> = ["force", "finesse", "guts", "logic", "show", "tell"];

// One number field bound to a single CollapseModifiers key (or a Method's
// methodDice entry via onMethodChange below) — a plain number input plus
// -/+ steppers, since every modifier is a signed ± value with no cap of
// its own (the derived stat it feeds is what gets floored, in
// domain/chudStats.ts). The steppers exist because iOS's numeric keypad
// has no minus key and almost every Collapse result is negative — typing
// still works (desktop, Android), but iPhone needs the buttons to go
// negative at all.
function ModifierField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const safe = Number.isFinite(value) ? value : 0;
  return (
    <label className="collapse-mod-field">
      <span>{label}</span>
      <div className="collapse-mod-field-row">
        <button
          type="button"
          className="collapse-mod-stepper"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(safe - 1)}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          step={1}
          value={safe}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            onChange(Number.isFinite(n) ? n : 0);
          }}
        />
        <button
          type="button"
          className="collapse-mod-stepper"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(safe + 1)}
        >
          +
        </button>
      </div>
    </label>
  );
}

// Permanent Collapse Table adjustments (handbook: every lasting Collapse
// result in one place instead of hand-tweaking a stat and forgetting why).
// Every field defaults to 0 and is purely additive — the actual floors
// (Max HP/WT never below 1, everything else never below 0) are applied
// where each stat is computed (domain/chudStats.ts), not here.
export function CollapseModifiersPanel({
  modifiers,
  onChange,
  results,
  onResultsChange,
}: {
  modifiers: CollapseModifiers;
  onChange: (next: CollapseModifiers) => void;
  results: CollapseResultEntry[];
  onResultsChange: (next: CollapseResultEntry[]) => void;
}) {
  const [newResultName, setNewResultName] = useState("");
  const [newResultText, setNewResultText] = useState("");

  const set = <K extends keyof CollapseModifiers>(key: K, value: CollapseModifiers[K]) =>
    onChange({ ...modifiers, [key]: value });

  const setMethod = (field: keyof ApproachStats, value: number) =>
    onChange({ ...modifiers, methodDice: { ...modifiers.methodDice, [field]: value } });

  const addResult = () => {
    const name = newResultName.trim();
    if (!name) return;
    const entry: CollapseResultEntry = {
      id: `collapse-result-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      text: newResultText.trim(),
    };
    onResultsChange([...results, entry]);
    setNewResultName("");
    setNewResultText("");
  };

  const removeResult = (id: string) => onResultsChange(results.filter((r) => r.id !== id));

  return (
    <div className="mods collapse-modifiers-panel">
      <h3>Collapse Modifiers</h3>
      <div className="collapse-mod-grid">
        <ModifierField label="Max HP" value={modifiers.maxHp} onChange={(v) => set("maxHp", v)} />
        <ModifierField label="Readiness" value={modifiers.readiness} onChange={(v) => set("readiness", v)} />
        <ModifierField label="Inv Slots" value={modifiers.inventorySlots} onChange={(v) => set("inventorySlots", v)} />
        <ModifierField label="Capacity" value={modifiers.capacity} onChange={(v) => set("capacity", v)} />
        <ModifierField label="Ganbare!" value={modifiers.ganbareCharges} onChange={(v) => set("ganbareCharges", v)} />
        <ModifierField label="WT" value={modifiers.wt} onChange={(v) => set("wt", v)} />
      </div>

      <div className="collapse-mod-subhead">Method Dice</div>
      <div className="collapse-mod-grid">
        {METHOD_FIELDS.map((field) => (
          <ModifierField
            key={field}
            label={APPROACH_LABELS[field]}
            value={modifiers.methodDice[field] ?? 0}
            onChange={(v) => setMethod(field, v)}
          />
        ))}
      </div>

      <div className="collapse-mod-subhead">Totals</div>
      <div className="collapse-mod-grid">
        <ModifierField
          label="Attack/Defense"
          value={modifiers.totalAttackDefense}
          onChange={(v) => set("totalAttackDefense", v)}
        />
        <ModifierField label="Every Roll" value={modifiers.totalAll} onChange={(v) => set("totalAll", v)} />
      </div>

      <div className="collapse-mod-subhead">Results</div>
      <div className="collapse-results-list">
        {results.map((r) => (
          <div className="collapse-result-row" key={r.id}>
            <div className="collapse-result-text">
              <strong>{r.name}</strong>
              {r.text && <span>{r.text}</span>}
            </div>
            <button
              type="button"
              className="collapse-result-remove"
              onClick={() => removeResult(r.id)}
              aria-label={`Remove Collapse result: ${r.name}`}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="collapse-result-add">
          <input
            type="text"
            placeholder="Result name"
            value={newResultName}
            onChange={(e) => setNewResultName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Free text (optional)"
            value={newResultText}
            onChange={(e) => setNewResultText(e.target.value)}
          />
          <button type="button" onClick={addResult} disabled={!newResultName.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
