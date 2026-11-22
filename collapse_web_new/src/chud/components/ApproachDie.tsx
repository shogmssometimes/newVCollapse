import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { createPortal } from "react-dom"
import type { ApproachDieResult, ApproachRollResult, DieSides } from "../../domain/approachDice"
import { rollFlatDice, computeFumbleWounds, useSkillReroll } from "../../domain/approachDice"
import { addSetRollRow, readGlobalMeters, spendGrit } from "../../utils/chudVanillaBridge"
import { pushNotification, removeNotification, hasPendingNotification } from "../../domain/notifications"
import { STAT_AND_METHOD_MAX } from "../../domain/coreApproachMap"
import { STANDARD_LONG_PRESS_MS } from "../../utils/gestureConstants"
import { lockScroll, unlockScroll } from "../../utils/scrollLock"
import {
  currentChudSlot,
  loadPersistedRoll,
  rollPersistKey,
  ROLLS_CLEARED_EVENT,
  savePersistedRoll,
} from "../../utils/approachRollPersistence"

export type ApproachDieRollResult = ApproachRollResult

// Each Method renders its own ApproachDie instance with fully independent
// popup state, so nothing stops two different Methods' roll popups from
// being open at once (e.g. rolling Finesse, then — without dismissing it —
// rolling Guts). Track whichever instance's popup is currently open here,
// module-wide, so opening one always closes any other first instead of
// stacking two popups on screen together.
let activePopupCloseRef: (() => void) | null = null

// An unresolved roll (dice shown, any pending Overload, any activated
// Engram Stack) used to live only in this component's React state — fine
// for an in-page unmount, but the HUD lives in an <iframe> whose whole
// document (and JS realm) is torn down and recreated on route change, not
// just this one component. By the time any unmount cleanup *could* run,
// the navigation may already have discarded the frame, so the pending
// Overload/Engram Stack were silently lost (never spent, never refunded)
// and the next roll came up fresh — a free reroll. Mirror the unresolved
// roll out to localStorage on every change instead, scoped per-Method
// (by its display label, which is unique and stable) and per character
// slot, and restore it on mount. Cleared once the roll is actually
// Confirmed/sent to Margin — from that point everything it represents is
// already durably persisted elsewhere (the spent Overload pool, the
// consumed Engram charges), so there's nothing left worth surviving a
// reload. See `../../utils/approachRollPersistence` for the persistence
// helpers themselves (shared with CharMgmt.tsx's slot delete/import, which
// need to discard stale rolls without importing this whole component).

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

// Grit Menu's Hidden/Reckless buttons (handbook v12 p40) — same effect text
// as the HUD's Status Effects catalog (meter-bridge.js/GMCombatTracker.tsx).
const GRIT_STATUS_EFFECT: Record<"Hidden" | "Reckless", string> = {
  Hidden: "+1d6 to Finesse, Logic and Show rolls. Found by a Perception check that meets or beats your Set; if found, lose Hidden and become Exposed.",
  Reckless: "+1d6 to Force, Guts and Tell rolls. Stopped by a Method roll (Roleplay Action) that meets or beats your Set; if stopped, lose Reckless and become Exposed.",
}

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
// *pending* — holding the Total line now explicitly Confirms it instead
// (locks the double in for good, same moment it spends from its pool);
// Send to Set and a confirmed Margin also confirm implicitly. Closing the
// popup (X or tapping outside) no longer discards anything — see
// `popupVisible`/"no free rerolls" below — only an explicit Confirm,
// Send to Set, or Margin locks a pending double in; it can still be
// un-done (tap the die) right up until one of those happens. The Engram
// Stack (see `stagedEngram`/`engramStack`) is different: activating a
// staged Engram commits the instant it's tapped, with no pending/undo
// window at all — there's no way to "unroll" that decision short of the
// charges never having been spent in the first place. From there, two
// paths continue: send the Total to the HUD's Set Roll list, or turn it
// into a Margin against an Opposition roll. A positive Margin can then be spent
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
  stagedEngram = null,
  onConsumeStagedEngram,
  onRefundEngram,
  totalAllModifier = 0,
  totalAttackDefenseModifier = 0,
  noDiceMode = false,
  onToggleOverloadPip,
  inference = 0,
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
  /** The one Engram currently charged-and-staged from the HUD's Engram Q
   * (global — shared across every Method's popup), waiting to be
   * activated into THIS roll. Null if nothing is staged right now. */
  stagedEngram?: { id: string; name: string; charges: number } | null
  /** Called once the staged Engram above has been activated (rolled into
   * this roll's Stack) — clears the global staged slot so it can't also
   * be activated by a different Method's popup. */
  onConsumeStagedEngram?: () => void
  /** Refunds `amount` charges back to an Engram — used when swapping this
   * roll's already-activated Stack out for a newly-staged Engram, before
   * the Stack is locked in by Confirm/Margin. */
  onRefundEngram?: (engramId: string, amount: number) => void
  /** Permanent Collapse Table modifier applied automatically to every
   * Total this Method rolls, shown in the Total line's breakdown. */
  totalAllModifier?: number
  /** Permanent Collapse Table modifier applied only once a Total is sent
   * to Margin (Attack or Defense) — not part of the initial Total line. */
  totalAttackDefenseModifier?: number
  /** No Dice Mode: the app is just the character sheet — no roll popup.
   * Tapping the name box does nothing; tapping a pip directly toggles it
   * spent/unspent instead (see onToggleOverloadPip). */
  noDiceMode?: boolean
  /** No Dice Mode only: tapping a pip reports its origin and whether it
   * was spent (so the parent flips exactly 1 die the other way). */
  onToggleOverloadPip?: (origin: "base" | "wardrobe", wasSpent: boolean) => void
  /** Inference stat (Dice Mode only) — gates the Use Skill button (shown
   * when >= 1) and is its silent per-roll reroll cap. */
  inference?: number
}) {
  const wardrobeAvail = wardrobeAvailable ?? wardrobeBonus
  // Restored once per mount — see the "unresolved roll persistence" doc
  // comment near loadPersistedRoll/savePersistedRoll above. A persisted
  // roll is only trustworthy if it was rolled from the SAME pool size
  // this Method currently has; if a stat drop (e.g. lower Personality)
  // shrank the pool since the roll was made, the extra persisted dice
  // would let a since-removed die be doubled/Confirmed for a free
  // Overload — so discard it instead of restoring it.
  const [initialPersistedRoll] = useState(() => {
    const persisted = loadPersistedRoll(label)
    if (!persisted) return null
    const expectedPoolMax = Math.min(STAT_AND_METHOD_MAX, Math.max(0, available) + Math.max(0, wardrobeAvail))
    if (persisted.result.dice.length !== expectedPoolMax) {
      savePersistedRoll(label, null)
      return null
    }
    return persisted
  })
  const [errorFlash, setErrorFlash] = useState(false)
  const [result, setResult] = useState<ApproachDieRollResult | null>(initialPersistedRoll?.result ?? null)
  // Whether the popup is actually shown right now — distinct from having a
  // `result`. Closing (X/outside tap) only hides the popup; it never
  // throws the roll away. Reopening the same Method (without a fresh roll)
  // shows the exact same dice/Stack/pending-Overload until the roll is
  // Confirmed or sent to Margin — see closePopup/rollPool and the
  // Method-row press handler in ApproachPanel.tsx that reopens instead of
  // re-rolling when an unresolved result is already sitting here.
  const [popupVisible, setPopupVisible] = useState(false)
  // The backdrop that eats the "tap outside to dismiss" gesture (see the
  // popup's createPortal render below) must leave a hole over this
  // Method's own box, since re-pressing it while the popup is open is a
  // legitimate way to arm a new roll (handlePointerDown isn't gated on
  // popupVisible) — tracked as a rect so the backdrop can be split into
  // bands around it instead of covering it.
  const [boxRect, setBoxRect] = useState<DOMRect | null>(null)
  const [pendingOverload, setPendingOverload] = useState<Set<number>>(() => new Set(initialPersistedRoll?.pendingOverload ?? []))
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
  // The one Engram Stack activated onto this roll (handbook p25: the
  // roller holds only one Engram type at a time). It's created by
  // activating `stagedEngram` (tapping the standby chip below) — that
  // rolls its dice once and they never reroll even if the player swaps
  // away and back. Swapping to a *different* newly-staged Engram before
  // this roll is Confirmed/sent to Margin refunds this Stack's charges and
  // replaces it; once Confirmed/Margin'd (resolvedRef), the Stack is
  // locked and can no longer be swapped or cleared.
  const [engramStack, setEngramStack] = useState<{ id: string; name: string; rolls: number[] } | null>(
    initialPersistedRoll?.engramStack ?? null
  )
  // Caches each Engram's rolled dice for the lifetime of the CURRENT roll
  // (cleared on every fresh rollPool — see below) so swapping away and
  // back to the same Engram before Confirming reuses its first rolled
  // values instead of rolling again — "no free rerolls" applies per-Engram
  // across swaps, not just to the Method dice themselves.
  const engramRollCacheRef = useRef<Record<string, number[]>>({})
  // Hold progress (0-100) for the Total line's long-press-to-Confirm
  // gesture — replaces the old die-swipe-left Confirm, which was
  // unreliable. Confirms everything at once: any pending Overload AND
  // locks the current Engram Stack in for good.
  const [confirmHoldProgress, setConfirmHoldProgress] = useState(0)
  // Use Skill (handbook p20, Dice Mode only): which die indices have
  // already been rerolled-by-Skill this roll — reset on every fresh
  // rollPool, never on reopening an unresolved result. Its size doubles as
  // the "rerolls used" count against the silent `inference` cap.
  const [skillUsedIndices, setSkillUsedIndices] = useState<Set<number>>(new Set())
  // Grit Menu (handbook p40, Dice Mode only) — each spends 1 Grit via the
  // same path as tapping the Grit bar (see spendGrit in chudVanillaBridge).
  const [gritBonusDie, setGritBonusDie] = useState<number | null>(null) // "+1d10" — once per roll
  const [ignoreOverloadSpend, setIgnoreOverloadSpend] = useState(false) // "Ignore Overload"
  const [gritRerollUsed, setGritRerollUsed] = useState(false) // "Reroll" — once per roll, after a shown miss
  const [grit, setGrit] = useState(() => readGlobalMeters().grit)
  // The Grit Menu's own spendGrit silently refuses while a grit-zero
  // notification is pending (same guard as tapping the Grit bar), so the
  // buttons need to visually disable too — otherwise they look usable but
  // do nothing (see spendGrit in chudVanillaBridge).
  const [gritZeroPending, setGritZeroPending] = useState(() => hasPendingNotification("grit-zero"))
  useEffect(() => {
    const onStorage = () => {
      setGrit(readGlobalMeters().grit)
      setGritZeroPending(hasPendingNotification("grit-zero"))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])
  // Swipe-commit "fling" — the picked-up die flies off in the swipe
  // direction instead of the action applying (and the chip
  // disappearing/resetting) instantly, so the gesture reads as a deliberate
  // throw rather than a snap. The actual action is deferred until the fling
  // finishes playing.
  const [dieFling, setDieFling] = useState<{ index: number; dir: "up" | "down" | "left" | "right" } | null>(null)
  const flingTimer = useRef<number | null>(null)
  // What resolveOverloadIfNeeded actually spent (base/Wardrobe die counts),
  // so a post-Margin "Ignore Overload" (handbook p51: Grit can be spent
  // after the roll, once the Margin is already known) can refund it —
  // cleared once refunded, since there's nothing left to give back twice.
  const resolvedOverloadRef = useRef<{ base: number; wardrobe: number } | null>(null)
  // Tracks the one "Fumble!" notification this roll has queued (if any) so
  // a Grit Menu action that recalculates the Margin (+1d10, Reroll) can
  // replace it instead of leaving a stale notice from the pre-Grit result
  // sitting in the queue alongside (or instead of) the new one.
  const marginFumbleNotifIdRef = useRef<string | null>(null)
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
  // Guards each gesture's own lockScroll()/unlockScroll() pairing so a
  // stray extra cancel (e.g. both onPointerLeave and onPointerCancel
  // firing for one release) can't unlock the page twice for one lock.
  const scrollLockedRef = useRef(false)
  const dieScrollLockedRef = useRef(false)

  // Spends the pending Overloads from their own pools — dice at indices
  // [0, available) came from the base pool, [available, available +
  // wardrobeAvail) came from Wardrobe (see `poolMax`/the roll-chip loop
  // below) — one die each, resolved together in a single call so the
  // parent's state update can't miss any (see the module doc comment on
  // why resolving dice one-at-a-time in a loop used to under-spend). This
  // is the "Confirm" action (long-press the Total line, Send to Set, or a
  // confirmed Margin) — closing the popup before this happens (see
  // closePopup) no longer cancels anything; it just hides the popup and
  // the pending Overload/Engram Stack remain exactly as they are until
  // Confirmed. Idempotent via resolvedRef: once resolved,
  // repeat calls are no-ops rather than double-spending.
  const resolveOverloadIfNeeded = useCallback(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    // Clear the persisted copy of this roll before spending, not after —
    // the save-on-change effect below would otherwise still be the one
    // that gets around to it (on the next render), leaving a window where
    // another tab's storage listener (see below) could read it as still
    // live and let that tab's own Confirm double-spend the same Overload.
    savePersistedRoll(label, null)
    // Grit Menu's "Ignore Overload": the die Overloaded this roll keeps its
    // doubled value (already reflected in dieMax/displayTotal below) but
    // isn't actually spent from its pool.
    if (onOverload && pendingOverload.size > 0 && !ignoreOverloadSpend) {
      let baseCount = 0
      let wardrobeCount = 0
      pendingOverload.forEach((index) => {
        if (index >= available) wardrobeCount += 1
        else baseCount += 1
      })
      onOverload(baseCount, wardrobeCount)
      resolvedOverloadRef.current = { base: baseCount, wardrobe: wardrobeCount }
    }
    setResolved(true)
  }, [label, onOverload, pendingOverload, available, ignoreOverloadSpend])

  const closePopup = useCallback(() => {
    // Closing the popup (via the X button or tapping outside) now ONLY
    // hides it — "no free rerolls": the roll, any pending Overload, and
    // the Engram Stack all stay exactly as they are. Reopening this same
    // Method (see the roll-trigger gating in ApproachPanel.tsx) shows the
    // identical dice/pending state rather than throwing it away, right up
    // until the roll is actually Confirmed (long-press the Total) or sent
    // to Margin — only THEN does the next roll-trigger start a fresh roll.
    if (activePopupCloseRef === closePopup) activePopupCloseRef = null
    setPopupVisible(false)
  }, [])

  // Opens THIS instance's popup, first closing whichever other Method's
  // popup (if any) is currently open — otherwise two Methods rolled in a
  // row would both stay visible, stacked on top of each other.
  const openPopup = useCallback(() => {
    if (activePopupCloseRef && activePopupCloseRef !== closePopup) activePopupCloseRef()
    activePopupCloseRef = closePopup
    setPopupVisible(true)
  }, [closePopup])

  // Writes this roll out to localStorage on every change so it survives
  // the HUD iframe being torn down and recreated (unmount cleanup alone
  // can't be relied on — see the module doc comment above). Cleared once
  // Confirmed/Margin'd (`resolved`): everything it represents by then is
  // already durably persisted elsewhere.
  useEffect(() => {
    if (resolved || !result) {
      savePersistedRoll(label, null)
      return
    }
    savePersistedRoll(label, { result, pendingOverload: Array.from(pendingOverload), engramStack })
  }, [label, result, pendingOverload, engramStack, resolved])

  // Two tabs open on the same slot can both have the same unresolved roll
  // loaded (each from its own mount-time read of localStorage) — without
  // this, both could independently long-press Confirm and each call
  // onOverload, double-spending the same Overload dice. A real cross-tab
  // "storage" event fires here when the OTHER tab's Confirm clears this
  // Method's persist key (see resolveOverloadIfNeeded's early clear
  // above), so treat that the same as having resolved it locally —
  // locking this tab's popup instead of letting its own Confirm still
  // spend again.
  useEffect(() => {
    if (resolvedRef.current || !result) return
    const key = rollPersistKey(label)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      if (event.newValue) return // still live — not a Confirm-elsewhere clear
      resolvedRef.current = true
      setResolved(true)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [label, result])

  // Full Rest (Overload reset) / slot delete / slot import / new character
  // can all invalidate an unresolved roll this same mounted instance is
  // still holding in memory — clearAllPersistedRolls broadcasts this event
  // alongside wiping localStorage so a live instance (the HUD doesn't
  // unmount for Full Rest) discards the stale roll too, instead of only
  // losing it to a future reload.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ slot: number }>).detail
      if (detail && detail.slot !== currentChudSlot()) return
      resolvedRef.current = false
      setResult(null)
      setPendingOverload(new Set())
      setEngramStack(null)
      setResolved(false)
      setPopupVisible(false)
      if (activePopupCloseRef === closePopup) activePopupCloseRef = null
    }
    window.addEventListener(ROLLS_CLEARED_EVENT, handler)
    return () => window.removeEventListener(ROLLS_CLEARED_EVENT, handler)
  }, [closePopup])

  // The result popup stays open until the player dismisses it (tap outside
  // or the close button) — it never times out on its own. The popup is
  // rendered via createPortal into document.body, physically outside
  // boxRef's own subtree, so "outside" must explicitly also check
  // popupRef — relying solely on the popup's own stopPropagation calls
  // bubbling correctly across the portal boundary was fragile and could
  // let a tap on a die/button inside the popup be misread as "outside"
  // and close it before the player's intended action landed.
  useEffect(() => {
    if (!popupVisible) return
    const handleOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (boxRef.current?.contains(event.target)) return
      if (popupRef.current?.contains(event.target)) return
      // Captured ahead of whatever's actually under the tap (e.g. the HUD's
      // HP card, which has its own tap-decrements-HP gesture) — closing
      // the popup must swallow this same pointerdown, or dismissing it
      // doubles as the first tap of that element's own gesture underneath.
      event.preventDefault()
      event.stopPropagation()
      closePopup()
    }
    document.addEventListener("pointerdown", handleOutside, true)
    return () => document.removeEventListener("pointerdown", handleOutside, true)
  }, [popupVisible, closePopup])

  // Keeps boxRect current while the popup (and its backdrop) is up, so the
  // hole tracks the box through layout shifts, scrolling, and resizes.
  useEffect(() => {
    if (!popupVisible) {
      setBoxRect(null)
      return
    }
    const update = () => setBoxRect(boxRef.current?.getBoundingClientRect() ?? null)
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [popupVisible])

  const vibrate = (ms: number) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(ms)
  }

  // Latest-value refs purely for the unmount cleanup below — an effect
  // with `[]` deps only ever sees the closure from the very first render,
  // so anything it reads about an in-progress roll has to come through a
  // ref kept current on every render instead of a captured variable.
  const onOverloadRef = useRef(onOverload)
  onOverloadRef.current = onOverload
  const onRefundEngramRef = useRef(onRefundEngram)
  onRefundEngramRef.current = onRefundEngram
  const pendingOverloadRef = useRef(pendingOverload)
  pendingOverloadRef.current = pendingOverload
  const availableAtRenderRef = useRef(available)
  availableAtRenderRef.current = available
  const ignoreOverloadSpendRef = useRef(ignoreOverloadSpend)
  ignoreOverloadSpendRef.current = ignoreOverloadSpend
  const engramStackRef = useRef(engramStack)
  engramStackRef.current = engramStack
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => () => {
    if (rollAnimTimer.current !== null) window.clearInterval(rollAnimTimer.current)
    if (errorFlashTimer.current !== null) window.clearTimeout(errorFlashTimer.current)
    if (diePressTimer.current !== null) window.clearTimeout(diePressTimer.current)
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    if (chargeInterval.current !== null) window.clearInterval(chargeInterval.current)
    if (flingTimer.current !== null) window.clearTimeout(flingTimer.current)
    if (confirmHoldTimer.current !== null) window.clearTimeout(confirmHoldTimer.current)
    if (confirmHoldInterval.current !== null) window.clearInterval(confirmHoldInterval.current)
    if (scrollLockedRef.current) { scrollLockedRef.current = false; unlockScroll() }
    if (dieScrollLockedRef.current) { dieScrollLockedRef.current = false; unlockScroll() }
    if (activePopupCloseRef === closePopup) activePopupCloseRef = null
    // Leaving the HUD (navigating away, or a reload) mid-roll used to just
    // drop everything silently: a pending Overload was never actually
    // spent from its pool (so the die looked available again on return),
    // and an already-activated Engram Stack's spent charges vanished for
    // nothing (neither consumed for real nor given back). Resolve both for
    // real right here instead — the Overload is spent as if Confirmed, and
    // the Engram Stack's charges are refunded since the roll it was
    // locked into never got Confirmed or sent to Margin.
    if (!resolvedRef.current) {
      if (onOverloadRef.current && pendingOverloadRef.current.size > 0 && !ignoreOverloadSpendRef.current) {
        let baseCount = 0
        let wardrobeCount = 0
        pendingOverloadRef.current.forEach((index) => {
          if (index >= availableAtRenderRef.current) wardrobeCount += 1
          else baseCount += 1
        })
        onOverloadRef.current(baseCount, wardrobeCount)
      }
      if (engramStackRef.current && onRefundEngramRef.current) {
        onRefundEngramRef.current(engramStackRef.current.id, engramStackRef.current.rolls.length)
      }
      // This only runs when unmount cleanup actually fires in the same JS
      // realm (e.g. a real component unmount, not the HUD iframe being
      // torn down and recreated — that case is instead handled by the
      // write-through persistence above, which keeps the roll genuinely
      // *unresolved* across the reload rather than finalizing it here).
      // Since this path just finalized the roll for real, drop the
      // persisted copy so a future mount doesn't restore a stale snapshot
      // that no longer matches the now-spent/refunded pools.
      savePersistedRoll(labelRef.current, null)
    }
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
    openPopup()
    setPendingOverload(new Set())
    setEngramStack(null)
    engramRollCacheRef.current = {}
    setConfirmHoldProgress(0)
    setSkillUsedIndices(new Set())
    setGritBonusDie(null)
    setIgnoreOverloadSpend(false)
    setGritRerollUsed(false)
    setResolved(false)
    resolvedOverloadRef.current = null
    // Don't remove the notification itself here — a Fumble queued by a
    // previous roll on this same Method is still a real pending
    // notification the player hasn't accepted yet. Just stop tracking it:
    // it's no longer this (new) roll's to replace.
    marginFumbleNotifIdRef.current = null
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
    if (scrollLockedRef.current) {
      scrollLockedRef.current = false
      unlockScroll()
    }
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
    // No Dice Mode: the hold-then-swipe roll gesture does nothing — pips
    // are tapped directly instead (see the pip-rendering block below).
    if (noDiceMode) return
    if (poolMax <= 0) return
    rolledThisGesture.current = false
    gestureStart.current = { x: event.clientX, y: event.clientY }
    // Lock page scroll for the duration of this hold-then-swipe — an
    // underlying scroll fighting the same finger movement used to make
    // the swipe threshold unreliable to hit.
    scrollLockedRef.current = true
    lockScroll()
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
      // No free rerolls: an unresolved result (not yet Confirmed or sent
      // to Margin) just reopens — the exact same dice, pending Overload,
      // and Engram Stack, rather than throwing them away for a fresh roll.
      if (result && !resolvedRef.current) {
        openPopup()
      } else {
        rollPool(poolMax)
      }
    }
  }

  const handlePointerCancel = () => {
    // A pointercancel (e.g. the OS took over for a system gesture) always
    // aborts — never rolls, even mid-gesture.
    cancelGesture()
  }

  // Overload doubles a die's face value. Nothing Explodes, so the Method's
  // own Total is simply the single highest die in the pool after any
  // Overloads — Engram Stack d4s (see engramStack state) are a flat
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
  const engramBonusTotal = engramStack ? engramStack.rolls.reduce((a, b) => a + b, 0) : 0
  // The Collapse "every roll" Total modifier (if any) is applied
  // automatically to every rolled Total — see the breakdown rendered
  // alongside "Total:" below. The Attack/Defense modifier is NOT part of
  // this — it only applies once this Total is sent to Margin (see
  // startMargin), since it only means something against an opposition.
  const displayTotal = dieMax + engramBonusTotal + totalAllModifier + (gritBonusDie ?? 0)

  // Use Skill (handbook p20, Dice Mode only): each tap rerolls the lowest
  // die not yet rerolled this roll, keeping the higher of old/new, and
  // marks it "Skill" — silently capped at `inference` rerolls per roll
  // (the button just disables, no counter shown). Locked the same way as
  // everything else once Confirmed/sent to Margin.
  const canUseSkill = !noDiceMode && !resolvedRef.current && !!result && skillUsedIndices.size < inference
  const useSkill = () => {
    if (!canUseSkill || !result) return
    const outcome = useSkillReroll(result.dice, skillUsedIndices)
    if (!outcome) return
    setResult({ ...result, dice: outcome.dice })
    setSkillUsedIndices((prev) => new Set(prev).add(outcome.index))
  }

  // Grit Menu (handbook p40, Dice Mode only) — each button spends 1 Grit
  // through the exact same path as tapping the Grit bar (spendGrit), so
  // dropping to 0 here still queues the "Grit reached 0" notification.
  //
  // Recalculating the Margin (±Grit menu, after the Margin is already
  // shown) must also re-decide the Fumble notification: pushNotification
  // is a no-op while one of the same kind is already pending, so without
  // first removing this roll's own earlier notice (if any), a Grit action
  // that brings the roll OUT of a Fumble would leave the stale "take N
  // Wounds" notification sitting there forever, and one that still misses
  // (just by a different amount) would never update its text.
  const applyMarginFumbleCheck = (computed: number) => {
    if (marginFumbleNotifIdRef.current) {
      removeNotification(marginFumbleNotifIdRef.current)
      marginFumbleNotifIdRef.current = null
    }
    if (isSaveRoll) return
    const wounds = computeFumbleWounds(computed, fumbleNumber)
    if (wounds > 0) {
      const miss = -computed
      const past = miss - fumbleNumber
      const created = pushNotification(
        "margin-fumble",
        "Fumble!",
        `${label}: missed by ${miss} (Fumble Number ${fumbleNumber > 0 ? -fumbleNumber : fumbleNumber}, ${past} past) — take ${wounds} Wound${wounds === 1 ? "" : "s"}.`,
        { hp: -wounds }
      )
      if (created) marginFumbleNotifIdRef.current = created.id
    }
  }

  // Grit stays usable after the Margin is shown (handbook p51: "you may
  // use Wing-It, Overload or Grit after your roll to bring the Margin up
  // out of a Fumble") — only the "fully locked" views (closed/past Margin
  // entirely, e.g. the Wound roll) shut it off; the Margin screen itself
  // doesn't, even though resolveOverloadIfNeeded already ran to get there.
  const gritMenuLocked = resolvedRef.current && view !== "margin-result"
  const gritAddD10 = () => {
    if (noDiceMode || gritMenuLocked || !result || gritBonusDie !== null || grit <= 0) return
    const rolled = Math.floor(Math.random() * 10) + 1
    if (!spendGrit(1)) return
    setGrit((g) => Math.max(0, g - 1))
    setGritBonusDie(rolled)
    if (view === "margin-result" && marginBase !== null) {
      const newBase = marginBase + rolled
      setMarginBase(newBase)
      const opposition = Number(oppositionInput)
      if (Number.isFinite(opposition)) {
        const computed = newBase - opposition
        setMargin(computed)
        applyMarginFumbleCheck(computed)
      }
    }
  }
  const gritIgnoreOverload = () => {
    if (noDiceMode || gritMenuLocked || pendingOverload.size === 0 || ignoreOverloadSpend || grit <= 0) return
    if (!spendGrit(1)) return
    setGrit((g) => Math.max(0, g - 1))
    // If the Overload was already spent (resolveOverloadIfNeeded already
    // ran — we're on the Margin screen now), give the die back; otherwise
    // it hasn't been spent yet and setting the flag below is enough to
    // stop resolveOverloadIfNeeded from ever spending it.
    if (resolvedOverloadRef.current) {
      const { base, wardrobe } = resolvedOverloadRef.current
      for (let i = 0; i < base; i++) onToggleOverloadPip?.("base", true)
      for (let i = 0; i < wardrobe; i++) onToggleOverloadPip?.("wardrobe", true)
      resolvedOverloadRef.current = null
    }
    setIgnoreOverloadSpend(true)
  }
  const gritReroll = () => {
    if (noDiceMode || gritRerollUsed || grit <= 0 || margin === null || margin >= 0) return
    if (!spendGrit(1)) return
    setGrit((g) => Math.max(0, g - 1))
    // Reroll the same number of dice as the first roll, not `poolMax` —
    // by the time Grit Reroll is available (a Margin has been calculated),
    // an Overloaded die has already been spent for real from the
    // available/Wardrobe pool, so `poolMax` is one die short of what was
    // actually rolled. The Overloaded die stays spent on the track either
    // way (handbook v12 p40/p51: Grit doesn't refund it); it just isn't
    // removed from the dice the Reroll rolls.
    const rerolled = onRoll(result?.dice.length ?? poolMax)
    setResult(rerolled)
    const newDieMax = rerolled.dice.reduce((max, d) => Math.max(max, d.total), 0)
    const newTotal = newDieMax + engramBonusTotal + totalAllModifier + (gritBonusDie ?? 0) + totalAttackDefenseModifier
    setMarginBase(newTotal)
    const opposition = Number(oppositionInput)
    if (Number.isFinite(opposition)) {
      const computed = newTotal - opposition
      setMargin(computed)
      applyMarginFumbleCheck(computed)
    }
    setGritRerollUsed(true)
  }
  const gritAddStatus = (status: "Hidden" | "Reckless") => {
    if (noDiceMode || grit <= 0) return
    if (!spendGrit(1)) return
    setGrit((g) => Math.max(0, g - 1))
    // On the Margin screen, marginBase (not displayTotal) is the current
    // Total — displayTotal's dieMax still reads pendingOverload against
    // whatever `result` is now, which after a Grit Reroll is a brand new
    // dice array; the old Overloaded index just points at a different,
    // unrelated die in it and would silently inflate this row's value.
    addSetRollRow(marginBase ?? displayTotal, { name: status, effect: GRIT_STATUS_EFFECT[status] })
  }
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

  // Engram Stack: activating the staged chip (sourced from the HUD's
  // Engram Q — see `stagedEngram`) rolls its dice ONCE and locks them into
  // this roll's Stack. The roller holds only one Engram type at a time —
  // activating a newly-staged Engram while a different one is already
  // this roll's Stack swaps it: the old Stack's charges are refunded,
  // then the new one rolls fresh. Once this roll is Confirmed/sent to
  // Margin (resolvedRef), the Stack is locked — no more swapping. Dice
  // never reroll: the same `engramStack.rolls` persist across close/reopen
  // (see closePopup/rollPool) until the Stack itself is replaced.
  const activateStagedEngram = () => {
    if (!stagedEngram || resolvedRef.current) return
    if (engramStack && engramStack.id === stagedEngram.id) return // already this Stack — nothing to do
    if (engramStack && onRefundEngram) {
      onRefundEngram(engramStack.id, engramStack.rolls.length)
    }
    // Reuse this Engram's cached rolls if it was already activated earlier
    // in this same roll (then swapped away) — only roll fresh the first
    // time an Engram is activated per roll.
    const cached = engramRollCacheRef.current[stagedEngram.id]
    const rolls = cached ?? rollFlatDice(stagedEngram.charges, 4)
    engramRollCacheRef.current[stagedEngram.id] = rolls
    setEngramStack({ id: stagedEngram.id, name: stagedEngram.name, rolls })
    onConsumeStagedEngram?.()
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
    if (dieScrollLockedRef.current) {
      dieScrollLockedRef.current = false
      unlockScroll()
    }
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
  // one of the 3 remaining cardinal directions fires that direction's
  // action — up doubles *this* die, down sends the Total to the Set list,
  // right starts the Margin flow (left no longer does anything — Confirm
  // moved to a long-press on the Total line, see confirmHoldProgress).
  // Moving too far before arming cancels the whole press, same guard the
  // Method row's own hold-then-swipe uses.
  const handleDiePointerDown = (index: number, event: React.PointerEvent<HTMLButtonElement>) => {
    // Note: NOT gated on resolvedRef — Send to Set/Margin must keep
    // working after the Total's long-press Confirms a pending Overload.
    // Only the Overload-specific actions (addOverload/removeOverload
    // below) stay guarded by resolvedRef, so a resolved die can no longer
    // be doubled or un-doubled, but every other die gesture keeps working.
    dieSuppressClick.current = false
    dieSwipeDirRef.current = null
    setDieSwipeDir(null)
    dieGestureStart.current = { x: event.clientX, y: event.clientY }
    dieScrollLockedRef.current = true
    lockScroll()
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
        // Left no longer does anything — Confirm moved to a long-press on
        // the Total line (see confirmHoldProgress below), since the
        // left-swipe gesture here was unreliable.
        : null
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
    } else {
      setDieFling({ index, dir: "right" }) // swipe right: Create Margin
      flingTimer.current = window.setTimeout(() => { startMargin(displayTotal + totalAttackDefenseModifier); setDieFling(null) }, FLING_DURATION_MS)
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

  // Confirm — long-press the Total line. Replaces the old die-pickup
  // swipe-left Confirm, which players found unreliable. Locks in any
  // pending Overload (resolveOverloadIfNeeded) AND the current Engram
  // Stack (resolvedRef also gates activateStagedEngram/onRefundEngram) in
  // one gesture, without leaving the result screen.
  const confirmHoldTimer = useRef<number | null>(null)
  const confirmHoldInterval = useRef<number | null>(null)
  const cancelConfirmHold = () => {
    if (confirmHoldTimer.current !== null) { window.clearTimeout(confirmHoldTimer.current); confirmHoldTimer.current = null }
    if (confirmHoldInterval.current !== null) { window.clearInterval(confirmHoldInterval.current); confirmHoldInterval.current = null }
    setConfirmHoldProgress(0)
  }
  const startConfirmHold = () => {
    if (resolvedRef.current) return
    const start = Date.now()
    confirmHoldInterval.current = window.setInterval(() => {
      setConfirmHoldProgress(Math.min(100, ((Date.now() - start) / STANDARD_LONG_PRESS_MS) * 100))
    }, 30)
    confirmHoldTimer.current = window.setTimeout(() => {
      cancelConfirmHold()
      vibrate(VIBRATE_PIP_MS * 2)
      resolveOverloadIfNeeded()
    }, STANDARD_LONG_PRESS_MS)
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
    applyMarginFumbleCheck(computed)
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
  // sheet (a Method's base rating can never exceed STAT_AND_METHOD_MAX,
  // and the combined pool — base + Wardrobe — never rolls more than
  // STAT_AND_METHOD_MAX dice either, see `displayWardrobeBonus` above).
  // Circles past baseRating + displayWardrobeBonus are locked (this
  // Method hasn't grown a die there, nor does Wardrobe add one within
  // the 6-die cap). Base and Wardrobe are two separate pools mechanically
  // (different caps, spent
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
  // Methods cap out at STAT_AND_METHOD_MAX (6) dice per roll (see
  // `poolMax` above) no matter how many Wardrobe pieces are stacked, so
  // the display — track pips, locked slots, and the "plus X of Y from
  // Wardrobe" label — must cap Wardrobe's contribution at whatever's left
  // of that 6 after the base rating, instead of showing every Wardrobe
  // die even past the point where it can ever actually roll.
  const displayWardrobeBonus = Math.max(0, Math.min(wardrobeBonus, STAT_AND_METHOD_MAX - trackMax))
  const displayWardrobeAvail = Math.min(wardrobeAvail, displayWardrobeBonus)
  const wardrobeTrackCurrent = Math.max(0, Math.min(displayWardrobeAvail, displayWardrobeBonus))
  const isDepleted = poolMax <= 0 && trackMax + displayWardrobeBonus > 0
  const totalSlots = STAT_AND_METHOD_MAX

  const rollHint = noDiceMode
    ? "Tap a pip to Overload it"
    : poolMax <= 0
    ? "No dice"
    : errorFlash
    ? "No more dice"
    : armed
    ? `Swipe to roll ${poolMax}`
    : "Hold, then swipe to roll"

  // Grit Menu (handbook p40) — shown both in the result view (before Margin
  // is started) and the margin-result view (where Reroll becomes relevant,
  // once a miss is shown) rather than duplicating the JSX in both places.
  const gritZeroHint = "Resolve Grit reached 0 first"
  const gritMenuEl = !noDiceMode && (
    <div className="approach-die-grit-menu" aria-label="Grit Menu">
      <span className="approach-die-grit-menu-label">Grit</span>
      <button
        type="button"
        className="approach-die-grit-btn"
        disabled={gritMenuLocked || gritBonusDie !== null || grit <= 0 || gritZeroPending}
        onClick={(event) => { event.stopPropagation(); gritAddD10() }}
        title={gritZeroPending ? gritZeroHint : "Spend 1 Grit: roll 1d10 and add it to the Total (once per roll) — still usable on the Margin screen"}
      >
        +1d10
      </button>
      <button
        type="button"
        className="approach-die-grit-btn"
        disabled={gritMenuLocked || pendingOverload.size === 0 || ignoreOverloadSpend || grit <= 0 || gritZeroPending}
        onClick={(event) => { event.stopPropagation(); gritIgnoreOverload() }}
        title={gritZeroPending ? gritZeroHint : "Spend 1 Grit: the die Overloaded this roll doesn't count as spent — refunds it if it was already spent"}
      >
        Ignore Overload
      </button>
      <button
        type="button"
        className="approach-die-grit-btn"
        disabled={gritRerollUsed || grit <= 0 || margin === null || margin >= 0 || gritZeroPending}
        onClick={(event) => { event.stopPropagation(); gritReroll() }}
        title={gritZeroPending ? gritZeroHint : "Spend 1 Grit: reroll the whole pool once (must keep the new result)"}
      >
        Reroll
      </button>
      <button
        type="button"
        className="approach-die-grit-btn"
        disabled={grit <= 0 || gritZeroPending}
        onClick={(event) => { event.stopPropagation(); gritAddStatus("Hidden") }}
        title={gritZeroPending ? gritZeroHint : "Spend 1 Grit: adds Hidden to Set Rolls — this Total is your Set value"}
      >
        Hidden
      </button>
      <button
        type="button"
        className="approach-die-grit-btn"
        disabled={grit <= 0 || gritZeroPending}
        onClick={(event) => { event.stopPropagation(); gritAddStatus("Reckless") }}
        title={gritZeroPending ? gritZeroHint : "Spend 1 Grit: adds Reckless to Set Rolls — this Total is your Set value"}
      >
        Reckless
      </button>
    </div>
  )

  return (
    <div
      ref={boxRef}
      className={`method-row${armed ? " armed" : ""}${errorFlash ? " error" : ""}`}
    >
      <button
        type="button"
        className="method-row-roll"
        aria-label={`${label}, ${available} of ${baseRating} base dice available${displayWardrobeBonus > 0 ? `, plus ${displayWardrobeAvail} of ${displayWardrobeBonus} from Wardrobe` : ""}. ${rollHint}.`}
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
          ...Array.from({ length: displayWardrobeBonus - wardrobeTrackCurrent }, (_, index) => ({ key: `wardrobe-spent-${index}`, origin: "wardrobe" as const, spent: true })),
        ].map((pip, index) => {
          const slot = index + 1
          const isWardrobe = pip.origin === "wardrobe"
          const isAvailable = !pip.spent
          const isPreview = armed && isAvailable
          return (
            <span
              key={pip.key}
              className={`method-die-pip${isWardrobe ? " wardrobe" : ""}${isAvailable ? " available" : " spent"}${isPreview ? " drag-preview" : ""}${noDiceMode ? " no-dice-tappable" : ""}`}
              style={{ gridColumn: slot, WebkitUserSelect: noDiceMode ? "none" : undefined, WebkitTouchCallout: noDiceMode ? "none" : undefined }}
              title={
                isWardrobe
                  ? `Wardrobe bonus die${wardrobeItems.length ? ` (${wardrobeItems.join(", ")})` : ""}. Always rolled; ${pip.spent ? "spent (Overloaded away)." : "Overload-spendable, same as a base die."}`
                  : undefined
              }
              aria-hidden={isWardrobe ? undefined : "true"}
              role={noDiceMode ? "button" : undefined}
              onPointerDown={noDiceMode ? (event) => event.stopPropagation() : undefined}
              onClick={noDiceMode ? () => onToggleOverloadPip?.(pip.origin, pip.spent) : undefined}
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
        {Array.from({ length: Math.max(0, STAT_AND_METHOD_MAX - trackMax - displayWardrobeBonus) }, (_, index) => (
          <span
            key={`locked-${index}`}
            className="method-die-pip locked"
            style={{ gridColumn: trackMax + displayWardrobeBonus + index + 1 }}
            aria-hidden="true"
          >
            {trackMax + displayWardrobeBonus + index + 1}
          </span>
        ))}
      </div>

      {(rolling || result) && popupVisible && createPortal(
        <>
          {(() => {
            const dismiss = (event: React.PointerEvent) => {
              event.preventDefault()
              closePopup()
            }
            if (!boxRect) {
              return (
                <div
                  className="approach-die-popup-backdrop"
                  style={{ top: 0, left: 0, right: 0, bottom: 0 }}
                  onPointerDown={dismiss}
                />
              )
            }
            // Four bands framing boxRect, leaving it as a hole so a
            // re-press there still reaches the real box underneath.
            return (
              <>
                <div
                  className="approach-die-popup-backdrop"
                  style={{ top: 0, left: 0, right: 0, height: Math.max(0, boxRect.top) }}
                  onPointerDown={dismiss}
                />
                <div
                  className="approach-die-popup-backdrop"
                  style={{ top: boxRect.bottom, left: 0, right: 0, bottom: 0 }}
                  onPointerDown={dismiss}
                />
                <div
                  className="approach-die-popup-backdrop"
                  style={{ top: boxRect.top, left: 0, width: Math.max(0, boxRect.left), height: boxRect.height }}
                  onPointerDown={dismiss}
                />
                <div
                  className="approach-die-popup-backdrop"
                  style={{ top: boxRect.top, left: boxRect.right, right: 0, height: boxRect.height }}
                  onPointerDown={dismiss}
                />
              </>
            )
          })()}
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
                      className={`approach-die-chip${pendingOverload.has(index) ? " overloaded" : ""}${isTop ? " top" : ""}${isPressing ? " pressing" : ""}${isArmed ? " armed" : ""}${fling ? ` fling-${fling}` : ""}${skillUsedIndices.has(index) ? " skill-used" : ""}`}
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
                          ? "Tap to undo this Overload · hold the Total below to Confirm it for good"
                          : "Hold, then swipe: up Doubles, down sends to Set, right starts Margin"
                      }
                    >
                      <span
                        className={`rising-progress-fill${isPressing ? " timed active" : ""}${isArmed ? " active" : ""}${isArmed && dieSwipeDir ? " ready" : ""}`}
                        aria-hidden="true"
                      />
                      {dieRoll.rolls[0]}
                      {pendingOverload.has(index) && <span className="approach-die-chip-doubled">DOUBLED</span>}
                      {skillUsedIndices.has(index) && <span className="approach-die-chip-skill">SKILL</span>}
                    </button>
                  )
                })}
              </div>
              {(engramStack || (stagedEngram && !resolvedRef.current)) && (
                <div className="approach-die-engram-row" aria-label="Engram Stack">
                  {engramStack && (
                    <span
                      className="approach-die-engram-chip spent"
                      title={`${engramStack.name}: ${engramStack.rolls.join(" + ")} — locked in for this roll`}
                    >
                      <span className="approach-die-engram-chip-name">{engramStack.name}</span>
                      <span className="approach-die-engram-chip-dice">
                        {engramStack.rolls.map((roll, index) => (
                          <span key={index} className="approach-die-engram-die">{roll}</span>
                        ))}
                      </span>
                    </span>
                  )}
                  {stagedEngram && !resolvedRef.current && stagedEngram.id !== engramStack?.id && (
                    <button
                      type="button"
                      className="approach-die-engram-chip standby"
                      onClick={(event) => { event.stopPropagation(); activateStagedEngram() }}
                      title={
                        engramStack
                          ? `Swap the Stack: refunds ${engramStack.name} and rolls ${stagedEngram.charges}d4 for ${stagedEngram.name} instead`
                          : `Roll ${stagedEngram.charges}d4 for ${stagedEngram.name} and add it to this roll — final, can't be undone`
                      }
                    >
                      <span className="approach-die-engram-chip-name">{stagedEngram.name}</span>
                      <span className="approach-die-engram-chip-count">×{stagedEngram.charges}</span>
                    </button>
                  )}
                </div>
              )}
              <div
                className={`approach-die-popup-total${resolvedRef.current ? "" : " confirmable"}`}
                onPointerDown={(event) => { event.stopPropagation(); startConfirmHold() }}
                onPointerUp={(event) => { event.stopPropagation(); cancelConfirmHold() }}
                onPointerLeave={cancelConfirmHold}
                onPointerCancel={cancelConfirmHold}
                onContextMenu={(event) => event.preventDefault()}
                title={resolvedRef.current ? undefined : "Hold to Confirm — locks in any Overload and the Engram Stack for good"}
              >
                <span
                  className={`rising-progress-fill timed${confirmHoldProgress > 0 ? " active" : ""}`}
                  style={{ ["--hold-progress-ms" as string]: `${STANDARD_LONG_PRESS_MS}ms` } as CSSProperties}
                  aria-hidden="true"
                />
                Total: {displayTotal}{" "}
                {(engramBonusTotal > 0 || overloadedIndex !== null || totalAllModifier !== 0 || gritBonusDie !== null) && (
                  <span className="approach-die-popup-total-sub">
                    (
                    {overloadedIndex !== null && overloadedBaseValue !== null
                      ? `${overloadedBaseValue} doubled to ${overloadedBaseValue * 2}`
                      : `${dieMax} die`}
                    {engramBonusTotal > 0 ? ` + ${engramBonusTotal} Engram` : ""}
                    {gritBonusDie !== null ? ` + ${gritBonusDie} Grit` : ""}
                    {totalAllModifier !== 0 ? ` ${totalAllModifier > 0 ? "+" : "−"} ${Math.abs(totalAllModifier)} Collapse` : ""})
                  </span>
                )}
              </div>
              <div className="approach-die-popup-swipe-hint">
                ↑ Double · ↓ Send to Set · → Margin · Hold Total to Confirm
              </div>
              {!noDiceMode && inference >= 1 && (
                <button
                  type="button"
                  className="approach-die-use-skill-btn"
                  disabled={!canUseSkill}
                  onClick={(event) => { event.stopPropagation(); useSkill() }}
                  title="Reroll the lowest die not yet rerolled this roll, keeping the higher value"
                >
                  Use Skill
                </button>
              )}
              {gritMenuEl}
            </>
          )}


          {view === "margin-input" && (
            <div className="approach-margin-input">
              {totalAttackDefenseModifier !== 0 && (
                <div className="approach-margin-attacker-total">
                  Attacker Total: {marginBase} ({displayTotal} {totalAttackDefenseModifier > 0 ? "+" : "−"} {Math.abs(totalAttackDefenseModifier)} Collapse)
                </div>
              )}
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
              {gritRerollUsed && result && (
                <div className="approach-margin-reroll-note">
                  Rerolled: {result.dice.map((d) => d.total).join(" · ")} → Total {marginBase}
                </div>
              )}
              {margin > 0 && (
                <button type="button" className="approach-roll-path-btn" onClick={(e) => { e.stopPropagation(); handleRollDamage() }}>
                  Roll Wounds ({margin}{dieLabel(damageDie)})
                </button>
              )}
              {gritMenuEl}
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
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
