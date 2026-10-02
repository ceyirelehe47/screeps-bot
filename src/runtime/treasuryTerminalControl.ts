import { createTreasuryFirstLiveState, type Read } from "@/runtime/treasuryFirstLiveState";
import { createTreasuryFirstLiveControl } from "@/runtime/treasuryFirstLiveControl";
import { createTreasuryContinuousOHControl, readTreasuryContinuousOHControl } from "@/runtime/treasuryContinuousOHControl";
import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { readTreasuryContinuousOHFenceControl } from "@/runtime/treasuryContinuousOHFence";

/** 持续控制拥有独立账本，旧一次性主镜像协议原样保留。 */
export function readTreasuryTerminalControl(lane: TreasuryTerminalLane): Read {
  return lane.continuous ? readTreasuryContinuousOHControl() : createTreasuryFirstLiveState(lane).readControl();
}
export function createTreasuryTerminalControl(lane: TreasuryTerminalLane) {
  return lane.continuous ? createTreasuryContinuousOHControl() : createTreasuryFirstLiveControl(lane);
}
export function readTreasuryTerminalFenceControl(lane: TreasuryTerminalLane): Read {
  return lane.continuous ? readTreasuryContinuousOHFenceControl() : readTreasuryTerminalControl(lane);
}
