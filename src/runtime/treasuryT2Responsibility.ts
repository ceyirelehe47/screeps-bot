import { TREASURY_T2_LANE } from "@/runtime/treasuryTerminalLane";
import { readTreasuryLaneQuota, readTreasuryLaneResponsibility } from "@/runtime/treasuryTerminalResponsibility";
export type { TreasuryT1Quota as TreasuryT2Quota, TreasuryT1Responsibility as TreasuryT2Responsibility } from "@/runtime/treasuryTerminalResponsibility";
export const readTreasuryT2Quota = () => readTreasuryLaneQuota(TREASURY_T2_LANE);
export const readTreasuryT2Responsibility = () => readTreasuryLaneResponsibility(TREASURY_T2_LANE);
