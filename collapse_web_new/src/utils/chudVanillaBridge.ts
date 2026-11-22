// Thin write-side bridge into the vanilla (non-React) HUD widgets that live
// in public/chud/meter-bridge.js. Both surfaces share the same origin, so
// writing these exact localStorage shapes (and re-dispatching a synthetic
// "storage" event, since same-tab writes don't fire one automatically) keeps
// the HUD in sync immediately rather than only on next load/cross-tab event.

import type { CollapseModifiers, CoreStats } from "../types/chud";
import { computeDerived, withCollapseModifiers } from "../domain/chudStats";
import { clampCore } from "../domain/coreApproachMap";
import { hasPendingNotification, pushNotification, queueHpZeroNotificationsIfNeeded } from "../domain/notifications";
import { isNoDiceMode } from "./noDiceMode";
import { statusRollsKey, csmatrixKey } from "./slotKeys";

// Set Rolls and the CS Matrix graph (which also holds the global
// Grit/Collapse meters) were previously read/written at these
// fixed keys regardless of which character slot was active (B2). Each realm
// that knows its active slot calls `setVanillaBridgeSlot` once so every
// function below targets that slot's own data instead. Defaults to slot 1
// (the legacy un-suffixed keys) so this is a no-op until a realm opts in.
let activeSlot = 1;

export function setVanillaBridgeSlot(slot: number): void {
  activeSlot = slot;
}

const STATUS_ROLLS_KEY = () => statusRollsKey(activeSlot);
const CSMATRIX_KEY = () => csmatrixKey(activeSlot);
const METER_MAX = 6;

type StatusRollRow = { id: string; name: string; effect: string; roll: number };
type StatusRollsState = { rows: StatusRollRow[] };
type GlobalMeters = { collapse?: number; grit?: number };
type CSMatrixGraph = { nodes?: unknown[]; edges?: unknown[]; meta?: { globalMeters?: GlobalMeters; [key: string]: unknown } };

const clampMeter = (n: number) => Math.max(0, Math.min(METER_MAX, n));

/** Max Grit is always `6 - Collapse` (handbook rule) — exported so any
 * surface previewing a Grit-granting effect (Rest Widget notification text,
 * etc.) can show the player the number that will actually land, instead of
 * repeating this formula and risking it drifting out of sync with the real
 * clamp applied in `adjustGlobalMeters` below. */
export const maxGritForCollapse = (collapse: number) => Math.max(0, METER_MAX - collapse);

function notify(key: string, json: string) {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: json, storageArea: window.localStorage }));
  } catch {
    // StorageEvent construction can fail in non-browser test environments — ignore.
  }
}

/**
 * Prepends a new Set Roll row (HUD "Set Rolls" widget) with the given value.
 * Name starts blank (not "New Effect") — a glow on the row instead marks it
 * as new until the player types their own name (see meter-bridge.js's Set
 * Rolls widget, which keys that glow off an empty name rather than this
 * pre-fill text so there's no boilerplate to delete every time). Placed at
 * the front of the list so it survives the widget's 10-row display cap.
 *
 * No Dice Mode's Engram "Play" flow pre-fills `name`/`effect` instead (the
 * Engram's own name/effect text, so the row doesn't glow as "unnamed") and
 * sets `openValueEntry` so meter-bridge.js opens the tap-to-type value
 * field immediately — the player still has to type what they rolled at
 * the table.
 */
export function addSetRollRow(value: number, options?: { name?: string; effect?: string; openValueEntry?: boolean }): void {
  try {
    const raw = window.localStorage.getItem(STATUS_ROLLS_KEY());
    const parsed: StatusRollsState = raw ? JSON.parse(raw) : { rows: [] };
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const row: StatusRollRow & { openValueEntry?: boolean } = {
      id: `sr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: options?.name ?? "",
      effect: options?.effect ?? "",
      roll: value,
      ...(options?.openValueEntry ? { openValueEntry: true } : {}),
    };
    const json = JSON.stringify({ rows: [row, ...rows] });
    window.localStorage.setItem(STATUS_ROLLS_KEY(), json);
    notify(STATUS_ROLLS_KEY(), json);
  } catch {
    // storage unavailable — ignore
  }
}

/**
 * Applies a delta to the CS Matrix's Grit/Collapse global meters (mirrors
 * the clamp/maxGrit math in meter-bridge.js's buildGritCollapseMeter so both
 * surfaces agree on the result). Used when a notification is accepted.
 */
export function adjustGlobalMeters(delta: { grit?: number; collapse?: number }): void {
  try {
    const raw = window.localStorage.getItem(CSMATRIX_KEY());
    const graph: CSMatrixGraph = raw ? JSON.parse(raw) : { nodes: [], edges: [], meta: {} };
    graph.meta = graph.meta || {};
    const meta = graph.meta.globalMeters || {};
    const nextCollapse = clampMeter((meta.collapse ?? 0) + (delta.collapse ?? 0));
    const maxGrit = maxGritForCollapse(nextCollapse);
    const nextGrit = Math.min(maxGrit, Math.max(0, (meta.grit ?? 0) + (delta.grit ?? 0)));
    graph.meta.globalMeters = { ...meta, collapse: nextCollapse, grit: nextGrit };
    const json = JSON.stringify(graph);
    window.localStorage.setItem(CSMATRIX_KEY(), json);
    notify(CSMATRIX_KEY(), json);
  } catch {
    // storage unavailable — ignore
  }
}

/**
 * Applies a delta to the HP counter stored at the given (slot-aware)
 * `chud.state.v1`-style key, clamped to [0, hpMax] for that slot's current
 * Core stats. Used when a notification is accepted from outside the CHUD
 * iframe (e.g. the outer app's header bell), where there's no live Chud.tsx
 * instance to apply it.
 *
 * Also detects the >0 -> <=0 transition right here and queues the
 * "hp-zero"/"choose-path" notifications if needed — this has to happen at
 * every surface that can change HP, not just inside Chud.tsx, since the CHUD
 * iframe is a separate route from the outer app's pages (AAG, etc.) and
 * usually isn't mounted at all when a Dig Deep or Rest notification is
 * accepted from here.
 */
export function adjustHpCounter(delta: number, chudStateKey: string): void {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const current = typeof parsed.hpCounter === "number" ? parsed.hpCounter : 0;
    const core = clampCore((parsed.core as CoreStats | undefined) ?? { vigor: 0, inference: 0, personality: 0 });
    const modifiers = withCollapseModifiers(parsed.collapseModifiers as Partial<CollapseModifiers> | undefined);
    const hpMax = computeDerived(core, modifiers).hp;
    const next = Math.min(hpMax, Math.max(0, current + delta));
    const hasBeenDownedBefore = parsed.hasBeenDownedBefore === true;
    const nowDowned = queueHpZeroNotificationsIfNeeded(current, next, hasBeenDownedBefore);
    const json = JSON.stringify({
      ...parsed,
      hpCounter: next,
      ...(nowDowned ? { hasBeenDownedBefore: true } : {}),
    });
    window.localStorage.setItem(chudStateKey, json);
    notify(chudStateKey, json);
  } catch {
    // storage unavailable — ignore
  }
}

/**
 * Persists the player's one-time "Choose Your Path" answer (live/survive/die)
 * directly to the slot's CHUD state, for when the choice notification is
 * resolved from the outer app's header bell rather than the live iframe.
 */
export function setCollapsePath(path: string, chudStateKey: string): void {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const json = JSON.stringify({ ...parsed, collapsePath: path });
    window.localStorage.setItem(chudStateKey, json);
    notify(chudStateKey, json);
  } catch {
    // storage unavailable — ignore
  }
}

/**
 * Spends 1 Grit from the global meter through the exact same path as
 * tapping the Grit bar's left side (meter-bridge.js's buildGritCollapseMeter
 * tapDelta=-1 case) — used by the Grit Menu's spend buttons so dropping to
 * 0 here still queues the "grit reached 0" notification (+1 Collapse),
 * instead of silently decrementing with no side effect. Returns false
 * (nothing spent) if Grit is already 0 or its own "grit reached 0"
 * notification is still pending (locked out, same as the bar).
 */
export function spendGrit(amount = 1): boolean {
  if (hasPendingNotification("grit-zero")) return false;
  const { grit: prevGrit } = readGlobalMeters();
  if (prevGrit <= 0) return false;
  const next = Math.max(0, prevGrit - amount);
  adjustGlobalMeters({ grit: -(prevGrit - next) });
  if (next === 0) {
    if (isNoDiceMode()) {
      pushNotification(
        "grit-zero",
        "Grit reached 0",
        "+1 Collapse. Reroll Grit at the table and set it on the bar.",
        { collapse: 1 }
      );
    } else {
      const rolled = 1 + Math.floor(Math.random() * 6);
      pushNotification(
        "grit-zero",
        "Grit reached 0",
        "Accept to apply +1 Collapse and recover Grit, or cancel to leave Grit at 0.",
        { collapse: 1, grit: rolled },
        { roll: { die: 6, value: rolled } }
      );
    }
  }
  return true;
}

/** Reads the current Grit/Collapse global meters (for computing Full Rest's
 * absolute "set Grit" as a delta against whatever it currently is). */
export function readGlobalMeters(): { grit: number; collapse: number } {
  try {
    const raw = window.localStorage.getItem(CSMATRIX_KEY());
    const graph: CSMatrixGraph = raw ? JSON.parse(raw) : { meta: {} };
    const meta = graph.meta?.globalMeters ?? {};
    return { grit: meta.grit ?? 0, collapse: meta.collapse ?? 0 };
  } catch {
    return { grit: 0, collapse: 0 };
  }
}

/** Reads the current HP counter for the given (slot-aware) `chud.state.v1`
 * key, for computing Full Rest's "HP to max" as a delta. */
export function readHpCounter(chudStateKey: string): number {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    return typeof parsed.hpCounter === "number" ? parsed.hpCounter : 0;
  } catch {
    return 0;
  }
}

/** Resets the Approach Overload pool (Method dice) to fully unspent for the
 * given (slot-aware) `chud.state.v1` key — Full Rest only. */
export function resetApproachOverload(chudStateKey: string): void {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const prevSpent = (parsed.approachOverloadSpent as Record<string, number>) ?? {};
    const resetSpent = Object.fromEntries(Object.keys(prevSpent).map((k) => [k, 0]));
    const prevWardrobeSpent = (parsed.approachWardrobeOverloadSpent as Record<string, number>) ?? {};
    const resetWardrobeSpent = Object.fromEntries(Object.keys(prevWardrobeSpent).map((k) => [k, 0]));
    const json = JSON.stringify({
      ...parsed,
      approachOverloadSpent: resetSpent,
      approachWardrobeOverloadSpent: resetWardrobeSpent,
    });
    window.localStorage.setItem(chudStateKey, json);
    notify(chudStateKey, json);
  } catch {
    // storage unavailable — ignore
  }
}

/** Restores all Ganbare! Charges (spent count back to 0) for the given
 * (slot-aware) `chud.state.v1` key — Full Rest only. */
export function resetGanbareCharges(chudStateKey: string): void {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const json = JSON.stringify({ ...parsed, ganbareSpent: 0 });
    window.localStorage.setItem(chudStateKey, json);
    notify(chudStateKey, json);
  } catch {
    // storage unavailable — ignore
  }
}

/** Reads the current Core stats for the given (slot-aware) `chud.state.v1`
 * key, for computing Full Rest's HP-to-max delta. */
export function readCore(chudStateKey: string): { vigor: number; inference: number; personality: number } | undefined {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    return parsed.core as { vigor: number; inference: number; personality: number } | undefined;
  } catch {
    return undefined;
  }
}

/** Reads the current Collapse Modifiers for the given (slot-aware)
 * `chud.state.v1` key, back-filling any missing fields to 0 — used
 * wherever a derived stat needs to be computed outside Aag.tsx/Chud.tsx
 * (e.g. RestWidget's Full Rest HP-to-max delta when it has no live `core`
 * prop to read from). */
export function readCollapseModifiers(chudStateKey: string): CollapseModifiers | undefined {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    return withCollapseModifiers(parsed.collapseModifiers as Partial<CollapseModifiers> | undefined);
  } catch {
    return undefined;
  }
}


export function readCollapsePath(chudStateKey: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(chudStateKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.collapsePath === "string" ? parsed.collapsePath : undefined;
  } catch {
    return undefined;
  }
}
