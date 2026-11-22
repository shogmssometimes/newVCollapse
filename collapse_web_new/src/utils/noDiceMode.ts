// "No Dice Mode" — a per-device (not per-character, not network-synced)
// toggle: when on, the app stops rolling anything and becomes a plain
// character sheet. Players roll and do math at the table; the app only
// records what they'd write on paper (spent/unspent dice, Set Roll
// values, Grit/HP). See Profile.tsx for the toggle UI. Shared verbatim by
// the GM app (its own hub reads/writes the exact same key) — there is no
// cross-device sync, it's just the same localStorage key read by whatever
// browser it's opened in.
export const NO_DICE_MODE_KEY = "collapse.noDiceMode";

export function isNoDiceMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(NO_DICE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNoDiceMode(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const value = next ? "1" : "0";
    window.localStorage.setItem(NO_DICE_MODE_KEY, value);
    // Same-tab reactivity — native `storage` events never fire in the tab
    // that made the change, only in other tabs/windows, so dispatch one
    // manually (same pattern as chudVanillaBridge.ts's `notify`).
    window.dispatchEvent(new StorageEvent("storage", { key: NO_DICE_MODE_KEY, newValue: value, storageArea: window.localStorage }));
  } catch {
    // storage unavailable — ignore
  }
}

/** Subscribes to No Dice Mode changes, same-tab or cross-tab. Returns an unsubscribe function. */
export function subscribeNoDiceMode(cb: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === NO_DICE_MODE_KEY) cb();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
