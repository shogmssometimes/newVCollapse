import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { createPortal } from "react-dom"
import type { ApproachDieResult, ApproachRollResult, DieSides } from "../../domain/approachDice"
import { rollFlatDice, computeFumbleWounds } from "../../domain/approachDice"
import { addSetRollRow } from "../../utils/chudVanillaBridge"
import { pushNotification } from "../../domain/notifications"
import { STAT_AND_METHOD_MAX } from "../../domain/coreApproachMap"

export type ApproachDieRollResult = ApproachRollResult

const ROLL_ANIM_TICKS = 8
const ROLL_ANIM_INTERVAL_MS = 60
const ERROR_FLASH_MS = 420
const VIBRATE_PIP_MS = 14
// How long a swipe-committed die takes to fly off before its action
// (Double/Margin/Send to Set/Confirm) actually applies.
const FLING_DURATION_MS = 220
// Long-press (not a tap) to double a die — a plain tap on a die that's
// already doubled cancels it instead (see handleDieClick).
const DIE_LONG_PRESS_MS = 210
// How long the Method's name box must be held before it's "armed" and
// ready to roll. Once armed, moving the pointer past METHOD_SWIPE_PX in
// any direction marks the roll as "pending" — it only actually fires when
// the pointer is released while still past that distance; pulling back
// under the threshold before releasing cancels the pending roll instead.
// Moving that far *before* arming instead cancels the hold outright (reads
// as an accidental drag, not a deliberate press).
const METHOD_ARM_MS = 175
const METHOD_PRE_ARM_CANCEL_PX = 8
const METHOD_SWIPE_PX = 10
// Picking up a rolled die (post-result) reuses the same long-press-then-
// swipe shape as rolling itself, but with 4 directions instead of 1:
// once armed, swiping up doubles that die, down sends the Total to the
// Set list, right starts the Margin flow, and left Confirms (locks any
// pending Overload in for good — back to the plain result, no popup
// close). Closing the popup (X/outside tap) WITHOUT confirming first
// instead Cancels any pending Overload — nothing spent.
const DIE_PRE_ARM_CANCEL_PX = 8
const DIE_SWIPE_PX = 18

type PopupView = "result" | "margin-input" | "margin-result" | "damage"

const dieLabel = (die: DieSides) => `D${die}`

// Method row — printed-sheet style: the track is a fixed 1-6 numbered
// circle row (never a glowing number). A solid marker sits on the current
// (base) pool size; a faint ghost marker sits on the full (base) rating so
// a depleted pool still shows where "full" is. There's no reason to ever
// roll fewer than every die in the pool, so there's nothing left to
// "select" — rolling is a long-press-then-swipe gesture instead: holding
// the name box briefly arms it (the same gold charging glow as before),
// then any swipe in any direction while armed instantly rolls the whole
// pool (base-available + Wardrobe) and opens the result popup. Releasing
// before it's armed, or holding without swiping, does nothing — only the
// swipe fires the roll.
//
// Wardrobe dice are folded directly into the same track as a gold-tinted
// pip (same round shape, just colored, continuing the circle sequence)
// right after the Method's own circles ("Wardrobe adds dice to that
// Method's roll only") — they're always rolled alongside the base pool,
// and are Overload-spendable as their own pool (same mechanic as the base
// pool: a doubled Wardrobe die is spent, and only restores on Full Rest),
// just tracked and capped separately from the base rating.
//
// Past the roll, the popup offers Overload: long-press a die to double it
// (spending 1 from whichever pool that die came from — base or Wardrobe).
// A quick tap on an already-doubled die undoes it while it's still only
// *pending* — picking a die back up and swiping left now explicitly
// Confirms it instead (locks the double in for good, same moment it
// spends from its pool); Send to Set and a confirmed Margin also confirm
// implicitly. Closing the popup (X or tapping outside) with a double
// still only pending, never confirmed, Cancels it instead — nothing is
// spent. Engrams tapped onto the roll (see engramOptions) are different:
// they commit the instant they're tapped, with no pending/undo window at
// all — there's no way to "unroll" that decision short of the charges
// never having been spent in the first place. From there, two paths
// continue: send the Total to the HUD's Set Roll list, or turn it into a
// Margin against an Opposition roll. A positive Margin can then be spent
// on a flat (non-exploding) Wound roll — individual dice are checked against a Wound
// Threshold/Target so the player can read off how many "successes" they
// have to announce at the table. None of this adjudicates anything; it
// only surfaces the numbers.
export function ApproachDie({
  label,
  baseRating,
  wardrobeBonus = 0,
  wardrobeAvailable,
  wardrobeItems = [],
  available,
  damageDie,
  fumbleNumber = 0,
  onRoll,
  onOverload,
  engramOptions = [],
  onSpendEngram,
}: {
  label: string
  /** Core-distributed rating alone (before Wardrobe) — the track's full/ghost count and the base Overload-spendable pool size. */
  baseRating: number
  /** Total extra dice granted by Wardrobe items assigned to this Method — the track's Wardrobe slot count (always rolled, regardless of how many are currently spent). */
  wardrobeBonus?: number
  /** Wardrobe dice currently available (wardrobeBonus minus any Overloaded-and-spent Wardrobe dice) — its own pool, same Overload/rest mechanic as the base pool. Defaults to wardrobeBonus (nothing spent) if omitted. */
  wardrobeAvailable?: number
  /** Wardrobe item names/bonuses contributing to wardrobeBonus, for a tooltip. */
  wardrobeItems?: string[]
  /** Base-pool dice currently available (baseRating minus any Overloaded-and-spent dice). */
  available: number
  /** Weapon Quality die size, used for the post-Margin Wound roll. */
  damageDie: DieSides
  /** Fumble Number (V+I+P) — a Margin confirmed as an Attack Fumbles when the opposition beats it by this much or more. 0 (default) means Fumble never triggers. */
  fumbleNumber?: number
  onRoll: (count: number) => ApproachDieRollResult
  /** Spends `baseCount` dice from the base pool and `wardrobeCount` from the Wardrobe pool at once (one per doubled die, resolved together). Returns false if either pool couldn't cover its full count. */
  onOverload?: (baseCount: number, wardrobeCount: number) => boolean
  /** Qualifying equipped Engrams with charges > 0 — shown as tappable standby icons in the roll popup (same list shared by every Method). */
  engramOptions?: Array<{ id: string; name: string; charges: number }>
  /** Tapping an Engram icon spends ALL of its current charges at once, immediately and for good (no undo); returns how many were spent so this many d4s can be rolled and added to the Total. */
  onSpendEngram?: (engramId: string) => number
}) {
  const wardrobeAvail = wardrobeAvailable ?? wardrobeBonus
  const [errorFlash, setErrorFlash] = useState(false)
  const [result, setResult] = useState<ApproachDieRollResult | null>(null)
  const [pendingOverload, setPendingOverload] = useState<Set<number>>(new Set())
  const [resolved, setResolved] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [armed, setArmed] = useState(false)
  const [chargeProgress, setChargeProgress] = useState(0) // 0-100, grows from the instant of press, independent of `armed`
  // True once armed AND the pointer has moved past METHOD_SWIPE_PX — the
  // roll doesn't fire yet, this only drives the "ready to release" visual;
  // pulling back under the threshold before releasing clears it again with
  // no action taken, and only releasing while it's true actually rolls.
  const [pendingRoll, setPendingRoll] = useState(false)
  const [rollingPreview, setRollingPreview] = useState<number[]>([])
  const [pressingDieIndex, setPressingDieIndex] = useState<number | null>(null)
  const [armedDieIndex, setArmedDieIndex] = useState<number | null>(null)
  const [marginBase, setMarginBase] = useState<number | null>(null)
  const [view, setView] = useState<PopupView>("result")
  const [oppositionInput, setOppositionInput] = useState("")
  // Fumble (handbook): only an Attack roll can Fumble, never a Save — this
  // toggle lets the player flag the current Margin as a Save before
  // confirming it, so the Fumble check below can skip it even when the
  // Defense Total beats the Attack Total by the Fumble Number or more.
  const [isSaveRoll, setIsSaveRoll] = useState(false)
  const [margin, setMargin] = useState<number | null>(null)
  const [damageDice, setDamageDice] = useState<number[]>([])
  const [woundValue, setWoundValue] = useState("")
  const [woundMode, setWoundMode] = useState<"threshold" | "target">("threshold")
  // Engram bonus dice standby'd onto this roll — tapping an Engram icon
  // spends ALL of its current charges at once and rolls that many d4s,
  // grouped here and summed into the Total alongside the Method dice.
  // Charges are spent immediately and permanently — unlike Overload below,
  // there's no pending/undo window at all for an Engram once it's tapped;
  // closing the popup can never claw it back.
  const [engramBonus, setEngramBonus] = useState<Array<{ id: string; name: string; rolls: number[] }>>([])
  // Swipe-commit "fling" — the picked-up die flies off in the swipe
  // direction instead of the action applying (and the chip
  // disappearing/resetting) instantly, so the gesture reads as a deliberate
  // throw rather than a snap. The actual action is deferred until the fling
  // finishes playing.
  const [dieFling, setDieFling] = useState<{ index: number; dir: "up" | "down" | "left" | "right" } | null>(null)
  const flingTimer = useRef<number | null>(null)
  const rollAnimTimer = useRef<number | null>(null)
  const errorFlashTimer = useRef<number | null>(null)
  const armTimer = useRef<number | null>(null)
  const chargeInterval = useRef<number | null>(null)
  const armedRef = useRef(false)
  const pendingRollRef = useRef(false)
  const gestureStart = useRef<{ x: number; y: number } | null>(null)
  const rolledThisGesture = useRef(false)
  const resolvedRef = useRef(false)
  const diePressTimer = useRef<number | null>(null)
  const dieSuppressClick = useRef(false)
  const dieGestureStart = useRef<{ x: number; y: number } | null>(null)
  const dieSwipedThisGesture = useRef(false)
  const dieSwipeDirRef = useRef<"up" | "down" | "left" | "right" | null>(null)
  const [dieSwipeDir, setDieSwipeDir] = useState<"up" | "down" | "left" | "right" | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Spends the pending Overloads from their own pools — dice at indices
  // [0, available) came from the base pool, [available, available +
  // wardrobeAvail) came from Wardrobe (see `poolMax`/the roll-chip loop
  // below) — one die each, resolved together in a single call so the
  // parent's state update can't miss any (see the module doc comment on
  // why resolving dice one-at-a-time in a loop used to under-spend). This
  // is the "Confirm" action (die-pickup swipe left, Send to Set, or a
  // confirmed Margin) — closing the popup WITHOUT calling this first
  // (see closePopup) is instead a Cancel: the pending double is just
  // dropped, nothing spent. Idempotent via resolvedRef: once resolved,
  // repeat calls are no-ops rather than double-spending.
  const resolveOverloadIfNeeded = useCallback(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    if (onOverload && pendingOverload.size > 0) {
      let baseCount = 0
      let wardrobeCount = 0
      pendingOverload.forEach((index) => {
        if (index >= available) wardrobeCount += 1
        else baseCount += 1
      })
      onOverload(baseCount, wardrobeCount)
    }
    setResolved(true)
  }, [onOverload, pendingOverload, available])

  const closePopup = useCallback(() => {
    // Closing the popup (via the X button or tapping outside) now
    // Cancels any Overload that's still only pending — nothing is spent.
    // Confirming a double (so closing can't take it back) happens
    // explicitly: picking the die back up and swiping left, or committing
    // the roll via Send to Set / a confirmed Margin (see
    // handleDiePointerUp/sendToSet/handleConfirmMargin) all resolve it for
    // real first. Engrams are unaffected either way — they were already
    // spent for good the instant they were tapped.
    resolvedRef.current = true
    setResult(null)
    setRolling(false)
    setPendingOverload(new Set())
    setResolved(false)
    setView("result")
    setOppositionInput("")
    setIsSaveRoll(false)
    setMargin(null)
    setMarginBase(null)
    setDamageDice([])
    setWoundValue("")
    setWoundMode("threshold")
    setArmedDieIndex(null)
    setDieFling(null)
    setEngramBonus([])
    if (flingTimer.current !== null) {
      window.clearTimeout(flingTimer.current)
      flingTimer.current = null
    }
    if (rollAnimTimer.current !== null) {
      window.clearInterval(rollAnimTimer.current)
      rollAnimTimer.current = null
    }
  }, [])

  // The result popup stays open until the player dismisses it (tap outside
  // or the close button) — it never times out on its own. The popup is
  // rendered via createPortal into document.body, physically outside
  // boxRef's own subtree, so "outside" must explicitly also check
  // popupRef — relying solely on the popup's own stopPropagation calls
  // bubbling correctly across the portal boundary was fragile and could
  // let a tap on a die/button inside the popup be misread as "outside"
  // and close it before the player's intended action landed.
  useEffect(() => {
    if (!result) return
    const handleOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (boxRef.current?.contains(event.target)) return
      if (popupRef.current?.contains(event.target)) return
      closePopup()
    }
    document.addEventListener("pointerdown", handleOutside)
    return () => document.removeEventListener("pointerdown", handleOutside)
  }, [result, closePopup])

  const vibrate = (ms: number) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(ms)
  }

  useEffect(() => () => {
    if (rollAnimTimer.current !== null) window.clearInterval(rollAnimTimer.current)
    if (errorFlashTimer.current !== null) window.clearTimeout(errorFlashTimer.current)
    if (diePressTimer.current !== null) window.clearTimeout(diePressTimer.current)
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    if (chargeInterval.current !== null) window.clearInterval(chargeInterval.current)
    if (flingTimer.current !== null) window.clearTimeout(flingTimer.current)
  }, [])

  const flashError = () => {
    setErrorFlash(true)
    if (errorFlashTimer.current !== null) window.clearTimeout(errorFlashTimer.current)
    errorFlashTimer.current = window.setTimeout(() => setErrorFlash(false), ERROR_FLASH_MS)
  }

  // The current pool this Method can roll right now — always the whole
  // pool; there's nothing left to pick since a roll always uses every die.
  // Spent Wardrobe dice (Overloaded away) don't get rolled either, same as
  // spent base dice — so this uses wardrobeAvail (current), not wardrobeBonus
  // (total capacity, used only for the track's slot count).
  // Methods cap out at STAT_AND_METHOD_MAX (6) dice per roll regardless of
  // rating or Wardrobe bonus — Wardrobe dice beyond that cap simply don't
  // get rolled (truncated from the Wardrobe side only; `available`, the
  // base pool, is assumed to already be ≤ the cap via existing track logic).
  const poolMax = Math.min(STAT_AND_METHOD_MAX, Math.max(0, available) + Math.max(0, wardrobeAvail))

  const rollPool = (count: number) => {
    if (count <= 0) {
      flashError()
      return
    }
    const rolled = onRoll(count)
    resolvedRef.current = false
    setResult(null)
    setPendingOverload(new Set())
    setEngramBonus([])
    setResolved(false)
    setView("result")
    setRolling(true)
    // "Numbers rolling" visual: re-roll a throwaway D10 face per die, every
    // tick, so the popup looks like the dice are actually tumbling before
    // settling on the real result.
    setRollingPreview(Array.from({ length: count }, () => Math.floor(Math.random() * 10) + 1))
    let ticks = 0
    rollAnimTimer.current = window.setInterval(() => {
      ticks += 1
      if (ticks >= ROLL_ANIM_TICKS) {
        if (rollAnimTimer.current !== null) {
          window.clearInterval(rollAnimTimer.current)
          rollAnimTimer.current = null
        }
        setRolling(false)
        setResult(rolled)
        return
      }
      setRollingPreview(Array.from({ length: count }, () => Math.floor(Math.random() * 10) + 1))
    }, ROLL_ANIM_INTERVAL_MS)
  }

  const cancelGesture = () => {
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current)
      armTimer.current = null
    }
    if (chargeInterval.current !== null) {
      window.clearInterval(chargeInterval.current)
      chargeInterval.current = null
    }
    armedRef.current = false
    setArmed(false)
    setChargeProgress(0)
    pendingRollRef.current = false
    setPendingRoll(false)
    gestureStart.current = null
  }

  // Holding the name box arms the gesture (same gold "charging" glow the
  // row already had); only a swipe — in any direction, by any amount past
  // METHOD_SWIPE_PX — while armed actually fires the roll, and it always
  // rolls the whole pool. Moving too far *before* arming cancels instead,
  // so an accidental drag (e.g. scrolling past the row) doesn't arm it.
  // The charge-up glow itself starts growing the instant the pointer goes
  // down (see chargeProgress below) rather than waiting for the full
  // METHOD_ARM_MS to elapse before showing anything — a press that
  // doesn't visibly react right away reads as broken and players let go
  // before it ever arms.
  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (poolMax <= 0) return
    rolledThisGesture.current = false
    gestureStart.current = { x: event.clientX, y: event.clientY }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture isn't critical — move/up still fire on this
      // element for mouse, and most touch browsers grant it anyway.
    }
    const pressStart = Date.now()
    setChargeProgress(1) // immediate, visible reaction on the very first paint after press
    chargeInterval.current = window.setInterval(() => {
      setChargeProgress(Math.min(100, ((Date.now() - pressStart) / METHOD_ARM_MS) * 100))
    }, 30)
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null
      armedRef.current = true
      setArmed(true)
      setChargeProgress(100)
      vibrate(VIBRATE_PIP_MS)
    }, METHOD_ARM_MS)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (rolledThisGesture.current || !gestureStart.current) return
    const dx = event.clientX - gestureStart.current.x
    const dy = event.clientY - gestureStart.current.y
    const dist = Math.hypot(dx, dy)
    if (!armedRef.current) {
      if (dist > METHOD_PRE_ARM_CANCEL_PX) cancelGesture()
      return
    }
    // Past this point the roll is only *pending* — nothing fires until
    // release. Pulling back under the threshold clears the pending state
    // again (no action), matching "incomplete gesture does nothing".
    const nowPending = dist > METHOD_SWIPE_PX
    if (nowPending !== pendingRollRef.current) {
      pendingRollRef.current = nowPending
      setPendingRoll(nowPending)
      if (nowPending) vibrate(VIBRATE_PIP_MS)
    }
  }

  const handlePointerUp = () => {
    const shouldRoll = armedRef.current && pendingRollRef.current && !rolledThisGesture.current
    cancelGesture()
    if (shouldRoll) {
      rolledThisGesture.current = true
      vibrate(VIBRATE_PIP_MS * 2)
      rollPool(poolMax)
    }
  }

  const handlePointerCancel = () => {
    // A pointercancel (e.g. the OS took over for a system gesture) always
    // aborts — never rolls, even mid-gesture.
    cancelGesture()
  }

  // Overload doubles a die's face value. Nothing Explodes, so the Method's
  // own Total is simply the single highest die in the pool after any
  // Overloads — Engram bonus d4s (see engramBonus state) are a flat
  // separate addition on top of that (handbook "Roll+xd4" notation: added
  // to an existing roll, not part of the take-the-highest pool), so they're
  // summed in afterward rather than folded into this max().
  const overloadedValue = (dieRoll: ApproachDieResult) => dieRoll.rolls[0] * 2
  const dieMax = result
    ? result.dice.reduce(
        (max, dieRoll, index) => Math.max(max, pendingOverload.has(index) ? overloadedValue(dieRoll) : dieRoll.total),
        0
      )
    : 0
  // Only one die may be Overloaded per roll (see addOverload), so this is
  // either empty or a single index — used for the popup total's doubling
  // breakdown below, same idea as the Engram breakdown.
  const overloadedIndex = pendingOverload.size > 0 ? Array.from(pendingOverload)[0] : null
  const overloadedBaseValue = overloadedIndex !== null && result ? result.dice[overloadedIndex].total : null
  const engramBonusTotal = engramBonus.reduce(
    (sum, entry) => sum + entry.rolls.reduce((a, b) => a + b, 0),
    0
  )
  const displayTotal = dieMax + engramBonusTotal
  // Picking up a die previews doubling it, but only once confirmed with a
  // long-press (a plain tap would be too easy to trigger by accident while
  // reading the result) — it's then auto-resolved (spent from its own
  // pool — base or Wardrobe) the moment the player moves past this screen:
  // Send to Set, Create Margin, or just closing the popup. A quick tap on
  // an already-doubled die un-does it while the popup is still open;
  // there's no separate Resolve/Undo step. Only one die may be Overloaded
  // per roll — a die's pool is identified by its index: indices below
  // `available` came from the base pool, the rest from Wardrobe (see
  // `poolMax`).
  const addOverload = (index: number) => {
    if (!onOverload || resolvedRef.current) return
    const isWardrobeDie = index >= available
    setPendingOverload((prev) => {
      if (prev.has(index)) return prev
      if (prev.size >= 1) {
        flashError() // only one die can be Overloaded per roll
        return prev
      }
      if (isWardrobeDie ? wardrobeAvail < 1 : available < 1) {
        flashError()
        return prev
      }
      return new Set([index])
    })
  }

  const removeOverload = (index: number) => {
    if (resolvedRef.current) return
    setPendingOverload((prev) => {
      if (!prev.has(index)) return prev
      const next = new Set(prev)
      next.delete(index)
      return next
    })
  }

  // Engram roller integration: tapping a standby icon spends ALL of that
  // Engram's current charges in one gesture and rolls that many d4s,
  // grouped as their own small chips and summed straight into the Total.
  // This is final the instant it happens — there's no undo/refund path,
  // tapping the resulting chip again does nothing (see its onClick below).
  // No-op if the Engram has already been emptied elsewhere in the meantime
  // (e.g. two Method popups open in quick succession) — onSpendEngram
  // returns 0 in that case.
  const addEngramBonus = (engramId: string) => {
    if (!onSpendEngram) return
    const option = engramOptions.find((entry) => entry.id === engramId)
    if (!option) return
    const amount = onSpendEngram(engramId)
    if (amount <= 0) return
    const rolls = rollFlatDice(amount, 4)
    setEngramBonus((prev) => [...prev, { id: engramId, name: option.name, rolls }])
  }

  const cancelDiePress = () => {
    if (diePressTimer.current !== null) {
      window.clearTimeout(diePressTimer.current)
      diePressTimer.current = null
    }
    setPressingDieIndex(null)
    setArmedDieIndex(null)
    dieGestureStart.current = null
    dieSwipeDirRef.current = null
    setDieSwipeDir(null)
  }

  const sendToSet = (total: number) => {
    resolveOverloadIfNeeded()
    addSetRollRow(total)
    closePopup()
  }

  const startMargin = (total: number) => {
    setMarginBase(total)
    setView("margin-input")
  }

  // Long-pressing a die "picks it up": once armed (same hold duration as
  // the old immediate-double long-press), any swipe past DIE_SWIPE_PX in
  // one of the 4 cardinal directions fires that direction's action —
  // up doubles *this* die, down sends the Total to the Set list, right
  // starts the Margin flow, left Confirms (locks in any pending Overload
  // for good — same as Send to Set/a confirmed Margin resolving it — but
  // without otherwise leaving the result screen). Moving too far before
  // arming cancels the whole press, same guard the Method row's own
  // hold-then-swipe uses.
  const handleDiePointerDown = (index: number, event: React.PointerEvent<HTMLButtonElement>) => {
    // Note: NOT gated on resolvedRef — Send to Set/Margin/Confirm must
    // keep working after a Confirm resolves the pending Overload. Only
    // the Overload-specific actions (addOverload/removeOverload below)
    // stay guarded by resolvedRef, so a resolved die can no longer be
    // doubled or un-doubled, but every other die gesture keeps working.
    dieSuppressClick.current = false
    dieSwipeDirRef.current = null
    setDieSwipeDir(null)
    dieGestureStart.current = { x: event.clientX, y: event.clientY }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture isn't critical — move/up still fire on this
      // element for mouse, and most touch browsers grant it anyway.
    }
    setPressingDieIndex(index)
    diePressTimer.current = window.setTimeout(() => {
      diePressTimer.current = null
      dieSuppressClick.current = true
      setPressingDieIndex(null)
      setArmedDieIndex(index)
      vibrate(VIBRATE_PIP_MS)
    }, DIE_LONG_PRESS_MS)
  }

  // Tracks which direction the current swipe *would* commit to if the
  // pointer were released right now — nothing actually fires here. Only
  // once armed does a direction register at all; pulling back under
  // DIE_SWIPE_PX clears it again (no pending direction = release does
  // nothing), same "incomplete gesture does nothing" rule as everywhere
  // else in this component.
  const handleDiePointerMove = (index: number, event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dieGestureStart.current) return
    const dx = event.clientX - dieGestureStart.current.x
    const dy = event.clientY - dieGestureStart.current.y
    const dist = Math.hypot(dx, dy)
    if (armedDieIndex !== index) {
      // Not armed yet — too much movement before the long-press lands
      // reads as an accidental drag, not a deliberate pick-up.
      if (dist > DIE_PRE_ARM_CANCEL_PX) cancelDiePress()
      return
    }
    const dir =
      dist <= DIE_SWIPE_PX
        ? null
        : Math.abs(dy) > Math.abs(dx)
        ? dy < 0
          ? "up"
          : "down"
        : dx > 0
        ? "right"
        : "left"
    if (dir !== dieSwipeDirRef.current) {
      dieSwipeDirRef.current = dir
      setDieSwipeDir(dir)
      if (dir) vibrate(VIBRATE_PIP_MS)
    }
  }

  // Only here, on release, does the pending direction (if any) actually
  // commit — matching the rest of the app's "hold and swipe, release to
  // fire" shape instead of committing mid-drag.
  const handleDiePointerUp = (index: number) => {
    const dir = armedDieIndex === index ? dieSwipeDirRef.current : null
    cancelDiePress()
    if (!dir) return
    vibrate(VIBRATE_PIP_MS * 2)
    if (dir === "up") {
      setDieFling({ index, dir: "up" }) // swipe up: Doubled
      flingTimer.current = window.setTimeout(() => { addOverload(index); setDieFling(null) }, FLING_DURATION_MS)
    } else if (dir === "down") {
      setDieFling({ index, dir: "down" }) // swipe down: Send to Set
      flingTimer.current = window.setTimeout(() => { sendToSet(displayTotal); setDieFling(null) }, FLING_DURATION_MS)
    } else if (dir === "right") {
      setDieFling({ index, dir: "right" }) // swipe right: Create Margin
      flingTimer.current = window.setTimeout(() => { startMargin(displayTotal); setDieFling(null) }, FLING_DURATION_MS)
    } else {
      // swipe left: Confirm — locks in any pending Overload for good
      // (burns its pool charge) without otherwise leaving the result
      // screen; still flings it off so the gesture reads as deliberate.
      setDieFling({ index, dir: "left" })
      flingTimer.current = window.setTimeout(() => { resolveOverloadIfNeeded(); setDieFling(null) }, FLING_DURATION_MS)
    }
  }

  const handleDieClick = (index: number) => {
    if (dieSuppressClick.current) {
      // This click followed a long-press (picked up, whether or not it
      // then swiped) — don't also treat it as the "tap to cancel" gesture.
      dieSuppressClick.current = false
      return
    }
    removeOverload(index)
  }

  const handleConfirmMargin = () => {
    resolveOverloadIfNeeded()
    const opposition = Number(oppositionInput)
    if (!Number.isFinite(opposition)) return
    const computed = (marginBase ?? displayTotal) - opposition
    setMargin(computed)
    setView("margin-result")
    // Fumble/Wound (handbook): a failed Attack only takes Wounds if it's a
    // genuine Fumble — the opposition beat the Attack Total by the Fumble
    // Number (V+I+P) or more. A Save never Fumbles and never wounds the
    // roller, no matter how badly it fails. There is exactly one
    // notification for this (no separate "Apply Wound" notice) — it both
    // names the Fumble and carries the HP effect to apply.
    if (!isSaveRoll) {
      const wounds = computeFumbleWounds(computed, fumbleNumber)
      if (wounds > 0) {
        const miss = -computed
        const past = miss - fumbleNumber
        pushNotification(
          "margin-fumble",
          "Fumble!",
          `${label}: missed by ${miss} (Fumble Number ${fumbleNumber > 0 ? -fumbleNumber : fumbleNumber}, ${past} past) — take ${wounds} Wound${wounds === 1 ? "" : "s"}.`,
          { hp: -wounds }
        )
      }
    }
  }

  const handleRollDamage = () => {
    if (margin === null || margin <= 0) return
    setDamageDice(rollFlatDice(margin, damageDie))
    setView("damage")
  }

  const woundThresholdNumber = Number(woundValue)
  const hasWoundValue = woundValue.trim() !== "" && Number.isFinite(woundThresholdNumber)
  const isSuccess = (value: number) =>
    hasWoundValue && (woundMode === "threshold" ? value >= woundThresholdNumber : value === woundThresholdNumber)
  const successCount = hasWoundValue ? damageDice.filter(isSuccess).length : 0

  // Track geometry: a fixed 1-6 numbered circle row, like the printed
  // sheet (a Method's base rating can never exceed STAT_AND_METHOD_MAX).
  // Circles past baseRating + wardrobeBonus are locked (this Method
  // hasn't grown a die there, nor does Wardrobe add one). Base and
  // Wardrobe are two separate pools mechanically (different caps, spent
  // independently) but are shown as ONE combined countdown: every still-
  // available pip (base or Wardrobe) is drawn first (left), every spent
  // pip after (right), so the row always reads as a clean "available →
  // spent" run with no out-of-order gaps. Color is what still tells them
  // apart: available base pips are blue, available Wardrobe pips are
  // gold; once spent, both turn the identical dull red (see
  // .method-die-pip.wardrobe.spent in chud.css) — a spent die is a spent
  // die regardless of source. Because this ordering is recomputed from
  // the available/spent counts, a pip's slot number isn't a stable
  // per-origin identity like the locked pips are — it shifts as dice are
  // spent or restored.
  const trackMax = Math.min(STAT_AND_METHOD_MAX, baseRating)
  const trackCurrent = Math.max(0, Math.min(available, trackMax))
  const wardrobeTrackCurrent = Math.max(0, Math.min(wardrobeAvail, wardrobeBonus))
  const isDepleted = poolMax <= 0 && trackMax + wardrobeBonus > 0
  // Normally exactly 6 grid columns, but Wardrobe can push the track past
  // the sheet's 1-6 ceiling — grow the column count to fit when it does,
  // so overflow slots still get their own equal-width column instead of
  // cramming into the last one.
  const totalSlots = Math.max(STAT_AND_METHOD_MAX, trackMax + wardrobeBonus)

  const rollHint = poolMax <= 0
    ? "No dice"
    : errorFlash
    ? "No more dice"
    : armed
    ? `Swipe to roll ${poolMax}`
    : "Hold, then swipe to roll"

  return (
    <div
      ref={boxRef}
      className={`method-row${armed ? " armed" : ""}${errorFlash ? " error" : ""}`}
    >
      <button
        type="button"
        className="method-row-roll"
        aria-label={`${label}, ${available} of ${baseRating} base dice available${wardrobeBonus > 0 ? `, plus ${wardrobeAvail} of ${wardrobeBonus} from Wardrobe` : ""}. ${rollHint}.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span
          className={`rising-progress-fill${chargeProgress > 0 ? " active" : ""}${pendingRoll ? " ready" : ""}`}
          style={
            !pendingRoll && chargeProgress > 0
              ? { opacity: (chargeProgress / 100) * 0.85, transform: `translateY(${18 - (chargeProgress / 100) * 48}%)` }
              : undefined
          }
          aria-hidden="true"
        />
        <span className="method-row-name">{label}</span>
      </button>

      {/* The track is a CSS Grid with one equal-width (1fr) column per
          slot, rather than a flex row — every pip gets an explicit
          gridColumn (its slot number), so the 6 columns always line up
          at the exact same x-position across every Method row (Force's
          circle in slot 3 sits directly above Guts's locked pip in slot
          3), while still stretching to fill the row's full width. The
          "Charges Spent" overlay also gets an explicit column span
          (1 to trackMax) so it only covers the Method's own circles,
          painting over them (same grid area, later in DOM order) rather
          than needing position:absolute. */}
      <div
        className="method-row-track"
        role="group"
        aria-label={`${label} dice track`}
        style={{ ["--method-track-columns" as string]: totalSlots }}
      >
        {/* Base and Wardrobe dice are two separate pools mechanically
            (different caps, spent/tracked independently), but a user
            rolling doesn't care where a die came from when deciding
            "do I have any left" — so visually they're one combined
            countdown: every still-available pip (whichever pool) is
            pushed to the left, every spent pip (whichever pool) is
            pushed to the right, in one unbroken run. Color is the only
            thing that still says "this one's from Wardrobe" (gold vs
            blue when available; a Wardrobe-origin spent pip keeps the
            same dull red as a spent base pip, since once it's spent
            there's nothing left to tell apart). Positions are
            recomputed from these counts on every render, so a pip's
            slot number can shift as dice are spent/restored — unlike
            the locked pips below, these aren't meant to be a stable
            per-slot identity. */}
        {[
          ...Array.from({ length: trackCurrent }, (_, index) => ({ key: `base-avail-${index}`, origin: "base" as const, spent: false })),
          ...Array.from({ length: wardrobeTrackCurrent }, (_, index) => ({ key: `wardrobe-avail-${index}`, origin: "wardrobe" as const, spent: false })),
          ...Array.from({ length: trackMax - trackCurrent }, (_, index) => ({ key: `base-spent-${index}`, origin: "base" as const, spent: true })),
          ...Array.from({ length: wardrobeBonus - wardrobeTrackCurrent }, (_, index) => ({ key: `wardrobe-spent-${index}`, origin: "wardrobe" as const, spent: true })),
        ].map((pip, index) => {
          const slot = index + 1
          const isWardrobe = pip.origin === "wardrobe"
          const isAvailable = !pip.spent
          const isPreview = armed && isAvailable
          return (
            <span
              key={pip.key}
              className={`method-die-pip${isWardrobe ? " wardrobe" : ""}${isAvailable ? " available" : " spent"}${isPreview ? " drag-preview" : ""}`}
              style={{ gridColumn: slot }}
              title={
                isWardrobe
                  ? `Wardrobe bonus die${wardrobeItems.length ? ` (${wardrobeItems.join(", ")})` : ""}. Always rolled; ${pip.spent ? "spent (Overloaded away)." : "Overload-spendable, same as a base die."}`
                  : undefined
              }
              aria-hidden={isWardrobe ? undefined : "true"}
            >
              {slot}
            </span>
          )
        })}
        {/* When both pools are fully depleted (every die — base and
            Wardrobe — Overloaded away), cover the whole track with a
            plain banner instead of per-pip "spent" circles. A
            partial-width banner reads as broken (locked pips dangling
            past its edge); the full track covered reads as "this Method
            is spent". If only one pool is depleted, its own pips just
            turn red individually instead — the other pool's dice are
            still usable, so the banner would incorrectly hide them. */}
        {isDepleted && (
          <div
            className="method-row-track-overlay"
            style={{ gridColumn: `1 / span ${totalSlots}` }}
            aria-hidden="true"
          >
            Charges Spent
          </div>
        )}
        {/* Remaining slots up to the sheet's 1-6 ceiling that neither the
            Method's own rating nor Wardrobe have reached yet — hollow,
            dashed potential the Method hasn't grown into. */}
        {Array.from({ length: Math.max(0, STAT_AND_METHOD_MAX - trackMax - wardrobeBonus) }, (_, index) => (
          <span
            key={`locked-${index}`}
            className="method-die-pip locked"
            style={{ gridColumn: trackMax + wardrobeBonus + index + 1 }}
            aria-hidden="true"
          >
            {trackMax + wardrobeBonus + index + 1}
          </span>
        ))}
      </div>

      {(rolling || result) && createPortal(
        <div
          ref={popupRef}
          className="approach-die-popup"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="approach-die-popup-close"
            onClick={(event) => {
              event.stopPropagation()
              closePopup()
            }}
            aria-label="Close roll result"
          >
            X
          </button>
          <div className="approach-die-popup-label">{label}</div>

          {rolling && (
            <div className="approach-die-popup-die">
              {rollingPreview.map((face, index) => {
                const previewTop = rollingPreview.length > 0 ? Math.max(...rollingPreview) : null
                const isTop = previewTop !== null && face === previewTop
                return (
                  <span key={index} className={`approach-die-chip rolling${isTop ? " top" : ""}`} aria-hidden="true">
                    {face}
                  </span>
                )
              })}
            </div>
          )}

          {!rolling && result && view === "result" && (
            <>
              <div className="approach-die-popup-die">
                {result.dice.map((dieRoll, index) => {
                  const effectiveValue = pendingOverload.has(index) ? overloadedValue(dieRoll) : dieRoll.total
                  const isTop = result.dice.length > 0 && effectiveValue === dieMax
                  const isPressing = pressingDieIndex === index
                  const isArmed = armedDieIndex === index
                  const fling = dieFling?.index === index ? dieFling.dir : null
                  return (
                    <button
                      key={index}
                      type="button"
                      className={`approach-die-chip${pendingOverload.has(index) ? " overloaded" : ""}${isTop ? " top" : ""}${isPressing ? " pressing" : ""}${isArmed ? " armed" : ""}${fling ? ` fling-${fling}` : ""}`}
                      style={{ ["--hold-progress-ms" as string]: `${DIE_LONG_PRESS_MS}ms` } as CSSProperties}
                      disabled={fling !== null}
                      onPointerDown={(event) => { event.stopPropagation(); handleDiePointerDown(index, event) }}
                      onPointerMove={(event) => { event.stopPropagation(); handleDiePointerMove(index, event) }}
                      onPointerUp={(event) => { event.stopPropagation(); handleDiePointerUp(index) }}
                      onPointerLeave={cancelDiePress}
                      onPointerCancel={cancelDiePress}
                      onContextMenu={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleDieClick(index)
                      }}
                      title={
                        pendingOverload.has(index)
                          ? "Tap to undo this Overload · pick it up and swipe left to Confirm it for good"
                          : "Hold, then swipe: up Doubles, down sends to Set, right starts Margin, left Confirms"
                      }
                    >
                      <span
                        className={`rising-progress-fill${isPressing ? " timed active" : ""}${isArmed ? " active" : ""}${isArmed && dieSwipeDir ? " ready" : ""}`}
                        aria-hidden="true"
                      />
                      {dieRoll.rolls[0]}
                      {pendingOverload.has(index) && <span className="approach-die-chip-doubled">DOUBLED</span>}
                    </button>
                  )
                })}
              </div>
              {(engramBonus.length > 0 || engramOptions.length > 0) && (
                <div className="approach-die-engram-row" aria-label="Engram roller">
                  {engramBonus.map((entry) => (
                    <span
                      key={entry.id}
                      className="approach-die-engram-chip spent"
                      title={`${entry.name}: ${entry.rolls.join(" + ")} — spent, locked in for this roll`}
                    >
                      <span className="approach-die-engram-chip-name">{entry.name}</span>
                      <span className="approach-die-engram-chip-dice">
                        {entry.rolls.map((roll, index) => (
                          <span key={index} className="approach-die-engram-die">{roll}</span>
                        ))}
                      </span>
                    </span>
                  ))}
                  {engramOptions
                    .filter((option) => !engramBonus.some((entry) => entry.id === option.id))
                    .map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="approach-die-engram-chip standby"
                        onClick={(event) => { event.stopPropagation(); addEngramBonus(option.id) }}
                        title={`Spend all ${option.charges} charge${option.charges === 1 ? "" : "s"} of ${option.name} (+${option.charges}d4 to the Total) — final, can't be undone`}
                      >
                        <span className="approach-die-engram-chip-name">{option.name}</span>
                        <span className="approach-die-engram-chip-count">×{option.charges}</span>
                      </button>
                    ))}
                </div>
              )}
              {(engramBonus.length > 0 || overloadedIndex !== null) && (
                <div className="approach-die-popup-total">
                  Total: {displayTotal}{" "}
                  <span className="approach-die-popup-total-sub">
                    (
                    {overloadedIndex !== null && overloadedBaseValue !== null
                      ? `${overloadedBaseValue} doubled to ${overloadedBaseValue * 2}`
                      : `${dieMax} die`}
                    {engramBonus.length > 0 ? ` + ${engramBonusTotal} Engram` : ""})
                  </span>
                </div>
              )}
              <div className="approach-die-popup-swipe-hint">
                ↑ Double · ↓ Send to Set · → Margin · ← Confirm
              </div>
            </>
          )}


          {view === "margin-input" && (
            <div className="approach-margin-input">
              <label className="approach-margin-label" htmlFor={`opposition-${label}`}>
                Opposition Roll
              </label>
              <input
                id={`opposition-${label}`}
                type="number"
                inputMode="numeric"
                className="approach-margin-field"
                value={oppositionInput}
                onChange={(e) => setOppositionInput(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className={`approach-margin-save-toggle${isSaveRoll ? " active" : ""}`}
                aria-pressed={isSaveRoll}
                onClick={(e) => { e.stopPropagation(); setIsSaveRoll((v) => !v) }}
              >
                {isSaveRoll ? "Save roll (never Fumbles)" : "Attack roll (can Fumble)"}
              </button>
              <button
                type="button"
                className="approach-roll-path-btn"
                disabled={oppositionInput.trim() === ""}
                onClick={(e) => { e.stopPropagation(); handleConfirmMargin() }}
              >
                Calculate Margin
              </button>
            </div>
          )}

          {view === "margin-result" && margin !== null && (
            <div className="approach-margin-result">
              <div className="approach-margin-value">{margin > 0 ? `+${margin}` : margin}</div>
              <div className="approach-margin-sub">Margin</div>
              {margin > 0 && (
                <button type="button" className="approach-roll-path-btn" onClick={(e) => { e.stopPropagation(); handleRollDamage() }}>
                  Roll Wounds ({margin}{dieLabel(damageDie)})
                </button>
              )}
            </div>
          )}

          {view === "damage" && (
            <div className="approach-damage-roll">
              <div className="approach-damage-dice">
                {damageDice.map((value, index) => (
                  <span key={index} className={`approach-damage-chip${isSuccess(value) ? " success" : ""}`}>
                    {value}
                  </span>
                ))}
              </div>
              <div className="approach-damage-controls">
                <div className="approach-damage-wound-field">
                  <label htmlFor={`wound-${label}`}>{woundMode === "threshold" ? "Wound Threshold" : "Wound Target"}</label>
                  <input
                    id={`wound-${label}`}
                    type="number"
                    inputMode="numeric"
                    value={woundValue}
                    onChange={(e) => setWoundValue(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="approach-damage-mode-toggle"
                  onClick={(e) => { e.stopPropagation(); setWoundMode((m) => (m === "threshold" ? "target" : "threshold")) }}
                >
                  {woundMode === "threshold" ? "Switch to Target" : "Switch to Threshold"}
                </button>
              </div>
              <div className="approach-damage-success-count">
                <span className="approach-damage-success-value">{successCount}</span>
                <span className="approach-damage-success-label">Successes</span>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
