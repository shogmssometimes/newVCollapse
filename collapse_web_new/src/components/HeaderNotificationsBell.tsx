import { useCallback, useEffect, useState } from "react";
import { NotificationsTray } from "../chud/components/NotificationsTray";
import {
  getNotificationsStorageKey,
  listNotifications,
  pushNotification,
  removeNotification,
  setNotificationsSlot,
  type PendingNotification,
} from "../domain/notifications";
import {
  adjustGlobalMeters,
  adjustHpCounter,
  maxGritForCollapse,
  readCollapseModifiers,
  readCollapsePath,
  readCore,
  readGlobalMeters,
  readHpCounter,
  setCollapsePath,
  resetApproachOverload,
  resetGanbareCharges,
  setVanillaBridgeSlot,
} from "../utils/chudVanillaBridge";
import { computeDerived, DEFAULT_COLLAPSE_MODIFIERS } from "../domain/chudStats";
import { chudStateKey, deckBuilderKey } from "../utils/slotKeys";
import { fullRestEngrams } from "../utils/engramState";

/**
 * Outer-app header bell for the shared notifications queue (HP hitting 0,
 * Dig Deep, etc). Lives in the main app window rather than the CHUD iframe,
 * so it reads/writes the same localStorage-backed queue directly and
 * applies accepted effects straight to the active slot's storage (there's
 * no live Chud.tsx instance in this window to delegate to).
 */
export function HeaderNotificationsBell({ charSlot }: { charSlot: number }) {
  const [notifications, setNotifications] = useState<PendingNotification[]>(() => {
    // charSlot is a prop, not a URL param, so (unlike the CHUD iframe) it can
    // change at runtime — point the shared queue/bridge at it before the very
    // first read, and again below whenever it changes (B2).
    setNotificationsSlot(charSlot);
    setVanillaBridgeSlot(charSlot);
    return listNotifications();
  });

  useEffect(() => {
    setNotificationsSlot(charSlot);
    setVanillaBridgeSlot(charSlot);
    setNotifications(listNotifications());
  }, [charSlot]);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== getNotificationsStorageKey()) return;
      setNotifications(listNotifications());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const resolve = useCallback(
    (id: string, accept: boolean) => {
      const n = notifications.find((item) => item.id === id);
      if (n && accept) {
        if (n.effect.hp) adjustHpCounter(n.effect.hp, chudStateKey(charSlot));
        // Resolved live against this slot's current HP/Grit/Collapse right
        // now — not a delta baked in when the notification was queued,
        // which would go stale if another notification (e.g. Dig Deep then
        // Full Rest) was accepted first while this one still sat pending.
        if (n.effect.setHpToMax) {
          const key = chudStateKey(charSlot);
          const core = readCore(key) ?? { vigor: 0, inference: 0, personality: 0 };
          const modifiers = readCollapseModifiers(key) ?? DEFAULT_COLLAPSE_MODIFIERS;
          const hpMax = computeDerived(core, modifiers).hp;
          adjustHpCounter(hpMax - readHpCounter(key), key);
        }
        // Revive sets HP to exactly 1 (not a +1 delta) — see
        // reviveHp1 in notifications.ts.
        if (n.effect.reviveHp1) {
          const key = chudStateKey(charSlot);
          adjustHpCounter(1 - readHpCounter(key), key);
        }
        if (n.effect.gritGainRaw != null || n.effect.gritSetRaw != null) {
          const { grit: currentGrit, collapse: currentCollapse } = readGlobalMeters();
          const maxGrit = maxGritForCollapse(currentCollapse);
          const target =
            n.effect.gritSetRaw != null
              ? Math.min(maxGrit, n.effect.gritSetRaw)
              : Math.min(maxGrit, currentGrit + (n.effect.gritGainRaw ?? 0));
          adjustGlobalMeters({ grit: target - currentGrit });
        }
        if (n.effect.grit != null || n.effect.collapse != null) {
          adjustGlobalMeters({ grit: n.effect.grit, collapse: n.effect.collapse });
        }
        if (n.effect.restoreOverload) {
          // Full Rest restores spent Overload dice AND refills Ganbare!
          // Charges (handbook v12 p42) — must match Chud.tsx's own
          // restoreOverload handling, since Full Rest can also be accepted
          // from this bell on the AAG or any other page, not just the HUD.
          resetApproachOverload(chudStateKey(charSlot));
          resetGanbareCharges(chudStateKey(charSlot));
        }
        if (n.effect.fullEngramRestore) fullRestEngrams(deckBuilderKey(charSlot));
        if (n.kind === "hp-zero" && !n.effect.narrativeDeath) {
          const path = readCollapsePath(chudStateKey(charSlot));
          const pathLabel = path ? `${path[0].toUpperCase()}${path.slice(1)}` : null;
          pushNotification(
            "collapse-table",
            "Roll on Collapse Table",
            pathLabel
              ? `Roll on the "${pathLabel}" Collapse Table in the handbook.`
              : "Roll on the Collapse Table in the handbook.",
            {}
          );
        }
      }
      removeNotification(id);
      setNotifications(listNotifications());
    },
    [notifications, charSlot]
  );

  // "Choose Your Path" resolves via a button tap instead of accept/cancel —
  // persist the choice directly to the slot's CHUD state and clear it.
  const choose = useCallback(
    (id: string, key: string) => {
      const n = notifications.find((item) => item.id === id);
      if (n?.kind === "choose-path") {
        setCollapsePath(key, chudStateKey(charSlot));
      }
      removeNotification(id);
      setNotifications(listNotifications());
    },
    [notifications, charSlot]
  );

  return (
    <NotificationsTray
      notifications={notifications}
      onAccept={(id) => resolve(id, true)}
      onCancel={(id) => resolve(id, false)}
      onChoice={choose}
    />
  );
}
