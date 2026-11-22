import type { ApproachRollResult } from "../domain/approachDice"

// An unresolved Method roll (dice shown, any pending Overload, any
// activated Engram Stack) used to live only in ApproachDie's own React
// state — fine for an in-page unmount, but the HUD lives in an <iframe>
// whose whole document (and JS realm) is torn down and recreated on route
// change, not just that one component. By the time any unmount cleanup
// *could* run, the navigation may already have discarded the frame, so
// the pending Overload/Engram Stack were silently lost (never spent,
// never refunded) and the next roll came up fresh — a free reroll. This
// mirrors the unresolved roll out to localStorage on every change
// instead, scoped per-Method (by its display label, unique and stable)
// and per character slot, and restores it on mount.
//
// Split out of ApproachDie.tsx so other pages (slot delete/import in
// CharMgmt.tsx) can discard stale persisted rolls without importing the
// whole Method-roll-popup component tree.

export type PersistedRoll = {
  result: ApproachRollResult
  pendingOverload: number[]
  engramStack: { id: string; name: string; rolls: number[] } | null
}

/** Fired on `window` whenever persisted rolls for a slot are discarded, so
 * any ApproachDie instance already mounted for that slot (the HUD doesn't
 * unmount for Full Rest, unlike a route change) drops its in-memory copy
 * too, not just the localStorage one a future reload would otherwise
 * still see. */
export const ROLLS_CLEARED_EVENT = "chud:rolls-cleared"

export function currentChudSlot(): number {
  try {
    const n = parseInt(new URLSearchParams(window.location.search).get("slot") ?? "1", 10)
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch {
    return 1
  }
}

export function rollPersistKey(label: string, slot?: number): string {
  return `chud.approachRoll.v1.slot${slot ?? currentChudSlot()}.${label}`
}

export function loadPersistedRoll(label: string): PersistedRoll | null {
  try {
    const raw = window.localStorage.getItem(rollPersistKey(label))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedRoll> | null
    if (!parsed || typeof parsed !== "object" || !parsed.result) return null
    return {
      result: parsed.result,
      pendingOverload: Array.isArray(parsed.pendingOverload) ? parsed.pendingOverload : [],
      engramStack: parsed.engramStack ?? null,
    }
  } catch {
    return null
  }
}

export function savePersistedRoll(label: string, data: PersistedRoll | null): void {
  try {
    const key = rollPersistKey(label)
    if (!data || !data.result) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // storage unavailable — ignore
  }
}

/** Discards every Method's persisted unresolved roll for a slot — used
 * wherever the dice pools/stats behind those rolls can change out from
 * under them without the owning ApproachDie remounting to re-check
 * staleness itself: Full Rest (Overload resets, so a reopened roll's
 * pending Overload would no longer make sense), slot delete, slot import,
 * and new character creation. Persisted rolls are keyed per-Method-label,
 * so this scans by key prefix instead of needing a list of every Method's
 * label. */
export function clearAllPersistedRolls(slot?: number): void {
  const targetSlot = slot ?? currentChudSlot()
  try {
    const prefix = `chud.approachRoll.v1.slot${targetSlot}.`
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(prefix)) keys.push(key)
    }
    keys.forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // storage unavailable — ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(ROLLS_CLEARED_EVENT, { detail: { slot: targetSlot } }))
  } catch {
    // CustomEvent unavailable (non-browser test env) — localStorage above
    // is still cleared, which is all a reload needs.
  }
}
