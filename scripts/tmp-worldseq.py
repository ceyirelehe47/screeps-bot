# -*- coding: utf-8 -*-
import io

# 8) facade.ts
p = 'src/runtime/treasury/facade.ts'
s = io.open(p, encoding='utf-8').read()
old = """  function kernelOccupancyNow(options: {
    observationAsOfTick?: number;
    excludeAttemptId?: string;
  } = {}): { byKey: ReadonlyMap<string, number>; inflowByLocation: ReadonlyMap<string, number> } {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") {
      return { byKey: new Map(), inflowByLocation: new Map() };
    }
    const occupancy = computeTreasuryCoreOccupancy(health.memory, options);
    return { byKey: occupancy.byKey, inflowByLocation: occupancy.inflowByLocation };
  }"""
new = """  function kernelOccupancyNow(options: {
    observation?: TreasuryObservationView;
    excludeAttemptId?: string;
  } = {}): { byKey: ReadonlyMap<string, number>; inflowByLocation: ReadonlyMap<string, number> } {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") {
      return { byKey: new Map(), inflowByLocation: new Map() };
    }
    // 观察覆盖判定锚点（§6.2）：世界序优先（同步生效模型精确判定），
    // tick 边界兜底（世界序缺失的旧记录保守占用）。
    const occupancy = computeTreasuryCoreOccupancy(health.memory, {
      observationWorldSequence: options.observation?.epoch.worldSequence,
      observationAsOfTick: options.observation?.epoch.observedAtTick,
      excludeAttemptId: options.excludeAttemptId,
    });
    return { byKey: occupancy.byKey, inflowByLocation: occupancy.inflowByLocation };
  }"""
assert old in s
s = s.replace(old, new)

old = """    const occupancy = kernelOccupancyNow({
      observationAsOfTick: state.observation.epoch.observedAtTick,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(state, occupancy, context);
    return evaluateTreasuryAdmissionFacts(sources, candidateLegs, {
      excludeOwner,
    });
  }"""
new = """    const occupancy = kernelOccupancyNow({
      observation: state.observation,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(state, occupancy, context);
    return evaluateTreasuryAdmissionFacts(sources, candidateLegs, {
      excludeOwner,
    });
  }"""
assert old in s
s = s.replace(old, new)

old = """    const occupancy = kernelOccupancyNow({
      observationAsOfTick: observation.epoch.observedAtTick,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(
      { tick: Game.time, observation, ended: false },
      occupancy,
      context,
    );
    return { verdict: evaluateTreasuryAdmissionFacts(sources, candidateLegs, { excludeOwner }), observation };"""
new = """    const occupancy = kernelOccupancyNow({
      observation,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(
      { tick: Game.time, observation, ended: false },
      occupancy,
      context,
    );
    return { verdict: evaluateTreasuryAdmissionFacts(sources, candidateLegs, { excludeOwner }), observation };"""
assert old in s
s = s.replace(old, new)

old = "        const occupancy = kernelOccupancyNow({ observationAsOfTick: observation.epoch.observedAtTick });"
new = "        const occupancy = kernelOccupancyNow({ observation });"
assert old in s
s = s.replace(old, new)

old = """        capacityDelta: (roomName, kind) =>
          kernelUnknownInflowOccupancy(roomName, kind, state.observation.epoch.observedAtTick),"""
new = """        capacityDelta: (roomName, kind) =>
          kernelUnknownInflowOccupancy(roomName, kind, state.observation),"""
assert old in s
s = s.replace(old, new)

old = """      const kernelInflow = kernelUnknownInflowOccupancy(roomName, kind, state.observation.epoch.observedAtTick);"""
new = """      const kernelInflow = kernelUnknownInflowOccupancy(roomName, kind, state.observation);"""
assert old in s
s = s.replace(old, new)

old = """  /** kernel 侧占用流入投影（unknown + 未覆盖 committed；统一 occupancy 口径）。 */
  function kernelUnknownInflowOccupancy(roomName: string, kind: TreasuryLocationKind, asOfTick: number): number {
    return (
      kernelOccupancyNow({ observationAsOfTick: asOfTick }).inflowByLocation.get(overlayLocationKey(roomName, kind)) ?? 0
    );
  }"""
new = """  /** kernel 侧占用流入投影（unknown + 未覆盖 committed；统一 occupancy 口径）。 */
  function kernelUnknownInflowOccupancy(roomName: string, kind: TreasuryLocationKind, observation: TreasuryObservationView): number {
    return (
      kernelOccupancyNow({ observation }).inflowByLocation.get(overlayLocationKey(roomName, kind)) ?? 0
    );
  }"""
assert old in s
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("facade.ts ok")

# 9) actionContracts.ts
p = 'src/runtime/treasury/actionContracts.ts'
s = io.open(p, encoding='utf-8').read()
old = "/** 测试 adapter 的同步世界写入（受控测试世界；生产 adapter 不使用）。 */\nfunction applyTestTransferToWorld(args: TreasuryTestTransferArgs): void {"
new = ("/** 测试 adapter 的同步世界写入（受控测试世界；生产 adapter 不使用）。 */\n"
       "function applyTestTransferToWorld(args: TreasuryTestTransferArgs): void {\n"
       "  // 受控世界真实更新 → 世界序 +1（观察覆盖判定锚点；§6.2）。")
assert old in s
s = s.replace(old, new)
old = """  if (toStore) {
    const next = (toStore[args.resource] ?? 0) + args.amount;
    if (next > 0) toStore[args.resource] = next;
    else delete toStore[args.resource];
    if (typeof freeTo === "number") {
      (toStore as unknown as { __freeCapacity: number }).__freeCapacity = Math.max(0, freeTo - args.amount);
    }
  }
}"""
new = """  if (toStore) {
    const next = (toStore[args.resource] ?? 0) + args.amount;
    if (next > 0) toStore[args.resource] = next;
    else delete toStore[args.resource];
    if (typeof freeTo === "number") {
      (toStore as unknown as { __freeCapacity: number }).__freeCapacity = Math.max(0, freeTo - args.amount);
    }
  }
  bumpTreasuryWorldSequence();
}"""
assert old in s
s = s.replace(old, new)
old = 'import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";'
assert old in s
new = old + '\nimport { bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("actionContracts.ts ok")

# 10) test/mock/treasury.ts
p = 'test/mock/treasury.ts'
s = io.open(p, encoding='utf-8').read()
old = """/** 写入 storage/terminal 资源（模拟 tick 间外部变化）。 */
export function setStoreResources(
  structure: StructureStorage | StructureTerminal | undefined,
  resources: Record<string, number>,
): void {
  const record = structure?.store as unknown as Record<string, number>;
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "number") delete record[key];
  }
  for (const [resource, amount] of Object.entries(resources)) {
    record[resource] = amount;
  }
}"""
new = """/** 测试宿主直接推进世界序（installRooms 重建除外的一切世界真实更新）。 */
export function bumpTreasuryWorldSequenceForTest(): void {
  (globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence =
    ((globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence ?? 0) + 1;
}

/**
 * 写入 storage/terminal 资源（模拟 tick 间外部变化）。视为受控世界真实
 * 更新：世界序 +1（观察覆盖判定——§6.2；installRooms 重建不 bump，重建
 * 是测试基建行为而非世界推进）。
 */
export function setStoreResources(
  structure: StructureStorage | StructureTerminal | undefined,
  resources: Record<string, number>,
): void {
  const record = structure?.store as unknown as Record<string, number>;
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "number") delete record[key];
  }
  for (const [resource, amount] of Object.entries(resources)) {
    record[resource] = amount;
  }
  bumpTreasuryWorldSequenceForTest();
}"""
assert old in s
s = s.replace(old, new)
old = """  const free = (structure?.store as unknown as { __freeCapacity?: number }).__freeCapacity;
  if (typeof free === "number") {
    (structure?.store as unknown as { __freeCapacity: number }).__freeCapacity = Math.max(0, free - delta);
  }
}"""
new = """  const free = (structure?.store as unknown as { __freeCapacity?: number }).__freeCapacity;
  if (typeof free === "number") {
    (structure?.store as unknown as { __freeCapacity: number }).__freeCapacity = Math.max(0, free - delta);
  }
  bumpTreasuryWorldSequenceForTest();
}"""
assert old in s
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("mock ok")
