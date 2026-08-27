import {
  cloneCarrierDispatchRef,
  createCarrierDispatchRef,
  isCarrierDispatchRef,
  isValidDispatchRoomName,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import {
  claimCarrierAmountSlice,
  clearCarrierAmountSlices,
  releaseUncommittedCarrierAmountSlices,
} from "@/runtime/dispatchOwnership/carrierAmountSlice";

export type CarrierTaskType = "lab_supply" | "lab_cleanup" | "lab_product_unload" | "mineral_haul" | "terminal_feed" | "terminal_offload" | "factory_supply" | "factory_unload" | "power_spawn_supply" | "nuker_supply";
export type CarrierTaskDispatchClass = "capacity_relief";

export type CarrierStructureKind = "lab" | "terminal" | "storage" | "container" | "factory" | "power_spawn" | "nuker";

export interface CarrierTaskStep {
  readonly id: string;
  readonly resource: ResourceConstant;
  readonly fromKind: CarrierStructureKind;
  readonly toKind: CarrierStructureKind;
  readonly fromId: string;
  readonly toId: string;
  readonly amount: number;
}

/**
 * Production readers receive this deep-readonly live view. The board remains
 * the only owner allowed to replace task identity, metadata, or nested steps.
 */
export interface CarrierTask {
  readonly id: string;
  readonly producer: string;
  readonly roomName: string;
  readonly type: CarrierTaskType;
  readonly priority: number;
  readonly dispatchClass?: CarrierTaskDispatchClass;
  readonly steps: readonly CarrierTaskStep[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CarrierTaskDraft {
  readonly id: string;
  readonly type: CarrierTaskType;
  readonly priority: number;
  readonly dispatchClass?: CarrierTaskDispatchClass;
  readonly steps: readonly CarrierTaskStep[];
}

export interface CarrierTaskStepAmountClaim {
  readonly amount: number;
  commit(): void;
  release(): void;
}

export type MutableCarrierTaskStepForTest = {
  -readonly [Field in keyof CarrierTaskStep]: CarrierTaskStep[Field];
};

/** Test-only escape hatch for constructing malformed private heap fixtures. */
export type MutableCarrierTaskForTest = Omit<{
  -readonly [Field in keyof CarrierTask]: CarrierTask[Field];
}, "steps"> & {
  steps: MutableCarrierTaskStepForTest[];
};

interface CarrierTaskRecord {
  task: MutableCarrierTaskForTest;
  publishOrder: number;
}

interface CarrierTaskRoomStore {
  byOwner: Map<string, Map<string, CarrierTaskRecord>>;
  nextPublishOrder: number;
  /**
   * 结构 revision：所有经公共写 API 的变更（replace/remove/cleanup）都会
   * 递增。测试直接向 raw Map 注入 fixture 时不保证递增，因此读取侧的
   * 排序快照缓存还叠加生产者数/记录数指纹作为兜底校验。
   */
  revision: number;
}

type CarrierTaskBoardStore = Map<string, CarrierTaskRoomStore>;

/**
 * 每房间排序快照缓存：同一 room + revision + 结构指纹下，dispatch 序
 * （priority/createdAt/publishOrder）与 publish 序只排序一次，后续读取
 * 复用只读索引。索引持有 live record 引用，task 内容、优先级等字段始终
 * 从 record 现场读取，不会被缓存固化。缓存为模块级（global reset 与
 * __carrierTaskBoard 一同失效），容量以房间名为界自然有界。
 */
interface RoomOrderCacheEntry {
  revision: number;
  producerCount: number;
  recordCount: number;
  dispatchOrder: IndexedCarrierTaskRecord[];
  publishOrder: IndexedCarrierTaskRecord[];
}

const roomOrderCache = new Map<string, RoomOrderCacheEntry>();
// 全局单调 revision 源：空 store 被删除后重建时 revision 重新从 0 计数会与
// 陈旧缓存条目碰撞，因此递增必须跨 store 生命周期单调。
let carrierTaskBoardRevisionCounter = 0;
// 仅供测试观测排序重建次数，生产路径不读取。
let carrierTaskOrderRebuildCount = 0;

export function getCarrierTaskOrderRebuildCountForTest(): number {
  return carrierTaskOrderRebuildCount;
}

function bumpRoomRevision(roomStore: CarrierTaskRoomStore): void {
  carrierTaskBoardRevisionCounter += 1;
  roomStore.revision = carrierTaskBoardRevisionCounter;
}

function readRoomStructureFingerprint(
  roomStore: CarrierTaskRoomStore,
): { producerCount: number; recordCount: number } {
  const byOwner = readCarrierOwnerIndex(roomStore);
  if (!byOwner) return { producerCount: 0, recordCount: 0 };
  let producerCount = 0;
  let recordCount = 0;
  for (const ownerTasks of nativeMapValues(byOwner)) {
    if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) continue;
    producerCount += 1;
    recordCount += nativeMapSize(ownerTasks);
  }
  return { producerCount, recordCount };
}

function isRoomOrderCacheEntryUsable(
  cached: RoomOrderCacheEntry | undefined,
  roomStore: CarrierTaskRoomStore,
): boolean {
  if (!cached) return false;
  if (cached.revision !== ownDataProperty(roomStore, "revision")) return false;
  const fingerprint = readRoomStructureFingerprint(roomStore);
  return cached.producerCount === fingerprint.producerCount
    && cached.recordCount === fingerprint.recordCount;
}

function getRoomDispatchOrder(
  roomName: string,
  roomStore: CarrierTaskRoomStore,
): IndexedCarrierTaskRecord[] {
  const cached = roomOrderCache.get(roomName);
  if (isRoomOrderCacheEntryUsable(cached, roomStore)) {
    return cached.dispatchOrder;
  }
  const dispatchOrder = listIndexedRecordsInRoom(roomName, roomStore).sort(compareCarrierTaskRecords);
  const publishOrder = [...dispatchOrder].sort(compareCarrierPublishOrder);
  carrierTaskOrderRebuildCount += 1;
  roomOrderCache.set(roomName, {
    revision: ownDataProperty(roomStore, "revision") as number,
    ...readRoomStructureFingerprint(roomStore),
    dispatchOrder,
    publishOrder,
  });
  return dispatchOrder;
}

function getRoomPublishOrder(
  roomName: string,
  roomStore: CarrierTaskRoomStore,
): IndexedCarrierTaskRecord[] {
  const cached = roomOrderCache.get(roomName);
  if (isRoomOrderCacheEntryUsable(cached, roomStore)) {
    return cached.publishOrder;
  }
  const dispatchOrder = listIndexedRecordsInRoom(roomName, roomStore).sort(compareCarrierTaskRecords);
  const publishOrder = [...dispatchOrder].sort(compareCarrierPublishOrder);
  carrierTaskOrderRebuildCount += 1;
  roomOrderCache.set(roomName, {
    revision: ownDataProperty(roomStore, "revision") as number,
    ...readRoomStructureFingerprint(roomStore),
    dispatchOrder,
    publishOrder,
  });
  return publishOrder;
}

export type CarrierTaskSnapshot = Readonly<Omit<CarrierTask, "steps">> & {
  readonly steps: readonly Readonly<CarrierTaskStep>[];
};

export interface CarrierDispatchEntry {
  readonly ref: CarrierDispatchRef;
  readonly task: CarrierTask;
}

export interface CarrierTaskReadSnapshotEntry {
  readonly ref: CarrierDispatchRef;
  readonly task: CarrierTaskSnapshot;
}

export type CarrierTaskRoomSnapshot = readonly CarrierTaskReadSnapshotEntry[];

/**
 * Owner-aware detached DTO. Private Maps and publish metadata never escape.
 * Rooms are data properties whose values contain full refs, so equal local ids
 * from different producers remain distinct.
 */
export type CarrierTaskBoardSnapshot = Readonly<
  Record<string, CarrierTaskRoomSnapshot>
>;

type RuntimeGlobalWithCarrierTasks = typeof global & {
  __carrierTaskBoard?: CarrierTaskBoardStore;
};

const runtimeGlobal: RuntimeGlobalWithCarrierTasks = global;
const nativeMapSizeGetter = Object.getOwnPropertyDescriptor(
  Map.prototype,
  "size",
)?.get;
const nativeMapProbeKey = Object.freeze({ carrierTaskBoardMapProbe: true });

function isNativeMap<Key, Value>(
  value: unknown,
): value is Map<Key, Value> {
  if (value === null || typeof value !== "object") return false;
  try {
    Map.prototype.has.call(value, nativeMapProbeKey);
    return true;
  } catch {
    return false;
  }
}

function nativeMapGet<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
): Value | undefined {
  return Map.prototype.get.call(map, key) as Value | undefined;
}

function nativeMapSet<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
): void {
  Map.prototype.set.call(map, key, value);
}

function nativeMapDelete<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
): boolean {
  return Map.prototype.delete.call(map, key) as boolean;
}

function nativeMapSize<Key, Value>(map: Map<Key, Value>): number {
  if (!nativeMapSizeGetter) return 0;
  return nativeMapSizeGetter.call(map) as number;
}

function nativeMapEntries<Key, Value>(
  map: Map<Key, Value>,
): IterableIterator<[Key, Value]> {
  return Map.prototype.entries.call(map) as IterableIterator<[Key, Value]>;
}

function nativeMapKeys<Key, Value>(
  map: Map<Key, Value>,
): IterableIterator<Key> {
  return Map.prototype.keys.call(map) as IterableIterator<Key>;
}

function nativeMapValues<Key, Value>(
  map: Map<Key, Value>,
): IterableIterator<Value> {
  return Map.prototype.values.call(map) as IterableIterator<Value>;
}

function defineCarrierSnapshotProperty(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneCarrierSnapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) {
    return existing;
  }

  let snapshot: object;
  if (Array.isArray(value)) {
    snapshot = new Array(value.length);
  } else if (typeof value === "function") {
    snapshot = function carrierSnapshotFunction(): undefined {
      return undefined;
    };
  } else {
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(source);
    } catch {
      prototype = Object.freeze({});
    }
    if (prototype === null) {
      snapshot = Object.create(null) as object;
    } else if (prototype === Object.prototype) {
      snapshot = {};
    } else {
      snapshot = Object.create(Object.freeze({})) as object;
    }
  }
  seen.set(source, snapshot);

  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    return snapshot;
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      defineCarrierSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    if (!descriptor || !("value" in descriptor)) {
      defineCarrierSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    let clonedValue: unknown;
    try {
      clonedValue = cloneCarrierSnapshotValue(descriptor.value, seen);
    } catch {
      clonedValue = undefined;
    }
    defineCarrierSnapshotProperty(snapshot, key, clonedValue);
  }
  return snapshot;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isCarrierTaskBoardStore(value: unknown): value is CarrierTaskBoardStore {
  return isNativeMap<string, CarrierTaskRoomStore>(value);
}

function isCarrierTaskRoomStore(value: unknown): value is CarrierTaskRoomStore {
  return isNativeMap<string, Map<string, CarrierTaskRecord>>(
    ownDataProperty(value, "byOwner"),
  )
    && typeof ownDataProperty(value, "nextPublishOrder") === "number";
}

function readCarrierOwnerIndex(
  roomStore: unknown,
): Map<string, Map<string, CarrierTaskRecord>> | undefined {
  const byOwner = ownDataProperty(roomStore, "byOwner");
  return isNativeMap<string, Map<string, CarrierTaskRecord>>(byOwner)
    ? byOwner
    : undefined;
}

function readCarrierTaskRecordTask(record: unknown): unknown {
  return ownDataProperty(record, "task");
}

function readCarrierTaskRecordOrder(record: unknown): number | undefined {
  const order = ownDataProperty(record, "publishOrder");
  return Number.isSafeInteger(order) && (order as number) >= 0
    ? order as number
    : undefined;
}

interface IndexedCarrierTaskRecord {
  readonly ref: CarrierDispatchRef;
  readonly task: unknown;
  readonly publishOrder: number;
}

function listIndexedRecordsInRoom(
  roomName: string,
  roomStore: CarrierTaskRoomStore,
): IndexedCarrierTaskRecord[] {
  const indexed: IndexedCarrierTaskRecord[] = [];
  const byOwner = readCarrierOwnerIndex(roomStore);
  if (!byOwner) return indexed;
  for (const [producer, ownerTasks] of nativeMapEntries(byOwner)) {
    if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) continue;
    for (const [localId, record] of nativeMapEntries(ownerTasks)) {
      const ref = createCarrierDispatchRef(producer, roomName, localId);
      const publishOrder = readCarrierTaskRecordOrder(record);
      if (!ref || publishOrder === undefined) continue;
      indexed.push({
        ref,
        task: readCarrierTaskRecordTask(record),
        publishOrder,
      });
    }
  }
  return indexed;
}

function compareCarrierTaskRecords(
  left: IndexedCarrierTaskRecord,
  right: IndexedCarrierTaskRecord,
): number {
  const leftPriority = ownDataProperty(left.task, "priority");
  const rightPriority = ownDataProperty(right.task, "priority");
  if (
    typeof leftPriority === "number"
    && typeof rightPriority === "number"
    && leftPriority !== rightPriority
  ) {
    return rightPriority - leftPriority;
  }
  const leftCreatedAt = ownDataProperty(left.task, "createdAt");
  const rightCreatedAt = ownDataProperty(right.task, "createdAt");
  if (
    typeof leftCreatedAt === "number"
    && typeof rightCreatedAt === "number"
    && leftCreatedAt !== rightCreatedAt
  ) {
    return leftCreatedAt - rightCreatedAt;
  }
  return left.publishOrder - right.publishOrder;
}

function compareCarrierPublishOrder(
  left: IndexedCarrierTaskRecord,
  right: IndexedCarrierTaskRecord,
): number {
  return left.publishOrder - right.publishOrder;
}

/**
 * Returns an isolated, owner-aware read snapshot without creating the board.
 * Invalid outer room keys and malformed private siblings fail closed. Task
 * values are descriptor-cloned so debug accessors are never executed.
 */
export function peekCarrierTaskBoard(): CarrierTaskBoardSnapshot {
  const board = runtimeGlobal.__carrierTaskBoard;
  if (!isCarrierTaskBoardStore(board)) {
    return {};
  }

  const snapshot: Record<string, CarrierTaskRoomSnapshot> = {};
  for (const [roomName, rawRoomStore] of nativeMapEntries(board)) {
    if (
      !isValidDispatchRoomName(roomName)
      || !isCarrierTaskRoomStore(rawRoomStore)
    ) {
      continue;
    }
    const roomEntries = getRoomPublishOrder(roomName, rawRoomStore)
      .map(({ ref, task }): CarrierTaskReadSnapshotEntry => ({
        ref: cloneCarrierDispatchRef(ref) as CarrierDispatchRef,
        task: cloneCarrierSnapshotValue(
          task,
        ) as CarrierTaskSnapshot,
      }));
    defineCarrierSnapshotProperty(snapshot, roomName, roomEntries);
  }
  return snapshot;
}

/** Returns one room's detached owner-aware DTO without ensure or cleanup. */
export function peekCarrierTasksByRoom(
  roomName: string,
): CarrierTaskRoomSnapshot {
  if (!isValidDispatchRoomName(roomName)) return [];
  const board = runtimeGlobal.__carrierTaskBoard;
  if (!isCarrierTaskBoardStore(board)) return [];
  const roomStore = nativeMapGet(board, roomName);
  if (!isCarrierTaskRoomStore(roomStore)) return [];

  return getRoomPublishOrder(roomName, roomStore)
    .map(({ ref, task }): CarrierTaskReadSnapshotEntry => ({
      ref: cloneCarrierDispatchRef(ref) as CarrierDispatchRef,
      task: cloneCarrierSnapshotValue(
        task,
      ) as CarrierTaskSnapshot,
    }));
}

function ensureCarrierTaskBoard(): CarrierTaskBoardStore {
  const existing = runtimeGlobal.__carrierTaskBoard;
  if (isCarrierTaskBoardStore(existing)) {
    return existing;
  }

  const created: CarrierTaskBoardStore = new Map();
  runtimeGlobal.__carrierTaskBoard = created;
  return created;
}

function ensureRoomTaskStore(roomName: string): CarrierTaskRoomStore | undefined {
  if (!isValidDispatchRoomName(roomName)) return undefined;
  const board = ensureCarrierTaskBoard();
  const existing = nativeMapGet(board, roomName);
  if (isCarrierTaskRoomStore(existing)) {
    return existing;
  }

  carrierTaskBoardRevisionCounter += 1;
  const created: CarrierTaskRoomStore = {
    byOwner: new Map(),
    nextPublishOrder: 0,
    revision: carrierTaskBoardRevisionCounter,
  };
  nativeMapSet(board, roomName, created);
  return created;
}

function cleanupRoomTaskStoreIfEmpty(roomName: string): void {
  const board = runtimeGlobal.__carrierTaskBoard;
  if (!isCarrierTaskBoardStore(board)) return;
  const roomStore = nativeMapGet(board, roomName);
  if (!isCarrierTaskRoomStore(roomStore)) return;
  const byOwner = readCarrierOwnerIndex(roomStore);
  if (!byOwner) return;
  for (const ownerTasks of nativeMapValues(byOwner)) {
    if (
      isNativeMap<string, CarrierTaskRecord>(ownerTasks)
      && nativeMapSize(ownerTasks) > 0
    ) return;
  }
  nativeMapDelete(board, roomName);
  roomOrderCache.delete(roomName);
}

/**
 * Atomically claims a same-tick execution slice from both the whole task and
 * one step. Successful intents commit the slice until tick rollover; failed
 * intents release it immediately. This runtime-only ledger never enters
 * Memory and therefore cannot leave a cross-tick stale lock.
 */
export function claimCarrierTaskStepAmount(
  task: CarrierTask,
  step: CarrierTaskStep,
  claimantId: string,
  requestedAmount: number,
): CarrierTaskStepAmountClaim | null {
  const ref = createCarrierDispatchRef(task.producer, task.roomName, task.id);
  if (!ref) return null;
  return claimCarrierAmountSlice({
    taskRef: ref,
    taskSteps: task.steps,
    stepId: step.id,
    claimantId,
    requestedAmount,
  });
}

/** Sorted production live entries with complete producer-scoped refs. */
export function listCarrierDispatchEntriesByRoom(
  roomName: string,
): readonly CarrierDispatchEntry[] {
  // Peek 式读取：不因读取不存在的房间而创建 board/空 store。排序结果走
  // revision 缓存，task 始终是 live 引用（调用方约定不改写）。
  if (!isValidDispatchRoomName(roomName)) return [];
  const board = runtimeGlobal.__carrierTaskBoard;
  if (!isCarrierTaskBoardStore(board)) return [];
  const roomStore = nativeMapGet(board, roomName);
  if (!isCarrierTaskRoomStore(roomStore)) return [];
  return getRoomDispatchOrder(roomName, roomStore)
    .map(({ ref, task }): CarrierDispatchEntry => ({
      ref,
      task: task as CarrierTask,
    }));
}

/** Compatibility gateway: task values are readonly live board views. */
export function listCarrierTasksByRoom(roomName: string): CarrierTask[] {
  return listCarrierDispatchEntriesByRoom(roomName)
    .map((entry) => entry.task);
}

export function listCarrierTasksForProducer(producer: string): CarrierTask[] {
  if (!producer) return [];
  const board = ensureCarrierTaskBoard();
  const tasks: CarrierTask[] = [];
  for (const [roomName, roomStore] of nativeMapEntries(board)) {
    if (
      !isValidDispatchRoomName(roomName)
      || !isCarrierTaskRoomStore(roomStore)
    ) {
      continue;
    }
    const byOwner = readCarrierOwnerIndex(roomStore);
    if (!byOwner) continue;
    const ownerTasks = nativeMapGet(byOwner, producer);
    if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) continue;
    for (const [localId, record] of nativeMapEntries(ownerTasks)) {
      if (
        createCarrierDispatchRef(producer, roomName, localId)
        && readCarrierTaskRecordOrder(record) !== undefined
      ) {
        const task = readCarrierTaskRecordTask(record);
        if (task !== undefined) {
          tasks.push(task as CarrierTask);
        }
      }
    }
  }
  return tasks;
}

/** Exact production lookup; never ensures a board or guesses an owner. */
export function findCarrierTaskByRef(
  ref: CarrierDispatchRef,
): CarrierTask | undefined {
  const ownedRef = cloneCarrierDispatchRef(ref);
  if (!ownedRef || !isCarrierDispatchRef(ownedRef)) return undefined;
  const board = runtimeGlobal.__carrierTaskBoard;
  if (!isCarrierTaskBoardStore(board)) return undefined;
  const roomStore = nativeMapGet(board, ownedRef.scope.roomName);
  if (!isCarrierTaskRoomStore(roomStore)) return undefined;
  const byOwner = readCarrierOwnerIndex(roomStore);
  if (!byOwner) return undefined;
  const ownerTasks = nativeMapGet(byOwner, ownedRef.namespace);
  if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) return undefined;
  const record = nativeMapGet(ownerTasks, ownedRef.localId);
  return readCarrierTaskRecordOrder(record) === undefined
    ? undefined
    : readCarrierTaskRecordTask(record) as CarrierTask | undefined;
}

/**
 * Test-only mutable lookup used to inject malformed task fields. Production
 * imports are rejected by the Local Dispatch architecture boundary test.
 */
export function getMutableCarrierTaskByRefForTest(
  ref: CarrierDispatchRef,
): MutableCarrierTaskForTest | undefined {
  return findCarrierTaskByRef(ref) as MutableCarrierTaskForTest | undefined;
}

/**
 * Test-only legacy local-id view. It deliberately throws on an owner
 * collision, because a local-id record cannot represent that identity safely.
 */
export function getMutableCarrierTasksByRoomForTest(
  roomName: string,
): Record<string, MutableCarrierTaskForTest> {
  const result: Record<string, MutableCarrierTaskForTest> = Object.create(null);
  for (const entry of listCarrierDispatchEntriesByRoom(roomName)) {
    if (Object.prototype.hasOwnProperty.call(result, entry.ref.localId)) {
      throw new Error(
        `Ambiguous Carrier localId ${entry.ref.localId} in ${roomName}; use exact refs`,
      );
    }
    defineCarrierSnapshotProperty(
      result,
      entry.ref.localId,
      entry.task as MutableCarrierTaskForTest,
    );
  }
  return result;
}

/**
 * @deprecated Test-only compatibility alias. Production code must use list or
 * exact-ref APIs; tests should migrate to getMutableCarrierTasksByRoomForTest.
 */
export const getCarrierTasksByRoom = getMutableCarrierTasksByRoomForTest;

function cloneCarrierTaskStep(step: CarrierTaskStep): MutableCarrierTaskStepForTest {
  return {
    id: step.id,
    resource: step.resource,
    fromKind: step.fromKind,
    toKind: step.toKind,
    fromId: step.fromId,
    toId: step.toId,
    amount: step.amount,
  };
}

function removeCarrierTaskRecord(
  roomName: string,
  producer: string,
  localId: string,
  roomStore: CarrierTaskRoomStore,
  ownerTasks: Map<string, CarrierTaskRecord>,
): boolean {
  const ref = createCarrierDispatchRef(producer, roomName, localId);
  if (!ref) return false;
  if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) return false;
  const record = nativeMapGet(ownerTasks, localId);
  if (!record) return false;
  releaseUncommittedCarrierAmountSlices(ref);
  nativeMapDelete(ownerTasks, localId);
  bumpRoomRevision(roomStore);
  if (nativeMapSize(ownerTasks) === 0) {
    const byOwner = readCarrierOwnerIndex(roomStore);
    if (byOwner && nativeMapGet(byOwner, producer) === ownerTasks) {
      nativeMapDelete(byOwner, producer);
    }
  }
  return true;
}

export function replaceCarrierTasksForProducerRoom(
  producer: string,
  roomName: string,
  drafts: readonly CarrierTaskDraft[],
): void {
  if (!producer || !isValidDispatchRoomName(roomName)) return;
  const roomStore = ensureRoomTaskStore(roomName);
  if (!roomStore) return;
  const byOwner = readCarrierOwnerIndex(roomStore);
  if (!byOwner) return;

  let ownerTasks = nativeMapGet(byOwner, producer);
  if (
    drafts.length === 0
    && (
      !isNativeMap<string, CarrierTaskRecord>(ownerTasks)
      || nativeMapSize(ownerTasks) === 0
    )
  ) {
    return;
  }
  bumpRoomRevision(roomStore);
  if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) {
    ownerTasks = new Map();
    nativeMapSet(byOwner, producer, ownerTasks);
  }
  const nextIds = new Set<string>();

  for (const draft of drafts) {
    const ref = createCarrierDispatchRef(producer, roomName, draft.id);
    if (!ref) continue;
    const filteredSteps = draft.steps
      .filter((step) => step.amount > 0)
      .map(cloneCarrierTaskStep);
    if (filteredSteps.length === 0) continue;

    nextIds.add(ref.localId);
    const existing = nativeMapGet(ownerTasks, ref.localId);
    const existingPublishOrder = readCarrierTaskRecordOrder(existing);
    const existingTask = readCarrierTaskRecordTask(existing);
    const existingCreatedAt = ownDataProperty(existingTask, "createdAt");
    const publishOrder = existingPublishOrder ?? roomStore.nextPublishOrder++;
    const createdAt = typeof existingCreatedAt === "number"
      ? existingCreatedAt
      : Game.time;
    const task: MutableCarrierTaskForTest = {
      id: ref.localId,
      producer: ref.namespace,
      roomName: ref.scope.roomName,
      type: draft.type,
      priority: draft.priority,
      ...(draft.dispatchClass
        ? { dispatchClass: draft.dispatchClass }
        : {}),
      steps: filteredSteps,
      createdAt,
      updatedAt: Game.time,
    };
    nativeMapSet(ownerTasks, ref.localId, { task, publishOrder });
  }

  for (const localId of Array.from(nativeMapKeys(ownerTasks))) {
    if (nextIds.has(localId)) continue;
    removeCarrierTaskRecord(
      roomName,
      producer,
      localId,
      roomStore,
      ownerTasks,
    );
  }

  cleanupRoomTaskStoreIfEmpty(roomName);
}

export function pruneCarrierTasksForProducer(
  producer: string,
  validRoomNames: ReadonlySet<string>,
): number {
  if (!producer) return 0;
  const board = ensureCarrierTaskBoard();
  let removed = 0;
  for (const [roomName, roomStore] of Array.from(nativeMapEntries(board))) {
    if (!isCarrierTaskRoomStore(roomStore)) continue;
    if (validRoomNames.has(roomName)) continue;
    const byOwner = readCarrierOwnerIndex(roomStore);
    if (!byOwner) continue;
    const ownerTasks = nativeMapGet(byOwner, producer);
    if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) continue;
    for (const localId of Array.from(nativeMapKeys(ownerTasks))) {
      if (removeCarrierTaskRecord(
        roomName,
        producer,
        localId,
        roomStore,
        ownerTasks,
      )) {
        removed += 1;
      }
    }
    cleanupRoomTaskStoreIfEmpty(roomName);
  }
  return removed;
}

export function cleanupCarrierTaskBoard(
  ownedRooms: ReadonlySet<string>,
  ttl: number,
): number {
  const board = ensureCarrierTaskBoard();
  let removed = 0;
  for (const [roomName, rawRoomStore] of Array.from(nativeMapEntries(board))) {
    if (!isValidDispatchRoomName(roomName)) {
      nativeMapDelete(board, roomName);
      roomOrderCache.delete(roomName);
      continue;
    }
    if (!isCarrierTaskRoomStore(rawRoomStore)) {
      nativeMapDelete(board, roomName);
      roomOrderCache.delete(roomName);
      continue;
    }

    const roomLost = !ownedRooms.has(roomName);
    const byOwner = readCarrierOwnerIndex(rawRoomStore);
    if (!byOwner) {
      nativeMapDelete(board, roomName);
      roomOrderCache.delete(roomName);
      continue;
    }
    for (const [producer, ownerTasks] of Array.from(nativeMapEntries(byOwner))) {
      if (!isNativeMap<string, CarrierTaskRecord>(ownerTasks)) {
        nativeMapDelete(byOwner, producer);
        continue;
      }
      for (const [localId, record] of Array.from(nativeMapEntries(ownerTasks))) {
        const task = readCarrierTaskRecordTask(record);
        const updatedAt = ownDataProperty(task, "updatedAt");
        const taskRoomName = ownDataProperty(task, "roomName");
        const stale = typeof updatedAt !== "number"
          || Game.time - updatedAt > ttl;
        const roomMismatch = taskRoomName !== roomName;
        if (!roomLost && !stale && !roomMismatch) continue;
        if (removeCarrierTaskRecord(
          roomName,
          producer,
          localId,
          rawRoomStore,
          ownerTasks,
        )) {
          removed += 1;
        }
      }
    }
    cleanupRoomTaskStoreIfEmpty(roomName);
  }
  return removed;
}

export function clearCarrierTaskBoardForTest(): void {
  delete runtimeGlobal.__carrierTaskBoard;
  roomOrderCache.clear();
  carrierTaskBoardRevisionCounter = 0;
  carrierTaskOrderRebuildCount = 0;
  clearCarrierAmountSlices();
}
