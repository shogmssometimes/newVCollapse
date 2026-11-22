import { describe, expect, it } from "vitest"
import {
  availableApproachDice,
  computeFumbleWounds,
  DEFAULT_DIE_SIZE,
  DIE_LADDER,
  fullRestOverload,
  isDieSides,
  rollApproachDice,
  rollFlatDice,
  spendOverloadDie,
  stepDown,
  stepUp,
  useSkillReroll,
} from "./approachDice"

function sequence(...values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index]
    index += 1
    if (value === undefined) throw new Error("Random sequence exhausted.")
    return value
  }
}

describe("Approach dice", () => {
  it("defaults to D8 and steps through the shared die-size ladder", () => {
    expect(DEFAULT_DIE_SIZE).toBe(8)
    expect(DIE_LADDER.map(stepUp)).toEqual([6, 8, 10, 12, 20, 20])
    expect(DIE_LADDER.map(stepDown)).toEqual([4, 4, 6, 8, 10, 12])
  })

  it("computes Fumble Wounds per the handbook's 'past the Fumble Number' table", () => {
    // A hit or tie never Fumbles, regardless of Fumble Number.
    expect(computeFumbleWounds(0, 0)).toBe(0)
    expect(computeFumbleWounds(5, 3)).toBe(0)
    // A miss smaller than the Fumble Number is just a miss, not a Fumble.
    expect(computeFumbleWounds(-2, 3)).toBe(0)
    // miss === fumbleNumber (0 past) -> 1 Wound.
    expect(computeFumbleWounds(-3, 3)).toBe(1)
    // miss 5, Fumble Number 3 -> 2 past -> 1 Wound.
    expect(computeFumbleWounds(-5, 3)).toBe(1)
    // miss 6, Fumble Number 3 -> 3 past -> 2 Wounds.
    expect(computeFumbleWounds(-6, 3)).toBe(2)
  })

  it("recognizes valid persisted die sizes", () => {
    expect(isDieSides(8)).toBe(true)
    expect(isDieSides(7)).toBe(false)
    expect(isDieSides("8")).toBe(false)
  })

  it("rolls a number of d10s equal to the Approach rating and Total is the highest die", () => {
    const result = rollApproachDice(3, sequence(0, 0.25, 0.5))

    expect(result.dice.map((die) => die.rolls)).toEqual([[1], [3], [6]])
    expect(result.total).toBe(6)
  })

  it("never explodes, even on a maximum roll", () => {
    const result = rollApproachDice(2, sequence(0.999, 0.5))

    expect(result.dice.map((die) => die.rolls)).toEqual([[10], [6]])
    expect(result.total).toBe(10)
  })

  it("allows an Approach rating of zero and rejects invalid counts", () => {
    expect(rollApproachDice(0, sequence()).total).toBe(0)
    expect(() => rollApproachDice(-1)).toThrow(/non-negative integer/)
    expect(() => rollApproachDice(1.5)).toThrow(/non-negative integer/)
  })

  it("rejects invalid random samples instead of returning invalid rolls", () => {
    expect(() => rollApproachDice(1, () => 1)).toThrow(/Random source/)
  })

  it("tracks an Overload dice pool that depletes down to zero and clamps", () => {
    let spent = 0
    expect(availableApproachDice(3, spent)).toBe(3)
    spent = spendOverloadDie(3, spent)
    spent = spendOverloadDie(3, spent)
    expect(spent).toBe(2)
    expect(availableApproachDice(3, spent)).toBe(1)
    spent = spendOverloadDie(3, spent)
    spent = spendOverloadDie(3, spent) // pool already empty, no further change
    expect(spent).toBe(3)
    expect(availableApproachDice(3, spent)).toBe(0)
  })

  it("restores the Overload pool on a Full Rest", () => {
    expect(fullRestOverload()).toBe(0)
  })

  it("rejects an invalid Approach rating when checking the Overload pool", () => {
    expect(() => availableApproachDice(-1, 0)).toThrow(/non-negative integer/)
  })

  it("rolls flat, non-exploding dice for Damage/Severity rolls", () => {
    const result = rollFlatDice(3, 6, sequence(0.999, 0.5, 0))
    expect(result).toEqual([6, 4, 1])
  })

  it("allows a flat roll of zero dice and rejects invalid counts", () => {
    expect(rollFlatDice(0, 8, sequence())).toEqual([])
    expect(() => rollFlatDice(-1, 8)).toThrow(/non-negative integer/)
  })

  it("Use Skill rerolls the lowest not-yet-rerolled die and keeps the higher value", () => {
    const dice = [{ rolls: [7], total: 7 }, { rolls: [2], total: 2 }, { rolls: [5], total: 5 }]
    // Rerolls index 1 (lowest, value 2) — rolls a 9, which beats the old 2.
    const result = useSkillReroll(dice, new Set(), sequence(0.89))
    expect(result).not.toBeNull()
    expect(result!.index).toBe(1)
    expect(result!.dice[1]).toEqual({ rolls: [9], total: 9 })
    expect(result!.dice[0]).toEqual(dice[0]) // other dice untouched
  })

  it("Use Skill keeps the old value when the reroll is lower", () => {
    const dice = [{ rolls: [2], total: 2 }]
    // Rolls a 1, which is worse than the old 2 — keeps the 2.
    const result = useSkillReroll(dice, new Set(), sequence(0))
    expect(result!.dice[0]).toEqual({ rolls: [2], total: 2 })
  })

  it("Use Skill skips already-rerolled dice and returns null once every die has been used", () => {
    const dice = [{ rolls: [2], total: 2 }, { rolls: [8], total: 8 }]
    expect(useSkillReroll(dice, new Set([0, 1]), sequence())).toBeNull()
    const result = useSkillReroll(dice, new Set([0]), sequence(0.5))
    expect(result!.index).toBe(1) // index 0 already used, so the only reroll candidate is index 1
  })
})
