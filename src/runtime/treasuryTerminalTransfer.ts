import { getTreasuryService } from "@/runtime/runtimeServices";
import { ensureReservationSchemaActivated } from "@/runtime/resourceReservation";
import type { TreasuryService } from "@/runtime/treasury/facade";
import { normalizeTreasuryT1FirstLiveControl } from "@/runtime/treasuryT1FirstLiveControl";
import { normalizeTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { registerTreasuryPolicyResolver, type TreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { createTreasuryTerminalTransferLane } from "@/runtime/treasuryTerminalTransferLane";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_TERMINAL_LANES, treasuryLaneTaskMatches, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
import { readTreasuryLaneQuota } from "@/runtime/treasuryTerminalResponsibility";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
export { TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM } from "@/runtime/treasuryT1Facts";
const productionPolicy: TreasuryPolicyResolver = Object.freeze({
  policyId: "treasury.production-terminal-slices-T1-T2", policyVersion: 2,
  evaluate(context) {
    const lane = TREASURY_TERMINAL_LANES.find((entry) => entry.actionKind === context.actionKind);
    if (!lane || !context.rooms.includes(lane.sourceRoom) || !context.rooms.includes(lane.targetRoom) ||
        context.resource !== lane.resource && context.resource !== RESOURCE_ENERGY) {
      return {status:"rejected" as const,reason:"outside fixed Treasury terminal lane policy"};
    }
    return {withhold:0,strategicReserve:0,emergencyOverride:false,auditReason:"fixed terminal lane; bounded adapter owns the limit"};
  },
});
const t1 = createTreasuryTerminalTransferLane(TREASURY_T1_LANE);
const t2 = createTreasuryTerminalTransferLane(TREASURY_T2_LANE);
let running: typeof t1 | null = null;
let recoveryOnlyService: TreasuryService | null = null;
function ownsActivity(lane: TreasuryTerminalLane): boolean {
  const control = createTreasuryFirstLiveState(lane).readControl();
  const quota = readTreasuryLaneQuota(lane);
  if (control.status === "invalid" || control.status === "valid" && control.value.status === "active" ||
      quota.status === "invalid" || quota.status === "valid" && quota.value.status !== "drained") return true;
  const runtime = Memory.runtime as unknown as Record<string, unknown> | undefined;
  const core = runtime?.treasuryCore as {active?: Record<string,{identity?: {actionKind?: string}}> } | undefined;
  if (core?.active && Object.values(core.active).some((r) => r?.identity?.actionKind === lane.actionKind)) return true;
  return Object.values(Memory.data?.resourceControl?.tasks ?? {}).some((task) => task !== null && typeof task === "object" && (task as ResourceTransferTask).treasurySlice?.runId === lane.runId);
}
export function registerTreasuryProductionTerminalTransfer(): boolean {
  const old = t1.register(); const current = t2.register();
  return old && current && registerTreasuryPolicyResolver(productionPolicy).status === "registered";
}
export function beginTreasuryProductionTick(): boolean {
  running = null; recoveryOnlyService = null;
  // Normalize both controls even after OFF/reload; only one lane may own the shared lifecycle.
  normalizeTreasuryT1FirstLiveControl();
  normalizeTreasuryT2FirstLiveControl();
  const active = TREASURY_TERMINAL_LANES.filter(ownsActivity);
  if (active.length > 1) {
    // A same-tick foreign responsibility can appear after binding/admission. Stop fresh
    // dispatch, but one shared kernel tick still drains each lane's original attempt.
    try {
      if (ensureReservationSchemaActivated().status === "rejected") return false;
      const service = getTreasuryService();
      // 在kernel跨tick清理pending之前，先绑定原attempt并确认两lane task-side取消事实。
      if (!t1.prepareRecovery(service) || !t2.prepareRecovery(service)) return false;
      service.beginTick(); t1.recover(service); t2.recover(service);
      recoveryOnlyService = service; return true;
    } catch { return false; }
  }
  const engine = active[0]?.name === "T2" ? t2 : t1;
  const result = engine.begin(); if (result) running = engine; return result;
}
export function endTreasuryProductionTick(): void {
  const service = recoveryOnlyService; recoveryOnlyService = null;
  const engine = running; running = null;
  if (service) { service.endTick(); normalizeTreasuryT1FirstLiveControl(); normalizeTreasuryT2FirstLiveControl(); }
  else engine?.end();
}
export function runTreasuryTerminalTransferTask(task: ResourceTransferTask, ledger: ReceiverCapacityLedger,
  nativeBudgetAvailable: boolean, onScheduled: (amount: number, fee: number) => void): {readonly handled: boolean; readonly status?: string} {
  if (recoveryOnlyService && (task.treasurySlice !== undefined || TREASURY_TERMINAL_LANES.some((lane) => treasuryLaneTaskMatches(lane, task)))) {
    return {handled:true,status:"cross_lane_recovery_only"};
  }
  const lane = task.treasurySlice?.runId === TREASURY_T2_LANE.runId || treasuryLaneTaskMatches(TREASURY_T2_LANE, task) ? t2 : t1;
  return lane.run(task, ledger, nativeBudgetAvailable, onScheduled);
}
export function runTreasuryT1ShadowObservation(): void { t1.shadow(); t2.shadow(); }
export function readTreasuryT1MigrationBlockReason(): string | null { return running?.blockReason() ?? t1.blockReason() ?? t2.blockReason(); }
