/**
 * Hub market protection snapshot.
 *
 * The Hub planner mutates several runtime/config stores while planning.  The
 * market must never join those partially-written stores directly, so a plan is
 * exposed through one immutable, revision-bound snapshot only.
 */

import { MARKET_BASE_RESOURCE_CATALOG } from "@/runtime/marketBaseResourcePolicy";
import { getHubOnlyReserve } from "@/config/hub";

export const HUB_PROTECTION_SNAPSHOT_SCHEMA = "hub-protection-snapshot-v1";

export const HUB_BASE_MINERALS: readonly ResourceConstant[] =
  MARKET_BASE_RESOURCE_CATALOG;

const HUB_BASE_MINERAL_SET = new Set<string>(MARKET_BASE_RESOURCE_CATALOG);

export type HubProtectionAttemptStatus =
  | "in_progress"
  | "committed"
  | "blocked"
  | "failed";

export interface HubProtectionAttempt {
  attemptRevision: number;
  configIncarnation: number;
  startedAt: number;
  finishedAt?: number;
  configFingerprint: string;
  status: HubProtectionAttemptStatus;
  valid: boolean;
  reason?: string;
}

export interface HubProtectionRevisionMarker {
  revision: number;
  configIncarnation: number;
  configFingerprint: string;
}

export interface HubProtectionConfigIncarnation {
  incarnation: number;
  observedAt: number;
  configFingerprint: string;
}

export interface HubProtectionAllocationLedgerEntry {
  resource: ResourceConstant;
  totalAmount: number;
  roomCommitments: Record<string, number>;
}

export interface HubProtectionDispatchAssignment {
  roomName: string;
  product: ResourceConstant;
  targetAmount: number;
  isHubRoom: boolean;
  finalTarget?: ResourceConstant;
}

export interface HubProtectionRouteDecision {
  fromRoom: string;
  toRoom: string;
  resource: ResourceConstant;
  amount: number;
  fee: number;
  isHubReagentDemand?: boolean;
}

export interface HubProtectionTransferTask {
  id: string;
  resource: ResourceConstant;
  fromRoomName: string;
  toRoomName: string;
  amount: number;
  remainingAmount: number;
  status: string;
  reason?: string;
}

export interface HubCommittedProtectionSnapshot {
  schema: typeof HUB_PROTECTION_SNAPSHOT_SCHEMA;
  planRevision: number;
  configIncarnation: number;
  observedAt: number;
  expiresAt: number;
  configFingerprint: string;
  status: "committed" | "blocked" | "failed" | "in_progress";
  valid: boolean;
  marker: HubProtectionRevisionMarker & {
    hubRoomName: string;
    planMode: "distributed" | "fallback" | "blocked";
    targetCompounds: ResourceConstant[];
    hubReservePerCompound: number;
    hubOnlyReservePerCompound?: number;
  };
  synthesisConfig: HubProtectionRevisionMarker & {
    rooms: Record<string, unknown>;
  };
  transferTasks: HubProtectionRevisionMarker & {
    tasks: HubProtectionTransferTask[];
  };
  distributed: HubProtectionRevisionMarker & {
    dispatchAssignments: HubProtectionDispatchAssignment[];
    routeDecisions: HubProtectionRouteDecision[];
    allocationLedger: Record<string, HubProtectionAllocationLedgerEntry>;
  };
  baseMineralSurplus: HubProtectionRevisionMarker & {
    byRoom: Record<string, Partial<Record<ResourceConstant, number>>>;
  };
  failureReason?: string;
}

export interface HubRuntimeProtectionExtension {
  protectionAttemptHighWater?: number;
  protectionConfigIncarnationHighWater?: number;
  currentProtectionConfigIncarnation?: HubProtectionConfigIncarnation;
  currentProtectionAttempt?: HubProtectionAttempt;
  committedProtectionSnapshot?: HubCommittedProtectionSnapshot;
}

export interface HubProtectionConfigInput {
  enabled?: boolean;
  hubRoomName?: string;
  planInterval?: number;
  reservePerRoom?: number;
  hubReservePerCompound?: number;
  hubOnlyReservePerCompound?: number;
  targetCompounds?: readonly ResourceConstant[];
  storagePauseFreeCapacity?: number;
  surplusThreshold?: number;
  internalOnly?: boolean;
  distributedStorage?: boolean;
}

export interface HubProtectionRuntimeInput {
  status?: string;
  distributedSynthesis?: {
    dispatchAssignments?: readonly unknown[];
    routeDecisions?: readonly unknown[];
    allocationLedger?: Readonly<Record<string, unknown>>;
  };
}

export interface BuildCommittedHubProtectionSnapshotInput {
  revision: number;
  configIncarnation: number;
  tick: number;
  expiresAt: number;
  config: HubProtectionConfigInput;
  runtime: HubProtectionRuntimeInput;
  synthesisRooms: unknown;
  transferTasks: unknown;
  planMode: "distributed" | "fallback" | "blocked";
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validResource(value: unknown): value is ResourceConstant {
  return validString(value);
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return JSON.stringify(`__nonfinite_number__:${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic hub config");
    seen.add(value);
    const encoded = `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  const record = asRecord(value);
  if (!record) throw new TypeError("unsupported hub config value");
  if (seen.has(record)) throw new TypeError("cyclic hub config");
  seen.add(record);
  const encoded = `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
    )
    .join(",")}}`;
  seen.delete(record);
  return encoded;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getHubProtectionConfigFingerprint(
  config: HubProtectionConfigInput,
): string {
  const payload = {
    schema: HUB_PROTECTION_SNAPSHOT_SCHEMA,
    enabled: config.enabled === true,
    hubRoomName: config.hubRoomName ?? "",
    planInterval: config.planInterval ?? null,
    reservePerRoom: config.reservePerRoom ?? null,
    hubReservePerCompound: config.hubReservePerCompound ?? null,
    hubOnlyReservePerCompound: config.hubOnlyReservePerCompound ?? null,
    targetCompounds: [...(config.targetCompounds ?? [])],
    storagePauseFreeCapacity: config.storagePauseFreeCapacity ?? null,
    surplusThreshold: config.surplusThreshold ?? null,
    internalOnly: config.internalOnly === true,
    distributedStorage: config.distributedStorage === true,
  };
  return `hubcfg-v1:${fnv1a32(canonicalize(payload, new Set()))}`;
}

function configIncarnationCandidate(value: unknown): number {
  return finiteNonNegative(value) ? Math.floor(value) : 0;
}

/**
 * Observe Hub configuration on every tick, including disabled/missing states.
 *
 * A fingerprint returning to an older value is still a new incarnation.  The
 * separate high-water therefore prevents A→B→A and disable→reenable from
 * making an older committed snapshot eligible again.
 */
export function observeHubProtectionConfigIncarnation(
  runtime: HubRuntimeProtectionExtension,
  config: HubProtectionConfigInput,
  tick: number,
): {
  changed: boolean;
  observation: HubProtectionConfigIncarnation;
} {
  const configFingerprint = getHubProtectionConfigFingerprint(config);
  const current = runtime.currentProtectionConfigIncarnation;
  const persistedHighWater = configIncarnationCandidate(
    runtime.protectionConfigIncarnationHighWater,
  );
  const currentIncarnation = configIncarnationCandidate(
    current?.incarnation,
  );
  const attemptIncarnation = configIncarnationCandidate(
    runtime.currentProtectionAttempt?.configIncarnation,
  );
  const snapshotIncarnation = configIncarnationCandidate(
    runtime.committedProtectionSnapshot?.configIncarnation,
  );
  const highWater = Math.max(
    persistedHighWater,
    currentIncarnation,
    attemptIncarnation,
    snapshotIncarnation,
  );
  const currentIsConsistent =
    !!current &&
    finitePositiveInteger(
      runtime.protectionConfigIncarnationHighWater,
    ) &&
    finitePositiveInteger(current.incarnation) &&
    current.incarnation ===
      runtime.protectionConfigIncarnationHighWater &&
    persistedHighWater === highWater &&
    validString(current.configFingerprint) &&
    finiteNonNegative(current.observedAt) &&
    current.observedAt <= tick;

  if (
    currentIsConsistent &&
    current.configFingerprint === configFingerprint
  ) {
    return { changed: false, observation: current };
  }

  const observation: HubProtectionConfigIncarnation = {
    incarnation: highWater + 1,
    observedAt: tick,
    configFingerprint,
  };
  runtime.protectionConfigIncarnationHighWater =
    observation.incarnation;
  runtime.currentProtectionConfigIncarnation = observation;
  return { changed: true, observation };
}

function revisionMarker(
  revision: number,
  configIncarnation: number,
  configFingerprint: string,
): HubProtectionRevisionMarker {
  return { revision, configIncarnation, configFingerprint };
}

function cloneRooms(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record) throw new TypeError("invalid synthesis room config");
  const result: Record<string, unknown> = {};
  for (const [roomName, rawConfig] of Object.entries(record)) {
    if (!validString(roomName) || !asRecord(rawConfig)) {
      throw new TypeError("invalid synthesis room config entry");
    }
    result[roomName] = JSON.parse(JSON.stringify(rawConfig)) as unknown;
  }
  return result;
}

function cloneDispatchAssignments(
  value: readonly unknown[] | undefined,
): HubProtectionDispatchAssignment[] {
  const result: HubProtectionDispatchAssignment[] = [];
  for (const raw of value ?? []) {
    const assignment = asRecord(raw);
    if (
      !assignment ||
      !validString(assignment.roomName) ||
      !validResource(assignment.product) ||
      !finiteNonNegative(assignment.targetAmount) ||
      typeof assignment.isHubRoom !== "boolean" ||
      (assignment.finalTarget !== undefined &&
        !validResource(assignment.finalTarget))
    ) {
      throw new TypeError("invalid Hub dispatch assignment");
    }
    const finalTarget = assignment.finalTarget as
      | ResourceConstant
      | undefined;
    result.push({
      roomName: assignment.roomName,
      product: assignment.product,
      targetAmount: assignment.targetAmount,
      isHubRoom: assignment.isHubRoom,
      ...(finalTarget === undefined
        ? {}
        : { finalTarget }),
    });
  }
  return result;
}

function cloneRouteDecisions(
  value: readonly unknown[] | undefined,
): HubProtectionRouteDecision[] {
  const result: HubProtectionRouteDecision[] = [];
  for (const raw of value ?? []) {
    const route = asRecord(raw);
    if (
      !route ||
      !validString(route.fromRoom) ||
      !validString(route.toRoom) ||
      !validResource(route.resource) ||
      !finiteNonNegative(route.amount) ||
      !finiteNonNegative(route.fee) ||
      (route.isHubReagentDemand !== undefined &&
        typeof route.isHubReagentDemand !== "boolean")
    ) {
      throw new TypeError("invalid Hub route decision");
    }
    const isHubReagentDemand = route.isHubReagentDemand as
      | boolean
      | undefined;
    result.push({
      fromRoom: route.fromRoom,
      toRoom: route.toRoom,
      resource: route.resource,
      amount: route.amount,
      fee: route.fee,
      ...(isHubReagentDemand === undefined
        ? {}
        : { isHubReagentDemand }),
    });
  }
  return result;
}

function cloneAllocationLedger(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, HubProtectionAllocationLedgerEntry> {
  const result: Record<string, HubProtectionAllocationLedgerEntry> = {};
  for (const [resourceKey, raw] of Object.entries(value ?? {})) {
    const entry = asRecord(raw);
    const rawRoomCommitments = asRecord(entry?.roomCommitments);
    if (
      !entry ||
      !validResource(resourceKey) ||
      entry.resource !== resourceKey ||
      !finiteNonNegative(entry.totalAmount) ||
      !rawRoomCommitments
    ) {
      throw new TypeError("invalid Hub allocation ledger entry");
    }
    const roomCommitments: Record<string, number> = {};
    let commitmentTotal = 0;
    for (const [roomName, amount] of Object.entries(rawRoomCommitments)) {
      if (!validString(roomName) || !finiteNonNegative(amount)) {
        throw new TypeError("invalid Hub room allocation");
      }
      roomCommitments[roomName] = amount;
      commitmentTotal += amount;
    }
    if (commitmentTotal > entry.totalAmount + 0.000_001) {
      throw new TypeError("Hub room allocation exceeds total");
    }
    result[resourceKey] = {
      resource: resourceKey,
      totalAmount: entry.totalAmount,
      roomCommitments,
    };
  }
  return result;
}

function cloneTransferTasks(value: unknown): HubProtectionTransferTask[] {
  const records = Array.isArray(value)
    ? value
    : Object.values(asRecord(value) ?? {});
  const result: HubProtectionTransferTask[] = [];
  const seenIds = new Set<string>();
  for (const raw of records) {
    const task = asRecord(raw);
    if (
      !task ||
      !validString(task.id) ||
      !validResource(task.resource) ||
      !validString(task.fromRoomName) ||
      !validString(task.toRoomName) ||
      !finiteNonNegative(task.amount) ||
      !finiteNonNegative(task.remainingAmount) ||
      !validString(task.status) ||
      (task.reason !== undefined && typeof task.reason !== "string")
    ) {
      throw new TypeError("invalid Hub transfer task");
    }
    if (seenIds.has(task.id)) {
      throw new TypeError("duplicate Hub transfer task");
    }
    seenIds.add(task.id);
    const reason = task.reason as string | undefined;
    result.push({
      id: task.id,
      resource: task.resource,
      fromRoomName: task.fromRoomName,
      toRoomName: task.toRoomName,
      amount: task.amount,
      remainingAmount: task.remainingAmount,
      status: task.status,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  result.sort((left, right) => left.id.localeCompare(right.id));
  return result;
}

export function deriveHubBaseMineralResidual(
  hubRoomName: string,
  allocationLedger: Readonly<
    Record<string, HubProtectionAllocationLedgerEntry>
  >,
): Partial<Record<ResourceConstant, number>> {
  const result: Partial<Record<ResourceConstant, number>> = {};
  for (const resource of HUB_BASE_MINERALS) {
    const amount = allocationLedger[resource]?.roomCommitments[hubRoomName] ?? 0;
    if (!finiteNonNegative(amount)) {
      throw new TypeError("invalid Hub base-mineral residual");
    }
    const normalized = Math.floor(amount);
    if (normalized > 0) result[resource] = normalized;
  }
  return result;
}

export function beginHubProtectionAttempt(
  runtime: HubRuntimeProtectionExtension,
  config: HubProtectionConfigInput,
  tick: number,
): HubProtectionAttempt {
  const configObservation = observeHubProtectionConfigIncarnation(
    runtime,
    config,
    tick,
  ).observation;
  const previousHighWater = finiteNonNegative(runtime.protectionAttemptHighWater)
    ? Math.floor(runtime.protectionAttemptHighWater)
    : 0;
  const previousAttemptRevision = finiteNonNegative(
    runtime.currentProtectionAttempt?.attemptRevision,
  )
    ? Math.floor(runtime.currentProtectionAttempt!.attemptRevision)
    : 0;
  const previousSnapshotRevision = finiteNonNegative(
    runtime.committedProtectionSnapshot?.planRevision,
  )
    ? Math.floor(runtime.committedProtectionSnapshot!.planRevision)
    : 0;
  const attemptRevision =
    Math.max(previousHighWater, previousAttemptRevision, previousSnapshotRevision) +
    1;
  const configFingerprint = getHubProtectionConfigFingerprint(config);
  const attempt: HubProtectionAttempt = {
    attemptRevision,
    configIncarnation: configObservation.incarnation,
    startedAt: tick,
    configFingerprint,
    status: "in_progress",
    valid: false,
  };
  runtime.protectionAttemptHighWater = attemptRevision;
  runtime.currentProtectionAttempt = attempt;
  runtime.committedProtectionSnapshot = createInvalidHubProtectionSnapshot({
    revision: attemptRevision,
    configIncarnation: configObservation.incarnation,
    tick,
    config,
    status: "in_progress",
    reason: "planning_in_progress",
  });
  return attempt;
}

export function buildCommittedHubProtectionSnapshot(
  input: BuildCommittedHubProtectionSnapshotInput,
): HubCommittedProtectionSnapshot {
  if (
    !finitePositiveInteger(input.revision) ||
    !finitePositiveInteger(input.configIncarnation) ||
    !finiteNonNegative(input.tick) ||
    !finiteNonNegative(input.expiresAt) ||
    input.expiresAt < input.tick ||
    !validString(input.config.hubRoomName)
  ) {
    throw new TypeError("invalid Hub snapshot envelope");
  }
  const configFingerprint = getHubProtectionConfigFingerprint(input.config);
  const marker = revisionMarker(
    input.revision,
    input.configIncarnation,
    configFingerprint,
  );
  const distributed = input.runtime.distributedSynthesis;
  const allocationLedger = cloneAllocationLedger(
    distributed?.allocationLedger,
  );
  const baseMineralSurplus =
    input.planMode === "distributed"
      ? deriveHubBaseMineralResidual(
          input.config.hubRoomName,
          allocationLedger,
        )
      : {};

  return {
    schema: HUB_PROTECTION_SNAPSHOT_SCHEMA,
    planRevision: input.revision,
    configIncarnation: input.configIncarnation,
    observedAt: input.tick,
    expiresAt: input.expiresAt,
    configFingerprint,
    status: "committed",
    valid: true,
    marker: {
      ...marker,
      hubRoomName: input.config.hubRoomName,
      planMode: input.planMode,
      targetCompounds: [...(input.config.targetCompounds ?? [])],
      hubReservePerCompound: finiteNonNegative(
        input.config.hubReservePerCompound,
      )
        ? input.config.hubReservePerCompound
        : 10_000,
      hubOnlyReservePerCompound: getHubOnlyReserve(input.config),
    },
    synthesisConfig: {
      ...marker,
      rooms: cloneRooms(input.synthesisRooms),
    },
    transferTasks: {
      ...marker,
      tasks: cloneTransferTasks(input.transferTasks),
    },
    distributed: {
      ...marker,
      dispatchAssignments: cloneDispatchAssignments(
        distributed?.dispatchAssignments,
      ),
      routeDecisions: cloneRouteDecisions(distributed?.routeDecisions),
      allocationLedger,
    },
    baseMineralSurplus: {
      ...marker,
      byRoom: {
        [input.config.hubRoomName]: baseMineralSurplus,
      },
    },
  };
}

export function createInvalidHubProtectionSnapshot(input: {
  revision: number;
  configIncarnation: number;
  tick: number;
  config: HubProtectionConfigInput;
  status: "blocked" | "failed" | "in_progress";
  reason: string;
}): HubCommittedProtectionSnapshot {
  const configFingerprint = getHubProtectionConfigFingerprint(input.config);
  const marker = revisionMarker(
    input.revision,
    input.configIncarnation,
    configFingerprint,
  );
  const hubRoomName = input.config.hubRoomName ?? "";
  return {
    schema: HUB_PROTECTION_SNAPSHOT_SCHEMA,
    planRevision: input.revision,
    configIncarnation: input.configIncarnation,
    observedAt: input.tick,
    expiresAt: input.tick,
    configFingerprint,
    status: input.status,
    valid: false,
    marker: {
      ...marker,
      hubRoomName,
      planMode: "blocked",
      targetCompounds: [],
      hubReservePerCompound: 0,
      hubOnlyReservePerCompound: 0,
    },
    synthesisConfig: { ...marker, rooms: {} },
    transferTasks: { ...marker, tasks: [] },
    distributed: {
      ...marker,
      dispatchAssignments: [],
      routeDecisions: [],
      allocationLedger: {},
    },
    baseMineralSurplus: {
      ...marker,
      byRoom: hubRoomName ? { [hubRoomName]: {} } : {},
    },
    failureReason: input.reason,
  };
}

export function publishCommittedHubProtectionSnapshot(
  runtime: HubRuntimeProtectionExtension,
  attempt: HubProtectionAttempt,
  snapshot: HubCommittedProtectionSnapshot,
): void {
  if (
    snapshot.valid !== true ||
    snapshot.status !== "committed" ||
    snapshot.planRevision !== attempt.attemptRevision ||
    snapshot.configIncarnation !== attempt.configIncarnation ||
    snapshot.configFingerprint !== attempt.configFingerprint
  ) {
    throw new TypeError("Hub snapshot does not match current attempt");
  }
  runtime.committedProtectionSnapshot = snapshot;
  runtime.currentProtectionAttempt = {
    ...attempt,
    status: "committed",
    valid: true,
    finishedAt: snapshot.observedAt,
  };
}

export function publishInvalidHubProtectionSnapshot(
  runtime: HubRuntimeProtectionExtension,
  attempt: HubProtectionAttempt,
  config: HubProtectionConfigInput,
  tick: number,
  status: "blocked" | "failed",
  reason: string,
): void {
  runtime.committedProtectionSnapshot = createInvalidHubProtectionSnapshot({
    revision: attempt.attemptRevision,
    configIncarnation: attempt.configIncarnation,
    tick,
    config,
    status,
    reason,
  });
  runtime.currentProtectionAttempt = {
    ...attempt,
    status,
    valid: false,
    finishedAt: tick,
    reason,
  };
}

function markerMatches(
  value: unknown,
  revision: number,
  configIncarnation: number,
  configFingerprint: string,
): boolean {
  const marker = asRecord(value);
  return (
    marker?.revision === revision &&
    marker.configIncarnation === configIncarnation &&
    marker.configFingerprint === configFingerprint
  );
}

function equalBaseResidual(
  left: Readonly<Partial<Record<ResourceConstant, number>>>,
  right: Readonly<Partial<Record<ResourceConstant, number>>>,
): boolean {
  for (const resource of HUB_BASE_MINERALS) {
    if ((left[resource] ?? 0) !== (right[resource] ?? 0)) return false;
  }
  return true;
}

/**
 * Strict reader used by the market adapter.  It deliberately has no legacy
 * fallback: a new attempt makes the previous revision unreadable immediately.
 */
export function readFreshCommittedHubProtectionSnapshot(
  runtimeValue: unknown,
  config: HubProtectionConfigInput,
  tick: number,
): HubCommittedProtectionSnapshot | undefined {
  const runtime = asRecord(runtimeValue);
  const configObservation = asRecord(
    runtime?.currentProtectionConfigIncarnation,
  );
  const attempt = asRecord(runtime?.currentProtectionAttempt);
  const snapshot = asRecord(runtime?.committedProtectionSnapshot);
  const currentConfigFingerprint =
    getHubProtectionConfigFingerprint(config);
  if (
    !runtime ||
    !configObservation ||
    !attempt ||
    !snapshot ||
    snapshot.schema !== HUB_PROTECTION_SNAPSHOT_SCHEMA ||
    snapshot.valid !== true ||
    snapshot.status !== "committed" ||
    attempt.valid !== true ||
    attempt.status !== "committed" ||
    !finitePositiveInteger(snapshot.planRevision) ||
    !finitePositiveInteger(snapshot.configIncarnation) ||
    attempt.attemptRevision !== snapshot.planRevision ||
    attempt.configIncarnation !== snapshot.configIncarnation ||
    runtime.protectionAttemptHighWater !== snapshot.planRevision ||
    runtime.protectionConfigIncarnationHighWater !==
      snapshot.configIncarnation ||
    configObservation.incarnation !== snapshot.configIncarnation ||
    configObservation.configFingerprint !== currentConfigFingerprint ||
    snapshot.configFingerprint !== currentConfigFingerprint ||
    attempt.configFingerprint !== snapshot.configFingerprint ||
    !finiteNonNegative(configObservation.observedAt) ||
    configObservation.observedAt > tick ||
    !finiteNonNegative(snapshot.observedAt) ||
    !finiteNonNegative(snapshot.expiresAt) ||
    snapshot.observedAt > tick ||
    snapshot.expiresAt < tick ||
    snapshot.expiresAt < snapshot.observedAt ||
    !finiteNonNegative(attempt.startedAt) ||
    !finiteNonNegative(attempt.finishedAt) ||
    attempt.startedAt > attempt.finishedAt ||
    attempt.finishedAt !== snapshot.observedAt
  ) {
    return undefined;
  }

  const marker = asRecord(snapshot.marker);
  const synthesisConfig = asRecord(snapshot.synthesisConfig);
  const transferTasks = asRecord(snapshot.transferTasks);
  const distributed = asRecord(snapshot.distributed);
  const baseMineralSurplus = asRecord(snapshot.baseMineralSurplus);
  const revision = snapshot.planRevision;
  const configIncarnation = snapshot.configIncarnation;
  const fingerprint = snapshot.configFingerprint as string;
  if (
    !markerMatches(marker, revision, configIncarnation, fingerprint) ||
    !markerMatches(
      synthesisConfig,
      revision,
      configIncarnation,
      fingerprint,
    ) ||
    !markerMatches(
      transferTasks,
      revision,
      configIncarnation,
      fingerprint,
    ) ||
    !markerMatches(
      distributed,
      revision,
      configIncarnation,
      fingerprint,
    ) ||
    !markerMatches(
      baseMineralSurplus,
      revision,
      configIncarnation,
      fingerprint,
    ) ||
    marker?.hubRoomName !== config.hubRoomName ||
    !["distributed", "fallback", "blocked"].includes(
      String(marker?.planMode),
    ) ||
    !Array.isArray(marker?.targetCompounds) ||
    marker.targetCompounds.some(
      (resource: unknown) => !validResource(resource),
    ) ||
    new Set(marker.targetCompounds as unknown[]).size !==
      marker.targetCompounds.length ||
    !finiteNonNegative(marker?.hubReservePerCompound) ||
    !finiteNonNegative(marker?.hubOnlyReservePerCompound) ||
    marker?.hubOnlyReservePerCompound !== getHubOnlyReserve(config) ||
    !asRecord(synthesisConfig?.rooms) ||
    !Array.isArray(transferTasks?.tasks) ||
    !Array.isArray(distributed?.dispatchAssignments) ||
    !Array.isArray(distributed?.routeDecisions) ||
    !asRecord(distributed?.allocationLedger) ||
    !asRecord(baseMineralSurplus?.byRoom)
  ) {
    return undefined;
  }

  try {
    const clonedLedger = cloneAllocationLedger(
      distributed!.allocationLedger as Readonly<Record<string, unknown>>,
    );
    cloneDispatchAssignments(distributed!.dispatchAssignments as unknown[]);
    cloneRouteDecisions(distributed!.routeDecisions as unknown[]);
    cloneTransferTasks(transferTasks!.tasks);
    cloneRooms(synthesisConfig!.rooms);
    const byRoom = asRecord(baseMineralSurplus!.byRoom);
    const declared = asRecord(byRoom?.[config.hubRoomName ?? ""]);
    if (
      !declared ||
      Object.keys(byRoom ?? {}).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(
        byRoom,
        config.hubRoomName ?? "",
      )
    ) {
      return undefined;
    }
    for (const [resource, amount] of Object.entries(declared)) {
      if (
        !HUB_BASE_MINERAL_SET.has(resource) ||
        !finiteNonNegative(amount) ||
        amount <= 0
      ) {
        return undefined;
      }
    }
    const expected =
      marker!.planMode === "distributed"
        ? deriveHubBaseMineralResidual(
            config.hubRoomName ?? "",
            clonedLedger,
          )
        : {};
    if (
      !equalBaseResidual(
        declared as Partial<Record<ResourceConstant, number>>,
        expected,
      )
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return snapshot as unknown as HubCommittedProtectionSnapshot;
}
