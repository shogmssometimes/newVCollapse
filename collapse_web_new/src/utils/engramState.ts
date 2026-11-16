// Read/write bridge for the player's equipped Engrams (spell-slot style:
// copies owned = capacity spent & max charges; charges = current uses left
// before a Rest). Lives at the same per-slot storage key the old card-game
// deck builder used (`deckBuilderKey(slot)`), so Character Management's
// opaque export/import/delete still works unchanged.
//
// Exposed as plain functions (not a hook) so both the live Engram Manager
// page and notification-resolution code elsewhere (RestWidget, the header
// bell, Chud.tsx) can apply the same effects consistently, whether or not
// the Engram Manager page is currently mounted.

export type EquippedEngramState = { copies: number; charges: number }

export type EngramManagerState = {
  equipped: Record<string, EquippedEngramState>
}

function notify(key: string, json: string) {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: json, storageArea: window.localStorage }))
  } catch {
    // StorageEvent construction can fail outside a browser — ignore.
  }
}

export function readEngramState(storageKey: string): EngramManagerState {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return { equipped: {} }
    const parsed = JSON.parse(raw) as Partial<EngramManagerState>
    return {
      equipped: parsed.equipped ?? {},
    }
  } catch {
    return { equipped: {} }
  }
}

function writeEngramState(storageKey: string, next: EngramManagerState): void {
  try {
    const json = JSON.stringify(next)
    window.localStorage.setItem(storageKey, json)
    notify(storageKey, json)
  } catch {
    // storage unavailable — ignore
  }
}

/** Sets how many copies of an Engram are equipped, clamping charges to the
 * new copies count (copies are the max-charges pool). */
export function setEngramCopies(storageKey: string, engramId: string, copies: number): void {
  const state = readEngramState(storageKey)
  const safeCopies = Math.max(0, Math.round(copies))
  const equipped = { ...state.equipped }
  if (safeCopies <= 0) {
    delete equipped[engramId]
  } else {
    const prevCharges = equipped[engramId]?.charges ?? safeCopies
    equipped[engramId] = { copies: safeCopies, charges: Math.min(prevCharges, safeCopies) }
  }
  writeEngramState(storageKey, { ...state, equipped })
}

/** Spends `amount` charges from one Engram (floor at 0). */
export function spendEngramCharges(storageKey: string, engramId: string, amount: number): void {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current) return
  const equipped = {
    ...state.equipped,
    [engramId]: { ...current, charges: Math.max(0, current.charges - Math.max(0, amount)) },
  }
  writeEngramState(storageKey, { ...state, equipped })
}

/** Spends every currently-charged use of one equipped Engram at once — the
 * Method roll popup's Engram icon taps all of an Engram's charged stacks
 * in a single gesture rather than one at a time. Returns how many charges
 * were spent (0 if the Engram isn't equipped or already empty), so the
 * caller knows how many bonus d4s to roll. */
export function spendAllEngramCharges(storageKey: string, engramId: string): number {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current || current.charges <= 0) return 0
  const amount = current.charges
  writeEngramState(storageKey, {
    ...state,
    equipped: { ...state.equipped, [engramId]: { ...current, charges: 0 } },
  })
  return amount
}

/** Full Rest: every equipped Engram's charges refill to its copies count. */
export function fullRestEngrams(storageKey: string): void {
  const state = readEngramState(storageKey)
  const equipped = Object.fromEntries(
    Object.entries(state.equipped).map(([id, e]) => [id, { ...e, charges: e.copies }])
  )
  writeEngramState(storageKey, { equipped })
}
