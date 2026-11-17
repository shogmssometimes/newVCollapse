import { useRef } from "react";
import { createLongPressHandlers } from "../../utils/createLongPressHandlers";

export function StatCard({
  label,
  value,
  onIncr,
  onDecr,
}: {
  label: string;
  value: number;
  onIncr: () => void;
  onDecr: () => void;
}) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  // Tap decrements, long-press (or right-click) increments — mirrors the
  // Quality control's "hold to raise" gesture so a stray tap can't bump
  // this stat up by accident.
  const handlers = createLongPressHandlers(timerRef, firedRef, onDecr, onIncr);
  return (
    <div
      className="core-card interactive"
      role="button"
      tabIndex={0}
      aria-label={`${label} ${value}. Tap to decrease, long-press to increase.`}
      style={{ touchAction: "manipulation" }}
      {...handlers}
    >
      <span className="core-label">{label}</span>
      <div className="core-controls">
        <span className="core-value">{value}</span>
      </div>
    </div>
  );
}
