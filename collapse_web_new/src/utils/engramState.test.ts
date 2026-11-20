import { beforeEach, describe, expect, it } from "vitest";
import {
  addEngramCharge,
  fullRestEngrams,
  readEngramState,
  refundEngramCharges,
  setEngramCopies,
  spendAllEngramCharges,
} from "./engramState";

// Minimal localStorage + window.dispatchEvent polyfill — same approach as
// chudVanillaBridge.test.ts, since this module is normally only exercised
// in a browser.
function installFakeWindow() {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    dispatchEvent: () => true,
  };
}

const KEY = "deckBuilder.slot0";
const ID = "fortify";

beforeEach(() => {
  installFakeWindow();
});

describe("addEngramCharge after spendAllEngramCharges", () => {
  it("does not let a tap reload a spent use before a Full Rest (regression: free recharge)", () => {
    setEngramCopies(KEY, ID, 1);
    addEngramCharge(KEY, ID); // 0 -> 1 (loaded)
    expect(readEngramState(KEY).equipped[ID].charges).toBe(1);

    const spent = spendAllEngramCharges(KEY, ID); // activate: uses one up permanently
    expect(spent).toBe(1);
    expect(readEngramState(KEY).equipped[ID].charges).toBe(0);
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);

    // A tap used to reload charges back up to `copies` here, letting the
    // player activate the same Engram again for free. It must stay at 0
    // until a Full Rest.
    addEngramCharge(KEY, ID);
    expect(readEngramState(KEY).equipped[ID].charges).toBe(0);

    fullRestEngrams(KEY);
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(1);
    expect(readEngramState(KEY).equipped[ID].charges).toBe(1); // Full Rest reloads charges too
    addEngramCharge(KEY, ID); // at cap (1) already -> wraps to 0
    expect(readEngramState(KEY).equipped[ID].charges).toBe(0);
    addEngramCharge(KEY, ID); // can load back up to 1 now that usesLeft allows it
    expect(readEngramState(KEY).equipped[ID].charges).toBe(1);
  });

  it("refunding an unconsumed Stack (swapped away before Confirm) restores usesLeft, not just charges", () => {
    setEngramCopies(KEY, ID, 2);
    addEngramCharge(KEY, ID);
    addEngramCharge(KEY, ID); // charges = 2
    spendAllEngramCharges(KEY, ID); // staged, usesLeft -> 0
    refundEngramCharges(KEY, ID, 2); // never actually rolled into a confirmed roll
    const state = readEngramState(KEY).equipped[ID];
    expect(state.charges).toBe(2);
    expect(state.usesLeft).toBe(2);
    addEngramCharge(KEY, ID); // wraps back to 0 since charges === usesLeft cap
    expect(readEngramState(KEY).equipped[ID].charges).toBe(0);
  });
});
