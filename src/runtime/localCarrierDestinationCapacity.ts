import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";

export interface LocalCarrierDestinationCapacityClaim {
  amount: number;
  commit(): void;
  release(): void;
}

export interface LocalCarrierDestinationCapacityObservation {
  tick: number;
  committedAmount: number;
  blockedPickupCount: number;
}

interface DestinationClaimRecord {
  claimantId: string;
  targetId: string;
  resource?: ResourceConstant;
  amount: number;
  committed: boolean;
  seeded: boolean;
  seededTransfer?: {
    amount: number;
    committed: boolean;
  };
}

interface DestinationCapacityLedger {
  tick: number;
  game: Game;
  committedByTargetId: Map<string, number>;
  claimByClaimantId: Map<string, DestinationClaimRecord>;
  blockedPickupCountByRoom: Map<string, number>;
}

let ledger: DestinationCapacityLedger | undefined;

function normalizeCapacity(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function addCommittedAmount(
  target: DestinationCapacityLedger,
  targetId: string,
  amount: number,
): void {
  if (amount <= 0) return;
  target.committedByTargetId.set(
    targetId,
    (target.committedByTargetId.get(targetId) || 0) + amount,
  );
}

function seedCarrierCommitment(
  target: DestinationCapacityLedger,
  claimantId: string,
  targetId: string,
  amount: number,
  resource?: ResourceConstant,
): boolean {
  const normalizedAmount = normalizeCapacity(amount);
  if (normalizedAmount <= 0) return false;

  const record: DestinationClaimRecord = {
    claimantId,
    targetId,
    ...(resource ? { resource } : {}),
    amount: normalizedAmount,
    committed: true,
    seeded: true,
  };
  target.claimByClaimantId.set(claimantId, record);
  addCommittedAmount(target, targetId, normalizedAmount);
  return true;
}

function seedLiveCarrierCommitments(target: DestinationCapacityLedger): void {
  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepAssignmentState(creep.name);
    const snapshotTargetId = state?.synthesisCarrierPendingToId;
    const snapshotResource = state?.synthesisCarrierPendingResource;
    if (snapshotTargetId && snapshotResource) {
      if (seedCarrierCommitment(
        target,
        creep.name,
        snapshotTargetId,
        creep.store.getUsedCapacity(snapshotResource),
        snapshotResource,
      )) {
        continue;
      }
    }

    if (
      state?.carrierPlanMode === "deliver" &&
      state.carrierPlanTargetKind === "structure" &&
      state.carrierPlanTargetId
    ) {
      seedCarrierCommitment(
        target,
        creep.name,
        state.carrierPlanTargetId,
        creep.store.getUsedCapacity(),
      );
    }
  }
}

function getPhysicalDestinationFreeAmount(
  target: AnyStoreStructure,
  resource: ResourceConstant,
): number {
  return Math.min(
    normalizeCapacity(target.store.getFreeCapacity()),
    normalizeCapacity(target.store.getFreeCapacity(resource)),
  );
}

function getUnseededCommittedAmount(
  target: DestinationCapacityLedger,
  targetId: string,
): number {
  let amount = 0;
  for (const record of target.claimByClaimantId.values()) {
    if (!record.seeded && record.targetId === targetId) {
      amount += record.amount;
    }
  }
  return amount;
}

function getSeededTransferAmount(
  target: DestinationCapacityLedger,
  targetId: string,
): number {
  let amount = 0;
  for (const record of target.claimByClaimantId.values()) {
    if (record.seeded && record.targetId === targetId) {
      amount += record.seededTransfer?.amount || 0;
    }
  }
  return amount;
}

function ensureLedger(): DestinationCapacityLedger {
  if (ledger?.tick === Game.time && ledger.game === Game) {
    return ledger;
  }

  ledger = {
    tick: Game.time,
    game: Game,
    committedByTargetId: new Map(),
    claimByClaimantId: new Map(),
    blockedPickupCountByRoom: new Map(),
  };
  seedLiveCarrierCommitments(ledger);
  return ledger;
}

function recordBlockedPickup(
  target: DestinationCapacityLedger,
  roomName: string,
): void {
  target.blockedPickupCountByRoom.set(
    roomName,
    (target.blockedPickupCountByRoom.get(roomName) || 0) + 1,
  );
}

/**
 * 返回当前物理 Store 快照扣除已接货、在途 cargo 与本 tick 先到 claim 后的
 * 可用容量。Storage/Terminal 的资源共享总容量，因此总空闲与资源空闲取较小值。
 */
export function getLocalCarrierDestinationAvailableAmount(
  target: AnyStoreStructure,
  resource: ResourceConstant,
): number {
  const current = ensureLedger();
  const physicalFree = getPhysicalDestinationFreeAmount(target, resource);
  return Math.max(
    0,
    physicalFree - (current.committedByTargetId.get(target.id) || 0),
  );
}

/**
 * 为一次 carrier pickup 原子领取目标容量。相同 claimant 同 tick 只能持有一份
 * claim，防止 mount re-entry 重复发出 withdraw。失败路径必须调用 release；
 * accepted withdraw/transfer 调用 commit 后保留到 tick 结束，等待下一 tick 的
 * live Store/creep 快照接管。
 */
export function claimLocalCarrierDestinationCapacity(params: {
  claimantId: string;
  target: AnyStoreStructure;
  resource: ResourceConstant;
  requestedAmount: number;
}): LocalCarrierDestinationCapacityClaim | null {
  const current = ensureLedger();
  if (
    !Number.isSafeInteger(params.requestedAmount) ||
    params.requestedAmount <= 0
  ) {
    return null;
  }

  const existing = current.claimByClaimantId.get(params.claimantId);
  if (existing) {
    if (
      !existing.seeded ||
      existing.targetId !== params.target.id ||
      existing.seededTransfer
    ) {
      return null;
    }

    const physicalFree = getPhysicalDestinationFreeAmount(
      params.target,
      params.resource,
    );
    const amount = Math.min(
      params.requestedAmount,
      existing.amount,
      Math.max(
        0,
        physicalFree -
          getUnseededCommittedAmount(current, params.target.id) -
          getSeededTransferAmount(current, params.target.id),
      ),
    );
    if (amount <= 0) {
      const roomName = params.target.pos?.roomName;
      if (roomName) recordBlockedPickup(current, roomName);
      return null;
    }

    // Live cargo is already part of committedByTargetId. Allocate only an
    // execution slice here: it protects physical capacity from other seeded
    // carriers without subtracting the same in-flight commitment twice.
    const seededTransfer = { amount, committed: false };
    existing.seededTransfer = seededTransfer;
    let released = false;
    const isCurrentTransfer = (): boolean =>
      current.claimByClaimantId.get(params.claimantId) === existing &&
      existing.seededTransfer === seededTransfer;
    return {
      amount,
      commit(): void {
        if (!released && isCurrentTransfer()) seededTransfer.committed = true;
      },
      release(): void {
        if (released || seededTransfer.committed || !isCurrentTransfer()) {
          return;
        }
        released = true;
        delete existing.seededTransfer;
      },
    };
  }

  const availableAmount = getLocalCarrierDestinationAvailableAmount(
    params.target,
    params.resource,
  );
  const amount = Math.min(params.requestedAmount, availableAmount);
  if (amount <= 0) {
    const roomName = params.target.pos?.roomName;
    if (roomName) recordBlockedPickup(current, roomName);
    return null;
  }

  const record: DestinationClaimRecord = {
    claimantId: params.claimantId,
    targetId: params.target.id,
    resource: params.resource,
    amount,
    committed: false,
    seeded: false,
  };
  current.claimByClaimantId.set(params.claimantId, record);
  addCommittedAmount(current, params.target.id, amount);

  let released = false;
  const isCurrentRecord = (): boolean =>
    current.claimByClaimantId.get(params.claimantId) === record;
  return {
    amount,
    commit(): void {
      if (!released && isCurrentRecord()) record.committed = true;
    },
    release(): void {
      if (released || record.committed || !isCurrentRecord()) return;
      released = true;
      current.claimByClaimantId.delete(params.claimantId);
      const remaining = Math.max(
        0,
        (current.committedByTargetId.get(params.target.id) || 0) - amount,
      );
      if (remaining > 0) {
        current.committedByTargetId.set(params.target.id, remaining);
      } else {
        current.committedByTargetId.delete(params.target.id);
      }
    },
  };
}

export function getLocalCarrierDestinationCommittedAmount(
  targetId: string,
  resource?: ResourceConstant,
): number {
  const current = ensureLedger();
  if (resource === undefined) return current.committedByTargetId.get(targetId) || 0;
  let amount = 0;
  for (const claim of current.claimByClaimantId.values()) {
    // 未记录资源的普通投递按总量计入，宁可暂缓补货也不重复搬运。
    if (claim.targetId === targetId &&
        (claim.resource === undefined || claim.resource === resource)) {
      amount += claim.amount;
    }
  }
  return amount;
}

export function getLocalCarrierDestinationCapacityObservation(
  roomName: string,
  targetId: string,
): LocalCarrierDestinationCapacityObservation {
  const current = ensureLedger();
  return {
    tick: current.tick,
    committedAmount: current.committedByTargetId.get(targetId) || 0,
    blockedPickupCount:
      current.blockedPickupCountByRoom.get(roomName) || 0,
  };
}

export function clearLocalCarrierDestinationCapacityForTest(): void {
  ledger = undefined;
}
