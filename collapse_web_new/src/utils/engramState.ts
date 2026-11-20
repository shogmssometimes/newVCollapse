// Read/write bridge for the player's equipped Engrams (spell-slot style:
// copies owned = capacity spent & max charges; charges = currently loaded
// stacks, built up by tapping; usesLeft = how many times this Engram can
// still be charged-and-activated before a Rest, independent of how much is
// currently loaded). Lives at the same per-slot storage key the old
// card-game deck builder used (`deckBuilderKey(slot)`), so Character
// Management's opaque export/import/delete still works unchanged.
//
// Exposed as plain functions (not a hook) so both the live Engram Manager
// page and notification-resolution code elsewhere (RestWidget, the header
// bell, Chud.tsx) can apply the same effects consistently, whether or not
// the Engram Manager page is currently mounted.
//
// `charges` vs. `usesLeft` — why they're separate: a tap "loads" one more
// stack (0...usesLeft) for a long-press to activate later; activating
// (spendAllEngramCharges) permanently consumes that many uses from
// `usesLeft`, not just resetting `charges` to 0. Before this split, a tap
// after activating could reload `charges` right back up to `copies`
// (copies was the only cap taps respected), making an Engram "recharge for
// free" the instant you tapped it again post-activation — only
// `fullRestEngrams` is allowed to restore spent `usesLeft`.

export type EquippedEngramState = { copies: number; charges: number; usesLeft: number }

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

// Back-fills `usesLeft` for Engram state written before this field
// existed — treats it as fully available (same as a Full Rest), since an
// unset value should never retroactively lock an Engram the player could
// already freely tap before.
function withUsesLeft(e: { copies: number; charges: number; usesLeft?: number }): EquippedEngramState {
  return { copies: e.copies, charges: e.charges, usesLeft: e.usesLeft ?? e.copies }
}

export function readEngramState(storageKey: string): EngramManagerState {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return { equipped: {} }
    const parsed = JSON.parse(raw) as Partial<EngramManagerState>
    const equipped = parsed.equipped ?? {}
    return {
      equipped: Object.fromEntries(Object.entries(equipped).map(([id, e]) => [id, withUsesLeft(e)])),
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

/** Sets how many copies of an Engram are equipped, clamping charges and
 * usesLeft to the new copies count (copies are the max pool for both). */
export function setEngramCopies(storageKey: string, engramId: string, copies: number): void {
  const state = readEngramState(storageKey)
  const safeCopies = Math.max(0, Math.round(copies))
  const equipped = { ...state.equipped }
  if (safeCopies <= 0) {
    delete equipped[engramId]
  } else {
    // A brand-new equip starts uncharged (0) but with full uses available
    // — charges are only ever built up afterward via the Engram Q's
    // tap-to-charge gesture, never granted for free just by equipping.
    const prev = equipped[engramId]
    const prevCharges = prev?.charges ?? 0
    const prevUsesLeft = prev?.usesLeft ?? safeCopies
    equipped[engramId] = {
      copies: safeCopies,
      charges: Math.min(prevCharges, safeCopies),
      usesLeft: Math.min(prevUsesLeft, safeCopies),
    }
  }
  writeEngramState(storageKey, { ...state, equipped })
}

/** Spends `amount` charges from one Engram (floor at 0) — also permanently
 * consumes that many uses, same as spendAllEngramCharges. */
export function spendEngramCharges(storageKey: string, engramId: string, amount: number): void {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current) return
  const safeAmount = Math.max(0, amount)
  const equipped = {
    ...state.equipped,
    [engramId]: {
      ...current,
      charges: Math.max(0, current.charges - safeAmount),
      usesLeft: Math.max(0, current.usesLeft - safeAmount),
    },
  }
  writeEngramState(storageKey, { ...state, equipped })
}

/** Adds `amount` charges (and the uses they consumed) back to one Engram —
 * used to refund a Stack that was swapped out of the roller before being
 * Confirmed/sent to Margin, since that Stack was never actually used.
 * Clamped to the Engram's copies count (its max pool for both fields). */
export function refundEngramCharges(storageKey: string, engramId: string, amount: number): void {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current || amount <= 0) return
  const equipped = {
    ...state.equipped,
    [engramId]: {
      ...current,
      charges: Math.min(current.copies, current.charges + amount),
      usesLeft: Math.min(current.copies, current.usesLeft + amount),
    },
  }
  writeEngramState(storageKey, { ...state, equipped })
}

/** The Engram Q widget's tap gesture: charges/preps one more stack (+1),
 * wrapping back down to 0 once at `usesLeft` (NOT `copies` — once a use is
 * permanently spent this Rest, tapping can no longer load it back up, even
 * though `copies` — the Engram's total capacity — hasn't changed). This is
 * the "charging up" half of prepped → charged → spent; uses are only ever
 * spent via a long-press (spendAllEngramCharges) or restored by a Full
 * Rest, never lost (or gained) by a tap alone. */
export function addEngramCharge(storageKey: string, engramId: string): void {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current) return
  const cap = Math.min(current.copies, current.usesLeft)
  const next = cap <= 0 ? 0 : current.charges >= cap ? 0 : current.charges + 1
  const equipped = { ...state.equipped, [engramId]: { ...current, charges: next } }
  writeEngramState(storageKey, { ...state, equipped })
}

/** Spends every currently-charged use of one equipped Engram at once — the
 * Method roll popup's Engram icon taps all of an Engram's charged stacks
 * in a single gesture rather than one at a time. Permanently consumes that
 * many of `usesLeft` (only a Full Rest gives them back) in addition to
 * resetting `charges` to 0. Returns how many charges were spent (0 if the
 * Engram isn't equipped or already empty), so the caller knows how many
 * bonus d4s to roll. */
export function spendAllEngramCharges(storageKey: string, engramId: string): number {
  const state = readEngramState(storageKey)
  const current = state.equipped[engramId]
  if (!current || current.charges <= 0) return 0
  const amount = current.charges
  writeEngramState(storageKey, {
    ...state,
    equipped: {
      ...state.equipped,
      [engramId]: { ...current, charges: 0, usesLeft: Math.max(0, current.usesLeft - amount) },
    },
  })
  return amount
}

/** Full Rest: every equipped Engram's charges AND usesLeft refill to its
 * copies count — the only thing that restores spent uses. */
export function fullRestEngrams(storageKey: string): void {
  const state = readEngramState(storageKey)
  const equipped = Object.fromEntries(
    Object.entries(state.equipped).map(([id, e]) => [id, { ...e, charges: e.copies, usesLeft: e.copies }])
  )
  writeEngramState(storageKey, { equipped })
}
