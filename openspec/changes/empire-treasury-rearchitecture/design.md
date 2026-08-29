# 帝国国库设计（Empire Treasury Design）

## 1. 权威数据边界

| 数据类别 | 唯一权威 | Treasury 的角色 |
|---|---|---|
| 物理库存事实 | 当前 tick 的 Game 世界（`Game.rooms` / store） | 每 tick 构建一次不可变稀疏 observation；**绝不持久化为 Memory 第二副本** |
| 跨 tick 任务记录 | `Memory.data.resourceControl.tasks`（transfer task） | 只读索引，不复制、不修改 |
| 跨 tick 生产预留 | `Memory.runtime.resourceReservations` | 只读索引，过期/孤儿在读侧排除并计数，删除权留在 owner/memoryCleanup |
| 接收容量承诺 | transfer task 的 receiver commitment 语义（本轮）；`ReceiverCapacityLedger` 内存实例（后续阶段并入） | 聚合视图 + 轻量 headroom |
| 同 tick 已接受动作 | Treasury Transaction Journal（服务实例内，global heap 级） | 唯一登记点；每个 delta 可追溯到 actionId |
| 市场安全事实 | 既有 market fresh-read/WAL/permit 体系 | 本轮零接触；`market-fresh` scope 预留独立 epoch |

职责边界（不因 Treasury 出现而模糊）：

- **Treasury**：资产、承诺、预算、授权、合同、对账。
- **Logistics**：实际搬运与 terminal 调拨执行（执行成功后向 Treasury 报告 accepted action）。
- **Production**：lab/factory 生产执行。
- **Market**：价格发现、订单选择、交易执行（fresh epoch 独立，不复用共享 snapshot）。
- **Room Agent**：房间本地执行与应急行为。

物流/市场/生产模块不得自行认定"某批资源可用"，必须经 Treasury 查询或申请授权。

## 2. 模块结构

```
src/runtime/treasury/
  types.ts          核心类型（LocationKind/Epoch/JournalEntry/QueryContext/BalanceView/Metrics）
  observation.ts    Asset Observation：不可变稀疏物理事实 + 多方向索引 + fresh scope
  projection.ts     Transaction Journal + Projected Overlay + 幂等结算 + Reconciler
  commitments.ts    承诺统一索引（transfer tasks / production reservations / receiver headroom / route merge）
  facade.ts         TreasuryService（Gateway）；挂在 RuntimeServices 上
  shadow.ts         Treasury Shadow：新旧对比（零行为写入）
```

不建 God Object：每个文件单一职责，facade 只做组合与授权检查。规划算法保持可替换边界（第一版为确定性聚合视图，不做 min-cost flow）。

## 3. 语义定义

### 3.1 三层余额

- **Observed**：observation 构建时点的真实物理资产。同 tick 同 epoch 不可变（冻结数据；对外只暴露查询方法与冻结快照）。
- **Projected** = Observed + Σ(本 tick 已接受动作 delta)。投影只叠加，永不改写 observed 数值。
- **Committed**：尚未执行但已被任务/预留/合同占用的量（来自承诺索引，非持久副本）。

计划、reservation、pending task 不修改 Observed。只有调用方在 Game API 返回 OK 后显式调用 `recordAcceptedAction()` 才产生投影 delta。

### 3.2 Observation epoch

```
TreasuryEpoch = { scope: "shared" | "market-fresh"; epochSeq: 单调递增; observedAtTick: Game.time }
```

- 同 tick 内 shared observation 至多构建一次，重复访问返回同一引用（缓存计数）。
- `beginFreshObservation("market-fresh")` 每次调用独立扫描构建，不污染 shared 缓存——市场 fresh-read 语义（first/second read 隔离）的未来接入点。
- 任何即时授权路径必须校验 `epoch.observedAtTick === Game.time`；stale epoch 只能用于审计视图，不得作为可支配资产。

### 3.3 Journal 与幂等结算

```
TreasuryJournalEntry = { actionId（幂等键，调用方构造）; kind; roomName; locationKind; resource; delta; recordedAtTick; epochSeq; source }
```

- `recordAcceptedAction(entry)`：
  - epoch 过期（tick 不匹配）→ 拒绝（`stale_epoch`）；
  - actionId 已结算（保留最近若干 tick 的 FIFO 集合）→ 拒绝（`already_settled`），不重复叠加；
  - 通过 → journal 追加 + overlay 累加。
- overlay 键为 `room:locationKind:resource`，查询 `projectedAmount = observed + overlay`。
- reconciler 在下一 tick 构建时计算 `actual - (prevObserved + prevOverlay)`，非零差异计数并留存有限样本（环形缓冲），按流入/流出分类——差异是审计信号（物理世界同 tick 会有 creep 存取等合法变化），不是失败；但**不得静默丢弃**。

### 3.4 承诺索引（每 tick 重建，读侧零写）

- transfer tasks：复用 `createResourceTransferTaskAmountIndex()` 与 `isHealthyReceiverCapacityCommitment`/`countsResourceTransferTaskTowardDemand` canonical 谓词，提供 outgoing/pendingOutgoing/incoming/pendingIncoming/incomingTaskCount/route merge lookup。
- production reservations：活跃（未过期）条目聚合 + holder 存在性检查（孤儿计数，不删除）。
- receiver headroom（第一版口径）：`storageFree(observation) − healthy incoming task remaining`、`terminalFree − …`。**不含** safety reserve 与内存 ledger 的独立 reservation——完整语义在后续阶段由 `ReceiverCapacityLedger` 实例并入 Treasury 时提供，OpenSpec 任务表中登记。
- owner-aware：子分配语义目前由 ReceiverCapacityLedger 持有；Treasury 承诺索引保证"同一 taskId 在同视角桶内只计一次"（Record 键唯一）并在 shadow 中检查重复计数。

### 3.5 Budget / Reservation / Contract 分离

- **Budget**：某系统最多允许使用多少（上限，不占用资产）。
- **Reservation**：owner 已占用某批资产/容量（跨 tick，权威在既有持久存储）。
- **Contract**：具备执行含义的行为；执行成功（Game API OK）→ journal + projected delta。

本轮 Treasury 只落 Reservation 聚合与 Contract 的 journal 语义；Budget Service 与 Contract Service 是后续阶段（见任务表），facade 预留 `authorize` 边界。

### 3.6 带上下文的查询（禁止无上下文 available）

```
TreasuryQueryContext = {
  resource; rooms?; locations?（默认 storage+terminal）;
  allowProjected?（默认 true）; allowIncoming?（默认 false）;
  subtractOutgoing?（默认 true）; subtractReservations?（默认 true）;
  withhold?（调用方声明的策略保留量，如 market 保护/战略储备）
}
→ TreasuryBalanceView = { observed, projected, committed, incoming, spendable, overcommitted, epoch }
```

视图映射：physical=observed（限定 rooms/locations）；accessible=限定 locations 的 observed；projected；committed；spendable=max(0, base−committed−withhold) 且当原始差值为负时 `overcommitted=true`（不静默钳制）；expected incoming/outgoing=承诺索引对应桶；transferable=locations=[terminal] 的 spendable。`production-feasible`/`sellable` 属于策略组合（配方知识、市场保护账本），由调用方以 withhold 参数表达，后续阶段再固化为专用视图。

## 4. Tick 生命周期

1. **tick 开始（懒触发，首次访问 observation）**：新 epoch → reconcile 上一 tick journal/overlay → 重建稀疏 observation → 承诺索引按需构建。
2. **规划阶段**：消费者经 facade 查询带上下文余额、读承诺索引；分配决策仍属各模块（后续阶段迁入 Allocation Planner）。
3. **执行阶段**：执行器调用 Game API；成功后 `recordAcceptedAction()`；失败不写 journal。
4. **tick 结束**：`runTreasuryShadowCheck()`（低频采样）输出审计指标并低频快照 `Memory.runtime.treasuryPerf`；只持久化指标，不持久化物理事实。

## 5. Contract 生命周期（目标态，本轮部分落地）

`draft → authorized（预算+承诺检查通过）→ accepted（Game API OK，journal 结算，唯一）→ settled（下一 tick reconcile）→ archived`。

本轮落地 accepted/settled（journal + reconciler）；authorized 由后续 Contract Service 提供。同一幂等键（actionId）不得创建两个有效结算；过期/孤儿 reservation 由读侧排除 + 计数，删除权保留在 owner。

## 6. 不变量 → 落实位置

| # | 不变量 | 落实 |
|---|---|---|
| 1 | 同 tick 同 epoch Observed 不可变 | 冻结数据 + 同 tick 缓存引用 + 测试 |
| 2 | Projected 增量可追溯到已接受动作 | journal entry 强制 actionId/source + 测试 |
| 3 | 同一资产承诺唯一 owner | 权威存储唯一（tasks/reservations）+ 索引不复制 + shadow 检查 |
| 4 | child reservation 不重复消耗 parent | ReceiverCapacityLedger owner 语义保留；Treasury 索引不重复计入（后续并入时扩展检查） |
| 5 | spendable 非负 | max(0,…) + overcommitted 显式置位 + 测试 |
| 6 | receiver lease 不超可信容量 | headroom = free − healthy commitments，负值报 overcommit 信号 + 测试 |
| 7 | 相同幂等键不得两个有效合同 | settledActionIds FIFO 集合 + 测试 |
| 8 | 已接受动作只结算一次 | 同上（跨 tick 保留集合） |
| 9 | stale observation 不可即时支配 | epoch tick 校验 + fresh scope 独立 + 测试 |
| 10 | 过期 reservation 自动回收 | 读侧 isActive 排除 + expiredExcluded 计数（删除归 memoryCleanup） |
| 11 | 结构摧毁/资产丢失可对账 | reconciler 差异计数 + 样本；missing location 显式记录 |
| 12 | 查询无隐藏写入 | 查询路径只读；测试断言 Memory/任务表引用不变 |
| 13 | Shadow 零 Game 写 | shadow 不调用任何 intent API；测试断言 |
| 14 | 对账差异不静默吞掉 | 计数 + 环形缓冲样本 + 低频 Memory 快照 |
| 15 | emergency override 显式可审计 | 后续阶段（facade authorize 边界预留），本轮未实现 override 即无隐藏通道 |
| 16 | 业务模块不得绕过 Gateway 建第二套承诺 | 迁移地图 + 后续删除旧承诺路径；本轮先建立唯一入口 |
| 17 | 物理总量 = Σ位置桶 | 构建期求和 + shadow/test 验证 |
| 18 | 共享 snapshot 与 fresh epoch 隔离 | scope 字段 + fresh 不污染缓存 + 测试 |

## 7. 迁移地图（读者清单，承接 docs/inventory-reader-survey.md）

| 顺序 | 消费者 | 现状 | 目标 | 阶段 |
|---|---|---|---|---|
| 0 | productionMonitor storage/terminal energy | 直读 store | Treasury observation（本轮完成） | E |
| 1 | hubProgress collectHubProgressSnapshot | 整 store 枚举 + carrier 聚合 | Treasury + 后续 field 层 | 下阶段 |
| 2 | console hubProgress 面板 | 同上 | 随 1 | 下阶段 |
| 3 | resourceControl 快照热路径（getStoredResources/collectResourceControlSnapshots） | RESOURCES_ALL 全枚举、多处重复采集 | Treasury observation + 承诺索引 | 下阶段（shadow 门槛后） |
| 4 | hubPlanner 库存读取（12 处 task index 重建） | 自建聚合 | Treasury 承诺索引 + observation | 后续 |
| 5 | synthesisControl/factoryControl 库存基础 | 直扫 storage/terminal/lab/factory | Treasury production 扩展层 | 后续 |
| 6 | nukerControl/synthesisCompatibilityPlanning 独立采集 | 每 tick 重复 collect | Treasury 查询 | 后续 |
| 7 | market protection/projection 输入 | 自建 protection ledger | market-fresh epoch 接入（需独立安全评审） | 最后 |
| 8 | telemetry/externalTelemetry 自拼库存 | 自拼 | Treasury 视图 | 后续 |

写入者（承诺创建）迁移：transfer task 创建/回收保留在 logistics（权威不变）；production reservation 保留 owner 模块；后续 Contract Service 统一 authorized 语义。

## 8. 旧模块删除清单（全部按 shadow 门槛分批执行，非本轮）

1. `resourceControl.ts` 中 `getStoredResources`（RESOURCES_ALL 探测）与 snapshot 重复采集点（nukerControl.ts:579、synthesisCompatibilityPlanning.ts:310）——迁 Treasury 后删除。
2. `ResourceControlSnapshot` 混合结构（拆分后：物理→Treasury、策略底线→Policy 层、投影→Treasury overlay、Game 引用→删除）。
3. hubProgress/hubPlanner/synthesisControl/factoryControl 的自建库存聚合函数（roomResourceAmount/getRoomStock/buildCompactInventory 直读部分）。
4. `empireInventoryIndex.ts`/`empireInventoryShadow.ts`——Treasury 全层覆盖并 shadow 通过后整体退役（Treasury 吸收其 field/production 层）。
5. `createResourceTransferTaskAmountIndex` 的 12 处 hubPlanner 重复构建点。
6. 兼容层 `treasuryCompat`（若存在）——见下节删除条件。

## 9. 临时 adapter 删除条件

- `productionMonitor` 迁移后旧直读路径即删（本轮直接替换，不留 adapter）。
- 若后续为 hubProgress 建 Treasury 兼容 adapter：删除条件 = shadow 对比连续 1000+ tick 零 mismatch 且该消费者行为输出与旧路径逐字段一致；删除时同步删除其 shadow 对比项。
- `Memory.runtime.treasuryPerf` 未类型化断言：在 Treasury 进入生产消费者（阶段 3）前类型化并走 memoryDeclarationBoundaries 冻结流程。

## 10. 性能指标（确定性操作计数优先）

`Memory.runtime.treasuryPerf`（低频快照）：rebuildCount/reuseHits/locationsScanned/nonZeroEntries/storeEnumerations/roomFindCalls（必须为 0）/fallbackLiveReads（必须为 0）/commitmentRecords/commitmentIndexQueries/expiredCommitmentsExcluded/orphanReservations/journalEntries/duplicateSettlementRejected/reconciliationMismatches（流入/流出分桶）/shadowChecks/shadowMismatches。

验证方式：fixture 确定性操作次数断言（沿用 empireInventoryBenchmark 模式）+ 新旧扫描路径调用数对比，不依赖 wall-clock。
