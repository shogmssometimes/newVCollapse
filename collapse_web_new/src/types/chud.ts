// Shared cHUD (character HUD) domain types.

export interface CoreStats {
  vigor: number;
  inference: number;
  personality: number;
}

export interface ApproachStats {
  force: number;
  finesse: number;
  guts: number;
  logic: number;
  show: number;
  tell: number;
}

export interface SecondaryStats {
  vigor: number;
  inference: number;
  personality: number;
}

export type CollapsePath = "live" | "survive" | "die";

// Permanent player-set ± values from Collapse Table results — one place to
// record every lasting Collapse outcome instead of hand-adjusting a stat
// and forgetting why. Every derived stat is "handbook formula + this
// modifier" (see domain/chudStats.ts), then floored per the handbook's own
// rules (Max HP/WT never below 1; everything else never below 0).
export interface CollapseModifiers {
  maxHp: number;
  readiness: number;
  inventorySlots: number;
  capacity: number;
  ganbareCharges: number;
  wt: number;
  /** Per-Method flat modifier (added to that Method's Core-distributed
   * rating before Wardrobe bonus dice, same pool). */
  methodDice: Partial<Record<keyof ApproachStats, number>>;
  /** Applied only to a Total sent to Margin (Attack or Defense) — not
   * shown until a Margin roll is actually started. */
  totalAttackDefense: number;
  /** Applied automatically to every rolled Total, shown in its breakdown. */
  totalAll: number;
}

// A named Collapse Table result with no number to adjust (e.g. "lose an
// eye") — just a free-text note the player can add/remove.
export interface CollapseResultEntry {
  id: string;
  name: string;
  text: string;
}

// A known Skill (handbook v12 p20: Skills known = Inference). Reference
// only — the list never gates anything except adding past the Inference
// limit; the "Use Skill" button in a Method roll popup works regardless of
// what's listed here.
export interface SkillEntry {
  id: string;
  name: string;
  note: string;
}

export interface SaveState {
  core: CoreStats;
  hpCounter: number;
  approach: ApproachStats;
  damageDieSize?: import('../domain/approachDice').DieSides;
  approachOverloadSpent?: Partial<Record<keyof ApproachStats, number>>;
  /** Overload spend tracked separately for each Method's Wardrobe bonus dice
   * — they're their own depletable pool (same Overload/rest mechanic as the
   * base pool), capped at that Method's current Wardrobe bonus instead of
   * its base rating. */
  approachWardrobeOverloadSpent?: Partial<Record<keyof ApproachStats, number>>;
  /** Timestamp (ms) when the Ganbare! "glass cover" was last shattered (8
   * taps) — the control stays visibly broken and disabled until the
   * cooldown elapses, then the glass restores itself. */
  ganbareGlassBrokenAt?: number | null;
  wt: number;
  /** Derived as Vigor — persisted as an echo for pages that read it (Gear,
   * GearPanel, HPPanel), never set directly. */
  inventorySlots: number;
  secondary?: SecondaryStats;
  shortRest?: boolean;
  /** Whether this character has ever been downed (HP hit 0) before — gates
   * the one-time "Choose Your Path" (Live/Survive/Die) notification. */
  hasBeenDownedBefore?: boolean;
  /** The table the player chose to roll on each time they're downed, set by
   * the one-time "Choose Your Path" notification. */
  collapsePath?: CollapsePath;
  /** Ganbare! Charges spent (max = Personality, see computeGanbareCharges).
   * Restored to 0 by a Full Rest. Charges do not use Capacity. */
  ganbareSpent?: number;
  /** Permanent Collapse Table ± adjustments, owned/edited by the AAG page's
   * Collapse Modifiers section. Missing/partial fields default to 0 (see
   * withCollapseModifiers in domain/chudStats.ts). */
  collapseModifiers?: Partial<CollapseModifiers>;
  /** Free-text Collapse Table results with no number to change. */
  collapseResults?: CollapseResultEntry[];
  /** Known Skills (handbook v12 p20) — reference list capped at Inference,
   * owned/edited by the Modifiers page. */
  skills?: SkillEntry[];
}

export type GearSlotEntry = { name: string; units: string; qty: string };
export type GearData = { entries: GearSlotEntry[]; slotsUsed: number };

export type WardrobeEntry = { name: string; approach: string; quality: string };
