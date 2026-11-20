import { describe, expect, it } from "vitest"
import {
  computeDerived,
  computeFumbleNumber,
  computeGanbareCharges,
  computeInventorySlots,
  computeMethodRating,
  computeSkillCount,
  computeWtBase,
  DEFAULT_COLLAPSE_MODIFIERS,
} from "./chudStats"

// Handbook's Phase 6 worked example (YOU/Vie): Vigor 4, Inference 3,
// Personality 2 → HP 13, Capacity 9, Readiness 6, Slots 4, Skills 3,
// Ganbare Charges 2, Fumble Number 9.
const EXAMPLE_CORE = { vigor: 4, inference: 3, personality: 2 }

describe("Derived Vitals", () => {
  it("computes HP (Max) = 6 + Vigor + Inference", () => {
    expect(computeDerived(EXAMPLE_CORE).hp).toBe(13)
    expect(computeDerived({ vigor: 0, inference: 0, personality: 0 }).hp).toBe(6)
  })

  it("computes Capacity = 4 + Inference + Personality", () => {
    expect(computeDerived(EXAMPLE_CORE).capacity).toBe(9)
    expect(computeDerived({ vigor: 0, inference: 0, personality: 0 }).capacity).toBe(4)
  })

  it("computes Readiness (RDY) = Vigor + Personality", () => {
    expect(computeDerived(EXAMPLE_CORE).readyness).toBe(6)
    expect(computeDerived({ vigor: 0, inference: 0, personality: 0 }).readyness).toBe(0)
  })

  it("computes Inventory Slots = Vigor", () => {
    expect(computeInventorySlots(EXAMPLE_CORE)).toBe(4)
  })

  it("computes Skills = Inference", () => {
    expect(computeSkillCount(EXAMPLE_CORE)).toBe(3)
  })

  it("computes Ganbare Charges = Personality", () => {
    expect(computeGanbareCharges(EXAMPLE_CORE)).toBe(2)
  })

  it("computes Fumble Number = V+I+P", () => {
    expect(computeFumbleNumber(EXAMPLE_CORE)).toBe(9)
  })
})

describe("Collapse Modifiers", () => {
  const ZERO_CORE = { vigor: 0, inference: 0, personality: 0 }

  it("applies a Collapse modifier on top of the handbook formula", () => {
    const mods = { ...DEFAULT_COLLAPSE_MODIFIERS, maxHp: -2, readiness: 3, capacity: 1 }
    const derived = computeDerived(EXAMPLE_CORE, mods)
    expect(derived.hp).toBe(11) // 13 - 2
    expect(derived.readyness).toBe(9) // 6 + 3
    expect(derived.capacity).toBe(10) // 9 + 1
  })

  it("floors Max HP at 1, never 0 or negative", () => {
    const mods = { ...DEFAULT_COLLAPSE_MODIFIERS, maxHp: -99 }
    expect(computeDerived(ZERO_CORE, mods).hp).toBe(1)
  })

  it("floors Readiness and Capacity at 0, never negative", () => {
    const mods = { ...DEFAULT_COLLAPSE_MODIFIERS, readiness: -99, capacity: -99 }
    const derived = computeDerived(ZERO_CORE, mods)
    expect(derived.readyness).toBe(0)
    expect(derived.capacity).toBe(0)
  })

  it("floors Inventory Slots and Ganbare! Charges at 0, never negative", () => {
    const mods = { ...DEFAULT_COLLAPSE_MODIFIERS, inventorySlots: -99, ganbareCharges: -99 }
    expect(computeInventorySlots(ZERO_CORE, mods)).toBe(0)
    expect(computeGanbareCharges(ZERO_CORE, mods)).toBe(0)
  })

  it("computes WT = 3 + Collapse modifier, floored at 1", () => {
    expect(computeWtBase(DEFAULT_COLLAPSE_MODIFIERS)).toBe(3)
    expect(computeWtBase({ ...DEFAULT_COLLAPSE_MODIFIERS, wt: 2 })).toBe(5)
    expect(computeWtBase({ ...DEFAULT_COLLAPSE_MODIFIERS, wt: -99 })).toBe(1)
  })

  it("computes a Method's dice rating with its Collapse modifier, floored at 0", () => {
    const mods = { ...DEFAULT_COLLAPSE_MODIFIERS, methodDice: { force: 2, finesse: -99 } }
    expect(computeMethodRating(3, "force", mods)).toBe(5)
    expect(computeMethodRating(3, "finesse", mods)).toBe(0)
    expect(computeMethodRating(3, "guts", mods)).toBe(3)
  })
})
