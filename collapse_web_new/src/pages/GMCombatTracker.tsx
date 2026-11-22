import React, { useState, useCallback, useRef, useEffect } from "react";
import { rollApproachDice, rollFlatDice, computeFumbleWounds, DIE_LADDER, type DieSides } from "../domain/approachDice";
import { isNoDiceMode, subscribeNoDiceMode } from "../utils/noDiceMode";

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "collapse.gm.tracker.v2";
const MAX_SCENARIOS = 8;

// Method dice: the same 6 Methods the player app rolls (handbook p48's
// Margin generator reuses this same set for Combatant Entities).
type MethodKey = "force" | "finesse" | "guts" | "logic" | "show" | "tell";
const METHOD_KEYS: MethodKey[] = ["force", "finesse", "guts", "logic", "show", "tell"];
const METHOD_LABELS: Record<MethodKey, string> = {
  force: "Force", finesse: "Finesse", guts: "Guts", logic: "Logic", show: "Show", tell: "Tell",
};
const WOUND_DIE_OPTIONS: DieSides[] = DIE_LADDER.filter((d) => d !== 4) as DieSides[];

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
  color: "var(--text)",
  padding: "0.35rem 0.5rem",
  fontSize: "0.9rem",
  width: "100%",
};

// ── Types ────────────────────────────────────────────────────────────────────

type CombatantType = "enemy" | "player";

type NoteEntry = { id: string; category: string; text: string };

// Set Roll: a direct, per-combatant copy of the CHUD's "Set Rolls (Status
// Effects)" panel — each combatant owns its own independent rows, not synced
// to the shared CHUD localStorage state.
type SetRollRow = { id: string; name: string; effect: string; roll: number };

type SetRollState = {
  open: boolean;
  rows: SetRollRow[];
};

function newSetRollRow(): SetRollRow {
  return { id: `sr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: "", effect: "", roll: 0 };
}

function defaultSetRoll(): SetRollState {
  return { open: false, rows: [newSetRollRow(), newSetRollRow()] };
}

// Per-Combatant Collapse-style modifiers (handbook v12 §D8): a ± overlay on
// top of each base stat, never baked back into the base value. Every stat a
// GM sees is base + modifier, computed on demand by the eff*() helpers below
// — that keeps Start Fight (which re-applies these every fight) from ever
// double-counting a modifier into the stored base.
type CeModifiers = {
  readiness: number;
  maxHp: number;
  wt: number;
  methodDice: Partial<Record<MethodKey, number>>;
  totalAttackDefense: number;
  totalAll: number;
};

function defaultCeModifiers(): CeModifiers {
  return { readiness: 0, maxHp: 0, wt: 0, methodDice: {}, totalAttackDefense: 0, totalAll: 0 };
}

type Combatant = {
  id: string;
  name: string;
  type: CombatantType;
  icon?: string;
  avatarUrl?: string; // optional hosted image URL (e.g. Imgur) shown as circle
  hp: number;
  maxHp: number;
  rdy: number;
  notes: NoteEntry[];
  partyId?: string; // set when imported from a Party slot
  setRoll: SetRollState;
  wt: number; // base Wound Threshold (enemies default 3)
  woundDieSize: DieSides; // Wound die size for the Margin generator (default d6)
  fumbleNumber?: number; // optional Fumble Number for the Margin generator
  methodDice: Partial<Record<MethodKey, number>>; // base dice rating per Method (enemies)
  modifiers: CeModifiers;
  personality?: number; // optional Readiness tie-break
  overEncumbered?: boolean; // players: forces them last at Start Fight
  readinessResult?: number; // Start Fight's rolled (enemy) or GM-typed (player) Readiness result
  spentMethods: Partial<Record<MethodKey, boolean[]>>; // No Dice Mode (GM): one entry per die, tapped-spent pips, reset at Start Fight
};

// Modifiers are always applied on top of the stored base, never written back
// into it — see the CeModifiers comment above.
function effMaxHp(c: Combatant): number {
  return Math.max(1, c.maxHp + (c.modifiers?.maxHp ?? 0));
}
function effWt(c: Combatant): number {
  return Math.max(1, (c.wt ?? 3) + (c.modifiers?.wt ?? 0));
}
function effReadiness(c: Combatant): number {
  return (c.rdy ?? 0) + (c.modifiers?.readiness ?? 0);
}
function effMethodDice(c: Combatant, key: MethodKey): number {
  return Math.max(0, (c.methodDice?.[key] ?? 0) + (c.modifiers?.methodDice?.[key] ?? 0));
}

type Scenario = {
  id: string;
  name: string;
  combatants: Combatant[];
  savedAt: number;
};

type Party = {
  id: string;
  name: string;
  players: Combatant[]; // only player-type combatants
  savedAt: number;
};

const MAX_PARTIES = 8;

type AppState = {
  combatants: Combatant[];
  scenarios: Scenario[];
  parties: Party[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const ICONS = [
  "🟢","🔴","🔵","🟡","🟣","🟠","⚔️","🛡️","🔥","💀","👁️","👽","🧠","🌀","🌪️","⚡","🌙","⭐","🌊","🍂","🦾","🦴","🧊","🪓","🏹","🪄","🦅","🐉","🐺","🦂","🕷️","🐙","🐍","🦇","🦉","🧿","🎯","🧨","🛠️","🪨"
];

function autoName(existing: Combatant[]): string {
  let n = existing.length + 1;
  while (existing.some((c) => c.name === `Combatant ${n}`)) n++;
  return `Combatant ${n}`;
}

const ICON_MIGRATION: Record<string, string> = {
  "🟩": "🟢",
  "🟥": "🔴",
  "🟦": "🔵",
  "🟨": "🟡",
  "🟪": "🟣",
  "🟧": "🟠",
};

function pickIcon(existing: Combatant[], icon?: string): string {
  if (icon) return icon;
  return ICONS[existing.length % ICONS.length];
}

function migrateIcon(icon: any): string | undefined {
  if (typeof icon !== "string") return undefined;
  return ICON_MIGRATION[icon] ?? icon;
}

function normalizeAvatarUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (["imgur.com", "www.imgur.com", "m.imgur.com"].includes(host)) {
      const segments = path.split("/");
      if (segments[0] === "a" || segments[0] === "gallery") {
        const id = segments[1];
        if (id) return `https://i.imgur.com/${id}.jpg`;
      }
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && !lastSegment.includes(".")) {
        return `https://i.imgur.com/${lastSegment}.jpg`;
      }
      return `https://i.imgur.com/${lastSegment}`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function makeCombatant(existing: Combatant[], type: CombatantType = "enemy"): Combatant {
  return {
    id: uid(),
    name: autoName(existing),
    type,
    icon: pickIcon(existing),
    hp: type === "enemy" ? 10 : 0,
    maxHp: type === "enemy" ? 10 : 0,
    rdy: 0,
    notes: [],
    setRoll: defaultSetRoll(),
    wt: 3,
    woundDieSize: 6,
    methodDice: {},
    modifiers: defaultCeModifiers(),
    spentMethods: {},
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadApp(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { combatants: [], scenarios: [], parties: [] };
    const p = JSON.parse(raw);
    const migrateNotes = (n: any): NoteEntry[] => {
      if (Array.isArray(n)) return n;
      if (typeof n === "string" && n.trim()) return [{ id: uid(), category: "", text: n }];
      return [];
    };
    const migrateSetRoll = (sr: any): SetRollState => {
      if (sr && typeof sr === "object" && Array.isArray(sr.rows)) {
        return { open: !!sr.open, rows: sr.rows.map((r: any) => ({ id: String(r?.id || newSetRollRow().id), name: String(r?.name || ""), effect: String(r?.effect || ""), roll: clampStatusRoll(Number(r?.roll ?? 0)) })) };
      }
      return defaultSetRoll();
    };
    const migrateModifiers = (m: any): CeModifiers => {
      const base = defaultCeModifiers();
      if (!m || typeof m !== "object") return base;
      const methodDice: Partial<Record<MethodKey, number>> = {};
      if (m.methodDice && typeof m.methodDice === "object") {
        for (const k of METHOD_KEYS) {
          if (typeof m.methodDice[k] === "number") methodDice[k] = m.methodDice[k];
        }
      }
      return {
        readiness: typeof m.readiness === "number" ? m.readiness : 0,
        maxHp: typeof m.maxHp === "number" ? m.maxHp : 0,
        wt: typeof m.wt === "number" ? m.wt : 0,
        methodDice,
        totalAttackDefense: typeof m.totalAttackDefense === "number" ? m.totalAttackDefense : 0,
        totalAll: typeof m.totalAll === "number" ? m.totalAll : 0,
      };
    };
    const migrateMethodDice = (md: any): Partial<Record<MethodKey, number>> => {
      const out: Partial<Record<MethodKey, number>> = {};
      if (md && typeof md === "object") {
        for (const k of METHOD_KEYS) {
          if (typeof md[k] === "number") out[k] = md[k];
        }
      }
      return out;
    };
    const migrateCombatant = (c: any, index: number) => ({
      ...c,
      icon: migrateIcon(c.icon) ?? ICONS[index % ICONS.length],
      rdy: typeof c.rdy === "number" ? c.rdy : 0,
      notes: migrateNotes(c.notes),
      setRoll: migrateSetRoll(c.setRoll),
      wt: typeof c.wt === "number" ? c.wt : 3,
      woundDieSize: DIE_LADDER.includes(c.woundDieSize) ? c.woundDieSize : 6,
      fumbleNumber: typeof c.fumbleNumber === "number" ? c.fumbleNumber : undefined,
      methodDice: migrateMethodDice(c.methodDice),
      modifiers: migrateModifiers(c.modifiers),
      personality: typeof c.personality === "number" ? c.personality : undefined,
      overEncumbered: typeof c.overEncumbered === "boolean" ? c.overEncumbered : false,
      readinessResult: typeof c.readinessResult === "number" ? c.readinessResult : undefined,
      spentMethods: c.spentMethods && typeof c.spentMethods === "object" ? c.spentMethods : {},
    });
    return {
      combatants: Array.isArray(p.combatants)
        ? p.combatants.map(migrateCombatant)
        : [],
      scenarios: Array.isArray(p.scenarios)
        ? p.scenarios.map((s: any) => ({
            ...s,
            combatants: Array.isArray(s.combatants)
              ? s.combatants.map(migrateCombatant)
              : [],
          }))
        : [],
      parties: Array.isArray(p.parties)
        ? p.parties.map((pt: any) => ({
            ...pt,
            players: Array.isArray(pt.players) ? pt.players.map(migrateCombatant) : [],
          }))
        : [],
    };
  } catch {
    return { combatants: [], scenarios: [], parties: [] };
  }
}

function saveApp(s: AppState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

// ── Run state persistence ─────────────────────────────────────────────────────
// Keeps Run mode (and which combatant is active) alive across navigation until
// the GM explicitly ends combat (Edit / Clear).

const RUN_STATE_KEY = "collapse.gm.tracker.runstate.v1";

function loadRunState(): { mode: "edit" | "run"; runIndex: number; round: number } {
  try {
    const raw = localStorage.getItem(RUN_STATE_KEY);
    if (!raw) return { mode: "edit", runIndex: 0, round: 1 };
    const p = JSON.parse(raw);
    return {
      mode: p.mode === "run" ? "run" : "edit",
      runIndex: typeof p.runIndex === "number" && p.runIndex >= 0 ? p.runIndex : 0,
      round: typeof p.round === "number" && p.round >= 1 ? p.round : 1,
    };
  } catch {
    return { mode: "edit", runIndex: 0, round: 1 };
  }
}

function saveRunState(mode: "edit" | "run", runIndex: number, round: number) {
  try {
    localStorage.setItem(RUN_STATE_KEY, JSON.stringify({ mode, runIndex, round }));
  } catch {}
}

// ── Counter ───────────────────────────────────────────────────────────────────
// Supports: scroll wheel (↑ +1  ↓ −1), vertical touch swipe, tap value to type,
// tap max to edit max, ± buttons.

type CounterProps = {
  label: string;
  value: number;
  max: number;
  accent: string;
  onChange: (v: number) => void;
  onMaxChange?: (v: number) => void;
  large?: boolean;
  noMax?: boolean;
};

const Counter: React.FC<CounterProps> = ({
  label, value, max, accent, onChange, onMaxChange, large, noMax,
}) => {
  const elRef = useRef<HTMLDivElement>(null);
  const [editingVal, setEditingVal] = useState(false);
  const [editingMax, setEditingMax] = useState(false);

  // Live refs so one-time event handlers never go stale
  const valRef = useRef(value);
  const maxRef = useRef(max);
  const onChangeRef = useRef(onChange);
  valRef.current = value;
  maxRef.current = max;
  onChangeRef.current = onChange;

  // Attach non-passive wheel + touch once
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const clamp = (v: number) => noMax ? Math.max(0, v) : Math.max(0, Math.min(maxRef.current, v));

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onChangeRef.current(clamp(valRef.current + (e.deltaY < 0 ? 1 : -1)));
    };

    let touchLastY = 0;
    let touchAccum = 0;

    const onTouchStart = (e: TouchEvent) => {
      e.stopPropagation(); // prevent RunCard horizontal-swipe handler from seeing this
      touchLastY = e.touches[0].clientY;
      touchAccum = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const dy = touchLastY - e.touches[0].clientY; // positive = swipe up = increase
      touchAccum += dy;
      touchLastY = e.touches[0].clientY;
      const steps = Math.trunc(touchAccum / 24);
      if (steps !== 0) {
        onChangeRef.current(clamp(valRef.current + steps));
        touchAccum -= steps * 24;
      }
    };

    const onTouchEnd = () => { touchAccum = 0; };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const barColor = pct > 50 ? accent : pct > 25 ? "var(--accent-amber)" : "var(--error)";
  const valFs = large ? "2rem" : "1.25rem";
  const denomFs = large ? "0.9rem" : "0.72rem";
  const btnPad = large ? "0.55rem 0" : "0.22rem 0";
  const btnFs = large ? "1.2rem" : "0.88rem";

  return (
    <div ref={elRef} style={{ userSelect: "none", touchAction: "none", cursor: "ns-resize" }}>
      <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--muted)", marginBottom: 3 }}>
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginBottom: 5 }}>
        {editingVal ? (
          <input
            autoFocus
            type="number"
            defaultValue={value}
            style={{ width: large ? 62 : 44, fontSize: valFs, fontWeight: 700, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.05rem 0.25rem" }}
            onBlur={(e) => { onChange(Math.max(0, Math.min(max, Number(e.target.value)))); setEditingVal(false); }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setEditingVal(true); }}
            style={{ fontSize: valFs, fontWeight: 700, color: barColor, cursor: "text", lineHeight: 1 }}
          >
            {value}
          </span>
        )}
        {!noMax && (
          <>
            <span style={{ color: "rgba(255,255,255,0.25)", fontSize: denomFs }}>/</span>
            {editingMax && onMaxChange ? (
              <input
                autoFocus
                type="number"
                defaultValue={max}
                style={{ width: large ? 46 : 34, fontSize: denomFs, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.05rem 0.25rem" }}
                onBlur={(e) => { onMaxChange(Math.max(1, Number(e.target.value))); setEditingMax(false); }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <span
                onClick={(e) => { e.stopPropagation(); onMaxChange && setEditingMax(true); }}
                style={{ color: "rgba(255,255,255,0.35)", fontSize: denomFs, cursor: onMaxChange ? "text" : "default" }}
              >
                {max}
              </span>
            )}
          </>
        )}
      </div>

      {!noMax && (
        <div style={{ height: large ? 5 : 3, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 2, transition: "width 0.12s, background 0.12s" }} />
        </div>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: large ? 12 : 7 }}>
        <button
          onClick={(e) => { e.stopPropagation(); onChange(Math.max(0, value - 1)); }}
          style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--error)", fontSize: btnFs, padding: btnPad, cursor: "pointer" }}
        >−</button>
        <button
          onClick={(e) => { e.stopPropagation(); onChange(noMax ? value + 1 : Math.min(max, value + 1)); }}
          style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: accent, fontSize: btnFs, padding: btnPad, cursor: "pointer" }}
        >+</button>
      </div>
    </div>
  );
};

// ── Modifier Stepper ──────────────────────────────────────────────────────────
// A signed ± field with no numeric-keypad minus key needed (iPhone's numeric
// pad has none, and almost every modifier ends up negative) — mirrors the
// player app's CollapseModifiersPanel stepper.

const ModStepper: React.FC<{ label: string; value: number; onChange: (v: number) => void }> = ({ label, value, onChange }) => {
  const safe = Number.isFinite(value) ? value : 0;
  return (
    <div>
      <div style={{ fontSize: "0.68rem", color: "var(--muted)", marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(safe - 1)}
          style={{ width: 28, height: 28, minWidth: 28, flexShrink: 0, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: "0.95rem", fontWeight: 700, cursor: "pointer" }}
        >−</button>
        <input
          type="number"
          inputMode="numeric"
          value={safe}
          onChange={(e) => { const n = Math.round(Number(e.target.value)); onChange(Number.isFinite(n) ? n : 0); }}
          style={{ width: 40, textAlign: "center", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#f8f9fa", fontSize: "16px", padding: "0.2rem 0" }}
        />
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(safe + 1)}
          style={{ width: 28, height: 28, minWidth: 28, flexShrink: 0, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: "0.95rem", fontWeight: 700, cursor: "pointer" }}
        >+</button>
      </div>
    </div>
  );
};

// ── Enemy Modifiers Panel ─────────────────────────────────────────────────────
// Per-Combatant Collapse-style ± overlay (handbook v12 §D8): default 0,
// floors applied only where each eff*() helper reads it back (Max HP/WT
// never below 1, everything else never below 0).

const CeModifiersPanel: React.FC<{ value: CeModifiers; onChange: (next: CeModifiers) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof CeModifiers>(key: K, v: CeModifiers[K]) => onChange({ ...value, [key]: v });
  const setMethod = (key: MethodKey, v: number) => onChange({ ...value, methodDice: { ...value.methodDice, [key]: v } });

  return (
    <div style={{ marginTop: "0.6rem" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", borderBottom: "1px solid rgba(255,255,255,0.12)", padding: "6px 0 8px", cursor: "pointer", color: "rgba(248,250,252,0.65)", fontSize: "0.72rem", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }}
      >
        <span>Modifiers</span>
        <span style={{ fontSize: "0.55rem", opacity: 0.7 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.6rem" }}>
            <ModStepper label="Readiness" value={value.readiness} onChange={(v) => set("readiness", v)} />
            <ModStepper label="Max HP" value={value.maxHp} onChange={(v) => set("maxHp", v)} />
            <ModStepper label="WT" value={value.wt} onChange={(v) => set("wt", v)} />
          </div>
          <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", margin: "0.7rem 0 0.35rem" }}>Method Dice</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.6rem" }}>
            {METHOD_KEYS.map((k) => (
              <ModStepper key={k} label={METHOD_LABELS[k]} value={value.methodDice[k] ?? 0} onChange={(v) => setMethod(k, v)} />
            ))}
          </div>
          <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", margin: "0.7rem 0 0.35rem" }}>Totals</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.6rem" }}>
            <ModStepper label="Attack/Defense" value={value.totalAttackDefense} onChange={(v) => set("totalAttackDefense", v)} />
            <ModStepper label="Every Roll" value={value.totalAll} onChange={(v) => set("totalAll", v)} />
          </div>
        </div>
      )}
    </div>
  );
};

// ── WT Control ────────────────────────────────────────────────────────────────
// Wound Threshold: tap the value to type it, −/+ beside it, floored at 1
// (unlike Counter's HP floor of 0).

const WtControl: React.FC<{ base: number; modifier: number; onBaseChange: (v: number) => void }> = ({ base, modifier, onBaseChange }) => {
  const [editing, setEditing] = useState(false);
  const effective = Math.max(1, base + modifier);
  const setEffective = (next: number) => onBaseChange(Math.max(1, next) - modifier);

  return (
    <div>
      <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--muted)", marginBottom: 3 }}>WT</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginBottom: 5 }}>
        {editing ? (
          <input
            autoFocus
            type="number"
            defaultValue={effective}
            style={{ width: 44, fontSize: "1.25rem", fontWeight: 700, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.05rem 0.25rem" }}
            onBlur={(e) => { setEffective(Math.round(Number(e.target.value)) || 1); setEditing(false); }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span onClick={(e) => { e.stopPropagation(); setEditing(true); }} style={{ fontSize: "1.25rem", fontWeight: 700, color: "#e9c46a", cursor: "text", lineHeight: 1 }}>
            {effective}
          </span>
        )}
        {modifier !== 0 && <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.72rem" }}>({modifier > 0 ? "+" : "−"}{Math.abs(modifier)})</span>}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={(e) => { e.stopPropagation(); setEffective(effective - 1); }}
          style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--error)", fontSize: "0.88rem", padding: "0.22rem 0", cursor: "pointer" }}
        >−</button>
        <button
          onClick={(e) => { e.stopPropagation(); setEffective(effective + 1); }}
          style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#e9c46a", fontSize: "0.88rem", padding: "0.22rem 0", cursor: "pointer" }}
        >+</button>
      </div>
    </div>
  );
};

// ── Notes Table ───────────────────────────────────────────────────────────────

type NotesTableProps = {
  notes: NoteEntry[];
  onChange: (notes: NoteEntry[]) => void;
};

const NotesTable: React.FC<NotesTableProps> = ({ notes, onChange }) => {
  const addRow = () =>
    onChange([...notes, { id: uid(), category: "", text: "" }]);

  const updateRow = (id: string, field: keyof Omit<NoteEntry, "id">, value: string) =>
    onChange(notes.map((n) => (n.id === id ? { ...n, [field]: value } : n)));

  const removeRow = (id: string) =>
    onChange(notes.filter((n) => n.id !== id));

  const cellBase: React.CSSProperties = {
    background: "transparent",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    color: "#f8f9fa",
    fontSize: "0.83rem",
    padding: "0.3rem 0.4rem",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div style={{ marginTop: "0.7rem" }}>
      {notes.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1.2rem calc(25% - 1.2rem) 1fr 1.4rem", gap: "0 0.3rem", marginBottom: "0.2rem" }}>
          <span />
          <span style={{ fontSize: "0.67rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", paddingLeft: "0.4rem" }}>Category</span>
          <span style={{ fontSize: "0.67rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", paddingLeft: "0.4rem" }}>Note</span>
          <span />
        </div>
      )}
      {notes.map((n, i) => (
        <div key={n.id} style={{ display: "grid", gridTemplateColumns: "1.2rem calc(25% - 1.2rem) 1fr 1.4rem", gap: "0 0.3rem", alignItems: "center", marginBottom: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)", textAlign: "right" }}>{i + 1}.</span>
          <input
            value={n.category}
            placeholder="Category"
            onChange={(e) => updateRow(n.id, "category", e.target.value)}
            style={cellBase}
          />
          <input
            value={n.text}
            placeholder="Note…"
            onChange={(e) => updateRow(n.id, "text", e.target.value)}
            style={cellBase}
          />
          <button
            onClick={() => removeRow(n.id)}
            style={{ background: "none", border: "none", color: "rgba(255,107,107,0.5)", cursor: "pointer", fontSize: "0.85rem", padding: 0, lineHeight: 1 }}
          >✕</button>
        </div>
      ))}
      <button
        onClick={addRow}
        style={{ marginTop: notes.length > 0 ? "0.4rem" : 0, background: "none", border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 5, color: "var(--muted)", fontSize: "0.78rem", padding: "0.25rem 0.65rem", cursor: "pointer", width: "100%" }}
      >+ Add note</button>
    </div>
  );
};

// ── Set Roll Panel ────────────────────────────────────────────────────────────
// A direct copy of the CHUD's "Set Rolls (Status Effects)" panel — a Name /
// Effect / Set Roll (+/-) / Clear table with catalog autocomplete and
// hold-to-clear rows. Stopgapped here so each Combat Tracker combatant owns
// its own independent set of rows (not synced to any shared CHUD state).

const STATUS_ROLL_MAX = 50;
const STATUS_ROLL_MAX_ROWS = 10;
const STATUS_ROLL_CLEAR_HOLD_MS = 700;

const STATUS_EFFECTS_CATALOG: { name: string; effect: string }[] = [
  { name: "Slowed", effect: "Any movement costs +1 additional AP" },
  { name: "Bound", effect: "Cannot take movement actions" },
  { name: "Stunned", effect: "Reduce AP by 1d4" },
  { name: "Distracted", effect: "Cannot purchase/use Reaction Tokens" },
  { name: "Taunted", effect: "Must target Taunter with Combat Action or lose 2AP" },
  { name: "Marked", effect: "Cannot be Hidden" },
  { name: "Exposed", effect: "WT reduced by 1" },
  { name: "Nullified", effect: "Cannot use Mod Engrams" },
  { name: "Overheated", effect: "Cannot use Grit" },
  { name: "Irradiated", effect: "Lose 1 Grit" },
  { name: "Afflicted (Poison, Burn, Suffocation etc)", effect: "At the bottom of your turn, roll a dice, on evens reduce WT by 1, on odds, nothing happens." },
  { name: "Frightened", effect: "Must remain adjacent to fear source" },
  { name: "Crushed", effect: "Double AP Costs" },
  { name: "Confused", effect: "Roll twice, take lower" },
  { name: "Discombobulated", effect: "Roll 1d4, on 1, Combat Actions hit a random target" },
  { name: "Focused", effect: "On rolls, roll twice, take higher" },
  { name: "Shielded", effect: "Attacks against you hit the Set first. No Wounds are produced. Subtract the attacker's whole Total from the Set. If the Set holds, the attack does nothing except reduce the Set. If the Total is higher, the Shield breaks, and the leftover becomes the attack's Total against your defense roll." },
  { name: "Fortified", effect: "WT increased by 1" },
  { name: "Hastened", effect: "Any movement costs 1 less AP" },
  { name: "Inspired", effect: "Gain 1 Grit" },
  { name: "Energized", effect: "Gain +1AP" },
  { name: "Overclocked", effect: "Damage die steps up one tier" },
  { name: "Bleeding", effect: "On hit, Lose 1HP regardless of WT" },
  { name: "Charmed", effect: "Treat source as friendly" },
  { name: "Demoralized", effect: "Cannot Ganbare or receive Ganbare" },
  { name: "Rattled", effect: "Cannot use Overdrive" },
  { name: "Pressured", effect: "Cannot Flank or gain positional bonuses" },
  { name: "Exhausted", effect: "Reduce all AO/PCDC rolls by 1d4" },
  { name: "Downed", effect: "Out of the fight, must be revived" },
  { name: "Hidden", effect: "+1d6 to Finesse, Logic and Show rolls. Found by a Perception check that meets or beats your Set; if found, lose Hidden and become Exposed." },
  { name: "Reckless", effect: "+1d6 to Force, Guts and Tell rolls. Stopped by a Method roll (Roleplay Action) that meets or beats your Set; if stopped, lose Reckless and become Exposed." },
];

function normalizeStatusName(s: string): string {
  return String(s || "").trim().toLowerCase();
}

const STATUS_EFFECTS_BY_NAME = new Map(STATUS_EFFECTS_CATALOG.map((it) => [normalizeStatusName(it.name), it]));

function clampStatusRoll(n: number): number {
  return Math.max(0, Math.min(STATUS_ROLL_MAX, Number.isFinite(n) ? n : 0));
}

function getStatusSuggestions(query: string): { name: string; effect: string }[] {
  const q = normalizeStatusName(query);
  if (!q) return [];
  return STATUS_EFFECTS_CATALOG
    .filter((it) => normalizeStatusName(it.name).includes(q))
    .sort((a, b) => {
      const aStarts = normalizeStatusName(a.name).startsWith(q) ? 0 : 1;
      const bStarts = normalizeStatusName(b.name).startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 6);
}

type SetRollPanelProps = {
  value: SetRollState;
  onChange: (next: SetRollState) => void;
};

const SetRollRowView: React.FC<{
  row: SetRollRow;
  onUpdate: (next: SetRollRow) => void;
  onRemove: () => void;
}> = ({ row, onUpdate, onRemove }) => {
  const [nameFocused, setNameFocused] = useState(false);
  const [holdPct, setHoldPct] = useState(0);
  const [editingRoll, setEditingRoll] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const exact = STATUS_EFFECTS_BY_NAME.get(normalizeStatusName(row.name));
  const effectReadOnly = !!exact;
  const suggestions = nameFocused ? getStatusSuggestions(row.name) : [];

  const applySuggestion = (item: { name: string; effect: string }) => {
    onUpdate({ ...row, name: item.name, effect: item.effect });
    setNameFocused(false);
  };

  const clearHold = () => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (holdTickRef.current) { clearInterval(holdTickRef.current); holdTickRef.current = null; }
    setHoldPct(0);
  };

  const startHold = () => {
    const started = Date.now();
    holdTickRef.current = setInterval(() => {
      setHoldPct(Math.min(100, ((Date.now() - started) / STATUS_ROLL_CLEAR_HOLD_MS) * 100));
    }, 30);
    holdTimerRef.current = setTimeout(() => {
      clearHold();
      onRemove();
    }, STATUS_ROLL_CLEAR_HOLD_MS);
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch", position: "relative" }}>
      <div style={{ position: "relative", flex: "26 1 0", minWidth: 0 }}>
        <input
          type="text"
          value={row.name}
          placeholder="Type effect name..."
          autoComplete="off"
          onChange={(e) => {
            const name = e.target.value;
            const match = STATUS_EFFECTS_BY_NAME.get(normalizeStatusName(name));
            onUpdate({ ...row, name, effect: match ? match.effect : (effectReadOnly ? "" : row.effect) });
          }}
          onFocus={() => setNameFocused(true)}
          onBlur={() => setTimeout(() => setNameFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = getStatusSuggestions(row.name)[0];
              if (first) { e.preventDefault(); applySuggestion(first); }
            }
          }}
          style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "7px 8px", fontSize: "16px", color: "#e9f0ff", outline: "none" }}
        />
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 3, background: "#0d1117", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 8, maxHeight: 170, overflowY: "auto", zIndex: 30, boxShadow: "0 10px 28px rgba(0,0,0,0.55)" }}>
            {suggestions.map((item) => (
              <div
                key={item.name}
                onPointerDown={(e) => { e.preventDefault(); applySuggestion(item); }}
                style={{ padding: "8px 10px", fontSize: "0.7rem", color: "#e9f0ff", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
              >
                {item.name}
              </div>
            ))}
          </div>
        )}
      </div>
      <textarea
        rows={2}
        value={row.effect}
        readOnly={effectReadOnly}
        onChange={(e) => { if (!effectReadOnly) onUpdate({ ...row, effect: e.target.value }); }}
        style={{ flex: "42 1 0", minWidth: 0, boxSizing: "border-box", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "7px 8px", fontSize: "16px", color: effectReadOnly ? "rgba(248,250,252,0.55)" : "rgba(248,250,252,0.8)", fontStyle: effectReadOnly ? "italic" : "normal", outline: "none", lineHeight: 1.25, resize: "none" }}
      />
      <div style={{ flex: "22 1 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
        <button
          onClick={() => onUpdate({ ...row, roll: clampStatusRoll(row.roll - 1) })}
          style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, flexShrink: 0, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.07)", color: "#fff", fontSize: "0.95rem", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >−</button>
        {editingRoll ? (
          <input
            autoFocus
            type="number"
            inputMode="numeric"
            defaultValue={row.roll}
            style={{ width: 34, textAlign: "center", fontSize: "0.78rem", fontWeight: 800, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 4, color: "#6ac7ff", padding: "2px 2px" }}
            onBlur={(e) => { onUpdate({ ...row, roll: clampStatusRoll(Number(e.target.value)) }); setEditingRoll(false); }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setEditingRoll(true); }}
            style={{ minWidth: 20, textAlign: "center", fontVariantNumeric: "tabular-nums", fontWeight: 800, color: "#6ac7ff", fontSize: "0.72rem", cursor: "text" }}
          >{row.roll}</span>
        )}
        <button
          onClick={() => onUpdate({ ...row, roll: clampStatusRoll(row.roll + 1) })}
          style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, flexShrink: 0, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.07)", color: "#fff", fontSize: "0.95rem", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >+</button>
      </div>
      <button
        onPointerDown={(e) => { e.preventDefault(); startHold(); }}
        onPointerUp={clearHold}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
        style={{ flex: "10 1 0", minWidth: 30, borderRadius: 8, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)", color: "#f87171", fontSize: "0.78rem", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}
      >
        <span style={{ position: "absolute", inset: 0, background: "rgba(239,68,68,0.4)", width: `${holdPct}%`, pointerEvents: "none" }} />
        <span style={{ position: "relative", zIndex: 1 }}>X</span>
      </button>
    </div>
  );
};

const SetRollPanel: React.FC<SetRollPanelProps> = ({ value, onChange }) => {
  return (
    <div style={{ marginTop: "0.6rem" }}>
      <button
        onClick={(e) => { e.stopPropagation(); onChange({ ...value, open: !value.open }); }}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", borderBottom: "1px solid rgba(255,255,255,0.12)", padding: "6px 0 8px", cursor: "pointer", color: "rgba(248,250,252,0.65)", fontSize: "0.72rem", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }}
      >
        <span>Set Rolls (Status Effects)</span>
        <span style={{ fontSize: "0.55rem", opacity: 0.7 }}>{value.open ? "▲" : "▼"}</span>
      </button>
      {value.open && (
        <div style={{ paddingTop: 8, display: "flex", flexDirection: "column", gap: 8 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", gap: 6, padding: "0 2px" }}>
            <span style={{ flex: "26 1 0", fontSize: "0.55rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(248,250,252,0.4)", fontWeight: 600 }}>Name</span>
            <span style={{ flex: "42 1 0", fontSize: "0.55rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(248,250,252,0.4)", fontWeight: 600 }}>Effect</span>
            <span style={{ flex: "22 1 0", textAlign: "center", fontSize: "0.55rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(248,250,252,0.4)", fontWeight: 600 }}>Set Roll</span>
            <span style={{ flex: "10 1 0", textAlign: "center", fontSize: "0.55rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(248,250,252,0.4)", fontWeight: 600 }}>Clear</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {value.rows.map((row) => (
              <SetRollRowView
                key={row.id}
                row={row}
                onUpdate={(next) => onChange({ ...value, rows: value.rows.map((r) => (r.id === row.id ? next : r)) })}
                onRemove={() => onChange({ ...value, rows: value.rows.filter((r) => r.id !== row.id) })}
              />
            ))}
          </div>
          <button
            disabled={value.rows.length >= STATUS_ROLL_MAX_ROWS}
            onClick={() => onChange({ ...value, rows: [...value.rows, newSetRollRow()] })}
            style={{ alignSelf: "flex-start", marginTop: 2, padding: "7px 14px", borderRadius: 8, border: "1px dashed rgba(255,255,255,0.26)", background: "transparent", color: "rgba(248,250,252,0.65)", fontSize: "0.62rem", cursor: value.rows.length >= STATUS_ROLL_MAX_ROWS ? "not-allowed" : "pointer", letterSpacing: "0.08em", textTransform: "uppercase", opacity: value.rows.length >= STATUS_ROLL_MAX_ROWS ? 0.35 : 1 }}
          >
            Add Row
          </button>
        </div>
      )}
    </div>
  );
};

// ── Edit Row ──────────────────────────────────────────────────────────────────

type EditRowProps = {
  c: Combatant;
  index: number;
  isLast: boolean;
  onChange: (c: Combatant) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  partySelected?: boolean;
  onPartyToggle?: () => void;
};

const EditRow: React.FC<EditRowProps> = ({ c, index, isLast, onChange, onRemove, onMoveUp, onMoveDown, partySelected, onPartyToggle }) => {
  const [editingName, setEditingName] = useState(false);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "0.9rem 1rem", marginBottom: "0.55rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.8rem" }}>
        <div style={{ minWidth: 24, color: "var(--muted)", fontWeight: 700, fontSize: "0.85rem", textAlign: "center" }}>
          {index + 1}
        </div>
        {editingName ? (
          <input
            autoFocus
            style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.3rem 0.5rem", fontSize: "0.95rem" }}
            defaultValue={c.name}
            onBlur={(e) => { onChange({ ...c, name: e.target.value.trim() || c.name }); setEditingName(false); }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span onClick={() => setEditingName(true)} style={{ flex: 1, fontWeight: 600, fontSize: "0.95rem", cursor: "text", display: "flex", alignItems: "center", gap: 8 }}>
            {c.avatarUrl ? (
              <img
                src={c.avatarUrl}
                alt=""
                style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "1px solid rgba(255,255,255,0.15)" }}
              />
            ) : (
              <span style={{ fontSize: "1.4rem" }}>{c.icon || ICONS[index % ICONS.length]}</span>
            )}
            {c.name}
          </span>
        )}
        <button
          onClick={() => {
            const nextType = c.type === "enemy" ? "player" : "enemy" as CombatantType;
            onChange(
              nextType === "player"
                ? { ...c, type: "player", hp: 0, maxHp: 0 }
                : { ...c, type: "enemy", icon: c.icon || ICONS[index % ICONS.length], hp: c.maxHp > 0 ? c.maxHp : 10, maxHp: c.maxHp > 0 ? c.maxHp : 10 }
            );
          }}
          style={{
            background: c.type === "player" ? "rgba(99,255,177,0.12)" : "rgba(99,160,255,0.12)",
            border: `1px solid ${c.type === "player" ? "rgba(99,255,177,0.25)" : "rgba(99,160,255,0.25)"}`,
            borderRadius: 6,
            color: c.type === "player" ? "var(--accent-influence)" : "var(--accent)",
            padding: "0.3rem 0.7rem",
            cursor: "pointer",
            fontSize: "0.82rem",
            whiteSpace: "nowrap",
          }}
        >
          {c.type === "player" ? "Player" : "Enemy"}
        </button>
        {c.type === "player" && (
          <label
            title="Include in Party save"
            style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: "0.78rem", color: partySelected ? "var(--accent-influence)" : "var(--muted)", whiteSpace: "nowrap", userSelect: "none" }}
          >
            <input
              type="checkbox"
              checked={!!partySelected}
              onChange={onPartyToggle}
              style={{ accentColor: "var(--accent-influence)", cursor: "pointer" }}
            />
            Party
          </label>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              color: index === 0 ? "rgba(255,255,255,0.3)" : "#f8f9fa",
              padding: "0.25rem 0.5rem",
              cursor: index === 0 ? "default" : "pointer",
            }}
          >
            ↑
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              color: isLast ? "rgba(255,255,255,0.3)" : "#f8f9fa",
              padding: "0.25rem 0.5rem",
              cursor: isLast ? "default" : "pointer",
            }}
          >
            ↓
          </button>
          <button
            onClick={onRemove}
            aria-label="Remove"
            style={{ background: "none", border: "none", color: "rgba(255,107,107,0.55)", cursor: "pointer", fontSize: "1rem", padding: "0.15rem 0.35rem", lineHeight: 1 }}
          >✕</button>
        </div>
      </div>

      <div>
        <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Profile Picture URL</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {c.avatarUrl && (
            <img
              src={c.avatarUrl}
              alt=""
              style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "1px solid rgba(255,255,255,0.15)" }}
            />
          )}
          <input
            type="url"
            placeholder="https://i.imgur.com/…"
            value={c.avatarUrl ?? ""}
            onChange={(e) => onChange({ ...c, avatarUrl: e.target.value.trim() || undefined })}
            onBlur={(e) => {
              const normalized = normalizeAvatarUrl(e.target.value.trim());
              if (normalized !== (c.avatarUrl ?? undefined)) {
                onChange({ ...c, avatarUrl: normalized });
              }
            }}
            style={{ ...INPUT, flex: 1 }}
          />
          {c.avatarUrl && (
            <button
              onClick={() => onChange({ ...c, avatarUrl: undefined })}
              style={{ background: "none", border: "none", color: "rgba(255,107,107,0.55)", cursor: "pointer", fontSize: "1rem", padding: "0.15rem 0.35rem", lineHeight: 1 }}
              title="Remove picture"
            >✕</button>
          )}
        </div>
      </div>

      <div>
        <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>RDY</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="-?[0-9]*"
          value={c.rdy}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "" || raw === "-") { onChange({ ...c, rdy: 0 }); return; }
            const n = Number(raw);
            if (!Number.isNaN(n)) onChange({ ...c, rdy: n });
          }}
          style={{ ...INPUT, maxWidth: 120 }}
        />
        <div style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: 6 }}>
          Start Fight rolls 1d10 + RDY for enemies; players' Readiness result is typed in directly.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <div>
          <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Personality (optional)</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="-?[0-9]*"
            value={c.personality ?? ""}
            placeholder="—"
            onChange={(e) => {
              const raw = e.target.value;
              if (raw.trim() === "") { onChange({ ...c, personality: undefined }); return; }
              const n = Number(raw);
              if (!Number.isNaN(n)) onChange({ ...c, personality: n });
            }}
            style={INPUT}
          />
          <div style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: 6 }}>
            Breaks Readiness ties at Start Fight.
          </div>
        </div>
        {c.type === "player" && (
          <div>
            <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Over-Encumbered</span>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.85rem", color: c.overEncumbered ? "var(--error)" : "var(--muted)" }}>
              <input
                type="checkbox"
                checked={!!c.overEncumbered}
                onChange={(e) => onChange({ ...c, overEncumbered: e.target.checked })}
                style={{ width: 20, height: 20, cursor: "pointer" }}
              />
              Goes last at Start Fight
            </label>
          </div>
        )}
      </div>

      {c.type === "enemy" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>HP Max</span>
              <input
                type="number"
                min={1}
                value={c.maxHp}
                onChange={(e) => {
                  const nextMax = Math.max(1, Number(e.target.value));
                  onChange({ ...c, maxHp: nextMax, hp: nextMax });
                }}
                style={INPUT}
              />
              <div style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: 6 }}>
                HP starts at max when Start Fight runs.
              </div>
            </div>
            <div>
              <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Wound Threshold</span>
              <input
                type="number"
                min={1}
                value={c.wt}
                onChange={(e) => onChange({ ...c, wt: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                style={INPUT}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Wound Die</span>
              <select
                value={c.woundDieSize}
                onChange={(e) => onChange({ ...c, woundDieSize: Number(e.target.value) as DieSides })}
                style={{ ...INPUT, fontSize: "16px" }}
              >
                {WOUND_DIE_OPTIONS.map((d) => <option key={d} value={d}>d{d}</option>)}
              </select>
            </div>
            <div>
              <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Fumble Number (optional)</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="-?[0-9]*"
                value={c.fumbleNumber ?? ""}
                placeholder="—"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw.trim() === "") { onChange({ ...c, fumbleNumber: undefined }); return; }
                  const n = Number(raw);
                  if (!Number.isNaN(n)) onChange({ ...c, fumbleNumber: n });
                }}
                style={INPUT}
              />
            </div>
          </div>

          <div>
            <span style={{ display: "block", fontSize: "0.82rem", color: "var(--muted)", marginBottom: 5 }}>Method Dice</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.6rem" }}>
              {METHOD_KEYS.map((k) => (
                <div key={k}>
                  <span style={{ display: "block", fontSize: "0.68rem", color: "var(--muted)", marginBottom: 3 }}>{METHOD_LABELS[k]}</span>
                  <input
                    type="number"
                    min={0}
                    value={c.methodDice[k] ?? 0}
                    onChange={(e) => onChange({ ...c, methodDice: { ...c.methodDice, [k]: Math.max(0, Math.round(Number(e.target.value)) || 0) } })}
                    style={INPUT}
                  />
                </div>
              ))}
            </div>
          </div>

          <CeModifiersPanel value={c.modifiers ?? defaultCeModifiers()} onChange={(modifiers) => onChange({ ...c, modifiers })} />
        </>
      ) : (
        <div style={{ color: "var(--muted)", fontSize: "0.88rem", padding: "0.85rem 0.5rem", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, marginBottom: "0.6rem" }}>
          Player placeholders do not track HP.
        </div>
      )}

      <NotesTable notes={c.notes} onChange={(notes) => onChange({ ...c, notes })} />

      <SetRollPanel value={c.setRoll ?? defaultSetRoll()} onChange={(setRoll) => onChange({ ...c, setRoll })} />
    </div>
  );
};

// ── CE Margin Generator ───────────────────────────────────────────────────────
// Reuses the same dice math the player roller uses (rollApproachDice /
// rollFlatDice / computeFumbleWounds from domain/approachDice) behind a
// GM-local popup, since the player's ApproachDie component is too tightly
// coupled to the player app's own HUD/Engram/Overload-pool state to drop in
// here unmodified for an arbitrary enemy's data.

const ROLL_CHIP: React.CSSProperties = {
  width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 8, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.05)",
  fontWeight: 700, fontSize: "0.95rem",
};

const ROLL_BTN: React.CSSProperties = {
  background: "rgba(99,160,255,0.12)", border: "1px solid rgba(99,160,255,0.3)", borderRadius: 8,
  color: "var(--accent)", padding: "0.6rem 1rem", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer",
};

const CeRollPopup: React.FC<{ combatant: Combatant; methodKey: MethodKey; onClose: () => void }> = ({ combatant, methodKey, onClose }) => {
  const rating = effMethodDice(combatant, methodKey);
  const [dice] = useState<number[]>(() => rollApproachDice(rating).dice.map((d) => d.total));
  const [overloaded, setOverloaded] = useState(false);
  const [flanking, setFlanking] = useState(false);
  const [view, setView] = useState<"roll" | "margin-input" | "margin-result" | "damage">("roll");
  const [oppositionInput, setOppositionInput] = useState("");
  const [margin, setMargin] = useState<number | null>(null);
  const [damageDice, setDamageDice] = useState<number[]>([]);
  const [extraWoundDice, setExtraWoundDice] = useState(0);
  const [woundValue, setWoundValue] = useState(String(effWt(combatant)));

  const baseDie = dice.length > 0 ? Math.max(...dice) : 0;
  const baseDieIndex = dice.indexOf(baseDie);
  const dieValue = overloaded ? baseDie * 2 : baseDie;
  const totalAllMod = combatant.modifiers?.totalAll ?? 0;
  const flankBonus = flanking ? 1 : 0;
  const displayTotal = dieValue + totalAllMod + flankBonus;
  const totalAttackDefenseMod = combatant.modifiers?.totalAttackDefense ?? 0;
  const marginBase = displayTotal + totalAttackDefenseMod;

  const handleConfirmMargin = () => {
    const opposition = Number(oppositionInput);
    if (!Number.isFinite(opposition)) return;
    setMargin(marginBase - opposition);
    setView("margin-result");
  };

  const handleRollDamage = () => {
    if (margin === null || margin <= 0) return;
    setDamageDice(rollFlatDice(margin + extraWoundDice, combatant.woundDieSize));
    setView("damage");
  };

  const fumbleWounds = margin !== null && margin < 0 && typeof combatant.fumbleNumber === "number"
    ? computeFumbleWounds(margin, combatant.fumbleNumber)
    : 0;

  const woundThresholdNumber = Number(woundValue);
  const hasWoundValue = woundValue.trim() !== "" && Number.isFinite(woundThresholdNumber);
  const isSuccess = (v: number) => hasWoundValue && v >= woundThresholdNumber;
  const successCount = hasWoundValue ? damageDice.filter(isSuccess).length : 0;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", WebkitUserSelect: "none" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "var(--bg-dark)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", width: "92%", maxWidth: 360, display: "flex", flexDirection: "column", gap: "0.9rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: "1rem" }}>{combatant.name} — {METHOD_LABELS[methodKey]}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: "1.2rem", cursor: "pointer" }}>✕</button>
        </div>

        {view === "roll" && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {dice.length === 0 ? (
                <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>No dice to roll.</span>
              ) : dice.map((v, i) => (
                <span key={i} style={{ ...ROLL_CHIP, background: i === baseDieIndex ? "rgba(255,210,99,0.18)" : ROLL_CHIP.background, borderColor: i === baseDieIndex ? "rgba(255,210,99,0.5)" : (ROLL_CHIP.border as string) }}>
                  {v}
                </span>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: baseDie > 0 ? "pointer" : "default", opacity: baseDie > 0 ? 1 : 0.4 }}>
              <input type="checkbox" checked={overloaded} disabled={baseDie <= 0} onChange={(e) => setOverloaded(e.target.checked)} style={{ width: 20, height: 20 }} />
              Overload (double highest die)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
              <input type="checkbox" checked={flanking} onChange={(e) => setFlanking(e.target.checked)} style={{ width: 20, height: 20 }} />
              Flanking +1
            </label>
            <div style={{ fontSize: "1.3rem", fontWeight: 800, textAlign: "center" }}>
              Total: {displayTotal}
              {(totalAllMod !== 0 || flankBonus !== 0 || overloaded) && (
                <div style={{ fontSize: "0.72rem", color: "var(--muted)", fontWeight: 400 }}>
                  ({overloaded ? `${baseDie} doubled to ${dieValue}` : `${dieValue} die`}
                  {flankBonus ? " + 1 Flanking" : ""}
                  {totalAllMod !== 0 ? ` ${totalAllMod > 0 ? "+" : "−"} ${Math.abs(totalAllMod)} Collapse` : ""})
                </div>
              )}
            </div>
            <button onClick={() => setView("margin-input")} style={ROLL_BTN}>Enter Player's Total</button>
          </>
        )}

        {view === "margin-input" && (
          <>
            {totalAttackDefenseMod !== 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                Attacker Total: {marginBase} ({displayTotal} {totalAttackDefenseMod > 0 ? "+" : "−"} {Math.abs(totalAttackDefenseMod)} Collapse)
              </div>
            )}
            <label style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Player's Total</label>
            <input
              autoFocus type="number" inputMode="numeric" value={oppositionInput}
              onChange={(e) => setOppositionInput(e.target.value)}
              style={{ ...INPUT, fontSize: "16px", textAlign: "center" }}
            />
            <button disabled={oppositionInput.trim() === ""} onClick={handleConfirmMargin} style={{ ...ROLL_BTN, opacity: oppositionInput.trim() === "" ? 0.5 : 1 }}>
              Calculate Margin
            </button>
          </>
        )}

        {view === "margin-result" && margin !== null && (
          <>
            <div style={{ textAlign: "center", fontSize: "2rem", fontWeight: 800, color: margin > 0 ? "var(--accent-influence)" : "var(--error)" }}>
              {margin > 0 ? `+${margin} HIT` : `${margin} MISS`}
            </div>
            {margin > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
                  <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Extra Wound dice</span>
                  <button onClick={() => setExtraWoundDice((n) => Math.max(0, n - 1))} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "#fff", cursor: "pointer" }}>−</button>
                  <span>{extraWoundDice}</span>
                  <button onClick={() => setExtraWoundDice((n) => n + 1)} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "#fff", cursor: "pointer" }}>+</button>
                </div>
                <button onClick={handleRollDamage} style={ROLL_BTN}>
                  Roll Wounds ({margin + extraWoundDice}d{combatant.woundDieSize})
                </button>
              </>
            )}
            {margin < 0 && fumbleWounds > 0 && (
              <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "0.6rem", fontSize: "0.82rem", color: "#f87171" }}>
                Fumble! Missed past its Fumble Number ({combatant.fumbleNumber}) — {fumbleWounds} Wound{fumbleWounds === 1 ? "" : "s"} to {combatant.name}.
              </div>
            )}
          </>
        )}

        {view === "damage" && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              {damageDice.map((v, i) => (
                <span key={i} style={{ ...ROLL_CHIP, background: isSuccess(v) ? "rgba(99,255,177,0.18)" : ROLL_CHIP.background }}>{v}</span>
              ))}
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: 4 }}>Wound Threshold</label>
              <input type="number" inputMode="numeric" value={woundValue} onChange={(e) => setWoundValue(e.target.value)} style={{ ...INPUT, fontSize: "16px" }} />
            </div>
            {hasWoundValue && <div style={{ textAlign: "center", fontSize: "0.9rem", fontWeight: 700 }}>{successCount} Wound{successCount === 1 ? "" : "s"}</div>}
          </>
        )}
      </div>
    </div>
  );
};

// ── Run Card ──────────────────────────────────────────────────────────────────
// Horizontal swipe on the card background navigates between combatants.
// Vertical swipe / scroll on counters adjusts HP.

type RunCardProps = {
  c: Combatant;
  index: number;
  total: number;
  onChange: (c: Combatant) => void;
  onPrev: () => void;
  onNext: () => void;
  onGoTo: (i: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

const RunCard: React.FC<RunCardProps> = ({ c, index, total, onChange, onPrev, onNext, onGoTo, onMoveUp, onMoveDown }) => {
  const [rollMethod, setRollMethod] = useState<MethodKey | null>(null);
  const [noDice, setNoDice] = useState(() => isNoDiceMode());
  useEffect(() => subscribeNoDiceMode(() => setNoDice(isNoDiceMode())), []);
  const cardRef = useRef<HTMLDivElement>(null);
  const onPrevRef = useRef(onPrev);
  const onNextRef = useRef(onNext);
  const indexRef = useRef(index);
  const totalRef = useRef(total);
  onPrevRef.current = onPrev;
  onNextRef.current = onNext;
  indexRef.current = index;
  totalRef.current = total;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    let startX = 0, startY = 0;

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      if (Math.abs(dx) > 55 && dy < Math.abs(dx) * 0.7) {
        if (dx < 0 && totalRef.current > 1) onNextRef.current();
        else if (dx > 0 && indexRef.current > 0) onPrevRef.current();
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const downed = c.type === "enemy" && c.hp <= 0;

  return (
    <div
      ref={cardRef}
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "1.5rem 1.25rem 1.25rem", minHeight: "58vh", display: "flex", flexDirection: "column", gap: "1.5rem", touchAction: "pan-y" }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{index + 1} / {total}</span>
            {noDice && c.type === "enemy" ? (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                · RDY
                <input
                  type="number"
                  inputMode="numeric"
                  value={c.readinessResult ?? ""}
                  placeholder="Table roll"
                  onChange={(e) => {
                    const raw = e.target.value;
                    onChange({ ...c, readinessResult: raw.trim() === "" ? undefined : Number(raw) });
                  }}
                  style={{ ...INPUT, fontSize: "16px", width: 70, padding: "0.15rem 0.35rem" }}
                />
              </span>
            ) : (
              typeof c.readinessResult === "number" && <span> · RDY roll {c.readinessResult}</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {c.avatarUrl ? (
              <img
                src={c.avatarUrl}
                alt=""
                style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "2px solid rgba(255,255,255,0.15)", opacity: downed ? 0.4 : 1 }}
              />
            ) : (
              <span style={{ fontSize: "2rem", opacity: downed ? 0.4 : 1 }}>{c.icon || ICONS[index % ICONS.length]}</span>
            )}
            <div>
              <div style={{ fontWeight: 700, fontSize: "1.5rem", marginTop: 3, lineHeight: 1.1, opacity: downed ? 0.5 : 1 }}>{c.name}</div>
              {downed && (
                <div style={{ display: "inline-block", marginTop: 4, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 6, color: "#f87171", fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "0.15rem 0.5rem" }}>
                  Downed
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={onPrev} disabled={index === 0}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: index === 0 ? "rgba(255,255,255,0.18)" : "#f8f9fa", padding: "0.4rem 0.85rem", fontSize: "1.1rem", cursor: index === 0 ? "default" : "pointer" }}
            >←</button>
            <button
              onClick={onNext} disabled={total <= 1}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: total <= 1 ? "rgba(255,255,255,0.18)" : "#f8f9fa", padding: "0.4rem 0.85rem", fontSize: "1.1rem", cursor: total <= 1 ? "default" : "pointer" }}
            >→</button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={onMoveUp} disabled={index === 0}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: index === 0 ? "rgba(255,255,255,0.18)" : "#f8f9fa", padding: "0.25rem 0.6rem", fontSize: "0.85rem", cursor: index === 0 ? "default" : "pointer" }}
            >↑</button>
            <button
              onClick={onMoveDown} disabled={index === total - 1}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: index === total - 1 ? "rgba(255,255,255,0.18)" : "#f8f9fa", padding: "0.25rem 0.6rem", fontSize: "0.85rem", cursor: index === total - 1 ? "default" : "pointer" }}
            >↓</button>
          </div>
        </div>
      </div>

      {downed && (
        <div style={{ fontSize: "0.75rem", color: "#f87171", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, padding: "0.5rem 0.65rem" }}>
          Struck while Downed: auto-hit.
        </div>
      )}

      {/* Counters */}
      {c.type === "enemy" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "1.75rem", alignItems: "start" }}>
            <Counter
              label="HP" value={c.hp} max={effMaxHp(c)} accent="var(--accent-influence)"
              onChange={(v) => onChange({ ...c, hp: v })}
              onMaxChange={(v) => onChange({ ...c, maxHp: Math.max(1, v - (c.modifiers?.maxHp ?? 0)), hp: Math.min(c.hp, v) })}
              large
            />
            <WtControl
              base={c.wt}
              modifier={c.modifiers?.wt ?? 0}
              onBaseChange={(wt) => onChange({ ...c, wt })}
            />
          </div>
          <div>
            <div style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--muted)", marginBottom: 6 }}>
              {noDice ? "Methods — tap a die to mark it spent" : "Methods — tap to roll"}
            </div>
            {noDice ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {METHOD_KEYS.map((k) => {
                  const n = effMethodDice(c, k);
                  const spent = c.spentMethods?.[k] ?? [];
                  return (
                    <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: "0.72rem", color: n > 0 ? "var(--text)" : "rgba(255,255,255,0.3)" }}>{METHOD_LABELS[k]}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {n <= 0 && <span style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.25)" }}>—</span>}
                        {Array.from({ length: n }, (_, i) => {
                          const isSpent = !!spent[i];
                          return (
                            <button
                              key={i}
                              onClick={() => {
                                const next = Array.from({ length: n }, (_, j) => !!spent[j]);
                                next[i] = !next[i];
                                onChange({ ...c, spentMethods: { ...c.spentMethods, [k]: next } });
                              }}
                              aria-label={`${METHOD_LABELS[k]} die ${i + 1}${isSpent ? " (spent)" : ""}`}
                              style={{
                                width: 22, height: 22, borderRadius: "50%",
                                border: `1px solid ${isSpent ? "rgba(255,255,255,0.15)" : "rgba(99,160,255,0.45)"}`,
                                background: isSpent ? "rgba(255,255,255,0.04)" : "rgba(99,160,255,0.2)",
                                color: isSpent ? "rgba(255,255,255,0.25)" : "var(--accent)",
                                fontSize: "0.62rem", padding: 0, cursor: "pointer",
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                {METHOD_KEYS.map((k) => {
                  const n = effMethodDice(c, k);
                  return (
                    <button
                      key={k}
                      disabled={n <= 0}
                      onClick={() => setRollMethod(k)}
                      style={{ background: "rgba(99,160,255,0.08)", border: "1px solid rgba(99,160,255,0.22)", borderRadius: 8, color: n > 0 ? "var(--accent)" : "rgba(255,255,255,0.25)", padding: "0.5rem 0.3rem", fontSize: "0.78rem", cursor: n > 0 ? "pointer" : "default" }}
                    >
                      {METHOD_LABELS[k]}<br />
                      <span style={{ fontSize: "0.68rem", opacity: 0.8 }}>{n}d10</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(typeof c.fumbleNumber === "number" || (c.modifiers?.wt ?? 0) !== 0 || (c.modifiers?.totalAttackDefense ?? 0) !== 0 || (c.modifiers?.totalAll ?? 0) !== 0) && (
              <div style={{ fontSize: "0.68rem", color: "var(--muted)", marginTop: 6 }}>
                {typeof c.fumbleNumber === "number" ? `Fumble ${c.fumbleNumber} · ` : ""}
                {noDice ? `WT ${effWt(c)} · ` : ""}
                {(c.modifiers?.totalAttackDefense ?? 0) !== 0 ? `Attack/Defense ${c.modifiers!.totalAttackDefense! > 0 ? "+" : "−"}${Math.abs(c.modifiers!.totalAttackDefense!)} · ` : ""}
                {(c.modifiers?.totalAll ?? 0) !== 0 ? `Every Roll ${c.modifiers!.totalAll! > 0 ? "+" : "−"}${Math.abs(c.modifiers!.totalAll!)}` : ""}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ color: "var(--muted)", fontSize: "0.92rem", padding: "1rem", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          Player placeholder — no HP values are tracked here.
          <div>
            <label style={{ display: "block", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Readiness result</label>
            <input
              type="number"
              inputMode="numeric"
              value={c.readinessResult ?? ""}
              placeholder="Table roll"
              onChange={(e) => {
                const raw = e.target.value;
                onChange({ ...c, readinessResult: raw.trim() === "" ? undefined : Number(raw) });
              }}
              style={{ ...INPUT, fontSize: "16px", maxWidth: 140 }}
            />
          </div>
        </div>
      )}

      {/* Notes */}
      <NotesTable notes={c.notes} onChange={(notes) => onChange({ ...c, notes })} />

      {/* Set Roll (Status Effects) */}
      <SetRollPanel value={c.setRoll ?? defaultSetRoll()} onChange={(setRoll) => onChange({ ...c, setRoll })} />

      {/* Dot navigation */}
      {total > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 9, marginTop: "auto", paddingBottom: "0.25rem" }}>
          {Array.from({ length: total }, (_, i) => (
            <button
              key={i}
              onClick={() => onGoTo(i)}
              aria-label={`Combatant ${i + 1}`}
              style={{ width: 9, height: 9, borderRadius: "50%", padding: 0, border: "none", background: i === index ? "#f8f9fa" : "rgba(255,255,255,0.2)", cursor: "pointer", transition: "background 0.15s" }}
            />
          ))}
        </div>
      )}

      {rollMethod && (
        <CeRollPopup combatant={c} methodKey={rollMethod} onClose={() => setRollMethod(null)} />
      )}
    </div>
  );
};

// ── Party Panel ───────────────────────────────────────────────────────────────

type PartyPanelProps = {
  parties: Party[];
  selectedIds: Set<string>;
  combatants: Combatant[];
  onImport: (p: Party) => void;
  onSaveNew: (name: string) => void;
  onOverwrite: (id: string, name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

const PartyPanel: React.FC<PartyPanelProps> = ({
  parties, selectedIds, combatants, onImport, onSaveNew, onOverwrite, onRename, onDelete, onClose,
}) => {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingVal, setRenamingVal] = useState("");
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [saveAsName, setSaveAsName] = useState("");

  const selectedPlayers = combatants.filter((c) => c.type === "player" && selectedIds.has(c.id));
  const canSaveNew = parties.length < MAX_PARTIES && selectedPlayers.length > 0;

  const commitSaveNew = () => {
    if (!selectedPlayers.length) return;
    const name = newName.trim() || `Party ${parties.length + 1}`;
    onSaveNew(name);
    setNewName("");
  };

  const commitSaveAs = (id: string) => {
    if (!selectedPlayers.length) return;
    const name = saveAsName.trim() || parties.find((p) => p.id === id)?.name || `Party ${parties.length}`;
    onOverwrite(id, name);
    setSaveAsId(null);
    setSaveAsName("");
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: "var(--bg-dark)", border: "1px solid var(--border)", borderRadius: "12px 12px 0 0", padding: "1.25rem 1.25rem 2.5rem", width: "100%", maxWidth: 600, maxHeight: "72vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Parties
            <span style={{ marginLeft: 8, color: "var(--muted)", fontSize: "0.8rem", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {parties.length} / {MAX_PARTIES}
            </span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: "0.15rem 0.3rem" }}>✕</button>
        </div>

        <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "1rem", lineHeight: 1.4 }}>
          Check the <strong style={{ color: "var(--text)" }}>Party</strong> checkbox on player combatants in Edit mode, then save them here. Loading a party appends those players to the current pool.
        </div>

        {selectedPlayers.length > 0 ? (
          <div style={{ background: "rgba(99,255,177,0.06)", border: "1px solid rgba(99,255,177,0.18)", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.8rem", color: "var(--accent-influence)", marginBottom: "1rem" }}>
            {selectedPlayers.length} player{selectedPlayers.length !== 1 ? "s" : ""} selected: {selectedPlayers.map((p) => p.name).join(", ")}
          </div>
        ) : (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.8rem", color: "var(--muted)", marginBottom: "1rem" }}>
            No players checked — check Party on player rows in Edit mode to enable saving.
          </div>
        )}

        {parties.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: "0.85rem", textAlign: "center", padding: "1.5rem 0" }}>
            No saved parties yet.
          </div>
        )}

        {parties.map((p) => (
          <React.Fragment key={p.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.65rem 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renamingId === p.id ? (
                  <input
                    autoFocus
                    style={{ width: "100%", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.25rem 0.5rem", fontSize: "0.9rem", boxSizing: "border-box" }}
                    value={renamingVal}
                    onChange={(e) => setRenamingVal(e.target.value)}
                    onBlur={() => { onRename(p.id, renamingVal.trim() || p.name); setRenamingId(null); }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <>
                    <div
                      onClick={() => { setRenamingId(p.id); setRenamingVal(p.name); }}
                      style={{ fontWeight: 600, fontSize: "0.9rem", cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {p.name}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 2 }}>
                      {p.players.length} player{p.players.length !== 1 ? "s" : ""}: {p.players.map((pl) => pl.name).join(", ")} · {new Date(p.savedAt).toLocaleDateString()}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => onImport(p)}
                style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.22)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.8rem", padding: "0.3rem 0.6rem", cursor: "pointer", whiteSpace: "nowrap" }}
              >Import</button>
              <button
                onClick={() => {
                  if (!selectedPlayers.length) return;
                  setSaveAsId(p.id);
                  setSaveAsName(p.name);
                }}
                disabled={!selectedPlayers.length}
                title={selectedPlayers.length ? "Overwrite with selected players" : "Check Party on players first"}
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: selectedPlayers.length ? "var(--muted)" : "rgba(255,255,255,0.2)", fontSize: "0.8rem", padding: "0.3rem 0.55rem", cursor: selectedPlayers.length ? "pointer" : "default" }}
              >Save As</button>
              <button
                onClick={() => onDelete(p.id)}
                aria-label="Delete party"
                style={{ background: "none", border: "none", color: "rgba(255,107,107,0.55)", cursor: "pointer", fontSize: "0.95rem", padding: "0.15rem 0.3rem" }}
              >✕</button>
            </div>
            {saveAsId === p.id && (
              <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem" }}>
                <input
                  autoFocus
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#f8f9fa", padding: "0.4rem 0.65rem", fontSize: "0.9rem" }}
                />
                <button
                  onClick={() => commitSaveAs(p.id)}
                  style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.25)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer" }}
                >Save</button>
                <button
                  onClick={() => { setSaveAsId(null); setSaveAsName(""); }}
                  style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--muted)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer" }}
                >Cancel</button>
              </div>
            )}
          </React.Fragment>
        ))}

        {canSaveNew ? (
          <div style={{ display: "flex", gap: 8, marginTop: "1rem" }}>
            <input
              style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#f8f9fa", padding: "0.4rem 0.65rem", fontSize: "0.9rem" }}
              placeholder={`Party ${parties.length + 1}…`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitSaveNew()}
            />
            <button
              onClick={commitSaveNew}
              style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.25)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer", whiteSpace: "nowrap" }}
            >Save New</button>
          </div>
        ) : parties.length >= MAX_PARTIES ? (
          <div style={{ color: "var(--muted)", fontSize: "0.8rem", textAlign: "center", marginTop: "0.85rem" }}>
            Max {MAX_PARTIES} slots reached — overwrite or delete to add a new one.
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ── Scenario Panel ────────────────────────────────────────────────────────────

type ScenarioPanelProps = {
  scenarios: Scenario[];
  combatants: Combatant[];
  onLoad: (s: Scenario) => void;
  onSaveNew: (name: string) => void;
  onOverwrite: (id: string, name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

const ScenarioPanel: React.FC<ScenarioPanelProps> = ({
  scenarios, onLoad, onSaveNew, onOverwrite, onRename, onDelete, onClose,
}) => {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingVal, setRenamingVal] = useState("");
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [saveAsName, setSaveAsName] = useState("");

  const canAddNew = scenarios.length < MAX_SCENARIOS;

  const commitSaveNew = () => {
    const name = newName.trim() || `Scenario ${scenarios.length + 1}`;
    onSaveNew(name);
    setNewName("");
  };

  const commitSaveAs = (id: string) => {
    const name = saveAsName.trim() || scenarios.find((s) => s.id === id)?.name || `Scenario ${scenarios.length}`;
    onOverwrite(id, name);
    setSaveAsId(null);
    setSaveAsName("");
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: "var(--bg-dark)", border: "1px solid var(--border)", borderRadius: "12px 12px 0 0", padding: "1.25rem 1.25rem 2.5rem", width: "100%", maxWidth: 600, maxHeight: "72vh", overflowY: "auto" }}>
        {/* Title */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Scenarios
            <span style={{ marginLeft: 8, color: "var(--muted)", fontSize: "0.8rem", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {scenarios.length} / {MAX_SCENARIOS}
            </span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: "0.15rem 0.3rem" }}>✕</button>
        </div>

        <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "1rem", lineHeight: 1.4 }}>
          Build your pool, then save it to an empty slot or overwrite an existing one. The Save As action lets you keep or rename the scenario name before saving.
        </div>

        {scenarios.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: "0.85rem", textAlign: "center", padding: "1.5rem 0" }}>
            No saved scenarios yet.
          </div>
        )}

        {scenarios.map((s) => (
          <React.Fragment key={s.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.65rem 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    style={{ width: "100%", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 4, color: "#f8f9fa", padding: "0.25rem 0.5rem", fontSize: "0.9rem", boxSizing: "border-box" }}
                    value={renamingVal}
                    onChange={(e) => setRenamingVal(e.target.value)}
                    onBlur={() => { onRename(s.id, renamingVal.trim() || s.name); setRenamingId(null); }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <>
                    <div
                      onClick={() => { setRenamingId(s.id); setRenamingVal(s.name); }}
                      style={{ fontWeight: 600, fontSize: "0.9rem", cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {s.name}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 2 }}>
                      {s.combatants.length} combatant{s.combatants.length !== 1 ? "s" : ""} · {new Date(s.savedAt).toLocaleDateString()}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => onLoad(s)}
                style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.22)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.8rem", padding: "0.3rem 0.6rem", cursor: "pointer", whiteSpace: "nowrap" }}
              >Load</button>
              <button
                onClick={() => {
                  setSaveAsId(s.id);
                  setSaveAsName(s.name);
                }}
                title="Save As: overwrite this scenario with the current pool"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--muted)", fontSize: "0.8rem", padding: "0.3rem 0.55rem", cursor: "pointer" }}
              >Save As</button>
              <button
                onClick={() => onDelete(s.id)}
                aria-label="Delete scenario"
                style={{ background: "none", border: "none", color: "rgba(255,107,107,0.55)", cursor: "pointer", fontSize: "0.95rem", padding: "0.15rem 0.3rem" }}
              >✕</button>
            </div>
            {saveAsId === s.id && (
              <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem" }}>
                <input
                  autoFocus
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#f8f9fa", padding: "0.4rem 0.65rem", fontSize: "0.9rem" }}
                />
                <button
                  onClick={() => commitSaveAs(s.id)}
                  style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.25)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer" }}
                >Save</button>
                <button
                  onClick={() => { setSaveAsId(null); setSaveAsName(""); }}
                  style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--muted)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer" }}
                >Cancel</button>
              </div>
            )}
          </React.Fragment>
        ))}

        {canAddNew ? (
          <div style={{ display: "flex", gap: 8, marginTop: "1rem" }}>
            <input
              style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#f8f9fa", padding: "0.4rem 0.65rem", fontSize: "0.9rem" }}
              placeholder={`Scenario ${scenarios.length + 1}…`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitSaveNew()}
            />
            <button
              onClick={commitSaveNew}
              style={{ background: "rgba(99,255,177,0.08)", border: "1px solid rgba(99,255,177,0.25)", borderRadius: 4, color: "var(--accent-influence)", fontSize: "0.85rem", padding: "0.4rem 0.8rem", cursor: "pointer", whiteSpace: "nowrap" }}
            >Save New</button>
          </div>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: "0.8rem", textAlign: "center", marginTop: "0.85rem" }}>
            Max {MAX_SCENARIOS} slots reached — overwrite or delete to add a new one.
          </div>
        )}
      </div>
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function GMCombatTracker() {
  const [appState, setAppState] = useState<AppState>(loadApp);
  const [mode, setMode] = useState<"edit" | "run">(() => loadRunState().mode);
  const [runIndex, setRunIndex] = useState(() => loadRunState().runIndex);
  const [round, setRound] = useState(() => loadRunState().round);
  const [noDice, setNoDice] = useState(() => isNoDiceMode());
  useEffect(() => subscribeNoDiceMode(() => setNoDice(isNoDiceMode())), []);
  const [showScenarios, setShowScenarios] = useState(false);
  const [showParties, setShowParties] = useState(false);
  const [partySelected, setPartySelected] = useState<Set<string>>(new Set());

  const { combatants, scenarios, parties } = appState;

  const updateApp = useCallback((next: AppState) => {
    setAppState(next);
    saveApp(next);
  }, []);

  // Clamp run index when pool shrinks
  useEffect(() => {
    if (combatants.length > 0 && runIndex >= combatants.length) {
      setRunIndex(combatants.length - 1);
    }
  }, [combatants.length, runIndex]);

  // Persist Run mode / active index so combat stays running across navigation
  // until the GM explicitly ends it (Edit / Clear).
  useEffect(() => {
    saveRunState(mode, runIndex, round);
  }, [mode, runIndex, round]);

  // ── Pool actions ──────────────────────────────────────────────────────────

  const addCombatant = () => {
    setAppState((prev) => {
      const next = { ...prev, combatants: [...prev.combatants, makeCombatant(prev.combatants)] };
      saveApp(next);
      return next;
    });
  };

  // Functional update prevents stale-state overwrites during rapid counter changes
  const updateCombatant = useCallback((updated: Combatant) => {
    setAppState((prev) => {
      const next = { ...prev, combatants: prev.combatants.map((c) => (c.id === updated.id ? updated : c)) };
      saveApp(next);
      return next;
    });
  }, []);

  const moveCombatant = useCallback((id: string, direction: "up" | "down") => {
    setAppState((prev) => {
      const index = prev.combatants.findIndex((c) => c.id === id);
      if (index === -1) return prev;
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= prev.combatants.length) return prev;
      const nextCombatants = [...prev.combatants];
      [nextCombatants[index], nextCombatants[nextIndex]] = [nextCombatants[nextIndex], nextCombatants[index]];
      const next = { ...prev, combatants: nextCombatants };
      saveApp(next);
      return next;
    });
  }, []);

  const removeCombatant = (id: string) => {
    setAppState((prev) => {
      const next = { ...prev, combatants: prev.combatants.filter((c) => c.id !== id) };
      if (runIndex >= next.combatants.length && runIndex > 0) setRunIndex(next.combatants.length - 1);
      saveApp(next);
      return next;
    });
  };

  const clearPool = () => {
    if (!window.confirm("Clear all combatants from the pool?")) return;
    updateApp({ ...appState, combatants: [] });
    setRunIndex(0);
    setRound(1);
    setMode("edit");
  };

  // Resets HP/order/turn — only ever runs when the GM explicitly starts a
  // fight, never on a plain Edit↔Run toggle (that used to reset every time,
  // which lost mid-fight HP/order whenever the GM dipped into Edit).
  const startFight = () => {
    const noDice = isNoDiceMode();
    setAppState((prev) => {
      const rolled = prev.combatants.map((c) => {
        if (c.type === "enemy") {
          // No Dice Mode: nothing is rolled — the GM types each enemy's
          // table-rolled Readiness into the same field players already use.
          const readinessResult = noDice ? c.readinessResult : rollFlatDice(1, 10)[0] + effReadiness(c);
          return { ...c, readinessResult, hp: effMaxHp(c), spentMethods: {} };
        }
        return { ...c, spentMethods: {} };
      });
      const sorted = [...rolled].sort((a, b) => {
        const aLast = a.type === "player" && !!a.overEncumbered;
        const bLast = b.type === "player" && !!b.overEncumbered;
        if (aLast !== bLast) return aLast ? 1 : -1;
        const aR = a.readinessResult ?? -Infinity;
        const bR = b.readinessResult ?? -Infinity;
        if (aR !== bR) return bR - aR;
        const aP = a.personality ?? -Infinity;
        const bP = b.personality ?? -Infinity;
        if (aP !== bP) return bP - aP;
        if (a.type !== b.type) return a.type === "player" ? -1 : 1;
        return 0; // stable sort: ties fall back to current GM order
      });
      const next = { ...prev, combatants: sorted };
      saveApp(next);
      return next;
    });
    setRunIndex(0);
    setRound(1);
    setMode("run");
  };

  // ── Scenario actions ──────────────────────────────────────────────────────

  const saveNewScenario = (name: string) => {
    if (scenarios.length >= MAX_SCENARIOS) return;
    const snap: Scenario = { id: uid(), name, combatants: [...combatants], savedAt: Date.now() };
    updateApp({ ...appState, scenarios: [...scenarios, snap] });
  };

  const overwriteScenario = (id: string, name: string) => {
    updateApp({
      ...appState,
      scenarios: scenarios.map((s) =>
        s.id === id
          ? { ...s, name, combatants: [...combatants], savedAt: Date.now() }
          : s
      ),
    });
  };

  const renameScenario = (id: string, name: string) => {
    updateApp({ ...appState, scenarios: scenarios.map((s) => s.id === id ? { ...s, name } : s) });
  };

  const loadScenario = (s: Scenario) => {
    updateApp({ ...appState, combatants: s.combatants });
    setRunIndex(0);
    setShowScenarios(false);
  };

  const deleteScenario = (id: string) => {
    if (!window.confirm("Delete this scenario?")) return;
    updateApp({ ...appState, scenarios: scenarios.filter((s) => s.id !== id) });
  };

  // ── Party actions ─────────────────────────────────────────────────────────

  const togglePartySelect = useCallback((id: string) => {
    setPartySelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const saveNewParty = (name: string) => {
    if (parties.length >= MAX_PARTIES) return;
    const players = combatants.filter((c) => c.type === "player" && partySelected.has(c.id));
    if (!players.length) return;
    const snap: Party = { id: uid(), name, players, savedAt: Date.now() };
    updateApp({ ...appState, parties: [...parties, snap] });
  };

  const overwriteParty = (id: string, name: string) => {
    const players = combatants.filter((c) => c.type === "player" && partySelected.has(c.id));
    if (!players.length) return;
    updateApp({
      ...appState,
      parties: parties.map((p) =>
        p.id === id ? { ...p, name, players, savedAt: Date.now() } : p
      ),
    });
  };

  const renameParty = (id: string, name: string) => {
    updateApp({ ...appState, parties: parties.map((p) => p.id === id ? { ...p, name } : p) });
  };

  const importParty = (party: Party) => {
    const alreadyImported = combatants.some((c) => c.partyId === party.id);
    if (alreadyImported) {
      window.alert(`"${party.name}" is already in the pool. Clear those players first before importing again.`);
      return;
    }
    const freshPlayers = party.players.map((p) => ({ ...p, id: uid(), partyId: party.id }));
    updateApp({ ...appState, combatants: [...combatants, ...freshPlayers] });
    setShowParties(false);
  };

  const deleteParty = (id: string) => {
    if (!window.confirm("Delete this party?")) return;
    updateApp({ ...appState, parties: parties.filter((p) => p.id !== id) });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const safeIndex = Math.min(runIndex, Math.max(0, combatants.length - 1));

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "1rem 1rem 4rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem" }}>
        <div>
          <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)" }}>GM</div>
          <h1 style={{ margin: "0.1rem 0 0", fontSize: "1.5rem" }}>Enemy Pool</h1>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setShowParties(true)}
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#f8f9fa", padding: "0.4rem 0.75rem", fontSize: "0.82rem", cursor: "pointer" }}
          >
            Party{parties.length > 0 ? ` (${parties.length})` : ""}
          </button>
          <button
            onClick={() => setShowScenarios(true)}
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#f8f9fa", padding: "0.4rem 0.75rem", fontSize: "0.82rem", cursor: "pointer" }}
          >
            Scenarios{scenarios.length > 0 ? ` (${scenarios.length})` : ""}
          </button>
          {combatants.length > 0 && (
            <>
              {mode === "edit" && (
                <button
                  onClick={startFight}
                  title={noDice
                    ? "No Dice Mode: rolls nothing — sorts by each combatant's typed Readiness result and resets HP"
                    : "Rolls enemy Readiness, sorts the order, and resets HP — only ever run this when a fight is actually starting"}
                  style={{ background: "rgba(255,210,99,0.12)", border: "1px solid rgba(255,210,99,0.35)", borderRadius: 6, color: "#e9c46a", padding: "0.4rem 0.75rem", fontSize: "0.82rem", cursor: "pointer" }}
                >
                  Start Fight
                </button>
              )}
              <button
                onClick={() => setMode((m) => (m === "edit" ? "run" : "edit"))}
                style={{ background: mode === "run" ? "rgba(99,255,177,0.1)" : "rgba(255,255,255,0.05)", border: `1px solid ${mode === "run" ? "rgba(99,255,177,0.35)" : "rgba(255,255,255,0.1)"}`, borderRadius: 6, color: mode === "run" ? "var(--accent-influence)" : "#f8f9fa", padding: "0.4rem 0.75rem", fontSize: "0.82rem", cursor: "pointer" }}
              >
                {mode === "edit" ? "▶ Run" : "✎ Edit"}
              </button>
            </>
          )}
        </div>
      </div>

      {mode === "run" && combatants.length > 0 && (
        <div style={{ textAlign: "center", color: "var(--muted)", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: "0.75rem" }}>
          Round {round}
        </div>
      )}

      {/* Edit mode */}
      {mode === "edit" && (
        <>
          {combatants.length === 0 && (
            <div style={{ textAlign: "center", color: "var(--muted)", padding: "2.5rem 1rem", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
              No enemies yet. Add combatants to start tracking.
            </div>
          )}
          {combatants.map((c, index) => (
            <EditRow
              key={c.id}
              c={c}
              index={index}
              isLast={index === combatants.length - 1}
              onChange={updateCombatant}
              onMoveUp={() => moveCombatant(c.id, "up")}
              onMoveDown={() => moveCombatant(c.id, "down")}
              onRemove={() => removeCombatant(c.id)}
              partySelected={partySelected.has(c.id)}
              onPartyToggle={() => togglePartySelect(c.id)}
            />
          ))}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: "0.25rem" }}>
            <button
              onClick={addCombatant}
              style={{ flex: 1, background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.13)", borderRadius: 8, color: "var(--muted)", padding: "0.75rem", fontSize: "0.88rem", cursor: "pointer" }}
            >
              + Add
            </button>
            {combatants.length > 0 && (
              <button
                onClick={clearPool}
                style={{ background: "none", border: "1px solid rgba(255,107,107,0.18)", borderRadius: 8, color: "rgba(255,107,107,0.65)", padding: "0.75rem 1rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}

      {/* Run mode */}
      {mode === "run" && combatants.length > 0 && (
        <RunCard
          c={combatants[safeIndex]}
          index={safeIndex}
          total={combatants.length}
          onChange={updateCombatant}
          onPrev={() => setRunIndex((i) => Math.max(0, i - 1))}
          onNext={() => setRunIndex((i) => {
            const next = i + 1;
            if (next >= combatants.length) { setRound((r) => r + 1); return 0; }
            return next;
          })}
          onGoTo={setRunIndex}
          onMoveUp={() => { moveCombatant(combatants[safeIndex].id, "up"); setRunIndex((i) => Math.max(0, i - 1)); }}
          onMoveDown={() => { moveCombatant(combatants[safeIndex].id, "down"); setRunIndex((i) => Math.min(combatants.length - 1, i + 1)); }}
        />
      )}

      {/* Party panel */}
      {showParties && (
        <PartyPanel
          parties={parties}
          selectedIds={partySelected}
          combatants={combatants}
          onImport={importParty}
          onSaveNew={saveNewParty}
          onOverwrite={overwriteParty}
          onRename={renameParty}
          onDelete={deleteParty}
          onClose={() => setShowParties(false)}
        />
      )}

      {/* Scenario panel */}
      {showScenarios && (
        <ScenarioPanel
          scenarios={scenarios}
          combatants={combatants}
          onLoad={loadScenario}
          onSaveNew={saveNewScenario}
          onOverwrite={overwriteScenario}
          onRename={renameScenario}
          onDelete={deleteScenario}
          onClose={() => setShowScenarios(false)}
        />
      )}
    </div>
  );
}