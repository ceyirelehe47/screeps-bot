import { TREASURY_T3_LANE } from "@/runtime/treasuryTerminalLane";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
export { runtime, finiteNonNegative, treasuryT1SerializedBytes, type Control, type Payload, type Read } from "@/runtime/treasuryFirstLiveState";
export const PRIMARY = TREASURY_T3_LANE.controlKey;
export const MIRROR = TREASURY_T3_LANE.controlMirrorKey;
export const CONTROL_RUN_ID = TREASURY_T3_LANE.controlRunId;
const state = createTreasuryFirstLiveState(TREASURY_T3_LANE);
export const seal = state.seal;
export const readTreasuryT3FirstLiveControl = state.readControl;
