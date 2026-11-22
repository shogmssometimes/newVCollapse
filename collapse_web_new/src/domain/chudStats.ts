import type { ApproachStats, CollapseModifiers, CoreStats, SecondaryStats } from '../types/chud'

export const DEFAULT_CORE: CoreStats = { vigor: 3, inference: 2, personality: 2 };
export const DEFAULT_WT = 3;

export const DEFAULT_COLLAPSE_MODIFIERS: CollapseModifiers = {
  maxHp: 0,
  readiness: 0,
  inventorySlots: 0,
  capacity: 0,
  ganbareCharges: 0,
  wt: 0,
  methodDice: {},
  totalAttackDefense: 0,
  totalAll: 0,
};

// Back-fills any fields missing from a partial/legacy save (same pattern as
// engramState.ts's withUsesLeft) so every caller can rely on every field
// being present, without needing a migration step.
export function withCollapseModifiers(saved?: Partial<CollapseModifiers> | null): CollapseModifiers {
  return {
    ...DEFAULT_COLLAPSE_MODIFIERS,
    ...saved,
    methodDice: { ...(saved?.methodDice ?? {}) },
  };
}
export const DEFAULT_HP_COUNTER = 1;
export const DEFAULT_APPROACH: ApproachStats = {
  force: 0,
  finesse: 0,
  guts: 0,
  logic: 0,
  show: 0,
  tell: 0,
};

export const DEFAULT_SECONDARY: SecondaryStats = {
  vigor: 0,
  inference: 0,
  personality: 0,
};

// Derived Vitals, per the handbook's Phase 6 example (YOU/Vie):
//   HP (Max)        = 6 + Vigor + Inference
//   Capacity        = 4 + Inference + Personality
//   Readiness (RDY) = Vigor + Personality
// Each formula result then has its Collapse modifier (if any) added before
// being floored per the handbook: Max HP can never go below 1; Capacity
// and Readiness never below 0.
export function computeDerived(core: CoreStats, modifiers: CollapseModifiers = DEFAULT_COLLAPSE_MODIFIERS) {
  return {
    hp: Math.max(1, 6 + core.vigor + core.inference + modifiers.maxHp),
    capacity: Math.max(0, 4 + core.inference + core.personality + modifiers.capacity),
    readyness: Math.max(0, core.vigor + core.personality + modifiers.readiness),
  };
}

// Inventory Slots = Vigor (handbook rule) — always derived from Core
// stats, never a separately set/leveled value. (Not to be confused with
// the Fumble Number, which is V+I+P.)
export function computeInventorySlots(core: CoreStats, modifiers: CollapseModifiers = DEFAULT_COLLAPSE_MODIFIERS): number {
  return Math.max(0, core.vigor + modifiers.inventorySlots);
}

// Fumble Number = V+I+P — the margin by which an opponent must beat you to
// cause a Fumble (see the Combat section). Not yet surfaced in any UI.
export function computeFumbleNumber(core: CoreStats): number {
  return core.vigor + core.inference + core.personality;
}

// Skills = Inference — how many Skills the character knows.
export function computeSkillCount(core: CoreStats): number {
  return core.inference;
}

// Ganbare Charges = Personality — how many times a day you can give
// Ganbare! to an ally.
export function computeGanbareCharges(core: CoreStats, modifiers: CollapseModifiers = DEFAULT_COLLAPSE_MODIFIERS): number {
  return Math.max(0, core.personality + modifiers.ganbareCharges);
}

// WT base = 3 (handbook) + Collapse modifier, floored at 1. Temporary
// in-session changes (statuses like Exposed, via the WT StatCard's own
// tap/hold gestures) stay layered on top of this in Aag.tsx and never
// write back into the modifier itself.
export function computeWtBase(modifiers: CollapseModifiers = DEFAULT_COLLAPSE_MODIFIERS): number {
  return Math.max(1, DEFAULT_WT + modifiers.wt);
}

// A Method's effective dice-pool rating = its Core-distributed rating plus
// its Collapse modifier (if any), floored at 0. Wardrobe bonus dice are
// added on top of this elsewhere (ApproachPanel.tsx), same as before.
export function computeMethodRating(approachValue: number, field: keyof ApproachStats, modifiers: CollapseModifiers = DEFAULT_COLLAPSE_MODIFIERS): number {
  return Math.max(0, approachValue + (modifiers.methodDice[field] ?? 0));
}

// How many modifier fields are non-zero, counting each Method's dice entry
// separately (used by the AAG's "Collapse Modifiers" summary button so
// players can tell at a glance whether anything is active without opening
// the page).
export function countActiveCollapseModifiers(modifiers: CollapseModifiers): number {
  const scalarFields: Array<keyof CollapseModifiers> = [
    'maxHp', 'readiness', 'inventorySlots', 'capacity', 'ganbareCharges', 'wt',
    'totalAttackDefense', 'totalAll',
  ];
  const scalarCount = scalarFields.filter((f) => (modifiers[f] as number) !== 0).length;
  const methodCount = Object.values(modifiers.methodDice ?? {}).filter((v) => (v ?? 0) !== 0).length;
  return scalarCount + methodCount;
}

// "HP 7 (−2)" — shows a derived stat alongside its own Collapse modifier
// (if any) so the player can see at a glance why the number isn't the
// plain handbook formula. Returns just the bare value when the modifier
// is 0, so unmodified stats don't grow a redundant "(+0)".
export function formatStatWithModifier(value: number, modifier: number): string {
  if (!modifier) return String(value);
  return `${value} (${modifier > 0 ? "+" : "−"}${Math.abs(modifier)})`;
}
