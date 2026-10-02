import { getTreasuryService } from "@/runtime/runtimeServices";
import { ensureReservationSchemaActivated } from "@/runtime/resourceReservation";
import type { TreasuryService } from "@/runtime/treasury/facade";
import { createTreasuryFirstLiveControl } from "@/runtime/treasuryFirstLiveControl";
import { registerTreasuryPolicyResolver, type TreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { createTreasuryTerminalTransferLane } from "@/runtime/treasuryTerminalTransferLane";
import { TREASURY_TERMINAL_LANES, treasuryLaneTaskMatches, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
import { readTreasuryLaneQuota } from "@/runtime/treasuryTerminalResponsibility";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
export { TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM } from "@/runtime/treasuryT1Facts";
const productionPolicy: TreasuryPolicyResolver = Object.freeze({
  policyId: "treasury.production-terminal-slices-T1-T2-T3", policyVersion: 3,
  evaluate(context) {
    const lane = TREASURY_TERMINAL_LANES.find((entry) => entry.actionKind === context.actionKind);
    if (!lane || !context.rooms.includes(lane.sourceRoom) || !context.rooms.includes(lane.targetRoom) ||
        context.resource !== lane.resource && context.resource !== RESOURCE_ENERGY) {
      return {status:"rejected" as const,reason:"outside fixed Treasury terminal lane policy"};
    }
    return {withhold:0,strategicReserve:0,emergencyOverride:false,auditReason:"fixed terminal lane; bounded adapter owns the limit"};
  },
});
const engines = TREASURY_TERMINAL_LANES.map((lane) => ({
  lane, engine: createTreasuryTerminalTransferLane(lane), control: createTreasuryFirstLiveControl(lane),
}));
let running: ReturnType<typeof createTreasuryTerminalTransferLane> | null = null;
let recoveryOnlyService: TreasuryService | null = null;
function ownsActivity(lane: TreasuryTerminalLane): boolean {
  const control = createTreasuryFirstLiveState(lane).readControl();
  const quota = readTreasuryLaneQuota(lane);
  if (control.status === "invalid" || control.status === "valid" && control.value.status !== "closed" ||
      quota.status === "invalid" || quota.status === "valid" && quota.value.status !== "drained") return true;
  const runtime = Memory.runtime as unknown as Record<string, unknown> | undefined;
  const core = runtime?.treasuryCore as {active?: Record<string,{identity?: {actionKind?: string}}> } | undefined;
  if (core?.active && Object.values(core.active).some((r) => r?.identity?.actionKind === lane.actionKind)) return true;
  return Object.values(Memory.data?.resourceControl?.tasks ?? {}).some((task) => task !== null && typeof task === "object" && (task as ResourceTransferTask).treasurySlice?.runId === lane.runId);
}
export function registerTreasuryProductionTerminalTransfer(): boolean {
  let ready = true;
  for (const entry of engines) ready = entry.engine.register() && ready;
  return ready && registerTreasuryPolicyResolver(productionPolicy).status === "registered";
}
export function beginTreasuryProductionTick(): boolean {
  running = null; recoveryOnlyService = null;
  // OFF/reset 后仍归一化全部历史 lane；共享生命周期只允许一个新接纳者。
  for (const entry of engines) entry.control.normalize();
  const active = TREASURY_TERMINAL_LANES.filter(ownsActivity);
  if (active.length > 1) {
    // A same-tick foreign responsibility can appear after binding/admission. Stop fresh
    // dispatch, but one shared kernel tick still drains each lane's original attempt.
    try {
      if (ensureReservationSchemaActivated().status === "rejected") return false;
      const service = getTreasuryService();
      // 在 kernel 清理 pending 前恢复所有原 attempt，异常组合永不开新 dispatch。
      for (const entry of engines) if (!entry.engine.prepareRecovery(service)) return false;
      service.beginTick();
      for (const entry of engines) entry.engine.recover(service);
      recoveryOnlyService = service; return true;
    } catch { return false; }
  }
  const engine = engines.find((entry) => entry.lane === active[0])?.engine ?? engines[0].engine;
  const result = engine.begin(); if (result) running = engine; return result;
}
export function endTreasuryProductionTick(): void {
  const service = recoveryOnlyService; recoveryOnlyService = null;
  const engine = running; running = null;
  if (service) { service.endTick(); for (const entry of engines) entry.control.normalize(); }
  else engine?.end();
}
export function runTreasuryTerminalTransferTask(task: ResourceTransferTask, ledger: ReceiverCapacityLedger,
  nativeBudgetAvailable: boolean, onScheduled: (amount: number, fee: number) => void): {readonly handled: boolean; readonly status?: string} {
  if (recoveryOnlyService && (task.treasurySlice !== undefined || TREASURY_TERMINAL_LANES.some((lane) => treasuryLaneTaskMatches(lane, task)))) {
    return {handled:true,status:"cross_lane_recovery_only"};
  }
  const owner = task.treasurySlice === undefined ? undefined : engines.find((entry) => entry.lane.runId === task.treasurySlice?.runId);
  const selected = owner ?? engines.find((entry) => treasuryLaneTaskMatches(entry.lane, task)) ?? engines[0];
  return selected.engine.run(task, ledger, nativeBudgetAvailable, onScheduled);
}
export function runTreasuryT1ShadowObservation(): void { for (const entry of engines) entry.engine.shadow(); }
export function readTreasuryT1MigrationBlockReason(): string | null {
  return running?.blockReason() ?? engines.map((entry) => entry.engine.blockReason()).find((reason) => reason !== null) ?? null;
}
