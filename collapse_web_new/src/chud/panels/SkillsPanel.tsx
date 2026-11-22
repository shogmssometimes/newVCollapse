import { useState } from "react";
import type { SkillEntry } from "../../types/chud";

// Skills known (handbook v12 p20) — reference list capped at Inference (the
// AAG's Skills number). The list never gates the "Use Skill" button in a
// Method roll popup; it only limits how many entries can be added here.
export function SkillsPanel({
  skills,
  onChange,
  inference,
}: {
  skills: SkillEntry[];
  onChange: (next: SkillEntry[]) => void;
  inference: number;
}) {
  const [newName, setNewName] = useState("");
  const [newNote, setNewNote] = useState("");

  // If Inference later drops below the number already listed, keep every
  // entry — just block adding more until the count is back under the limit.
  const atLimit = skills.length >= inference;

  const addSkill = () => {
    const name = newName.trim();
    if (!name || atLimit) return;
    const entry: SkillEntry = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      note: newNote.trim(),
    };
    onChange([...skills, entry]);
    setNewName("");
    setNewNote("");
  };

  const removeSkill = (id: string) => onChange(skills.filter((s) => s.id !== id));

  return (
    <div className="mods collapse-modifiers-panel">
      <h3>Skills</h3>
      <div className="collapse-mod-subhead">Skills known: {skills.length} of {inference}</div>
      <div className="collapse-results-list">
        {skills.map((s) => (
          <div className="collapse-result-row" key={s.id}>
            <div className="collapse-result-text">
              <strong>{s.name}</strong>
              {s.note && <span>{s.note}</span>}
            </div>
            <button
              type="button"
              className="collapse-result-remove"
              onClick={() => removeSkill(s.id)}
              aria-label={`Remove Skill: ${s.name}`}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="collapse-result-add">
          <input
            type="text"
            placeholder="Skill name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={atLimit}
          />
          <input
            type="text"
            placeholder="Note (optional)"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            disabled={atLimit}
          />
          <button type="button" onClick={addSkill} disabled={atLimit || !newName.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
