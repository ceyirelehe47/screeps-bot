import {
  buildTreasuryActionContract,
  registerTreasuryActionAdapter,
  type TreasuryActionAdapter,
  type TreasuryActionReconcilerFacts,
} from "@/runtime/treasury/actionContracts";
import {
  createTreasuryReadOnlyObserver,
  type TreasuryReadOnlyConfig,
} from "@/runtime/treasury/readOnlyObservation";
import {
  registerTreasuryPolicyResolver,
  type TreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import {
  ensureReservationSchemaActivated,
} from "@/runtime/resourceReservation";
import { getTreasuryService } from "@/runtime/runtimeServices";
import type { TreasuryService } from "@/runtime/treasury/facade";
import { executeTerminalSend } from "@/runtime/marketActionArbiter";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { bumpTreasuryWorldSequence, readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import type { TreasuryObservationView } from "@/runtime/treasury/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import {
  TREASURY_T1_ACTION_KIND,
  TREASURY_T1_RUN_ID,
  TREASURY_T1_WORK_KEY_PREFIX,
  treasuryT1WorkKey,
  withTreasuryTaskSliceExcluded,
} from "@/runtime/treasuryTaskCommitmentBridge";
import {
  decodeTreasuryT1DurableFacts as decodeDurableFacts,
  encodeTreasuryT1DurableFacts,
  TREASURY_T1_SOURCE_ROOM,
  TREASURY_T1_TARGET_ROOM,
  type DurableT1Facts,
  type TreasuryT1EndpointFacts as EndpointSnapshot,
} from "@/runtime/treasuryT1Facts";

export { TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM } from "@/runtime/treasuryT1Facts";
const TREASURY_T1_MAX_HYDROGEN = 100;
const TREASURY_T1_MAX_FEE_ENERGY = 100;
const TREASURY_T1_QUOTA_KEY = "treasuryProductionT1Quota";
const TREASURY_T1_DESCRIPTION_PREFIX = "treasury-T1-2026-09-24:";

type TreasuryProductionMode = "off" | "shadow" | "canary" | "drain" | "invalid";

interface TreasuryT1TransferArgs {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly workKey: string;
  readonly transactionId: string;
  readonly tick: number;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
  readonly taskRemainingAmount: number;
  readonly taskUpdatedAt: number;
  readonly amount: number;
  readonly quote: number;
  readonly username: string;
  readonly source: EndpointSnapshot;
  readonly target: EndpointSnapshot;
}

interface T1Quota {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly status: "reserved" | "dispatching" | "drained";
  readonly taskId: string;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
  readonly workKey: string;
  readonly attemptId: string;
  readonly amount: number;
  readonly reservedAtTick: number;
}

interface DispatchContext {
  readonly taskId: string;
  readonly workKey: string;
  readonly attemptId: string;
  readonly amount: number;
  readonly ledger: ReceiverCapacityLedger;
  nativeCalls: number;
}

interface LastNativeAttempt {
  readonly taskId: string;
  readonly attemptId: string;
  readonly amount: number;
  readonly fee: number;
  readonly code: ScreepsReturnCode;
}

type QuotaRead = { readonly status: "absent" } | { readonly status: "valid"; readonly value: T1Quota } | { readonly status: "invalid" };

let adapterRegistrationReady = false;
let activeTreasuryService: TreasuryService | null = null;
let activeLifecycleTick = -1;
let lifecycleBlockReason: string | null = null;
let dispatchContext: DispatchContext | null = null;
let lastNativeAttempt: LastNativeAttempt | null = null;
let shadowObserver: ReturnType<typeof createTreasuryReadOnlyObserver> | null = null;
let shadowObserverShard: string | null = null;

const productionPolicy: TreasuryPolicyResolver = Object.freeze({
  policyId: "treasury.production-terminal-slice0-T1",
  policyVersion: 1,
  evaluate(context) {
    if (
      context.actionKind !== TREASURY_T1_ACTION_KIND ||
      !context.rooms.includes(TREASURY_T1_SOURCE_ROOM) ||
      !context.rooms.includes(TREASURY_T1_TARGET_ROOM) ||
      (context.resource !== RESOURCE_HYDROGEN && context.resource !== RESOURCE_ENERGY)
    ) {
      return { status: "rejected" as const, reason: "outside fixed T1 terminal slice policy" };
    }
    return {
      withhold: 0,
      strategicReserve: 0,
      emergencyOverride: false,
      auditReason: "fixed E3N59 to E4N58 H slice; bounded adapter owns the limit",
    };
  },
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function readMode(): TreasuryProductionMode {
  const config = (Memory as unknown as { cfg?: Record<string, unknown> }).cfg;
  const raw = isPlainObject(config?.treasuryTerminalTransferSlice0)
    ? config!.treasuryTerminalTransferSlice0.mode
    : undefined;
  if (raw === undefined) return "off";
  return raw === "off" || raw === "shadow" || raw === "canary" || raw === "drain" ? raw : "invalid";
}

function taskStore(): Record<string, ResourceTransferTask> | undefined {
  return Memory.data?.resourceControl?.tasks as Record<string, ResourceTransferTask> | undefined;
}

function taskLease(task: ResourceTransferTask): ResourceTransferTask["treasurySlice"] | undefined {
  return (task as ResourceTransferTask & { treasurySlice?: ResourceTransferTask["treasurySlice"] }).treasurySlice;
}

function updateTaskLease(task: ResourceTransferTask, lease: ResourceTransferTask["treasurySlice"] | null): boolean {
  const store = taskStore();
  if (!store || store[task.id] !== task) return false;
  if (lease === null) {
    if (task.treasurySlice === undefined) return true;
    delete task.treasurySlice;
  } else {
    task.treasurySlice = lease;
  }
  bumpTreasuryCommitmentRevision();
  return lease === null ? task.treasurySlice === undefined : task.treasurySlice === lease;
}

function writeTaskProgress(
  taskId: string,
  workKey: string,
  attemptId: string,
  amount: number,
  outcome: "committed" | "not_executed",
): boolean {
  const store = taskStore();
  const task = store?.[taskId];
  if (!store || !task || task.id !== taskId || !isPositiveInteger(amount)) return false;
  if (
    task.fromRoomName !== TREASURY_T1_SOURCE_ROOM ||
    task.toRoomName !== TREASURY_T1_TARGET_ROOM ||
    task.resource !== RESOURCE_HYDROGEN
  ) return false;
  const quota = readQuota();
  if (quota.status !== "valid" || quota.value.taskId !== taskId ||
      quota.value.workKey !== workKey || quota.value.attemptId !== attemptId ||
      quota.value.amount !== amount || quota.value.taskCreatedAt !== task.createdAt ||
      quota.value.taskAmount !== task.amount) return false;
  const previous = taskLease(task);
  if (!previous ||
    previous.schemaVersion !== 1 || previous.runId !== TREASURY_T1_RUN_ID ||
    previous.workKey !== workKey || previous.attemptId !== attemptId) return false;
  if (previous.phase === "closing") {
    return previous.amount === 0 && previous.outcome === outcome;
  }
  if (previous.amount !== amount || previous.phase !== "active") return false;
  if (outcome === "committed" && task.status !== "pending") return false;

  let remainingAmount = task.remainingAmount;
  let nextStatus = task.status;
  let updatedAt = task.updatedAt;
  let lastProgressAt = task.lastProgressAt;
  let blockedReason = task.blockedReason;
  let blockedSince = task.blockedSince;
  let lastError = task.lastError;
  if (outcome === "committed" && task.status === "pending") {
    if (!isInteger(remainingAmount) || remainingAmount < amount) return false;
    remainingAmount -= amount;
    updatedAt = Game.time;
    lastProgressAt = Game.time;
    blockedReason = undefined;
    blockedSince = undefined;
    lastError = undefined;
    if (remainingAmount === 0) nextStatus = "done";
  }
  const next: ResourceTransferTask = {
    ...task,
    remainingAmount,
    status: nextStatus,
    updatedAt,
    lastProgressAt,
    blockedReason,
    blockedSince,
    lastError,
    treasurySlice: {
      schemaVersion: 1,
      runId: TREASURY_T1_RUN_ID,
      workKey,
      attemptId,
      amount: 0,
      phase: "closing",
      outcome,
    },
  };
  store[taskId] = next;
  bumpTreasuryCommitmentRevision();
  return store[taskId] === next;
}

function readQuota(): QuotaRead {
  const runtime = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
  const raw = runtime?.[TREASURY_T1_QUOTA_KEY];
  if (raw === undefined) return { status: "absent" };
  if (
    !isPlainObject(raw) || raw.schemaVersion !== 2 || raw.runId !== TREASURY_T1_RUN_ID ||
    (raw.status !== "reserved" && raw.status !== "dispatching" && raw.status !== "drained") ||
    typeof raw.taskId !== "string" || typeof raw.workKey !== "string" ||
    typeof raw.attemptId !== "string" || !isPositiveInteger(raw.amount) ||
    !isInteger(raw.taskCreatedAt) || !isPositiveInteger(raw.taskAmount) ||
    !isInteger(raw.reservedAtTick)
  ) return { status: "invalid" };
  return { status: "valid", value: raw as unknown as T1Quota };
}

function writeQuota(value: T1Quota): boolean {
  const memory = Memory as unknown as { runtime?: Record<string, unknown> };
  if (!memory.runtime) memory.runtime = {};
  memory.runtime[TREASURY_T1_QUOTA_KEY] = value;
  const check = readQuota();
  return check.status === "valid" &&
    check.value.status === value.status &&
    check.value.runId === value.runId &&
    check.value.taskId === value.taskId &&
    check.value.taskCreatedAt === value.taskCreatedAt &&
    check.value.taskAmount === value.taskAmount &&
    check.value.workKey === value.workKey &&
    check.value.attemptId === value.attemptId &&
    check.value.amount === value.amount &&
    check.value.reservedAtTick === value.reservedAtTick;
}

function reserveQuota(args: TreasuryT1TransferArgs, attemptId: string): boolean {
  if (readQuota().status !== "absent") return false;
  return writeQuota({
    schemaVersion: 2,
    runId: TREASURY_T1_RUN_ID,
    status: "reserved",
    taskId: args.taskId,
    taskCreatedAt: args.taskCreatedAt,
    taskAmount: args.taskAmount,
    workKey: args.workKey,
    attemptId,
    amount: args.amount,
    reservedAtTick: Game.time,
  });
}

function beginNativeAttempt(args: TreasuryT1TransferArgs, attemptId: string): boolean {
  const quota = readQuota();
  if (
    quota.status !== "valid" || quota.value.status !== "reserved" ||
    quota.value.taskId !== args.taskId || quota.value.workKey !== args.workKey ||
    quota.value.attemptId !== attemptId || quota.value.amount !== args.amount
  ) return false;
  return writeQuota({ ...quota.value, status: "dispatching" });
}

function readTerminal(roomName: string, username?: string, expectedId?: string):
  | { readonly status: "ok"; readonly terminal: StructureTerminal; readonly snapshot: EndpointSnapshot }
  | { readonly status: "invalid" } {
  const room = Game.rooms[roomName];
  const terminal = room?.terminal;
  if (!room || !terminal || !room.controller || terminal.my !== true || terminal.isActive() !== true) {
    return { status: "invalid" };
  }
  const ownerName = terminal.owner?.username;
  if (
    !ownerName ||
    room.controller.my !== true || room.controller.owner?.username !== ownerName ||
    (username !== undefined && ownerName !== username) ||
    (expectedId !== undefined && terminal.id !== expectedId)
  ) return { status: "invalid" };
  const hydrogen = terminal.store.getUsedCapacity(RESOURCE_HYDROGEN);
  const energy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  const used = terminal.store.getUsedCapacity();
  const free = terminal.store.getFreeCapacity();
  const capacity = terminal.store.getCapacity();
  const cooldown = terminal.cooldown;
  if (![hydrogen, energy, used, free, capacity, cooldown].every(isInteger) || used + free !== capacity) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    terminal,
    snapshot: {
      id: terminal.id,
      hydrogen,
      energy,
      used,
      free,
      capacity,
      cooldown,
    },
  };
}

function taskMatchesArgs(task: ResourceTransferTask, args: TreasuryT1TransferArgs, requireLease: boolean): boolean {
  if (
    task.id !== args.taskId || task.status !== "pending" ||
    task.resource !== RESOURCE_HYDROGEN ||
    task.fromRoomName !== TREASURY_T1_SOURCE_ROOM ||
    task.toRoomName !== TREASURY_T1_TARGET_ROOM ||
    task.createdAt !== args.taskCreatedAt || task.amount !== args.taskAmount ||
    task.remainingAmount !== args.taskRemainingAmount || task.updatedAt !== args.taskUpdatedAt
  ) return false;
  const lease = taskLease(task);
  if (!requireLease && lease === undefined) return true;
  if (!lease || lease.schemaVersion !== 1 || lease.runId !== TREASURY_T1_RUN_ID ||
      lease.workKey !== args.workKey || lease.amount !== args.amount) return false;
  if (lease.phase === "preparing") return lease.attemptId === "";
  return lease.phase === "active" && dispatchContext !== null &&
    dispatchContext.attemptId === lease.attemptId && dispatchContext.attemptId !== "";
}

function liveQuote(amount: number): number | null {
  try {
    const quote = Game.market.calcTransactionCost(amount, TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM);
    return isInteger(quote) && quote <= TREASURY_T1_MAX_FEE_ENERGY ? quote : null;
  } catch {
    return null;
  }
}

function validateLiveArgs(value: unknown, requireLease: boolean): value is TreasuryT1TransferArgs {
  if (!isPlainObject(value)) return false;
  const args = value as unknown as TreasuryT1TransferArgs;
  if (
    args.schemaVersion !== 1 || args.runId !== TREASURY_T1_RUN_ID ||
    typeof args.taskId !== "string" || args.taskId.length < 1 || args.taskId.length > 80 ||
    !/^[A-Za-z0-9:_\.\->-]+$/.test(args.taskId) ||
    args.workKey !== treasuryT1WorkKey(args.taskId) ||
    typeof args.transactionId !== "string" || args.transactionId.length < 1 || args.transactionId.length > 128 ||
    args.tick !== Game.time || !isInteger(args.taskCreatedAt) || !isPositiveInteger(args.taskAmount) ||
    !isPositiveInteger(args.taskRemainingAmount) || args.taskRemainingAmount > args.taskAmount ||
    !isInteger(args.taskUpdatedAt) || !isPositiveInteger(args.amount) || args.amount > TREASURY_T1_MAX_HYDROGEN ||
    args.amount > args.taskRemainingAmount || !isInteger(args.quote) || args.quote > TREASURY_T1_MAX_FEE_ENERGY ||
    typeof args.username !== "string" || args.username.length < 1 || args.username.length > 32
  ) return false;
  for (const endpoint of [args.source, args.target]) {
    if (!isPlainObject(endpoint) || typeof endpoint.id !== "string" || endpoint.id.length < 1 || endpoint.id.length > 100 ||
        ![endpoint.hydrogen, endpoint.energy, endpoint.used, endpoint.free, endpoint.capacity, endpoint.cooldown].every(isInteger) ||
        endpoint.used + endpoint.free !== endpoint.capacity) return false;
  }
  const description = TREASURY_T1_DESCRIPTION_PREFIX + args.transactionId;
  if (description.length > 100 || args.source.id === args.target.id) return false;
  const store = taskStore();
  const task = store?.[args.taskId];
  if (!task || !taskMatchesArgs(task, args, requireLease)) return false;
  const source = readTerminal(TREASURY_T1_SOURCE_ROOM, args.username, args.source.id);
  const target = readTerminal(TREASURY_T1_TARGET_ROOM, args.username, args.target.id);
  if (source.status !== "ok" || target.status !== "ok") return false;
  if (
    source.snapshot.hydrogen !== args.source.hydrogen || source.snapshot.energy !== args.source.energy ||
    source.snapshot.used !== args.source.used || source.snapshot.free !== args.source.free ||
    source.snapshot.capacity !== args.source.capacity ||
    target.snapshot.hydrogen !== args.target.hydrogen || target.snapshot.used !== args.target.used ||
    target.snapshot.free !== args.target.free || target.snapshot.capacity !== args.target.capacity
  ) return false;
  if (requireLease && source.snapshot.cooldown !== 0) return false;
  const quote = liveQuote(args.amount);
  if (quote === null || quote !== args.quote || encodeDurableFacts(args) === null) return false;
  if (source.snapshot.cooldown !== args.source.cooldown) return false;
  return source.snapshot.hydrogen >= args.amount && source.snapshot.energy >= args.quote &&
    target.snapshot.free >= args.amount;
}

function buildTransferArgs(task: ResourceTransferTask, ledger: ReceiverCapacityLedger): TreasuryT1TransferArgs | null {
  if (
    task.status !== "pending" || !isPositiveInteger(task.remainingAmount) ||
    task.fromRoomName !== TREASURY_T1_SOURCE_ROOM || task.toRoomName !== TREASURY_T1_TARGET_ROOM ||
    task.resource !== RESOURCE_HYDROGEN || task.id.length > 80
  ) return null;
  const amount = Math.min(task.remainingAmount, TREASURY_T1_MAX_HYDROGEN);
  const source = readTerminal(TREASURY_T1_SOURCE_ROOM);
  const target = readTerminal(TREASURY_T1_TARGET_ROOM);
  if (source.status !== "ok" || target.status !== "ok" || source.snapshot.cooldown !== 0) return null;
  const quote = liveQuote(amount);
  if (
    quote === null || source.snapshot.hydrogen < amount || source.snapshot.energy < quote ||
    target.snapshot.free < amount || ledger.getAvailableAmount(TREASURY_T1_TARGET_ROOM, RESOURCE_HYDROGEN, task.id) < amount
  ) return null;
  const transactionId = formatTreasuryTransactionId(TREASURY_T1_ACTION_KIND, TREASURY_T1_RUN_ID, task.id);
  const args: TreasuryT1TransferArgs = {
    schemaVersion: 1,
    runId: TREASURY_T1_RUN_ID,
    taskId: task.id,
    workKey: treasuryT1WorkKey(task.id),
    transactionId,
    tick: Game.time,
    taskCreatedAt: task.createdAt,
    taskAmount: task.amount,
    taskRemainingAmount: task.remainingAmount,
    taskUpdatedAt: task.updatedAt,
    amount,
    quote,
    username: source.terminal.owner!.username,
    source: source.snapshot,
    target: target.snapshot,
  };
  return validateLiveArgs(args, false) ? args : null;
}

function encodeDurableFacts(args: TreasuryT1TransferArgs): string | null {
  const facts: DurableT1Facts = {
    schemaVersion: 1,
    runId: TREASURY_T1_RUN_ID,
    taskId: args.taskId,
    taskCreatedAt: args.taskCreatedAt,
    amount: args.amount,
    tick: args.tick,
    quote: args.quote,
    username: args.username,
    source: args.source,
    target: args.target,
  };
  return encodeTreasuryT1DurableFacts(facts);
}

function transactionMatches(value: unknown, facts: DurableT1Facts, transactionId: string): boolean {
  if (!isPlainObject(value)) return false;
  const description = TREASURY_T1_DESCRIPTION_PREFIX + transactionId;
  return value.time === facts.tick &&
    isPlainObject(value.sender) && value.sender.username === facts.username &&
    isPlainObject(value.recipient) && value.recipient.username === facts.username &&
    value.resourceType === RESOURCE_HYDROGEN && value.amount === facts.amount &&
    value.from === TREASURY_T1_SOURCE_ROOM && value.to === TREASURY_T1_TARGET_ROOM &&
    value.description === description && value.order === undefined;
}

function reconcileT1(factsValue: TreasuryActionReconcilerFacts, observationValue: unknown): "observed_committed" | "still_uncertain" {
  const facts = decodeDurableFacts(factsValue.durablePayload);
  if (
    factsValue.actionKind !== TREASURY_T1_ACTION_KIND || factsValue.adapterVersion !== 1 ||
    !facts || facts.taskId.length > 80 || facts.amount > TREASURY_T1_MAX_HYDROGEN ||
    Game.time <= facts.tick
  ) return "still_uncertain";
  const incoming = Game.market.incomingTransactions as unknown as readonly unknown[] | undefined;
  const outgoing = Game.market.outgoingTransactions as unknown as readonly unknown[] | undefined;
  if (!Array.isArray(incoming) || !Array.isArray(outgoing) || incoming.length > 256 || outgoing.length > 256) {
    return "still_uncertain";
  }
  // The kernel attempt ID is carried in our unique send description. Screeps
  // assigns its own transactionId to the resulting market record.
  const description = TREASURY_T1_DESCRIPTION_PREFIX + factsValue.transactionId;
  const inMatches = incoming.filter((row) => isPlainObject(row) && row.description === description);
  const outMatches = outgoing.filter((row) => isPlainObject(row) && row.description === description);
  const serverTransactionId = isPlainObject(inMatches[0]) ? inMatches[0].transactionId : undefined;
  const allCopies = [...incoming, ...outgoing].filter((row) =>
    isPlainObject(row) && row.transactionId === serverTransactionId);
  if (
    inMatches.length !== 1 || outMatches.length !== 1 ||
    typeof serverTransactionId !== "string" || serverTransactionId.length === 0 ||
    serverTransactionId.length > 100 ||
    !isPlainObject(outMatches[0]) || outMatches[0].transactionId !== serverTransactionId ||
    allCopies.length !== 2 ||
    !allCopies.every((row) => transactionMatches(row, facts, factsValue.transactionId))
  ) return "still_uncertain";

  const source = readTerminal(TREASURY_T1_SOURCE_ROOM, facts.username, facts.source.id);
  const target = readTerminal(TREASURY_T1_TARGET_ROOM, facts.username, facts.target.id);
  if (source.status !== "ok" || target.status !== "ok") return "still_uncertain";
  if (
    source.snapshot.hydrogen !== facts.source.hydrogen - facts.amount ||
    source.snapshot.energy !== facts.source.energy - facts.quote ||
    source.snapshot.used !== facts.source.used - facts.amount - facts.quote ||
    source.snapshot.free !== facts.source.free + facts.amount + facts.quote ||
    source.snapshot.capacity !== facts.source.capacity ||
    target.snapshot.hydrogen !== facts.target.hydrogen + facts.amount ||
    target.snapshot.used !== facts.target.used + facts.amount ||
    target.snapshot.free !== facts.target.free - facts.amount ||
    target.snapshot.capacity !== facts.target.capacity
  ) return "still_uncertain";

  if (!isPlainObject(observationValue)) return "still_uncertain";
  const observation = observationValue as unknown as TreasuryObservationView;
  if (observation.epoch.observedAtTick !== Game.time || observation.isStale()) return "still_uncertain";
  const sourceObserved = observation.location(TREASURY_T1_SOURCE_ROOM, "terminal");
  const targetObserved = observation.location(TREASURY_T1_TARGET_ROOM, "terminal");
  if (
    !sourceObserved.exists || !targetObserved.exists || sourceObserved.structureId !== facts.source.id ||
    targetObserved.structureId !== facts.target.id ||
    observation.amount(TREASURY_T1_SOURCE_ROOM, "terminal", RESOURCE_HYDROGEN) !== source.snapshot.hydrogen ||
    observation.amount(TREASURY_T1_SOURCE_ROOM, "terminal", RESOURCE_ENERGY) !== source.snapshot.energy ||
    observation.amount(TREASURY_T1_TARGET_ROOM, "terminal", RESOURCE_HYDROGEN) !== target.snapshot.hydrogen ||
    sourceObserved.usedCapacity !== source.snapshot.used || sourceObserved.freeCapacity !== source.snapshot.free ||
    targetObserved.usedCapacity !== target.snapshot.used || targetObserved.freeCapacity !== target.snapshot.free
  ) return "still_uncertain";
  return "observed_committed";
}

function executeT1(args: TreasuryT1TransferArgs): { ok: boolean; code: number } {
  const context = dispatchContext;
  if (
    !context || context.taskId !== args.taskId || context.workKey !== args.workKey ||
    context.attemptId.length === 0 || context.amount !== args.amount || context.nativeCalls !== 0 ||
    !validateLiveArgs(args, true) ||
    context.ledger.getAvailableAmount(TREASURY_T1_TARGET_ROOM, RESOURCE_HYDROGEN, args.taskId) < args.amount
  ) {
    return { ok: false, code: ERR_BUSY };
  }
  if (!beginNativeAttempt(args, context.attemptId)) return { ok: false, code: ERR_BUSY };
  context.nativeCalls += 1;
  const source = Game.rooms[TREASURY_T1_SOURCE_ROOM]?.terminal;
  if (!source) return { ok: false, code: ERR_INVALID_TARGET };
  const code = executeTerminalSend({
    terminal: source,
    resourceType: RESOURCE_HYDROGEN,
    amount: args.amount,
    transactionCost: args.quote,
    destinationRoomName: TREASURY_T1_TARGET_ROOM,
    actor: `treasury:${TREASURY_T1_RUN_ID}`,
    description: TREASURY_T1_DESCRIPTION_PREFIX + context.attemptId,
  });
  lastNativeAttempt = {
    taskId: args.taskId,
    attemptId: context.attemptId,
    amount: args.amount,
    fee: args.quote,
    code,
  };
  return { ok: code === OK, code };
}

const productionAdapter: TreasuryActionAdapter<TreasuryT1TransferArgs, { ok: boolean; code: number }> = {
  kind: TREASURY_T1_ACTION_KIND,
  version: 1,
  semanticIdentity: "production.terminal-transfer.slice0@E3N59-E4N58-H-v1",
  validate: (args) => validateLiveArgs(args, false) ? null : "T1 live facts/task validation failed",
  derivePostings: (args) => [
    { roomName: TREASURY_T1_SOURCE_ROOM, locationKind: "terminal", resource: RESOURCE_HYDROGEN, delta: -args.amount },
    { roomName: TREASURY_T1_SOURCE_ROOM, locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -args.quote },
    { roomName: TREASURY_T1_TARGET_ROOM, locationKind: "terminal", resource: RESOURCE_HYDROGEN, delta: args.amount },
  ],
  structureBindings: (args) => [
    { roomName: TREASURY_T1_SOURCE_ROOM, locationKind: "terminal", bindingKind: "game_object", role: "source", objectId: args.source.id, expectedType: "terminal", expectedRoom: TREASURY_T1_SOURCE_ROOM },
    { roomName: TREASURY_T1_TARGET_ROOM, locationKind: "terminal", bindingKind: "game_object", role: "target", objectId: args.target.id, expectedType: "terminal", expectedRoom: TREASURY_T1_TARGET_ROOM },
  ],
  durableFacts: (args) => {
    const payload = encodeDurableFacts(args);
    return payload === null ? null : { version: 1, payload };
  },
  execute: executeT1,
  reconcile: reconcileT1,
  settlesOnAccept: false,
  nonOkOutcome: "not_executed",
};

export function registerTreasuryProductionTerminalTransfer(): boolean {
  const adapter = registerTreasuryActionAdapter(productionAdapter);
  const policy = registerTreasuryPolicyResolver(productionPolicy);
  adapterRegistrationReady = adapter.status === "registered" && policy.status === "registered";
  return adapterRegistrationReady;
}

function readRawT1Active(): readonly Record<string, unknown>[] {
  const raw = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime?.treasuryCore;
  if (!isPlainObject(raw) || !isPlainObject(raw.active)) return [];
  return Object.values(raw.active).filter(isPlainObject);
}

function hasT1ActiveRecordForTask(taskId: string): boolean {
  const expected = treasuryT1WorkKey(taskId);
  return readRawT1Active().some((record) => record.workKey === expected && isPlainObject(record.identity) &&
    record.identity.actionKind === TREASURY_T1_ACTION_KIND);
}

function hasAnyT1ActiveRecord(): boolean {
  return readRawT1Active().some((record) => isPlainObject(record.identity) &&
    record.identity.actionKind === TREASURY_T1_ACTION_KIND &&
    typeof record.workKey === "string" && record.workKey.startsWith(TREASURY_T1_WORK_KEY_PREFIX));
}

function hasAnyT1TaskLease(): boolean {
  const tasks = taskStore();
  return !!tasks && Object.values(tasks).some((task) =>
    (task as ResourceTransferTask & { treasurySlice?: unknown }).treasurySlice !== undefined);
}

function readTaskIdFromWorkKey(workKey: unknown): string | null {
  if (typeof workKey !== "string" || !workKey.startsWith(TREASURY_T1_WORK_KEY_PREFIX)) return null;
  const suffix = workKey.slice(TREASURY_T1_WORK_KEY_PREFIX.length);
  const tasks = taskStore();
  if (!tasks) return null;
  for (const task of Object.values(tasks)) {
    if (treasuryT1WorkKey(task.id) === workKey) return task.id;
  }
  // Durable task IDs are not reconstructed from the hash; this is deliberately
  // fail closed when the authoritative task row has disappeared.
  void suffix;
  return null;
}

function recordFacts(record: TreasuryCoreWorkRecord): DurableT1Facts | null {
  if (record.identity.actionKind !== TREASURY_T1_ACTION_KIND) return null;
  return decodeDurableFacts(record.identity.durableFacts?.payload);
}

function ensureTaskLeaseFromRecord(record: TreasuryCoreWorkRecord): boolean {
  const facts = recordFacts(record);
  if (!facts || record.workKey !== treasuryT1WorkKey(facts.taskId)) return false;
  const store = taskStore();
  const task = store?.[facts.taskId];
  const quota = readQuota();
  if (!store || !task || task.id !== facts.taskId || task.createdAt !== facts.taskCreatedAt ||
      task.resource !== RESOURCE_HYDROGEN || task.fromRoomName !== TREASURY_T1_SOURCE_ROOM ||
      task.toRoomName !== TREASURY_T1_TARGET_ROOM || quota.status !== "valid" ||
      quota.value.taskId !== task.id || quota.value.taskCreatedAt !== task.createdAt ||
      quota.value.taskAmount !== task.amount || quota.value.workKey !== record.workKey ||
      quota.value.attemptId !== record.attemptId || quota.value.amount !== facts.amount) return false;
  const lease = taskLease(task);
  if (lease) return lease.schemaVersion === 1 && lease.runId === TREASURY_T1_RUN_ID &&
    lease.workKey === record.workKey && lease.attemptId === record.attemptId &&
    (lease.amount === facts.amount || (lease.phase === "closing" && lease.amount === 0));
  return updateTaskLease(task, {
    schemaVersion: 1,
    runId: TREASURY_T1_RUN_ID,
    workKey: record.workKey,
    attemptId: record.attemptId,
    amount: facts.amount,
    phase: "active",
  });
}

function applyFinalRecordOutcome(record: TreasuryCoreWorkRecord): boolean {
  if (record.outcome !== "committed" && record.outcome !== "not_executed") return false;
  const facts = recordFacts(record);
  if (!facts || record.workKey !== treasuryT1WorkKey(facts.taskId)) return false;
  ensureTaskLeaseFromRecord(record);
  return writeTaskProgress(
    facts.taskId,
    record.workKey,
    record.attemptId,
    facts.amount,
    record.outcome,
  );
}

function applyRingOutcome(attemptId: string, workKey: string, terminalPhase: string): boolean {
  if (terminalPhase !== "committed" && terminalPhase !== "not_executed") return false;
  const taskId = readTaskIdFromWorkKey(workKey);
  const task = taskId ? taskStore()?.[taskId] : undefined;
  const lease = task ? taskLease(task) : undefined;
  const quota = readQuota();
  if (!taskId || !task || !lease || lease.attemptId !== attemptId || lease.workKey !== workKey ||
      lease.runId !== TREASURY_T1_RUN_ID || quota.status !== "valid" ||
      quota.value.taskId !== taskId || quota.value.taskCreatedAt !== task.createdAt ||
      quota.value.taskAmount !== task.amount || quota.value.workKey !== workKey ||
      quota.value.attemptId !== attemptId) return false;
  return writeTaskProgress(taskId, workKey, attemptId, quota.value.amount, terminalPhase);
}

function readServiceActive(service: TreasuryService): readonly TreasuryCoreWorkRecord[] {
  const journal = service.kernelJournal();
  return journal.health.status === "healthy" ? journal.active : [];
}

function reconcilerFacts(record: TreasuryCoreWorkRecord): TreasuryActionReconcilerFacts | null {
  if (record.worstCase.some((leg) => leg.locationKind !== "terminal")) return null;
  return {
    actionKind: record.identity.actionKind,
    transactionId: record.attemptId,
    adapterVersion: record.identity.adapterVersion,
    durablePayload: record.identity.durableFacts?.payload,
    durablePayloadVersion: record.identity.durableFacts?.version,
    postings: record.worstCase.map((leg) => ({
      roomName: leg.roomName,
      locationKind: "terminal",
      resource: leg.resource,
      delta: leg.delta,
    })),
  };
}

function recoverT1Work(service: TreasuryService): void {
  let journal = service.kernelJournal();
  if (journal.health.status !== "healthy") {
    return;
  }
  for (const record of journal.active) {
    if (record.identity.actionKind === TREASURY_T1_ACTION_KIND && record.phase === "outcome_unknown") {
      const facts = reconcilerFacts(record);
      if (!facts) continue;
      const candidate = reconcileT1(facts, service.observation());
      if (candidate === "observed_committed") {
        const boundary = record.invocationBoundary?.worldSequence;
        if (!isInteger(boundary)) continue;
        if (readTreasuryWorldSequence() <= boundary) bumpTreasuryWorldSequence();
        if (service.beginFreshObservation() !== null) {
          service.settleUnknownOutcome({ attemptId: record.attemptId });
        }
      } else {
        service.settleUnknownOutcome({ attemptId: record.attemptId });
      }
    }
  }
  journal = service.kernelJournal();
  if (journal.health.status !== "healthy") return;
  for (const record of journal.active) {
    if (record.identity.actionKind === TREASURY_T1_ACTION_KIND) applyFinalRecordOutcome(record);
  }
  for (const entry of journal.ring) {
    if (entry.workKey.startsWith(TREASURY_T1_WORK_KEY_PREFIX)) {
      applyRingOutcome(entry.attemptId, entry.workKey, entry.terminalPhase);
    }
  }

  const quota = readQuota();
  const tasks = taskStore();
  if (tasks) {
    for (const task of Object.values(tasks)) {
      const lease = taskLease(task);
      if (!lease || lease.runId !== TREASURY_T1_RUN_ID) continue;
      const active = journal.active.some((record) => record.workKey === lease.workKey && record.attemptId === lease.attemptId);
      const terminal = journal.ring.find((entry) => entry.workKey === lease.workKey && entry.attemptId === lease.attemptId);
      if (active) continue;
      if (terminal) {
        const applied = applyRingOutcome(terminal.attemptId, terminal.workKey, terminal.terminalPhase);
        if (!applied && quota.status === "valid" && quota.value.status === "reserved" &&
            quota.value.attemptId === terminal.attemptId && quota.value.taskId === task.id) {
          writeTaskProgress(task.id, lease.workKey, lease.attemptId, lease.amount, "not_executed");
        }
        continue;
      }
      const latestLease = taskLease(task);
      if (!latestLease) continue;
      if (latestLease.phase === "preparing" && quota.status === "absent") {
        updateTaskLease(task, null);
      } else if (quota.status === "valid" && quota.value.status === "reserved" &&
          quota.value.taskId === task.id && quota.value.workKey === latestLease.workKey &&
          (latestLease.attemptId === "" || quota.value.attemptId === latestLease.attemptId)) {
        updateTaskLease(task, {
          ...latestLease,
          attemptId: quota.value.attemptId,
          phase: "active",
        });
        writeTaskProgress(task.id, latestLease.workKey, quota.value.attemptId, latestLease.amount, "not_executed");
      } else if (latestLease.phase === "active" && quota.status === "absent") {
        writeTaskProgress(task.id, latestLease.workKey, latestLease.attemptId, latestLease.amount, "not_executed");
      }
    }
  }

  if (quota.status === "valid" && quota.value.status === "dispatching") {
    const task = taskStore()?.[quota.value.taskId];
    if (task && taskLease(task) === undefined &&
        !journal.active.some((record) => record.attemptId === quota.value.attemptId) &&
        !journal.ring.some((entry) => entry.attemptId === quota.value.attemptId)) {
      updateTaskLease(task, {
        schemaVersion: 1,
        runId: TREASURY_T1_RUN_ID,
        workKey: quota.value.workKey,
        attemptId: quota.value.attemptId,
        amount: quota.value.amount,
        phase: "active",
      });
    }
  }
}

export function beginTreasuryProductionTick(): boolean {
  activeTreasuryService = null;
  activeLifecycleTick = -1;
  lifecycleBlockReason = null;
  const mode = readMode();
  const quota = readQuota();
  const hasRecoveryWork = hasAnyT1ActiveRecord() || hasAnyT1TaskLease() ||
    (quota.status === "valid" && quota.value.status !== "drained");
  if (!hasRecoveryWork && mode !== "canary" && mode !== "drain") return false;

  const gate = ensureReservationSchemaActivated();
  if (gate.status === "rejected") {
    lifecycleBlockReason = `reservation_schema_${gate.reason}`;
    return false;
  }
  try {
    const service = getTreasuryService();
    service.beginTick();
    activeTreasuryService = service;
    activeLifecycleTick = Game.time;
    recoverT1Work(service);
    // Completed tasks are no longer visited by resourceControl's pending-only
    // dispatcher. Close their exact lease from the per-tick lifecycle instead.
    if (mode === "off") {
      const tasks = taskStore();
      if (tasks) {
        for (const task of Object.values(tasks)) {
          if (taskLease(task)?.phase === "closing") {
            clearFinishedLeaseWhenOff(task, service);
          }
        }
      }
    }
    return true;
  } catch (error) {
    lifecycleBlockReason = String(error instanceof Error ? error.message : error).slice(0, 120);
    activeTreasuryService = null;
    activeLifecycleTick = -1;
    return false;
  }
}

export function endTreasuryProductionTick(): void {
  const service = activeTreasuryService;
  if (!service || activeLifecycleTick !== Game.time) return;
  try {
    service.endTick();
  } finally {
    activeTreasuryService = null;
    activeLifecycleTick = -1;
  }
}

function serviceForCurrentTick(): TreasuryService | null {
  return activeLifecycleTick === Game.time ? activeTreasuryService : null;
}

function readModeAndTaskMatch(task: ResourceTransferTask): { mode: TreasuryProductionMode; matches: boolean } {
  const matches = task.fromRoomName === TREASURY_T1_SOURCE_ROOM &&
    task.toRoomName === TREASURY_T1_TARGET_ROOM && task.resource === RESOURCE_HYDROGEN;
  return { mode: readMode(), matches };
}

function clearFinishedLeaseWhenOff(task: ResourceTransferTask, service: TreasuryService | null): boolean {
  const lease = taskLease(task);
  if (!lease) return true;
  if (lease.runId !== TREASURY_T1_RUN_ID || lease.phase !== "closing" || lease.amount !== 0 ||
      (lease.outcome !== "committed" && lease.outcome !== "not_executed")) return false;
  if (!service) return false;
  const journal = service.kernelJournal();
  if (journal.health.status !== "healthy") return false;
  const terminal = journal.ring.find((entry) =>
    entry.workKey === lease.workKey && entry.attemptId === lease.attemptId);
  if (!terminal || terminal.terminalPhase !== lease.outcome) return false;
  const active = journal.active;
  if (active.some((record) => record.workKey === lease.workKey && record.attemptId === lease.attemptId)) return false;
  const rawActive = hasT1ActiveRecordForTask(task.id);
  if (rawActive) return false;
  const quota = readQuota();
  if (quota.status !== "valid" || quota.value.taskId !== task.id ||
      quota.value.taskCreatedAt !== task.createdAt || quota.value.taskAmount !== task.amount ||
      quota.value.amount < 1 || quota.value.workKey !== lease.workKey ||
      quota.value.attemptId !== lease.attemptId) return false;
  if (quota.value.status !== "drained" && !writeQuota({ ...quota.value, status: "drained" })) return false;
  return updateTaskLease(task, null);
}

function taskHasActiveT1Work(task: ResourceTransferTask, service: TreasuryService | null): boolean {
  if (hasT1ActiveRecordForTask(task.id)) return true;
  if (!service) return false;
  const workKey = treasuryT1WorkKey(task.id);
  return readServiceActive(service).some((record) => record.workKey === workKey &&
    record.identity.actionKind === TREASURY_T1_ACTION_KIND);
}

function reserveTaskLease(task: ResourceTransferTask, args: TreasuryT1TransferArgs): boolean {
  return updateTaskLease(task, {
    schemaVersion: 1,
    runId: TREASURY_T1_RUN_ID,
    workKey: args.workKey,
    attemptId: "",
    amount: args.amount,
    phase: "preparing",
  });
}

function attachAdmittedAttempt(task: ResourceTransferTask, args: TreasuryT1TransferArgs, attemptId: string): boolean {
  return updateTaskLease(task, {
    schemaVersion: 1,
    runId: TREASURY_T1_RUN_ID,
    workKey: args.workKey,
    attemptId,
    amount: args.amount,
    phase: "active",
  });
}

function logDecision(taskId: string, status: string, reason?: string): void {
  const line = JSON.stringify({
    kind: "treasury-production-T1",
    tick: Game.time,
    taskId,
    status,
    ...(reason ? { reason: reason.slice(0, 120) } : {}),
  });
  console.log(line.slice(0, 512));
}

export function runTreasuryTerminalTransferTask(
  task: ResourceTransferTask,
  capacityLedger: ReceiverCapacityLedger,
  nativeBudgetAvailable: boolean,
  onScheduled: (amount: number, fee: number) => void,
): { readonly handled: boolean; readonly status?: string } {
  const { mode, matches } = readModeAndTaskMatch(task);
  const rawLease = (task as ResourceTransferTask & { treasurySlice?: unknown }).treasurySlice;
  if (!matches && rawLease === undefined && !hasT1ActiveRecordForTask(task.id)) return { handled: false };
  if (!matches) return { handled: true, status: "task_identity_changed" };

  const service = serviceForCurrentTick();
  const lease = taskLease(task);
  const activeForTask = taskHasActiveT1Work(task, service);
  if (activeForTask) return { handled: true, status: "active_work_held" };

  if (lease) {
    if (lease.schemaVersion !== 1 || lease.runId !== TREASURY_T1_RUN_ID || lease.workKey !== treasuryT1WorkKey(task.id)) {
      return { handled: true, status: "unknown_task_lease" };
    }
    if (lease.phase === "preparing") {
      const quota = readQuota();
      if (quota.status === "absent" && mode === "off") {
        updateTaskLease(task, null);
        return { handled: false };
      }
      return { handled: true, status: "preparing_held" };
    }
    if (lease.phase === "active") {
      const quota = readQuota();
      if (quota.status === "valid" && quota.value.status === "reserved" && quota.value.attemptId === lease.attemptId) {
        writeTaskProgress(task.id, lease.workKey, lease.attemptId, lease.amount, "not_executed");
      }
      return { handled: true, status: "active_held" };
    }
    if (mode === "off" && clearFinishedLeaseWhenOff(task, service)) return { handled: false };
    return { handled: true, status: "drained_held" };
  }

  if (mode === "off" || mode === "shadow") {
    const quota = readQuota();
    if (quota.status === "invalid") return { handled: true, status: "quota_invalid" };
    if (quota.status === "valid" && quota.value.taskId === task.id && quota.value.status !== "drained") {
      return { handled: true, status: "quota_unclosed" };
    }
    return { handled: false };
  }
  if (mode !== "canary") return { handled: true, status: mode === "drain" ? "draining" : "invalid_mode" };
  if (!service) return { handled: true, status: "lifecycle_unavailable" };
  if (!adapterRegistrationReady) return { handled: true, status: "adapter_registration_unavailable" };
  const journal = service.kernelJournal();
  // A first canary has no kernel record yet. The facade initializes it during
  // admission; an absent, legacy-free journal is the expected pristine state.
  if ((journal.health.status !== "healthy" && journal.health.status !== "absent") ||
      journal.legacyStores.length > 0) {
    return { handled: true, status: "kernel_unhealthy" };
  }
  if (journal.active.length > 0) return { handled: true, status: "another_work_active" };
  if (lifecycleBlockReason) return { handled: true, status: lifecycleBlockReason };
  const quota = readQuota();
  if (quota.status !== "absent") return { handled: true, status: quota.status === "invalid" ? "quota_invalid" : "quota_consumed" };
  if (!nativeBudgetAvailable) return { handled: true, status: "native_budget_or_terminal_busy" };

  const args = buildTransferArgs(task, capacityLedger);
  if (!args) {
    logDecision(task.id, "candidate_rejected", "live facts, fee, or shared receiver capacity outside policy");
    return { handled: true, status: "candidate_rejected" };
  }
  if (!reserveTaskLease(task, args)) return { handled: true, status: "task_lease_write_failed" };

  const built = buildTreasuryActionContract(service, {
    actionKind: TREASURY_T1_ACTION_KIND,
    transactionId: args.transactionId,
    args,
    source: TREASURY_T1_RUN_ID,
  });
  if (built.status !== "built") {
    updateTaskLease(task, null);
    logDecision(task.id, "contract_rejected", built.status === "rejected" ? built.detail : "contract not built");
    return { handled: true, status: "contract_rejected" };
  }
  const admission = withTreasuryTaskSliceExcluded(task.id, args.amount, () =>
    service.authorizeTreasuryActionContract(built.contract, { workKey: args.workKey }),
  );
  if (admission.status !== "admitted") {
    updateTaskLease(task, null);
    logDecision(task.id, "admission_rejected", admission.reason);
    return { handled: true, status: "admission_rejected" };
  }

  if (!attachAdmittedAttempt(task, args, admission.attemptId)) {
    service.cancelPendingWork({ attemptId: admission.attemptId });
    logDecision(task.id, "lease_attach_failed", "admitted pending work retained fail closed");
    return { handled: true, status: "lease_attach_failed" };
  }
  if (!reserveQuota(args, admission.attemptId)) {
    service.cancelPendingWork({ attemptId: admission.attemptId });
    logDecision(task.id, "quota_reservation_failed", "dispatch was not entered");
    return { handled: true, status: "quota_reservation_failed" };
  }

  dispatchContext = {
    taskId: task.id,
    workKey: args.workKey,
    attemptId: admission.attemptId,
    amount: args.amount,
    ledger: capacityLedger,
    nativeCalls: 0,
  };
  lastNativeAttempt = null;
  let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
  try {
    outcome = service.executeAuthorizedDispatch(admission.dispatch);
  } finally {
    dispatchContext = null;
  }

  const nativeAttempt = lastNativeAttempt;
  if (nativeAttempt && nativeAttempt.attemptId === admission.attemptId && nativeAttempt.code === OK) {
    try {
      onScheduled(nativeAttempt.amount, nativeAttempt.fee);
    } catch (error) {
      logDecision(task.id, "local_capacity_projection_failed", String(error));
    }
  }
  if (outcome.status === "not_executed") {
    const current = service.kernelJournal().active.find((record) => record.attemptId === admission.attemptId);
    if (current) applyFinalRecordOutcome(current);
  }
  logDecision(task.id, `dispatch_${outcome.status}`,
    "reason" in outcome ? outcome.reason : undefined);
  return { handled: true, status: `dispatch_${outcome.status}` };
}

export function runTreasuryT1ShadowObservation(): void {
  if (readMode() !== "shadow") return;
  const shard = Game.shard?.name;
  if (typeof shard !== "string" || shard.length === 0) return;
  if (!shadowObserver || shadowObserverShard !== shard) {
    const config: TreasuryReadOnlyConfig = {
      enabled: true,
      shardName: shard,
      rooms: [TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM],
      resources: [RESOURCE_HYDROGEN, RESOURCE_ENERGY],
      intervalTicks: 100,
      maxSampleCpu: 1,
      reserveCpu: 5,
      minBucket: 2_000,
      maxLogBytes: 8_192,
    };
    shadowObserver = createTreasuryReadOnlyObserver(config, {
      getTick: () => Game.time,
      getShard: () => Game.shard.name,
      cpu: () => ({ used: Game.cpu.getUsed(), tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }),
      getRoom: (name) => Game.rooms[name],
      getResourceCatalog: () => RESOURCES_ALL,
      getMemory: () => Memory,
      getService: getTreasuryService,
      emit: (line) => console.log(line),
    });
    shadowObserverShard = shard;
  }
  shadowObserver.run();
}

export function readTreasuryT1MigrationBlockReason(): string | null {
  return lifecycleBlockReason;
}
