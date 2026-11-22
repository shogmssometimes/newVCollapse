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
    // Full Rest hands the use back but doesn't preload the Q — charges
    // reset to 0 so the player still chooses what to tap up.
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

  it("adding copies grants usesLeft for the added copies (regression: Wing-It x2 stuck at 0/2)", () => {
    setEngramCopies(KEY, ID, 1);
    addEngramCharge(KEY, ID);
    spendAllEngramCharges(KEY, ID); // spend the single copy's only use
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);

    setEngramCopies(KEY, ID, 2); // equip a second copy
    const state = readEngramState(KEY).equipped[ID];
    expect(state.copies).toBe(2);
    expect(state.usesLeft).toBe(1); // the added copy brings its own use

    // A decrease back down to 1 copy still only has 1 unit of pool total,
    // against which 1 use has already been spent — usesLeft is 0, not
    // left over at 1 (see the "removing then re-adding a copy" regression
    // test below for why usesLeft can't just be clamped-not-reduced here).
    setEngramCopies(KEY, ID, 1);
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);
  });

  it("removing then re-adding copies does not refill already-spent uses without a Full Rest (regression)", () => {
    setEngramCopies(KEY, ID, 2);
    addEngramCharge(KEY, ID);
    addEngramCharge(KEY, ID); // charges = 2
    spendAllEngramCharges(KEY, ID); // both copies' uses spent
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);

    setEngramCopies(KEY, ID, 1); // remove a copy
    setEngramCopies(KEY, ID, 2); // and re-add it
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);

    setEngramCopies(KEY, ID, 0); // fully unequip
    setEngramCopies(KEY, ID, 2); // and re-equip both copies
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(0);

    fullRestEngrams(KEY);
    expect(readEngramState(KEY).equipped[ID].usesLeft).toBe(2);
  });
});
