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
//
// `usesLeft` itself is derived, not stored directly: `spent` (a persisted
// running total, only ever zeroed by fullRestEngrams) tracks how many uses
// have actually been activated since the last Rest, and
// `usesLeft = max(0, copies - spent)`. Deriving it this way — instead of
// nudging a stored `usesLeft` up/down whenever `copies` changes — is what
// makes setEngramCopies safe to call repeatedly: re-equipping a copy that
// was removed earlier this Rest doesn't hand back a use that's still
// genuinely spent (copies going 2 -> 1 -> 2 with `spent` unchanged at 2
// still nets usesLeft 0), while genuinely owning more copies than ever
// before this Rest still grants fresh uses for them (copies going 1 -> 2
// with 1 already spent nets usesLeft 1, since the pool grew to 2 but only
// 1 use has ever been spent against it).

export type EquippedEngramState = { copies: number; charges: number; usesLeft: number }

export type EngramManagerState = {
  equipped: Record<string, EquippedEngramState>
}

// On-disk shape: `spent` is the new persisted field; `usesLeft` is kept
// optional purely so old saves (written before this field existed) can be
// migrated on first read.
type StoredEngramState = { copies: number; charges: number; spent?: number; usesLeft?: number }
type StoredEngramManagerState = { equipped: Record<string, StoredEngramState> }

function notify(key: string, json: string) {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: json, storageArea: window.localStorage }))
  } catch {
    // StorageEvent construction can fail outside a browser — ignore.
  }
}

// Migrates a stored record to a known `spent` value — back-fills it from
// the old `usesLeft` field (copies - usesLeft) when absent, and treats a
// record with neither as fully available (same as a Full Rest), since an
// unset value should never retroactively lock an Engram the player could
// already freely tap before.
function withSpent(e: StoredEngramState): { copies: number; charges: number; spent: number } {
  const spent = e.spent ?? Math.max(0, e.copies - (e.usesLeft ?? e.copies))
  return { copies: e.copies, charges: e.charges, spent }
}

function toPublic(e: StoredEngramState): EquippedEngramState {
  const { copies, charges, spent } = withSpent(e)
  return { copies, charges, usesLeft: Math.max(0, copies - spent) }
}

function readRawState(storageKey: string): StoredEngramManagerState {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return { equipped: {} }
    const parsed = JSON.parse(raw) as Partial<StoredEngramManagerState>
    return { equipped: parsed.equipped ?? {} }
  } catch {
    return { equipped: {} }
  }
}

export function readEngramState(storageKey: string): EngramManagerState {
  const raw = readRawState(storageKey)
  return {
    equipped: Object.fromEntries(Object.entries(raw.equipped).map(([id, e]) => [id, toPublic(e)])),
  }
}

function writeRawState(storageKey: string, next: StoredEngramManagerState): void {
  try {
    const json = JSON.stringify(next)
    window.localStorage.setItem(storageKey, json)
    notify(storageKey, json)
  } catch {
    // storage unavailable — ignore
  }
}

/** Sets how many copies of an Engram are equipped. `spent` (how many uses
 * have been activated since the last Rest) is untouched by this — it's
 * what makes removing then re-adding a copy mid-Rest NOT refill a use that
 * was already genuinely spent (see the module doc comment above). Charges
 * are clamped down if they'd otherwise exceed the new, smaller pool. */
export function setEngramCopies(storageKey: string, engramId: string, copies: number): void {
  const state = readRawState(storageKey)
  const safeCopies = Math.max(0, Math.round(copies))
  const equipped = { ...state.equipped }
  if (safeCopies <= 0) {
    // Still tracked at copies: 0 (not deleted) so `spent` survives a
    // temporary full unequip — re-equipping later in the same Rest must
    // not hand back uses already spent against the copy being removed.
    const prev = withSpent(equipped[engramId] ?? { copies: 0, charges: 0 })
    equipped[engramId] = { copies: 0, charges: 0, spent: prev.spent }
  } else {
    const prev = withSpent(equipped[engramId] ?? { copies: safeCopies, charges: 0, spent: 0 })
    equipped[engramId] = {
      copies: safeCopies,
      charges: Math.min(prev.charges, safeCopies),
      spent: prev.spent,
    }
  }
  writeRawState(storageKey, { ...state, equipped })
}

/** Spends `amount` charges from one Engram (floor at 0) — also permanently
 * consumes that many uses, same as spendAllEngramCharges. */
export function spendEngramCharges(storageKey: string, engramId: string, amount: number): void {
  const state = readRawState(storageKey)
  const raw = state.equipped[engramId]
  if (!raw) return
  const current = withSpent(raw)
  const safeAmount = Math.max(0, amount)
  const equipped = {
    ...state.equipped,
    [engramId]: {
      ...current,
      charges: Math.max(0, current.charges - safeAmount),
      spent: current.spent + safeAmount,
    },
  }
  writeRawState(storageKey, { ...state, equipped })
}

/** Adds `amount` charges (and the uses they consumed) back to one Engram —
 * used to refund a Stack that was swapped out of the roller before being
 * Confirmed/sent to Margin, since that Stack was never actually used.
 * Charges are clamped to the Engram's copies count; `spent` floors at 0. */
export function refundEngramCharges(storageKey: string, engramId: string, amount: number): void {
  const state = readRawState(storageKey)
  const raw = state.equipped[engramId]
  if (!raw || amount <= 0) return
  const current = withSpent(raw)
  const equipped = {
    ...state.equipped,
    [engramId]: {
      ...current,
      charges: Math.min(current.copies, current.charges + amount),
      spent: Math.max(0, current.spent - amount),
    },
  }
  writeRawState(storageKey, { ...state, equipped })
}

/** The Engram Q widget's tap gesture: charges/preps one more stack (+1),
 * wrapping back down to 0 once at `usesLeft` (NOT `copies` — once a use is
 * permanently spent this Rest, tapping can no longer load it back up, even
 * though `copies` — the Engram's total capacity — hasn't changed). This is
 * the "charging up" half of prepped → charged → spent; uses are only ever
 * spent via a long-press (spendAllEngramCharges) or restored by a Full
 * Rest, never lost (or gained) by a tap alone. */
export function addEngramCharge(storageKey: string, engramId: string): void {
  const state = readRawState(storageKey)
  const raw = state.equipped[engramId]
  if (!raw) return
  const current = withSpent(raw)
  const usesLeft = Math.max(0, current.copies - current.spent)
  const cap = Math.min(current.copies, usesLeft)
  const next = cap <= 0 ? 0 : current.charges >= cap ? 0 : current.charges + 1
  const equipped = { ...state.equipped, [engramId]: { ...current, charges: next } }
  writeRawState(storageKey, { ...state, equipped })
}

/** Spends every currently-charged use of one equipped Engram at once — the
 * Method roll popup's Engram icon taps all of an Engram's charged stacks
 * in a single gesture rather than one at a time. Permanently consumes that
 * many of `usesLeft` (only a Full Rest gives them back) in addition to
 * resetting `charges` to 0. Returns how many charges were spent (0 if the
 * Engram isn't equipped or already empty), so the caller knows how many
 * bonus d4s to roll. */
export function spendAllEngramCharges(storageKey: string, engramId: string): number {
  const state = readRawState(storageKey)
  const raw = state.equipped[engramId]
  if (!raw) return 0
  const current = withSpent(raw)
  if (current.charges <= 0) return 0
  const amount = current.charges
  writeRawState(storageKey, {
    ...state,
    equipped: {
      ...state.equipped,
      [engramId]: { ...current, charges: 0, spent: current.spent + amount },
    },
  })
  return amount
}

/** Full Rest: every equipped Engram's usesLeft refills to its copies count
 * — the only thing that restores spent uses. Charges reset to 0 (not
 * preloaded to copies) — Full Rest hands uses back, it doesn't load the Q
 * for the player; which Engrams get tapped up again is still their choice. */
export function fullRestEngrams(storageKey: string): void {
  const state = readRawState(storageKey)
  const equipped = Object.fromEntries(
    Object.entries(state.equipped).map(([id, e]) => [id, { copies: e.copies, charges: 0, spent: 0 }])
  )
  writeRawState(storageKey, { equipped })
}
