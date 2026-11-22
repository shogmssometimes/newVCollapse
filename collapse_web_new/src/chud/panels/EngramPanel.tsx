import { EngramBriefWidget } from "../components/EngramBriefWidget";
import type { EngramManagerState } from "../../utils/engramState";

// Engram queue widget, always visible (no accordion box) — same treatment
// as the Gear queue, cycling through equipped Engrams with charges left.
export function EngramPanel({
  engramState,
  engramStorageKey,
  onStageForRoller,
  noDiceMode,
}: {
  engramState: EngramManagerState;
  engramStorageKey: string;
  onStageForRoller: (id: string, name: string, charges: number) => void;
  noDiceMode?: boolean;
}) {
  return (
    <div className="mods">
      <EngramBriefWidget
        state={engramState}
        storageKey={engramStorageKey}
        onStageForRoller={onStageForRoller}
        noDiceMode={noDiceMode}
      />
    </div>
  );
}
