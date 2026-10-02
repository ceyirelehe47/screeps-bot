import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
export interface TreasuryTerminalLane {
  readonly name: "T1" | "T2" | "T3";
  readonly runId: string;
  readonly actionKind: string;
  readonly sourceRoom: string;
  readonly targetRoom: string;
  readonly resource: ResourceConstant;
  readonly controlRunId: string;
  readonly controlKey: string;
  readonly controlMirrorKey: string;
  readonly quotaKey: string;
  readonly configKey: string;
  readonly descriptionPrefix: string;
  readonly semanticIdentity: string;
  readonly requiredReason?: string;
  readonly requiredProduct?: ResourceConstant;
  readonly demandBoundedSlice?: boolean;
}
export const TREASURY_T1_LANE: TreasuryTerminalLane = Object.freeze({
  name: "T1", runId: "treasury-production-T1-2026-09-24",
  actionKind: "production.terminal-transfer.slice0", sourceRoom: "E3N59", targetRoom: "E4N58",
  resource: RESOURCE_HYDROGEN, controlRunId: "treasury-t1-first-live-2026-09-27",
  controlKey: "treasuryT1FirstLiveControl", controlMirrorKey: "treasuryT1FirstLiveControlMirror",
  quotaKey: "treasuryProductionT1Quota", configKey: "treasuryTerminalTransferSlice0",
  descriptionPrefix: "treasury-T1-2026-09-24:",
  semanticIdentity: "production.terminal-transfer.slice0@E3N59-E4N58-H-v1",
});
export const TREASURY_T2_LANE: TreasuryTerminalLane = Object.freeze({
  name: "T2", runId: "treasury-production-T2-2026-10-02",
  actionKind: "production.terminal-transfer.uh-synthesis.slice0", sourceRoom: "E4N58", targetRoom: "E1N57",
  resource: RESOURCE_UTRIUM_HYDRIDE, controlRunId: "treasury-t2-first-live-2026-10-02",
  controlKey: "treasuryT2FirstLiveControl", controlMirrorKey: "treasuryT2FirstLiveControlMirror",
  quotaKey: "treasuryProductionT2Quota", configKey: "treasuryTerminalTransferT2",
  descriptionPrefix: "treasury-T2-2026-10-02:",
  semanticIdentity: "production.terminal-transfer.uh-synthesis.slice0@E4N58-E1N57-UH-v1",
  requiredReason: "synthesis:E1N57:UH2O",
  requiredProduct: RESOURCE_UTRIUM_ACID,
});
export const TREASURY_T3_LANE: TreasuryTerminalLane = Object.freeze({
  name: "T3", runId: "treasury-production-T3-2026-10-02",
  actionKind: "production.terminal-transfer.oh-synthesis.slice0", sourceRoom: "E4N58", targetRoom: "E1N57",
  resource: RESOURCE_HYDROXIDE, controlRunId: "treasury-t3-first-live-2026-10-02",
  controlKey: "treasuryT3FirstLiveControl", controlMirrorKey: "treasuryT3FirstLiveControlMirror",
  quotaKey: "treasuryProductionT3Quota", configKey: "treasuryTerminalTransferT3",
  descriptionPrefix: "treasury-T3-2026-10-02:",
  semanticIdentity: "production.terminal-transfer.oh-synthesis.slice0@E4N58-E1N57-OH-v1",
  requiredReason: "synthesis:E1N57:UH2O", requiredProduct: RESOURCE_UTRIUM_ACID,
  demandBoundedSlice: true,
});
export const TREASURY_TERMINAL_LANES = Object.freeze([TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE]);
export const treasuryLaneWorkKey = (lane: TreasuryTerminalLane, taskId: string): string =>
  `biz:${lane.runId}:${hashTreasuryCanonicalString(taskId)}`;
export const treasuryLaneTaskMatches = (lane: TreasuryTerminalLane, task: { fromRoomName: string; toRoomName: string; resource: ResourceConstant; origin?: string; reason?: string }): boolean =>
  task.fromRoomName === lane.sourceRoom && task.toRoomName === lane.targetRoom && task.resource === lane.resource &&
  (lane.requiredReason === undefined || task.origin === "automatic" && task.reason === lane.requiredReason);
