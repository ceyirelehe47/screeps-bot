import { BUILD_INFO } from "@/buildMeta";
import { runtime, finiteNonNegative, treasuryT1SerializedBytes, type Control, type Read } from "@/runtime/treasuryFirstLiveState";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
import { TREASURY_TERMINAL_LANES, TREASURY_T4_LANE, treasuryLaneTaskMatches } from "@/runtime/treasuryTerminalLane";
import { readTreasuryLaneResponsibility, type TreasuryT1Quota } from "@/runtime/treasuryTerminalResponsibility";
import { readTreasuryCoreStoreHealth, detectLegacyTreasuryStores } from "@/runtime/treasury/kernel/store";
import { isKnownEmptyLegacyTreasuryRoot } from "@/runtime/treasuryTerminalResponsibility";
import { inspectTreasuryResourceTransferReadiness, inspectTreasuryResourceTransferPreparation } from "@/runtime/resourceControl";
import { inspectConfiguredSynthesisTransferDemand } from "@/runtime/synthesisControl";
import { cancelResourceTransferTask, type ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { getLocalCarrierDestinationCommittedAmount } from "@/runtime/localCarrierDestinationCapacity";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { formatTreasuryTransactionId, formatTreasuryStableTransactionId } from "@/runtime/treasury/transactionId";
import { hasTerminalActionClaim, hasTerminalSendEffectThisTick, hasTerminalCargoEffectThisTick } from "@/runtime/marketActionArbiter";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { buildTreasuryCommitmentIndex, isValidTreasuryTransferTaskForCommitment } from "@/runtime/treasury/commitments";
import { buildTreasuryObservation } from "@/runtime/treasury/observation";
import { inspectTreasuryCarrierProductionCommitment } from "@/runtime/treasuryT3LocationCommitments";
import {
  checkTreasuryContinuousOHBudget, normalizeTreasuryContinuousOHPolicy, summarizeTreasuryContinuousOHBudget,
  type TreasuryContinuousOHPolicy,
} from "@/runtime/treasuryContinuousOHBudget";
import {
  CONTROL_RUN_ID, CONTINUOUS_RUN_ID, CONTINUOUS_ACTION_KIND,
  TREASURY_CONTINUOUS_OH_SESSION_MS, TREASURY_CONTINUOUS_OH_SESSION_TICKS,
  TREASURY_CONTINUOUS_OH_MAX_MEMORY_BYTES,
  readTreasuryContinuousOHState, writeTreasuryContinuousOHState, treasuryContinuousOHStatePayload,
  treasuryContinuousOHWorkKey,
  sealTreasuryContinuousOHState,
  type TreasuryContinuousOHState, type TreasuryContinuousOHCycle, type TreasuryContinuousOHClosedCertificate,
} from "@/runtime/treasuryContinuousOHState";

export interface TreasuryContinuousOHEnableOptions {
  readonly pilotTaskId: string;
  readonly pilotTaskCreatedAt: number;
  readonly pilotTaskAmount: number;
  readonly policy?: Partial<TreasuryContinuousOHPolicy>;
}
export type TreasuryContinuousOHResult = { readonly ok: boolean; readonly reason: string };
export type TreasuryContinuousOHQuotaRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: TreasuryT1Quota };

const ok = (reason: string): TreasuryContinuousOHResult => ({ ok: true, reason });
const fail = (reason: string): TreasuryContinuousOHResult => ({ ok: false, reason });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function now(): { tick: number; ms: number } | null {
  const ms = Date.now();
  return finiteNonNegative(Game.time) && finiteNonNegative(ms) ? { tick: Game.time, ms } : null;
}

function safeEnvironment(): boolean {
  try {
    const used = Game.cpu.getUsed();
    return Number.isFinite(used) && Number.isFinite(Game.cpu.tickLimit) &&
      Number.isFinite(Game.cpu.bucket) && Game.cpu.tickLimit - used >= 20 && Game.cpu.bucket >= 2_000 &&
      treasuryT1SerializedBytes(Memory) + 8_192 < TREASURY_CONTINUOUS_OH_MAX_MEMORY_BYTES;
  } catch { return false; }
}

function deploymentMatches(state?: TreasuryContinuousOHState): boolean {
  return Game.shard?.name === "shard1" && BUILD_INFO.dirty === false && BUILD_INFO.bundleHash !== "none" &&
    runtime()?.lastDeployTag === BUILD_INFO.tag && runtime()?.lastDeployBundleHash === BUILD_INFO.bundleHash &&
    (!state || state.deployTag === BUILD_INFO.tag && state.deployBundleHash === BUILD_INFO.bundleHash);
}

function endpoints(): { source: StructureTerminal; target: StructureTerminal } | null {
  const sourceRoom = Game.rooms[TREASURY_T4_LANE.sourceRoom];
  const targetRoom = Game.rooms[TREASURY_T4_LANE.targetRoom];
  if (![sourceRoom, targetRoom].every((room) => room?.controller?.my === true &&
    room.controller.owner?.username === "forster" && room.terminal?.my === true &&
    room.terminal.owner?.username === "forster" && room.terminal.isActive() === true &&
    typeof room.terminal.id === "string" && room.terminal.id.length > 0)) return null;
  return { source: sourceRoom.terminal!, target: targetRoom.terminal! };
}

function endpointIdentityMatches(state: TreasuryContinuousOHState): boolean {
  const ids = endpoints();
  return ids !== null && ids.source.id === state.sourceTerminalId && ids.target.id === state.targetTerminalId;
}

function endpointTouched(): boolean {
  return [TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom].some((room) =>
    hasTerminalActionClaim(room) || hasTerminalSendEffectThisTick(room) || hasTerminalCargoEffectThisTick(room));
}

/** 接货后的 cargo 与同 tick Store 效果必须先安静；准备阶段仍由自然备货完成。 */
function cargoQuiescent(state: TreasuryContinuousOHState): boolean {
  if (endpointTouched()) return false;
  const terminalIds = [state.sourceTerminalId, state.targetTerminalId];
  if (terminalIds.some((id) => getLocalCarrierDestinationCommittedAmount(id) > 0)) return false;
  for (const creep of Object.values(Game.creeps)) {
    const assignment = getCreepAssignmentState(creep.name);
    const legacy = creep.memory as unknown as Record<string, unknown>;
    const fromId = assignment?.synthesisCarrierPendingFromId ?? legacy.synthesisCarrierPendingFromId;
    const toId = assignment?.synthesisCarrierPendingToId ?? legacy.synthesisCarrierPendingToId;
    if ([fromId, toId].some((id) => typeof id === "string" && terminalIds.includes(id)) &&
        (creep.store.getUsedCapacity() ?? 0) > 0) return false;
  }
  return true;
}

function rawMode(): unknown {
  const cfg = (Memory as unknown as { cfg?: Record<string, unknown> }).cfg;
  const entry = cfg?.[TREASURY_T4_LANE.configKey];
  return object(entry) ? entry.mode : undefined;
}

function setMode(mode: "off" | "canary" | "drain"): boolean {
  try {
    if (rawMode() === mode) return true;
    const memory = Memory as unknown as { cfg?: Record<string, unknown> };
    if (memory.cfg !== undefined && !object(memory.cfg)) return false;
    memory.cfg ??= {};
    const prior = memory.cfg[TREASURY_T4_LANE.configKey];
    memory.cfg[TREASURY_T4_LANE.configKey] = { ...(object(prior) ? prior : {}), mode };
    return rawMode() === mode;
  } catch { return false; }
}

function taskStore(): Record<string, ResourceTransferTask> | null {
  const data = Memory.data as unknown;
  if (data === undefined) return {};
  if (!object(data) || data.resourceControl !== undefined && !object(data.resourceControl)) return null;
  const raw = object(data.resourceControl) ? data.resourceControl.tasks : undefined;
  if (raw === undefined) return {};
  if (!object(raw) || Object.entries(raw).some(([id, task]) => !object(task) || task.id !== id)) return null;
  return raw as unknown as Record<string, ResourceTransferTask>;
}

function taskInScope(task: ResourceTransferTask): boolean {
  return treasuryLaneTaskMatches(TREASURY_T4_LANE, task) && typeof task.id === "string" &&
    task.id.length > 0 && task.id.length <= 80 && finiteNonNegative(task.createdAt) &&
    finiteNonNegative(task.amount) && task.amount > 0 && finiteNonNegative(task.remainingAmount) &&
    task.remainingAmount <= task.amount;
}

function taskMatchesCycle(task: ResourceTransferTask, cycle: TreasuryContinuousOHCycle): boolean {
  return taskInScope(task) && task.id === cycle.taskId && task.createdAt === cycle.taskCreatedAt &&
    task.amount === cycle.taskAmount && task.remainingAmount === cycle.taskRemainingAtArm && task.status === "pending";
}

function otherLanesClear(): boolean {
  return TREASURY_TERMINAL_LANES.every((lane) => {
    if (lane.name === "T4") return true;
    const control = createTreasuryFirstLiveState(lane).readControl();
    return control.status !== "invalid" && !(control.status === "valid" && control.value.status !== "closed") &&
      readTreasuryLaneResponsibility(lane).status === "clear";
  });
}

function kernelReadable(): Extract<ReturnType<typeof readTreasuryCoreStoreHealth>, { status: "absent" | "healthy" }> | null {
  if (!isKnownEmptyLegacyTreasuryRoot(runtime()?.treasury) || detectLegacyTreasuryStores().length > 0) return null;
  const health = readTreasuryCoreStoreHealth();
  return health.status === "absent" || health.status === "healthy" && health.ringDegraded === null ? health : null;
}

function kernelIdleAndCertified(state: TreasuryContinuousOHState): boolean {
  const health = kernelReadable();
  if (!health) return false;
  if (health.status === "absent") return state.consumption.length === 0 && state.closedCycles.every((cert) => cert.ring === null);
  const certified = new Set(state.closedCycles.flatMap((cert) => cert.ring === null ? [] : [JSON.stringify(cert.ring)]));
  return Object.values(health.memory.active).length === 0 && health.memory.ring.every((entry) =>
    !entry.workKey.startsWith(`biz:${CONTINUOUS_RUN_ID}:`) ||
    certified.has(JSON.stringify(entry)));
}

function fixedGateReason(state: TreasuryContinuousOHState): string | null {
  const clock = now();
  if (!clock) return "clock_invalid";
  if (clock.tick < state.lastObservedAtTick || clock.ms < state.lastObservedAtMs ||
      state.consumption.some((entry) => entry.atTick > clock.tick || entry.atMs > clock.ms)) return "clock_regressed";
  if (clock.tick >= state.deadlineTick) return "fixed_tick_deadline";
  if (clock.ms >= state.deadlineMs) return "fixed_wall_deadline";
  if (!deploymentMatches(state)) return "deployment_changed";
  if (!endpointIdentityMatches(state)) return "endpoint_identity_changed";
  return null;
}

function cycleGateReason(state: TreasuryContinuousOHState, cycle: TreasuryContinuousOHCycle): string | null {
  const clock = now();
  if (!clock || clock.tick < cycle.startedAtTick || clock.ms < cycle.startedAtMs || clock.ms < cycle.lastHeartbeatAtMs) return "cycle_clock_regressed";
  if (clock.tick >= cycle.deadlineTick) return "cycle_tick_deadline";
  if (clock.ms >= cycle.deadlineMs) return "cycle_wall_deadline";
  // 产品每 tick 自己续 lease。reset 的已接纳责任用持久原attempt恢复；无接纳的过期lease取消。
  if (clock.ms >= cycle.controlUntilMs && cycle.quota === null) return "cycle_lease_expired";
  return null;
}

export function readTreasuryContinuousOHControl(): Read {
  const read = readTreasuryContinuousOHState();
  if (read.status !== "valid") return read;
  const state = read.value;
  const cycle = state.currentCycle;
  const value: Control & { sequence: number } = {
    schemaVersion: 1, runId: CONTROL_RUN_ID,
    status: cycle?.status ?? (state.sessionStatus === "stopped" || state.sessionStatus === "stopping" ? "closed" : "active"),
    startedAtTick: cycle?.startedAtTick ?? state.enabledAtTick,
    startedAtMs: cycle?.startedAtMs ?? state.enabledAtMs,
    deadlineTick: cycle?.deadlineTick ?? state.deadlineTick,
    deadlineMs: cycle?.deadlineMs ?? state.deadlineMs,
    lastHeartbeatAtMs: cycle?.lastHeartbeatAtMs ?? state.enabledAtMs,
    controlUntilMs: cycle?.controlUntilMs ?? state.deadlineMs,
    taskId: cycle?.taskId ?? "", taskCreatedAt: cycle?.taskCreatedAt ?? 0,
    taskAmount: cycle?.taskAmount ?? 0, taskRemainingAtArm: cycle?.taskRemainingAtArm ?? 0,
    sourceTerminalId: state.sourceTerminalId, targetTerminalId: state.targetTerminalId,
    deployTag: state.deployTag, deployBundleHash: state.deployBundleHash,
    closeReason: cycle?.closeReason ?? state.stopReason,
    maxSliceAmount: cycle?.amount ?? 0, sequence: cycle?.sequence ?? 0, hash: state.hash,
  };
  return { status: "valid", value };
}

export function readTreasuryContinuousOHQuota(): TreasuryContinuousOHQuotaRead {
  const read = readTreasuryContinuousOHState();
  if (read.status !== "valid") return read;
  const quota = read.value.currentCycle?.quota;
  return quota ? { status: "valid", value: quota } : { status: "absent" };
}

export function continuousClosedWorkAcknowledged(workKey: string, attemptId?: string): boolean {
  const read = readTreasuryContinuousOHState();
  return read.status === "valid" && read.value.closedCycles.some((cert) => cert.ring !== null &&
    cert.cycle.quota?.status === "drained" && cert.ring.workKey === workKey &&
    (attemptId === undefined || cert.ring.attemptId === attemptId));
}

/** 同次 fresh 责任读取只验证一遍完整book，不为ring每条再读整本。 */
export function readTreasuryContinuousOHClosedWorkSet(): ReadonlySet<string> | null {
  const read = readTreasuryContinuousOHState();
  if (read.status === "invalid") return null;
  return new Set(read.status === "absent" ? [] : read.value.closedCycles.flatMap((cert) =>
    cert.ring !== null && cert.cycle.quota?.status === "drained" ? [`${cert.ring.workKey}\n${cert.ring.attemptId}`] : []));
}

export function continuousSessionOwnsActivity(): boolean {
  const read = readTreasuryContinuousOHState();
  return read.status === "invalid" || read.status === "valid" && read.value.sessionStatus !== "stopped";
}

/**
 * 未绑定 pilot 或已验收的持续期借普通 synthesis producer 建单，再自然备货。
 * ON 时完整接管此候选的建单权限：busy/预算/坏态不能回退 Terminal 增量合并，
 * 否则会改变已签名 task 身份。此投影没有 native/额度/任务写入权限。
 */
export function inspectTreasuryContinuousOHProcurement(
  sourceRoomName: string, targetRoomName: string, resource: ResourceConstant,
  product: ResourceConstant, requestedAmount: number,
): { readonly ownsRoute: boolean; readonly amount: number } {
  const unmanaged = { ownsRoute: false, amount: 0 } as const;
  const held = { ownsRoute: true, amount: 0 } as const;
  if (sourceRoomName !== TREASURY_T4_LANE.sourceRoom || targetRoomName !== TREASURY_T4_LANE.targetRoom ||
      resource !== TREASURY_T4_LANE.resource || product !== RESOURCE_UTRIUM_ACID) return unmanaged;
  try {
    const read = readTreasuryContinuousOHState();
    if (read.status === "absent" || read.status === "valid" && read.value.sessionStatus === "stopped") {
      return readTreasuryLaneResponsibility(TREASURY_T4_LANE).status === "clear" ? unmanaged : held;
    }
    if (read.status !== "valid") return held;
    const state = read.value;
    const clock = now();
    if (!clock || !finiteNonNegative(requestedAmount) || requestedAmount < 1 ||
        state.sessionStatus !== "running" || state.pilot.taskId !== null && (state.pilot.releasedAtTick === null ||
          clock.tick <= state.pilot.releasedAtTick) || state.currentCycle !== null || state.modeTransition !== null ||
        rawMode() !== "canary" || fixedGateReason(state) !== null || !safeEnvironment() || !cargoQuiescent(state) ||
        state.sequenceHighWater >= state.policy.maxPrepareCycles || !otherLanesClear() ||
        !kernelIdleAndCertified(state) || readTreasuryLaneResponsibility(TREASURY_T4_LANE).status !== "clear") return held;
    return { ownsRoute: true, amount: procurementSupplyAmount(state, requestedAmount) };
  } catch { return held; }
}

/** 未绑定 pilot 的采购整量26，必须同时证明其10/10/6三片资金和预算足够。 */
function procurementBudgetPlan(state: TreasuryContinuousOHState, amount: number): { fee: number } | null {
  const clock = now();
  if (!clock || !finiteNonNegative(amount) || amount < 1) return null;
  const slice = state.pilot.taskId === null ? Math.min(state.policy.sliceAmount, state.pilot.sliceCap) : amount;
  const calls = Math.ceil(amount / slice);
  if (state.sequenceHighWater + calls > state.policy.maxPrepareCycles) return null;
  let fee = 0;
  for (let remaining = amount; remaining > 0; remaining -= slice) {
    const quote = Game.market.calcTransactionCost(Math.min(slice, remaining), TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom);
    if (!finiteNonNegative(quote) || quote > 100) return null;
    fee += quote;
  }
  const firstFee = Game.market.calcTransactionCost(Math.min(slice, amount), TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom);
  if (!checkTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
    clock.ms, clock.tick, Math.min(slice, amount), firstFee).ok) return null;
  const totals = summarizeTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs, clock.ms);
  for (const used of [totals.rolling24h, totals.epoch24h]) {
    if (used.oh + amount > state.policy.rolling24hOH || used.energy + fee > state.policy.rolling24hEnergy ||
        used.nativeCalls + calls > state.policy.rolling24hNativeCalls) return null;
  }
  return totals.lifetime.oh + amount <= state.policy.lifetimeOH && totals.lifetime.energy + fee <= state.policy.lifetimeEnergy &&
    totals.lifetime.nativeCalls + calls <= state.policy.lifetimeNativeCalls ? { fee } : null;
}

function procurementSupplyAmount(state: TreasuryContinuousOHState, requestedAmount: number, adoptingTask?: ResourceTransferTask): number {
  try {
    const clock = now();
    if (!clock) return 0;
    const sourceRoomName = TREASURY_T4_LANE.sourceRoom;
    const targetRoomName = TREASURY_T4_LANE.targetRoom;
    const resource = TREASURY_T4_LANE.resource;
    const product = RESOURCE_UTRIUM_ACID;
    const tasks = taskStore();
    if (!tasks || Object.entries(tasks).some(([id, task]) => task.id !== id ||
        !isValidTreasuryTransferTaskForCommitment(task) || task.treasurySlice !== undefined ||
        taskInScope(task) && task.status === "pending" && task.remainingAmount > 0 && task.id !== adoptingTask?.id)) return 0;
    // producer 已完成 canonical 初始化；此只读入口不迁移旧表或初始化 Memory。
    if (Memory.data?.resourceControl?.taskSchemaVersion !== 2) return 0;
    const prospectId = "treasury-T4-procurement-prospect";
    if (tasks[prospectId] !== undefined) return 0;
    const demand = inspectConfiguredSynthesisTransferDemand(targetRoomName, resource, product, adoptingTask?.id ?? prospectId);
    if (demand.status !== "bounded" || !finiteNonNegative(demand.amount) || demand.amount < 1) return 0;
    const rooms = Object.values(Game.rooms).filter((room) => room.controller?.my === true);
    const observation = buildTreasuryObservation({ scope: "market-fresh", epochSeq: 0, rooms });
    const commitments = buildTreasuryCommitmentIndex({ tick: clock.tick, tasks,
      reservations: Memory.runtime?.resourceReservations ?? {}, observation });
    if (commitments.commitmentCompleteness(sourceRoomName, resource) !== "complete" ||
        commitments.commitmentCompleteness(targetRoomName, resource) !== "complete" ||
        !observation.locationExists(sourceRoomName, "storage")) return 0;
    const floor = Memory.cfg?.resourceControl?.rooms?.[sourceRoomName]?.mineralFloor?.[resource] ?? 0;
    const stored = observation.amount(sourceRoomName, "storage", resource);
    const terminal = observation.amount(sourceRoomName, "terminal", resource);
    const outgoing = commitments.outgoing(sourceRoomName, resource) - (adoptingTask?.remainingAmount ?? 0);
    const reserved = commitments.reservedProduction(sourceRoomName, resource);
    const carried = inspectTreasuryCarrierProductionCommitment(sourceRoomName, resource);
    if (![floor, stored, terminal, outgoing, reserved, carried].every(finiteNonNegative)) return 0;
    // 只计可转移的 Storage/Terminal 现货，不借 lab 或既有待出/生产/搬运责任。
    // Terminal 已备好时仍可直接复用；kernel 已证实完全 idle。
    const backing = stored + terminal - floor - outgoing - reserved - carried!;
    if (!finiteNonNegative(backing) || backing < 1) return 0;
    const unbound = state.pilot.taskId === null;
    const desired = Math.min(requestedAmount, demand.amount, unbound ? state.pilot.cap : state.policy.sliceAmount);
    if (unbound && backing < desired) return 0;
    const maximum = Math.min(desired, backing);
    // 持续期可接真实1..9小片；未绑定 pilot 必须整批足额，不能以部分货建死任务。
    for (let amount = maximum; amount >= (unbound ? maximum : 1); amount -= 1) {
      const plan = procurementBudgetPlan(state, amount);
      if (!plan) continue;
      const fee = plan.fee;
      const prospect: ResourceTransferTask = adoptingTask ?? { id: prospectId, resource, fromRoomName: sourceRoomName,
        toRoomName: targetRoomName, amount, remainingAmount: amount, status: "pending", origin: "automatic",
        reason: TREASURY_T4_LANE.requiredReason, createdAt: clock.tick, updatedAt: clock.tick, lastProgressAt: clock.tick };
      if (inspectTreasuryResourceTransferPreparation(prospect, amount, fee).ok) return amount;
    }
    return 0;
  } catch { return 0; }
}

function quotaIdentityEqual(left: TreasuryT1Quota, right: TreasuryT1Quota): boolean {
  const { status: _left, ...a } = left;
  const { status: _right, ...b } = right;
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesCurrentQuota(value: TreasuryT1Quota, cycle: TreasuryContinuousOHCycle): boolean {
  return value.schemaVersion === 2 && value.runId === CONTINUOUS_RUN_ID && value.taskId === cycle.taskId &&
    value.taskCreatedAt === cycle.taskCreatedAt && value.taskAmount === cycle.taskAmount && value.amount === cycle.amount &&
    value.workKey === treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence) &&
    typeof value.attemptId === "string" && /^[A-Za-z0-9:_\-.]{1,128}$/.test(value.attemptId) &&
    finiteNonNegative(value.reservedAtTick) && value.reservedAtTick >= cycle.startedAtTick;
}

export function writeTreasuryContinuousOHQuota(value: TreasuryT1Quota, fee?: number): boolean {
  try {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid" || !read.value.currentCycle) return false;
    const state = read.value;
    const cycle = state.currentCycle!;
    if (!matchesCurrentQuota(value, cycle)) return false;
    const payload = treasuryContinuousOHStatePayload(state);
    const previous = cycle.quota;
    if (value.status === "reserved") {
      if (previous !== null || !finiteNonNegative(fee) || fee > state.policy.rolling24hEnergy ||
          state.consumption.some((entry) => entry.sequence === cycle.sequence)) return false;
      return writeTreasuryContinuousOHState({ ...payload, currentCycle: { ...cycle, quota: { ...value }, reservedFee: fee } });
    }
    if (!previous || !quotaIdentityEqual(previous, value)) return false;
    if (value.status === "dispatching") {
      const clock = now();
      const task = taskStore()?.[cycle.taskId];
      if (previous.status !== "reserved" || !clock || fee !== cycle.reservedFee || cycle.status !== "active" ||
          state.sessionStatus !== "running" || !task || !treasuryContinuousOHAllows(task, cycle.amount) ||
          state.consumption.some((entry) => entry.sequence === cycle.sequence || entry.attemptId === value.attemptId)) return false;
      const budget = checkTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
        clock.ms, clock.tick, cycle.amount, fee!);
      if (!budget.ok || state.pilot.releasedAtTick === null && pilotConsumed(state) + cycle.amount > state.pilot.cap) return false;
      return writeTreasuryContinuousOHState({ ...payload,
        currentCycle: { ...cycle, quota: { ...value } },
        consumption: [...state.consumption, { sequence: cycle.sequence, attemptId: value.attemptId,
          amount: cycle.amount, fee: fee!, atTick: clock.tick, atMs: clock.ms,
          epoch: Math.floor((clock.ms - state.enabledAtMs) / 86_400_000) }],
      });
    }
    if (value.status !== "drained") return false;
    if (previous.status === "drained") return true;
    const health = kernelReadable();
    const task = taskStore()?.[cycle.taskId];
    if (!health || health.status !== "healthy" || !task || !taskInScope(task) ||
        task.id !== cycle.taskId || task.createdAt !== cycle.taskCreatedAt || task.amount !== cycle.taskAmount ||
        Object.values(health.memory.active).some((record) => record.attemptId === value.attemptId || record.workKey === value.workKey)) return false;
    const ring = health.memory.ring.find((entry) => entry.attemptId === value.attemptId && entry.workKey === value.workKey);
    const lease = task.treasurySlice;
    if (!ring || ring.generation !== 1 || !lease || lease.runId !== CONTINUOUS_RUN_ID ||
        lease.workKey !== value.workKey || lease.attemptId !== value.attemptId || lease.phase !== "closing" || lease.amount !== 0 ||
        (lease.outcome !== "committed" && lease.outcome !== "not_executed") ||
        (lease.outcome === "committed" ? ring.terminalPhase !== "committed" ||
          task.remainingAmount !== cycle.taskRemainingAtArm - cycle.amount ||
          !state.consumption.some((entry) => entry.sequence === cycle.sequence) :
          !["not_executed", "abandoned"].includes(ring.terminalPhase) || task.remainingAmount !== cycle.taskRemainingAtArm)) return false;
    return writeTreasuryContinuousOHState({ ...payload, currentCycle: { ...cycle, quota: { ...value } } });
  } catch { return false; }
}

function pilotConsumed(state: TreasuryContinuousOHState): number {
  return state.consumption.reduce((total, entry) => total +
    (state.pilot.releasedAtTick === null || entry.atTick <= state.pilot.releasedAtTick ? entry.amount : 0), 0);
}

function pilotCommitted(state: TreasuryContinuousOHState): { amount: number; cycles: number } {
  const certs = state.closedCycles.filter((cert) => cert.outcome === "committed" &&
    (state.pilot.releasedAtTick === null || cert.cycle.startedAtTick <= state.pilot.releasedAtTick));
  return { amount: certs.reduce((sum, cert) => sum + cert.cycle.amount, 0), cycles: certs.length };
}

function closeCycle(state: TreasuryContinuousOHState, reason: string, stop: boolean): TreasuryContinuousOHResult {
  const cycle = state.currentCycle;
  if (!writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state),
    sessionStatus: stop ? "stopping" : state.sessionStatus,
    modeTransition: stop ? null : state.modeTransition,
    stopReason: stop ? reason.slice(0, 80) || "operator_stop" : state.stopReason,
    currentCycle: cycle && cycle.status !== "closed" ? { ...cycle, status: "closed", closeReason: reason.slice(0, 80) || "closed" } : cycle,
  })) { setMode("drain"); return fail("control_write_failed"); }
  if (!setMode(cycle ? "drain" : stop ? "off" : "canary")) return fail("mode_write_failed");
  return ok(stop ? "stopping" : "cycle_closed");
}

function closeTreasuryContinuousOH(reason = "operator_stop"): TreasuryContinuousOHResult {
  const read = readTreasuryContinuousOHState();
  if (read.status !== "valid") return fail(read.status);
  if (read.value.sessionStatus === "stopped") return setMode("off") ? ok("stopped") : fail("mode_write_failed");
  return closeCycle(read.value, reason, reason !== "native_attempt");
}

export function stopTreasuryContinuousOH(): TreasuryContinuousOHResult {
  const closed = closeTreasuryContinuousOH("operator_stop");
  if (!closed.ok) return closed;
  return normalizeTreasuryContinuousOHControl();
}

export function enableTreasuryContinuousOH(options?: TreasuryContinuousOHEnableOptions): TreasuryContinuousOHResult {
  try {
    const prior = readTreasuryContinuousOHState();
    if (prior.status !== "absent") return fail(prior.status === "invalid" ? "state_invalid" : "session_already_used");
    if (!object(options) || Object.keys(options).some((key) =>
      !["pilotTaskId", "pilotTaskCreatedAt", "pilotTaskAmount", "policy"].includes(key))) return fail("pilot_binding_required");
    const policy = normalizeTreasuryContinuousOHPolicy(options.policy);
    if (policy.ok === false) return fail(policy.reason);
    const clock = now();
    const ids = endpoints();
    const tasks = taskStore();
    const task = tasks?.[options.pilotTaskId];
    if (!clock || !ids || !tasks || !task || !taskInScope(task) || task.status !== "pending" || task.remainingAmount < 1 ||
        task.treasurySlice !== undefined || task.createdAt !== options.pilotTaskCreatedAt || task.amount !== options.pilotTaskAmount) return fail("pilot_task_or_endpoint_gate");
    if (rawMode() !== undefined && rawMode() !== "off") return fail("mode_not_off");
    const health = kernelReadable();
    if (!health || health.status === "healthy" && (Object.keys(health.memory.active).length > 0 ||
      health.memory.ring.some((entry) => entry.workKey.startsWith(`biz:${CONTINUOUS_RUN_ID}:`))) ||
      Object.values(tasks).some((entry) => entry.treasurySlice?.runId === CONTINUOUS_RUN_ID) || !otherLanesClear()) return fail("history_or_responsibility_present");
    if (!deploymentMatches() || !safeEnvironment()) return fail("environment_gate");
    if (endpointTouched()) return fail("terminal_action_this_tick");
    const sessionId = formatTreasuryStableTransactionId(CONTROL_RUN_ID, clock.tick, clock.ms,
      BUILD_INFO.tag, BUILD_INFO.bundleHash, ids.source.id, ids.target.id);
    if (!writeTreasuryContinuousOHState({
      schemaVersion: 1, runId: CONTROL_RUN_ID, sessionId, sessionStatus: "running", modeTransition: null,
      enabledAtTick: clock.tick, enabledAtMs: clock.ms,
      lastObservedAtTick: clock.tick, lastObservedAtMs: clock.ms,
      deadlineTick: clock.tick + TREASURY_CONTINUOUS_OH_SESSION_TICKS,
      deadlineMs: clock.ms + TREASURY_CONTINUOUS_OH_SESSION_MS,
      deployTag: BUILD_INFO.tag, deployBundleHash: BUILD_INFO.bundleHash,
      sourceTerminalId: ids.source.id, targetTerminalId: ids.target.id,
      policy: policy.policy,
      pilot: { taskId: task.id, taskCreatedAt: task.createdAt, taskAmount: task.amount, cap: 26, sliceCap: 10,
        completedAtTick: null, completedAtMs: null, completionReason: null, releasedAtTick: null, releasedAtMs: null },
      sequenceHighWater: 0, currentCycle: null, closedCycles: [], consumption: [], stopReason: "",
    })) return fail("state_write_failed");
    if (!setMode("canary")) { closeTreasuryContinuousOH("enable_mode_write_failed"); return fail("mode_write_failed"); }
    return ok("enabled_pilot");
  } catch { return fail("enable_failed"); }
}

/** 无旧任务可绑定时，只签入等待态；任务只能由正常 synthesis producer 创建。 */
export function enableTreasuryContinuousOHFromDemand(policyOptions?: Partial<TreasuryContinuousOHPolicy>): TreasuryContinuousOHResult {
  try {
    const prior = readTreasuryContinuousOHState();
    if (prior.status !== "absent") return fail(prior.status === "invalid" ? "state_invalid" : "session_already_used");
    const policy = normalizeTreasuryContinuousOHPolicy(policyOptions);
    if (policy.ok === false) return fail(policy.reason);
    const clock = now();
    const ids = endpoints();
    const tasks = taskStore();
    if (!clock || !ids || !tasks) return fail("demand_or_endpoint_gate");
    if (rawMode() !== undefined && rawMode() !== "off") return fail("mode_not_off");
    const health = kernelReadable();
    if (!health || health.status === "healthy" && (Object.keys(health.memory.active).length > 0 ||
        health.memory.ring.some((entry) => entry.workKey.startsWith(`biz:${CONTINUOUS_RUN_ID}:`))) ||
        Object.values(tasks).some((task) => task.treasurySlice !== undefined) || !otherLanesClear() ||
        readTreasuryLaneResponsibility(TREASURY_T4_LANE).status !== "clear") return fail("history_or_responsibility_present");
    if (!deploymentMatches() || !safeEnvironment()) return fail("environment_gate");
    const initial = sealTreasuryContinuousOHState({
      schemaVersion: 2, runId: CONTROL_RUN_ID,
      sessionId: formatTreasuryStableTransactionId(CONTROL_RUN_ID, clock.tick, clock.ms,
        BUILD_INFO.tag, BUILD_INFO.bundleHash, ids.source.id, ids.target.id),
      sessionStatus: "running", modeTransition: null, enabledAtTick: clock.tick, enabledAtMs: clock.ms,
      lastObservedAtTick: clock.tick, lastObservedAtMs: clock.ms,
      deadlineTick: clock.tick + TREASURY_CONTINUOUS_OH_SESSION_TICKS,
      deadlineMs: clock.ms + TREASURY_CONTINUOUS_OH_SESSION_MS,
      deployTag: BUILD_INFO.tag, deployBundleHash: BUILD_INFO.bundleHash,
      sourceTerminalId: ids.source.id, targetTerminalId: ids.target.id, policy: policy.policy,
      pilot: { taskId: null, taskCreatedAt: null, taskAmount: null, cap: 26, sliceCap: 10,
        completedAtTick: null, completedAtMs: null, completionReason: null, releasedAtTick: null, releasedAtMs: null },
      sequenceHighWater: 0, currentCycle: null, closedCycles: [], consumption: [], stopReason: "",
    });
    if (!cargoQuiescent(initial)) return fail("terminal_cargo_held");
    if (procurementSupplyAmount(initial, initial.pilot.cap) < 1) return fail("demand_supply_or_budget_gate");
    if (!writeTreasuryContinuousOHState(treasuryContinuousOHStatePayload(initial))) return fail("state_write_failed");
    if (!setMode("canary")) { closeTreasuryContinuousOH("enable_mode_write_failed"); return fail("mode_write_failed"); }
    return ok("enabled_awaiting_natural_pilot");
  } catch { return fail("enable_from_demand_failed"); }
}

function adoptNaturalPilotTask(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  if (state.schemaVersion !== 2 || state.pilot.taskId !== null || state.currentCycle !== null ||
      state.sequenceHighWater !== 0 || state.sessionStatus !== "running" || rawMode() !== "canary" ||
      fixedGateReason(state) || !safeEnvironment() || !cargoQuiescent(state) || !otherLanesClear() ||
      !kernelIdleAndCertified(state) || readTreasuryLaneResponsibility(TREASURY_T4_LANE).status !== "clear") return ok("pilot_binding_held");
  const tasks = taskStore();
  if (!tasks || Object.entries(tasks).some(([id, task]) => task.id !== id || !isValidTreasuryTransferTaskForCommitment(task))) return fail("task_store_unreadable");
  const candidates = Object.values(tasks).filter((task) => taskInScope(task) && task.status === "pending" && task.remainingAmount > 0);
  if (candidates.length === 0) return ok("awaiting_natural_pilot_task");
  if (candidates.length !== 1) return ok("pilot_binding_ambiguous");
  const task = candidates[0];
  if (task.treasurySlice !== undefined || task.amount > state.pilot.cap || task.remainingAmount !== task.amount ||
      task.createdAt < state.enabledAtTick || task.createdAt > Game.time ||
      !new RegExp(`^${task.createdAt}:[1-9][0-9]*:OH:E4N58->E1N57$`).test(task.id)) return ok("pilot_task_identity_unavailable");
  if (procurementSupplyAmount(state, task.remainingAmount, task) < 1) return ok("pilot_binding_demand_or_supply_held");
  return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state),
    pilot: { ...state.pilot, taskId: task.id, taskCreatedAt: task.createdAt, taskAmount: task.amount },
  }) ? ok("natural_pilot_task_bound") : fail("pilot_binding_write_failed");
}

function appendClosedCycle(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  const cycle = state.currentCycle;
  if (!cycle || cycle.status !== "closed") return ok("no_closed_cycle");
  const health = kernelReadable();
  const tasks = taskStore();
  if (!health || !tasks) return fail("closure_evidence_unreadable");
  if (health.status === "healthy" && Object.values(health.memory.active).some((record) =>
    record.identity.actionKind === CONTINUOUS_ACTION_KIND || record.workKey === treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence))) return ok("original_work_held");
  if (Object.values(tasks).some((task) => task.treasurySlice?.runId === CONTINUOUS_RUN_ID)) return ok("task_lease_held");
  const clock = now();
  if (!clock || clock.tick < cycle.startedAtTick || clock.ms < cycle.startedAtMs) return fail("closure_clock_regressed");
  const task = tasks[cycle.taskId];
  let cert: TreasuryContinuousOHClosedCertificate;
  if (cycle.quota === null) {
    if (health.status === "healthy" && health.memory.ring.some((entry) => entry.workKey === treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence))) return fail("unbound_closed_work");
    cert = { sequence: cycle.sequence, cycle, closedAtTick: clock.tick, closedAtMs: clock.ms,
      outcome: "cancelled", taskRemainingAtClose: cycle.taskRemainingAtArm, ring: null };
  } else {
    if (cycle.quota.status !== "drained" || health.status !== "healthy" || !task || !taskInScope(task) ||
        task.id !== cycle.taskId || task.createdAt !== cycle.taskCreatedAt || task.amount !== cycle.taskAmount) return ok("quota_or_task_held");
    const ring = health.memory.ring.find((entry) => entry.attemptId === cycle.quota!.attemptId && entry.workKey === cycle.quota!.workKey);
    if (!ring || ring.generation !== 1) return fail("exact_ring_missing");
    const outcome = ring.terminalPhase === "committed" ? "committed" :
      ["not_executed", "abandoned"].includes(ring.terminalPhase) ? "not_executed" : null;
    if (!outcome || task.remainingAmount !== cycle.taskRemainingAtArm - (outcome === "committed" ? cycle.amount : 0)) return fail("task_closure_mismatch");
    cert = { sequence: cycle.sequence, cycle, closedAtTick: clock.tick, closedAtMs: clock.ms,
      outcome, taskRemainingAtClose: task.remainingAmount, ring: { ...ring } };
  }
  return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state),
    currentCycle: null, closedCycles: [...state.closedCycles, cert],
    modeTransition: state.sessionStatus === "stopping" ? null : "canary_after_closure",
  }) ? ok("cycle_certified") : fail("certificate_write_failed");
}

/** 只取消同任务已核实切片后的陈旧余量；标准API保留原amount/remaining，预算/证书不改。 */
function cancelSatisfiedTasks(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  if (state.currentCycle !== null || !kernelIdleAndCertified(state)) return ok("responsibility_held");
  const tasks = taskStore();
  if (!tasks) return fail("task_store_unreadable");
  for (const task of Object.values(tasks)) {
    if (!taskInScope(task) || task.status !== "pending" || task.remainingAmount < 1 || task.treasurySlice !== undefined ||
        !state.closedCycles.some((cert) => cert.outcome === "committed" && cert.cycle.taskId === task.id &&
          cert.cycle.taskCreatedAt === task.createdAt && cert.cycle.taskAmount === task.amount)) continue;
    const demand = inspectConfiguredSynthesisTransferDemand(TREASURY_T4_LANE.targetRoom,
      TREASURY_T4_LANE.resource, RESOURCE_UTRIUM_ACID, task.id);
    if (demand.status !== "bounded" || demand.amount !== 0) continue;
    const before = { amount: task.amount, remainingAmount: task.remainingAmount };
    const result = cancelResourceTransferTask(task.id);
    const after = taskStore()?.[task.id];
    if (typeof result === "string" || !result.ok || !after || after.status !== "cancelled" ||
        after.amount !== before.amount || after.remainingAmount !== before.remainingAmount) return fail("stale_task_cancel_failed");
    after.lastError = "treasury_T4_demand_satisfied_after_exact_slice_closure";
  }
  return ok("stale_task_check_complete");
}

function markPilotCompletion(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  if (state.pilot.taskId === null || state.pilot.releasedAtTick !== null || state.sessionStatus !== "running" || state.currentCycle !== null ||
      !kernelIdleAndCertified(state)) return ok("pilot_not_complete");
  const committed = pilotCommitted(state);
  if (committed.cycles < 1) return ok("pilot_no_committed_slice");
  const demand = inspectConfiguredSynthesisTransferDemand(TREASURY_T4_LANE.targetRoom,
    TREASURY_T4_LANE.resource, RESOURCE_UTRIUM_ACID, state.pilot.taskId);
  if (committed.amount !== state.pilot.cap && (demand.status !== "bounded" || demand.amount !== 0)) return ok("pilot_in_progress");
  const clock = now();
  if (!clock) return fail("clock_invalid");
  const completionReason = committed.amount === state.pilot.cap ? "cap_settled" as const :
    committed.cycles >= 2 ? "demand_satisfied" as const : "shortened" as const;
  return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state),
    sessionStatus: "pilot_complete_awaiting_release",
    pilot: { ...state.pilot, completedAtTick: clock.tick, completedAtMs: clock.ms, completionReason },
  }) && setMode("canary") ? ok(`pilot_${completionReason}_awaiting_release`) : fail("pilot_completion_write_failed");
}

export function acceptTreasuryContinuousOHPilot(): TreasuryContinuousOHResult {
  try {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid") return fail(read.status);
    const state = read.value;
    if (state.pilot.releasedAtTick !== null) return fail("pilot_already_released");
    if (state.sessionStatus !== "pilot_complete_awaiting_release" || state.currentCycle !== null) return fail("pilot_not_awaiting_release");
    const fixed = fixedGateReason(state);
    if (fixed) return fail(fixed);
    if (pilotCommitted(state).cycles < 2 || state.pilot.completionReason === "shortened") return fail("pilot_shortened_not_multislice_acceptance");
    const demand = inspectConfiguredSynthesisTransferDemand(TREASURY_T4_LANE.targetRoom,
      TREASURY_T4_LANE.resource, RESOURCE_UTRIUM_ACID, state.pilot.taskId);
    if (pilotCommitted(state).amount !== state.pilot.cap && (demand.status !== "bounded" || demand.amount !== 0)) return fail("pilot_completion_changed");
    const tasks = taskStore();
    if (!tasks || !kernelIdleAndCertified(state) || !otherLanesClear() ||
        Object.values(tasks).some((task) => task.treasurySlice?.runId === CONTINUOUS_RUN_ID)) return fail("pilot_responsibility_held");
    if (!safeEnvironment()) return fail("environment_gate");
    const clock = now()!;
    if (!writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state), sessionStatus: "running",
      pilot: { ...state.pilot, releasedAtTick: clock.tick, releasedAtMs: clock.ms },
    })) return fail("pilot_release_write_failed");
    return setMode("canary") ? ok("pilot_released") : fail("mode_write_failed");
  } catch { return fail("pilot_release_failed"); }
}

function prepareNextCycle(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  if (state.pilot.taskId === null) return ok("awaiting_natural_pilot_task");
  const clock = now()!;
  if (state.pilot.releasedAtTick !== null && clock.tick <= state.pilot.releasedAtTick) return ok("pilot_release_next_tick");
  if (state.sequenceHighWater >= state.policy.maxPrepareCycles) return ok("prepare_cycle_budget_exhausted");
  if (!otherLanesClear() || !kernelIdleAndCertified(state)) return ok("other_responsibility_held");
  const tasks = taskStore();
  if (!tasks) return fail("task_store_unreadable");
  if (Object.values(tasks).some((task) => task.treasurySlice?.runId === CONTINUOUS_RUN_ID)) return fail("orphan_task_lease_held");
  const pilot = state.pilot.releasedAtTick === null;
  const candidates = Object.values(tasks).filter((task) => taskInScope(task) && task.status === "pending" &&
    task.remainingAmount > 0 && task.treasurySlice === undefined && (!pilot ||
      task.id === state.pilot.taskId && task.createdAt === state.pilot.taskCreatedAt && task.amount === state.pilot.taskAmount))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (candidates.length === 0) return ok("idle_no_task");
  const candidate = candidates[0];
  const demand = inspectConfiguredSynthesisTransferDemand(TREASURY_T4_LANE.targetRoom,
    TREASURY_T4_LANE.resource, RESOURCE_UTRIUM_ACID, candidate.id);
  if (demand.status !== "bounded") return ok(demand.status === "held" ? demand.reason : "idle_demand_unmanaged");
  if (demand.amount <= 0) return ok("idle_no_demand");
  const maximum = Math.min(state.policy.sliceAmount, pilot ? state.pilot.sliceCap : state.policy.sliceAmount,
    pilot ? state.pilot.cap - pilotConsumed(state) : state.policy.sliceAmount);
  const amount = Math.min(maximum, candidate.remainingAmount, demand.amount);
  if (!finiteNonNegative(amount) || amount < 1) return ok("pilot_budget_exhausted");
  let fee: number;
  try { fee = Game.market.calcTransactionCost(amount, TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom); }
  catch { return ok("quote_unavailable"); }
  const budget = checkTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
    clock.ms, clock.tick, amount, fee);
  if (!budget.ok) return ok(budget.reason);
  if (!safeEnvironment()) return ok("environment_gate");
  if (endpointTouched()) return ok("terminal_action_this_tick");
  const preparation = inspectTreasuryResourceTransferPreparation(candidate, amount, fee);
  if (!preparation.ok) return ok(preparation.reason);
  const cycle: TreasuryContinuousOHCycle = {
    sequence: state.sequenceHighWater + 1, status: "preparing",
    startedAtTick: clock.tick, deadlineTick: Math.min(state.deadlineTick, clock.tick + 600),
    startedAtMs: clock.ms, deadlineMs: Math.min(state.deadlineMs, clock.ms + 30 * 60_000),
    lastHeartbeatAtMs: clock.ms, controlUntilMs: Math.min(state.deadlineMs, clock.ms + 60_000),
    taskId: candidate.id, taskCreatedAt: candidate.createdAt, taskAmount: candidate.amount,
    taskRemainingAtArm: candidate.remainingAmount, amount, closeReason: "", quota: null, reservedFee: null,
  };
  return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state),
    sequenceHighWater: cycle.sequence, currentCycle: cycle,
  }) && setMode("canary") ? ok("preparing") : fail("cycle_prepare_write_failed");
}

function maintainCycle(state: TreasuryContinuousOHState): TreasuryContinuousOHResult {
  const cycle = state.currentCycle!;
  if (cycle.quota !== null) {
    // reserve/dispatch 的原attempt已经唯一，reset后只drain，不再次调用native。
    return cycle.status === "closed" ? appendClosedCycle(state) : closeCycle(state,
      cycle.quota.status === "reserved" ? "pre_native_recovery" : "native_attempt", false);
  }
  const expired = cycleGateReason(state, cycle);
  if (expired) return closeCycle(state, expired, false);
  const tasks = taskStore();
  const task = tasks?.[cycle.taskId];
  if (!task || !taskMatchesCycle(task, cycle)) return closeCycle(state, "task_identity_changed", true);
  const health = kernelReadable();
  if (!health) return fail("kernel_unreadable");
  if (health.status === "healthy" && Object.values(health.memory.active).some((record) =>
    record.identity.actionKind === CONTINUOUS_ACTION_KIND)) return closeCycle(state, "admitted_before_quota_recovery", false);
  const demand = inspectConfiguredSynthesisTransferDemand(TREASURY_T4_LANE.targetRoom,
    TREASURY_T4_LANE.resource, RESOURCE_UTRIUM_ACID, task.id);
  if (demand.status === "bounded" && demand.amount < cycle.amount) return closeCycle(state, "synthesis_need_changed", false);
  if (demand.status !== "bounded") return closeCycle(state, "synthesis_demand_unreadable", true);
  const clock = now()!;
  let fee: number;
  try { fee = Game.market.calcTransactionCost(cycle.amount, TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom); }
  catch { return ok("quote_unavailable"); }
  const budget = checkTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
    clock.ms, clock.tick, cycle.amount, fee);
  if (!budget.ok) return closeCycle(state, "budget_changed_before_native", false);
  let status = cycle.status;
  if (status === "preparing" && safeEnvironment() && otherLanesClear() && cargoQuiescent(state)) {
    const ids = endpoints();
    const ready = inspectTreasuryResourceTransferReadiness(task, cycle.amount, fee);
    if (ids && ids.source.cooldown === 0 && (ids.source.store.getUsedCapacity(TREASURY_T4_LANE.resource) ?? 0) >= cycle.amount &&
        (ids.source.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) >= fee &&
        (ids.target.store.getFreeCapacity() ?? 0) >= cycle.amount && ready.ok) status = "active";
  }
  if (clock.ms === cycle.lastHeartbeatAtMs && status === cycle.status) return ok(status);
  return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state), currentCycle: {
    ...cycle, status, lastHeartbeatAtMs: clock.ms, controlUntilMs: Math.min(cycle.deadlineMs, clock.ms + 60_000),
  } }) ? ok(status) : fail("cycle_maintenance_write_failed");
}

export function normalizeTreasuryContinuousOHControl(): TreasuryContinuousOHResult {
  try {
    let read = readTreasuryContinuousOHState();
    if (read.status === "absent") return rawMode() === undefined || rawMode() === "off" ? ok("absent") : fail("control_absent");
    if (read.status === "invalid") { setMode("drain"); return fail("state_invalid"); }
    let state = read.value;
    if (state.sessionStatus === "stopped") return setMode("off") ? ok("stopped") : fail("mode_write_failed");
    const fixed = fixedGateReason(state);
    if (fixed && state.sessionStatus !== "stopping") {
      const closed = closeCycle(state, fixed, true);
      if (!closed.ok) return closed;
      read = readTreasuryContinuousOHState();
      if (read.status !== "valid") return fail("state_invalid");
      state = read.value;
    }
    if (state.modeTransition === "canary_after_closure" && (rawMode() === "drain" || rawMode() === "canary")) {
      if (!setMode("canary") || !writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state), modeTransition: null })) {
        return fail("closure_mode_handoff_failed");
      }
      read = readTreasuryContinuousOHState();
      if (read.status !== "valid") return fail("state_invalid");
      state = read.value;
    }
    if (!fixed && (Game.time !== state.lastObservedAtTick || Date.now() !== state.lastObservedAtMs)) {
      if (!writeTreasuryContinuousOHState(treasuryContinuousOHStatePayload(state))) return fail("observation_high_water_write_failed");
      read = readTreasuryContinuousOHState();
      if (read.status !== "valid") return fail("state_invalid");
      state = read.value;
    }
    if (state.sessionStatus !== "stopping" && rawMode() !== "canary" &&
        !(state.currentCycle?.status === "closed" && rawMode() === "drain")) {
      const closed = closeCycle(state, "mode_stopped", true);
      if (!closed.ok) return closed;
      read = readTreasuryContinuousOHState();
      if (read.status !== "valid") return fail("state_invalid");
      state = read.value;
    }
    if (state.currentCycle?.status === "closed") {
      const archived = appendClosedCycle(state);
      if (!archived.ok) return archived;
      read = readTreasuryContinuousOHState();
      if (read.status !== "valid") return fail("state_invalid");
      state = read.value;
      if (state.currentCycle !== null) { setMode("drain"); return archived; }
      if (state.modeTransition === "canary_after_closure") {
        if (!setMode("canary") || !writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state), modeTransition: null })) {
          return fail("closure_mode_handoff_failed");
        }
        read = readTreasuryContinuousOHState();
        if (read.status !== "valid") return fail("state_invalid");
        state = read.value;
      }
    }
    if (state.sessionStatus === "stopping") {
      if (state.currentCycle !== null || !kernelIdleAndCertified(state) ||
          Object.values(taskStore() ?? {}).some((task) => task.treasurySlice?.runId === CONTINUOUS_RUN_ID)) {
        setMode("drain"); return ok("stopping_original_responsibility_held");
      }
      return writeTreasuryContinuousOHState({ ...treasuryContinuousOHStatePayload(state), sessionStatus: "stopped" }) &&
        setMode("off") ? ok("stopped") : fail("session_stop_write_failed");
    }
    if (state.currentCycle !== null) return maintainCycle(state);
    if (!kernelIdleAndCertified(state)) return fail("kernel_or_uncertified_history_held");
    if (state.pilot.taskId === null) return adoptNaturalPilotTask(state);
    const stale = cancelSatisfiedTasks(state);
    if (!stale.ok) return stale;
    const pilot = markPilotCompletion(state);
    if (!pilot.ok) return pilot;
    read = readTreasuryContinuousOHState();
    if (read.status !== "valid") return fail("state_invalid");
    state = read.value;
    if (state.sessionStatus === "pilot_complete_awaiting_release") {
      return setMode("canary") ? ok(`pilot_${state.pilot.completionReason}_awaiting_release`) : fail("mode_write_failed");
    }
    if (!setMode("canary")) return fail("mode_write_failed");
    return prepareNextCycle(state);
  } catch { setMode("drain"); return fail("control_normalization_failed"); }
}

function treasuryContinuousOHAllows(task: ResourceTransferTask, amount: number): boolean {
  try {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid" || read.value.sessionStatus !== "running" || rawMode() !== "canary") return false;
    const state = read.value;
    const cycle = state.currentCycle;
    if (!cycle || cycle.status !== "active" || amount !== cycle.amount || !taskMatchesCycle(task, cycle) ||
        fixedGateReason(state) || cycleGateReason(state, cycle) || !safeEnvironment() || !otherLanesClear()) return false;
    const fee = Game.market.calcTransactionCost(amount, TREASURY_T4_LANE.sourceRoom, TREASURY_T4_LANE.targetRoom);
    return checkTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
      Date.now(), Game.time, amount, fee).ok &&
      (state.pilot.releasedAtTick !== null || pilotConsumed(state) + amount <= state.pilot.cap);
  } catch { return false; }
}

export interface TreasuryContinuousOHStatusOptions { readonly fenceBenchmarkQueries?: number; }

/** 固定两端的有界只读测量，不调用生命周期或业务写入口。 */
function fenceBenchmark(requestedQueries: number): unknown {
  const tick = Game.time; const buildHash = BUILD_INFO.bundleHash;
  let queries = 0; let start: number | null = null;
  try {
    start = Game.cpu.getUsed();
    if (!Number.isFinite(start) || !Number.isFinite(Game.cpu.tickLimit)) throw Error("cpu_unreadable");
    while (queries < requestedQueries) {
      const used = Game.cpu.getUsed();
      if (!Number.isFinite(used) || used < start) throw Error("cpu_unreadable");
      if (Game.cpu.tickLimit - used < 10) break;
      hasTreasuryTerminalFence(queries % 2 === 0 ? TREASURY_T4_LANE.sourceRoom : TREASURY_T4_LANE.targetRoom);
      queries += 1;
    }
    const end = Game.cpu.getUsed();
    if (!Number.isFinite(end) || end < start) throw Error("cpu_unreadable");
    return { requestedQueries, queries, used: end - start, completed: queries === requestedQueries, tick, buildHash };
  } catch {
    return { requestedQueries, queries, used: null, completed: false, tick, buildHash, reason: "cpu_or_fence_unreadable" };
  }
}

export function treasuryContinuousOHStatus(options?: TreasuryContinuousOHStatusOptions): unknown {
  const read = readTreasuryContinuousOHState();
  const status = read.status === "valid" ? { ...read.value, mode: rawMode(),
    budget: summarizeTreasuryContinuousOHBudget(read.value.policy, read.value.consumption, read.value.enabledAtMs, Date.now()),
    pilotCommitted: pilotCommitted(read.value), pilotConsumed: pilotConsumed(read.value),
  } : { status: read.status, mode: rawMode() };
  if (options === undefined) return status;
  if (!object(options) || Object.getOwnPropertySymbols(options).length > 0 ||
      Object.getOwnPropertyNames(options).some((key) => key !== "fenceBenchmarkQueries")) {
    return { ...status, fenceBenchmark: { completed:false,queries:0,used:null,reason:"invalid_benchmark_options" } };
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "fenceBenchmarkQueries");
  if (descriptor === undefined) return status;
  const count = "value" in descriptor ? descriptor.value : undefined;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    return { ...status, fenceBenchmark: { completed:false,queries:0,used:null,reason:"invalid_benchmark_count" } };
  }
  return { ...status, fenceBenchmark: fenceBenchmark(count) };
}

/** 工厂无顶层初始化；lane 常量只在实际调用时读取，避免与 shared recovery 的循环加载相互触发。 */
export function createTreasuryContinuousOHControl() {
  return {
    read: readTreasuryContinuousOHControl, normalize: normalizeTreasuryContinuousOHControl,
    allows: treasuryContinuousOHAllows, close: closeTreasuryContinuousOH, status: treasuryContinuousOHStatus,
    readQuota: readTreasuryContinuousOHQuota, writeQuota: writeTreasuryContinuousOHQuota,
    workKey: (taskId: string) => treasuryContinuousOHWorkKey(taskId,
      readTreasuryContinuousOHState().status === "valid" ? continuousSequence() : 0),
    transactionId: (taskId: string) => formatTreasuryTransactionId(CONTINUOUS_ACTION_KIND, CONTINUOUS_RUN_ID,
      `${taskId}:${continuousSequence()}`),
    sequence: continuousSequence,
  };
}

function continuousSequence(): number {
  const read = readTreasuryContinuousOHState();
  return read.status === "valid" ? read.value.currentCycle?.sequence ?? 0 : 0;
}
