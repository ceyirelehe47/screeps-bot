import { TREASURY_T1_LANE } from "@/runtime/treasuryTerminalLane";
import { readTreasuryLaneQuota, readTreasuryLaneResponsibility } from "@/runtime/treasuryTerminalResponsibility";
export type { TreasuryT1Quota, TreasuryT1Responsibility } from "@/runtime/treasuryTerminalResponsibility";
export const readTreasuryT1Quota = () => readTreasuryLaneQuota(TREASURY_T1_LANE);
export const readTreasuryT1Responsibility = () => readTreasuryLaneResponsibility(TREASURY_T1_LANE);
