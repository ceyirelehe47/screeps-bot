# -*- coding: utf-8 -*-
# 临时脚本：strict/risk-adjusted capacity 分立。执行后删除。
import io

# 1) types.ts：TreasuryReceiverCommitments 增加双口径字段
path = "src/runtime/treasury/types.ts"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()
old = '''  /** projected 口径（observed free 减去本 tick 已结算 transaction 的容量净变化）。 */
  projectedStorageHeadroom: number;
  projectedTerminalHeadroom: number;
  projectedOvercommitted: boolean;'''
new = '''  /**
   * projected 口径（**risk-adjusted**：observed free − 本 tick overlay 容量净
   * 变化 − quarantine/unresolved intent 正流入占用；第七轮起的语义，第八轮
   * 显式标注——receiver admission 使用该口径）。prefer 显式字段
   * riskAdjustedStorageHeadroom/riskAdjustedTerminalHeadroom（同值）。
   */
  projectedStorageHeadroom: number;
  projectedTerminalHeadroom: number;
  projectedOvercommitted: boolean;
  /** 严格口径（observed free − 本 tick overlay 净变化；不含任何风险扣减）。 */
  strictStorageHeadroom: number;
  strictTerminalHeadroom: number;
  strictOvercommitted: boolean;
  /** risk-adjusted 口径（= projected* 字段；额外扣除 quarantine/intent 占用）。 */
  riskAdjustedStorageHeadroom: number;
  riskAdjustedTerminalHeadroom: number;
  riskAdjustedOvercommitted: boolean;'''
assert old in src, "types receiver"
src = src.replace(old, new)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)

# 2) commitments.ts：strictCapacityDelta 选项 + 双口径计算
path = "src/runtime/treasury/commitments.ts"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()
old = '''  /** 本 tick 已结算 transaction 的位置容量净变化（facade overlay 注入）。 */
  readonly capacityDelta?: (roomName: string, kind: TreasuryLocationKind) => number;'''
new = '''  /**
   * 位置容量净变化（**risk-adjusted** 口径：overlay + quarantine/intent 正流入
   * 占用；receiver admission 用）。facade overlay 注入。
   */
  readonly capacityDelta?: (roomName: string, kind: TreasuryLocationKind) => number;
  /** 严格口径容量净变化（仅本 tick overlay；不含风险占用）。 */
  readonly strictCapacityDelta?: (roomName: string, kind: TreasuryLocationKind) => number;'''
assert old in src, "commitments option"
src = src.replace(old, new)

old2 = '''  const capacityDelta = options.capacityDelta ?? (() => 0);'''
new2 = '''  const capacityDelta = options.capacityDelta ?? (() => 0);
  const strictCapacityDelta = options.strictCapacityDelta ?? (() => 0);'''
assert old2 in src, "commitments resolve"
src = src.replace(old2, new2)

old3 = '''      const projectedStorageFree = storageFreeCapacity - capacityDelta(roomName, "storage");
      const projectedTerminalFree = terminalFreeCapacity - capacityDelta(roomName, "terminal");'''
new3 = '''      const projectedStorageFree = storageFreeCapacity - capacityDelta(roomName, "storage");
      const projectedTerminalFree = terminalFreeCapacity - capacityDelta(roomName, "terminal");
      // 严格口径（不含 quarantine/intent 风险占用）。
      const strictStorageFree = storageFreeCapacity - strictCapacityDelta(roomName, "storage");
      const strictTerminalFree = terminalFreeCapacity - strictCapacityDelta(roomName, "terminal");'''
assert old3 in src, "commitments compute"
src = src.replace(old3, new3)

old4 = '''        projectedStorageHeadroom: projectedStorageFree - healthyIncomingAmount,
        projectedTerminalHeadroom: projectedTerminalFree - healthyIncomingAmount,
        projectedOvercommitted:
          healthyIncomingAmount > projectedStorageFree ||
          healthyIncomingAmount > projectedTerminalFree,'''
new4 = '''        projectedStorageHeadroom: projectedStorageFree - healthyIncomingAmount,
        projectedTerminalHeadroom: projectedTerminalFree - healthyIncomingAmount,
        projectedOvercommitted:
          healthyIncomingAmount > projectedStorageFree ||
          healthyIncomingAmount > projectedTerminalFree,
        strictStorageHeadroom: strictStorageFree - healthyIncomingAmount,
        strictTerminalHeadroom: strictTerminalFree - healthyIncomingAmount,
        strictOvercommitted:
          healthyIncomingAmount > strictStorageFree ||
          healthyIncomingAmount > strictTerminalFree,
        riskAdjustedStorageHeadroom: projectedStorageFree - healthyIncomingAmount,
        riskAdjustedTerminalHeadroom: projectedTerminalFree - healthyIncomingAmount,
        riskAdjustedOvercommitted:
          healthyIncomingAmount > projectedStorageFree ||
          healthyIncomingAmount > projectedTerminalFree,'''
assert old4 in src, "commitments fields"
src = src.replace(old4, new4)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)

# 3) facade.ts：strictCapacityDelta 注入 + 新容量 API + 接口
path = "src/runtime/treasury/facade.ts"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()
old5 = '''          // 容量口径（第七/八轮 risk-adjusted）：projected 变化 + quarantine
          // 与 unresolved intent 的正净流入占用统一扣减——receiver headroom 等
          // 派生口径与 riskAdjustedFreeCapacity 一致（可能已流入的资源必须
          // 减少 free capacity，负流出不增加）。
          capacityDelta: (roomName, kind) =>
            projection.locationCapacityDelta(roomName, kind) +
            (treasuryQuarantineCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0) +
            (treasuryIntentCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0),'''
new5 = '''          // 容量口径（第七/八轮）：capacityDelta = **risk-adjusted**（overlay +
          // quarantine/unresolved intent 正净流入占用——receiver admission 用，
          // 与 riskAdjustedFreeCapacity 同口径）；strictCapacityDelta = 仅
          // overlay 的严格口径（可能已流入的资源必须减少 free capacity，
          // 负流出不增加——只有 risk 口径做该保守扣减）。
          capacityDelta: (roomName, kind) =>
            projection.locationCapacityDelta(roomName, kind) +
            (treasuryQuarantineCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0) +
            (treasuryIntentCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0),
          strictCapacityDelta: (roomName, kind) => projection.locationCapacityDelta(roomName, kind),'''
assert old5 in src, "facade inject"
src = src.replace(old5, new5)

old6 = '''  /** projected 口径容量（observed ± 本 tick 已结算净变化；只读）。 */
  projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;'''
new6 = '''  /**
   * @deprecated 兼容别名：projectedUsedCapacity = strictProjectedUsedCapacity
   *（严格口径）；projectedFreeCapacity = riskAdjustedFreeCapacity（第七轮起
   * 语义即 risk-adjusted——可能已流入的 uncertain 资源占用空间）。新代码
   * 使用下方显式命名的双口径 API。
   */
  projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** @deprecated 见 projectedUsedCapacity。 */
  projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 严格口径 used = observed.used + 本 tick overlay 净变化（不含风险扣减）。 */
  strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 严格口径 free = observed.free − overlay 净变化（used + free = physical）。 */
  strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** risk-adjusted free = 严格 free − quarantine/unresolved intent 正流入占用（admission 口径）。 */
  riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;'''
assert old6 in src, "facade interface"
src = src.replace(old6, new6)

old7 = '''    projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return this.observation().usedCapacity(roomName, kind) + projection.locationCapacityDelta(roomName, kind);
    },'''
new7 = '''    projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // @deprecated 兼容别名（严格口径）——新代码使用 strictProjectedUsedCapacity。
      return this.strictProjectedUsedCapacity(roomName, kind);
    },

    strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.used + 本 tick overlay 净变化（不含风险扣减）。
      return this.observation().usedCapacity(roomName, kind) + projection.locationCapacityDelta(roomName, kind);
    },

    strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.free − overlay 净变化——与 strictProjectedUsed
      // 互补（两者之和 = physical capacity，不含任何风险扣减）。
      return this.observation().freeCapacity(roomName, kind) - projection.locationCapacityDelta(roomName, kind);
    },

    riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // risk-adjusted：严格 free 再扣 quarantine/unresolved intent 正流入
      // 占用（可能已流入的 uncertain 资源占用空间；receiver admission 用）。
      metrics.riskAdjustedCapacityLookups += 1;
      const quarantineOccupancy = treasuryQuarantineCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0;
      const intentOccupancy = treasuryIntentCapacityOccupancy().get(`${roomName}\\u0000${kind}`) ?? 0;
      return (
        this.observation().freeCapacity(roomName, kind) -
        projection.locationCapacityDelta(roomName, kind) -
        quarantineOccupancy -
        intentOccupancy
      );
    },'''
assert old7 in src, "facade impl"
src = src.replace(old7, new7)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("ok")
