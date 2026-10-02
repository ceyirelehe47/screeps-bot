import { TREASURY_T3_LANE } from "@/runtime/treasuryTerminalLane";
import { readTreasuryLaneQuota, readTreasuryLaneResponsibility } from "@/runtime/treasuryTerminalResponsibility";
export type { TreasuryT1Quota as TreasuryT3Quota, TreasuryT1Responsibility as TreasuryT3Responsibility } from "@/runtime/treasuryTerminalResponsibility";
export const readTreasuryT3Quota = () => readTreasuryLaneQuota(TREASURY_T3_LANE);
export const readTreasuryT3Responsibility = () => readTreasuryLaneResponsibility(TREASURY_T3_LANE);
