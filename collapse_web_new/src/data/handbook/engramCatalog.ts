// Engram catalog — the handbook's actual Engram table (Phase 8_Engrams),
// LVL/NAME/NOTE/EFFECT, transcribed from the v10 rulebook. Engram names,
// status effects, and costs here are the source of truth for the Engram
// Manager; they are not the old card-game "mod cards" dataset.
import rawEngrams from './raw/engrams.json'

export type EngramCatalogEntry = {
  id: string
  name: string
  /** Capacity cost per copy equipped (handbook "LVL"). */
  level: number
  /** Handbook "Effect" column. */
  effect: string
  /** Handbook "Note" column (may be empty — some Engrams apply automatically, with no roll notation). */
  note: string
  /** True for Engrams whose charges add Xd4 straight into the player's own
   * current Method roll total (tappable as a standby icon in the Method
   * roll popup). False for the handful that do something else entirely
   * (heal/target another roll/no roll at all) — those stay on the Engram
   * Q's own long-press popup instead. */
  rollsIntoMethod: boolean
}

const normalize = (value?: string) => (value ? value.trim() : '')

// These Engrams don't add their d4s to the player's own current roll total
// — they heal, target someone else's roll, remove Wounds, or have no roll
// at all. Every other Engram's charges add Xd4 straight into the Method
// roll popup's total.
const EXCLUDED_FROM_METHOD_ROLLER = new Set([
  'Weighted',
  'Heal',
  'Guardian Angel',
  'Ketchup',
  'Boon',
  'Curse',
  'Usurp',
  'Reviver',
  'Teleport',
  'Zone Heal',
])

export const engramCatalog: EngramCatalogEntry[] = rawEngrams.map((entry) => ({
  id: entry.id,
  name: entry.name,
  level: entry.level,
  effect: normalize(entry.effect),
  note: normalize(entry.note),
  rollsIntoMethod: !EXCLUDED_FROM_METHOD_ROLLER.has(entry.name),
}))

export const engramCatalogById: Record<string, EngramCatalogEntry> = Object.fromEntries(
  engramCatalog.map((entry) => [entry.id, entry])
)

export default engramCatalog
