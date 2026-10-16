import { createTreasuryFirstLiveControl } from "@/runtime/treasuryFirstLiveControl";
import { createTreasuryContinuousOHControl } from "@/runtime/treasuryContinuousOHControl";
import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
export {
  readTreasuryTerminalControl,
  readTreasuryTerminalFenceControl,
} from "@/runtime/treasuryTerminalControlReadModel";

export function createTreasuryTerminalControl(lane: TreasuryTerminalLane) {
  return lane.continuous ? createTreasuryContinuousOHControl() : createTreasuryFirstLiveControl(lane);
}
