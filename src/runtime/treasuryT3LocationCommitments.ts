import { BUILD_INFO } from "@/buildMeta";
import { peekCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { isValidTreasuryTransferTaskForCommitment } from "@/runtime/treasury/commitments";
import type { TreasuryLocationCommitmentRequest } from "@/runtime/treasury/facade";
import { readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { runtime } from "@/runtime/treasuryFirstLiveState";
import { readTreasuryTerminalControl } from "@/runtime/treasuryTerminalControl";
import { decodeTreasuryTerminalFacts } from "@/runtime/treasuryTerminalFacts";
import { readTreasuryLaneQuota, readTreasuryLaneResponsibility } from "@/runtime/treasuryTerminalResponsibility";
import { TREASURY_TERMINAL_LANES, treasuryLaneTaskMatches, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nativeMap(value: unknown): value is Map<unknown, unknown> {
  try { Map.prototype.has.call(value, ""); return true; } catch { return false; }
}

const CARRIER_TYPES = new Set(["lab_supply", "lab_cleanup", "lab_product_unload", "mineral_haul", "terminal_feed", "terminal_offload", "factory_supply", "factory_unload", "power_spawn_supply", "nuker_supply"]);
const CARRIER_SOURCE_KINDS = new Set(["lab", "terminal", "storage", "container", "factory", "power_spawn", "nuker"]);

/** 与资源调度的生产运输保护一致，读取货运板，不初始化或修改任务。 */
function carrierProductionCommitment(roomName: string, resource: string): number | null {
  const board = (global as typeof global & { __carrierTaskBoard?: unknown }).__carrierTaskBoard;
  const snapshot = peekCarrierTasksByRoom(roomName);
  // peek 会跳过不能解释的记录；位置豁免必须额外证明没有漏读责任。
  if (board !== undefined) {
    if (!nativeMap(board)) return null;
    const room = Map.prototype.get.call(board, roomName) as unknown;
    if (room !== undefined) {
      if (!room || typeof room !== "object") return null;
      const owners = Object.getOwnPropertyDescriptor(room, "byOwner")?.value as unknown;
      if (!nativeMap(owners)) return null;
      let recordCount = 0;
      for (const rows of Map.prototype.values.call(owners) as Iterable<unknown>) {
        if (!nativeMap(rows)) return null;
        for (const ignored of Map.prototype.values.call(rows) as Iterable<unknown>) {
          void ignored;
          recordCount += 1;
        }
      }
      if (recordCount !== snapshot.length) return null;
    }
  }
  let amount = 0;
  for (const { task } of snapshot) {
    if (task.roomName !== roomName || !CARRIER_TYPES.has(task.type) || !Array.isArray(task.steps)) return null;
    if (task.type !== "lab_supply" && task.type !== "factory_supply") continue;
    for (const step of task.steps) {
      if (!RESOURCES_ALL.includes(step.resource) || !CARRIER_SOURCE_KINDS.has(step.fromKind) || !integer(step.amount)) return null;
      if (step.resource !== resource || step.fromKind !== "storage" && step.fromKind !== "terminal") continue;
      if (!integer(step.amount) || !integer(amount + step.amount)) return null;
      amount += step.amount;
    }
  }
  return amount;
}

/**
 * T3 只允许完整 Storage 支持；T4 可将确证的一部分余量定位到 Storage。
 * 两者都保留房间全部承诺，剩下尚无 Storage 证明的责任继续占 Terminal。
 * Terminal 的发送量、费用、其他任务和生产保护继续由原授权公式扣除。
 * 每次接纳及 fresh 执行复验重新检查全部证明，不缓存位置豁免。
 */
export function treasuryT3CommittedOutgoingForLocation(request: TreasuryLocationCommitmentRequest): number | undefined {
  try {
    const lane = TREASURY_TERMINAL_LANES.find((entry) =>
      (entry.name === "T3" || entry.continuous) && entry.actionKind === request.context.actionKind);
    if (!lane) return undefined;
    const { context, candidate, observation, commitments, roomCommittedOutgoing } = request;
    if (request.roomName !== lane.sourceRoom || request.locationKind !== "terminal" || request.resource !== lane.resource ||
        context.actionKind !== lane.actionKind || candidate === null ||
        candidate.identity.actionKind !== lane.actionKind || candidate.identity.adapterVersion !== 1 ||
        candidate.identity.adapterSemanticIdentity !== lane.semanticIdentity ||
        candidate.identity.canonicalDigest !== context.contractDigest || candidate.identity.durableFacts?.version !== 1 ||
        !integer(roomCommittedOutgoing) || commitments.commitmentCompleteness(lane.sourceRoom, lane.resource) !== "complete" ||
        observation.isStale() || observation.epoch.observedAtTick !== Game.time ||
        observation.epoch.worldSequence < readTreasuryWorldSequence()) return undefined;
    const facts = decodeTreasuryTerminalFacts(lane, candidate.identity.durableFacts.payload);
    const controlRead = readTreasuryTerminalControl(lane);
    if (!facts || facts.tick !== Game.time || controlRead.status !== "valid" || controlRead.value.status !== "active") return undefined;
    const control = controlRead.value;
    const now = Date.now();
    const state = runtime();
    const mode = (Memory.cfg as unknown as Record<string, { mode?: unknown }> | undefined)?.[lane.configKey]?.mode;
    if (mode !== "canary" || Game.shard?.name !== "shard1" || BUILD_INFO.dirty || BUILD_INFO.bundleHash === "none" ||
        control.deployTag !== BUILD_INFO.tag || control.deployBundleHash !== BUILD_INFO.bundleHash ||
        state?.lastDeployTag !== control.deployTag || state?.lastDeployBundleHash !== control.deployBundleHash ||
        now < control.startedAtMs || now >= control.controlUntilMs || now >= control.deadlineMs ||
        Game.time < control.startedAtTick || Game.time >= control.deadlineTick ||
        facts.taskId !== control.taskId || facts.taskCreatedAt !== control.taskCreatedAt ||
        facts.source.id !== control.sourceTerminalId || facts.target.id !== control.targetTerminalId ||
        !integer(control.maxSliceAmount) || facts.amount > control.maxSliceAmount ||
        (lane.continuous && facts.sequence !== control.sequence) ||
        candidate.workKey !== treasuryLaneWorkKey(lane, facts.taskId, facts.sequence)) return undefined;
    const tasks = Memory.data?.resourceControl?.tasks as Record<string, ResourceTransferTask> | undefined;
    const task = tasks?.[facts.taskId];
    if (!task || task.id !== facts.taskId || !isValidTreasuryTransferTaskForCommitment(task) ||
        task.status !== "pending" || !treasuryLaneTaskMatches(lane, task) ||
        task.createdAt !== control.taskCreatedAt || task.amount !== control.taskAmount ||
        task.remainingAmount !== control.taskRemainingAtArm || facts.amount > task.remainingAmount) return undefined;
    const lease = task.treasurySlice;
    if (!lease || lease.schemaVersion !== 1 || lease.runId !== lane.runId ||
        lease.workKey !== candidate.workKey || lease.amount !== facts.amount || lease.outcome !== undefined) return undefined;
    const quota = readTreasuryLaneQuota(lane);
    if (context.excludeAttemptId === null) {
      if (lease.phase !== "preparing" || lease.attemptId !== "" || quota.status !== "absent") return undefined;
    } else if (lease.phase !== "active" || lease.attemptId !== context.excludeAttemptId ||
        quota.status !== "valid" || quota.value.status !== "reserved" ||
        quota.value.taskId !== task.id || quota.value.taskCreatedAt !== task.createdAt ||
        quota.value.taskAmount !== task.amount || quota.value.workKey !== candidate.workKey ||
        quota.value.attemptId !== context.excludeAttemptId || quota.value.amount !== facts.amount) return undefined;
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "absent" && health.status !== "healthy" ||
        health.status === "healthy" && health.ringDegraded !== null) return undefined;
    for (const other of TREASURY_TERMINAL_LANES) {
      if (other === lane) continue;
      const otherControl = readTreasuryTerminalControl(other);
      if (otherControl.status === "invalid" || otherControl.status === "valid" && otherControl.value.status !== "closed" ||
          readTreasuryLaneResponsibility(other).status !== "clear") return undefined;
    }
    const source = observation.location(lane.sourceRoom, "terminal");
    const target = observation.location(lane.targetRoom, "terminal");
    const storage = observation.location(lane.sourceRoom, "storage");
    if (!source.exists || !target.exists || !storage.exists ||
        source.structureId !== control.sourceTerminalId || target.structureId !== control.targetTerminalId ||
        observation.amount(lane.sourceRoom, "terminal", lane.resource) !== facts.source.resourceAmount ||
        observation.amount(lane.sourceRoom, "terminal", RESOURCE_ENERGY) !== facts.source.energy ||
        facts.source.resourceAmount < facts.amount) return undefined;
    const residual = task.remainingAmount - facts.amount;
    if (!integer(residual) || residual === 0 || residual > roomCommittedOutgoing) return undefined;
    // 正向证明当前承诺索引恰好只交还本片，而没有删掉任务残余或其他任务。
    let rawOutgoing = 0;
    for (const [id, row] of Object.entries(tasks!)) {
      if (row.fromRoomName !== lane.sourceRoom || row.resource !== lane.resource) continue;
      if (row.id !== id || !isValidTreasuryTransferTaskForCommitment(row)) return undefined;
      if (row.status !== "pending") continue;
      if (!integer(rawOutgoing + row.remainingAmount)) return undefined;
      rawOutgoing += row.remainingAmount;
    }
    if (rawOutgoing - facts.amount !== roomCommittedOutgoing) return undefined;
    const stored = observation.amount(lane.sourceRoom, "storage", lane.resource);
    const reserved = commitments.reservedProduction(lane.sourceRoom, lane.resource);
    const carried = carrierProductionCommitment(lane.sourceRoom, lane.resource);
    const terminalOccupied = request.occupancyOutflow(lane.sourceRoom, "terminal", lane.resource);
    const storageOccupied = request.occupancyOutflow(lane.sourceRoom, "storage", lane.resource);
    if (![stored, reserved, carried, terminalOccupied, storageOccupied].every(integer)) return undefined;
    const otherPending = roomCommittedOutgoing - residual;
    const storageBacking = stored - reserved - carried! - otherPending - terminalOccupied - storageOccupied;
    if (!integer(storageBacking) || !lane.continuous && storageBacking < residual) return undefined;
    // 首片 10：room 承诺 903 = Storage 887 + Terminal 16；Terminal 26 仍只准花 10。
    const storageAssigned = lane.continuous ? Math.min(residual, storageBacking) : residual;
    return roomCommittedOutgoing - storageAssigned;
  } catch { return undefined; }
}
