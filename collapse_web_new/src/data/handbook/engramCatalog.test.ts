import { describe, expect, it } from "vitest"
import { engramCatalog } from "./engramCatalog"

describe("Engram catalog (handbook Phase 8_Engrams)", () => {
  it("has the current 38-Engram list (Blood Rage and Hack removed)", () => {
    expect(engramCatalog.length).toBe(38)
  })

  it("has unique ids", () => {
    const ids = engramCatalog.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every Engram has a name and a positive LVL cost", () => {
    for (const entry of engramCatalog) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.level).toBeGreaterThan(0)
    }
  })

  it("includes known handbook Engrams with the right LVL cost", () => {
    const byName = Object.fromEntries(engramCatalog.map((e) => [e.name, e]))
    expect(byName["Wing-It"].level).toBe(1)
    expect(byName["Guardian Angel"].level).toBe(2)
    expect(byName["Usurp"].level).toBe(3)
    expect(byName["Desync"].level).toBe(3)
    expect(byName["Reviver"].level).toBe(1)
  })
})
