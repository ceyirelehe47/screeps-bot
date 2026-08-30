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

- 每 tick 恰好发行一个 shared epoch（beginTick）；重复访问返回同一引用（缓存计数）。
- `beginFreshObservation()` 每次调用独立扫描构建并发行独立 epoch，不污染 shared 缓存——市场 fresh-read 语义（first/second read 隔离）的未来接入点。endTick 后返回 `null`（tick 已关闭，不得再发行 fresh epoch）。**数量上限（第四轮）**：每 tick fresh 发行数有硬上限（8）——fresh 观察是全房间扫描，无上限即无界 CPU 风险；超限拒绝（返回 null）并计数 freshEpochLimitRejections，下一 tick 恢复额度。
- **epochSeq 单点递增（第四轮修复）**：序列号只在 nextEpochSeq 一处递增，每发行一个 epoch 恰好 +1（shared 与 fresh 连续编号、无空洞），与实现注释一致。
- **epoch 注册表**：每 tick 发行的全部 epoch（shared 1 + fresh N）登记进 facade 内注册表（每 tick 清空）。已接受动作登记必须携带决策所依据的 `TreasuryDecisionContext { scope, epochSeq, observedAtTick }` 并通过注册表校验；stale（旧 tick）、unknown（本 tick 未发行的序列号；global reset 后旧 epoch 全部不可恢复）、scope 混用（声明 scope 与注册表不符）一律拒绝。无绕过注册表校验的公开登记入口（convenience 单 posting 入口同样强制）。
- **exact observation 绑定（第三轮）**：注册表条目保存该 epoch 的 exact immutable observation 引用（heap-only，每 tick 清空）。transaction 物理可行性验证（位置存在/数量/容量/结构 incarnation）必须使用 decision 指向的那一次观察，绝不回退 shared。语义分层：decision observation 提供该决策时点的物理基线；Treasury overlay 提供本 tick 已接受但尚未反映到物理事实的 intents（同 tick 多笔防超卖，跨 epoch 共享）；exact fresh observation 不能被 shared observation 替代。
- stale epoch 只能用于审计视图，不得作为可支配资产。

### 3.3 Transaction Journal 与幂等结算（第四轮：两阶段协议 + receipt v3）

```
TreasuryTransactionInput = { transactionId（幂等键，格式受 Treasury 边界约束）; kind; source; decision; postings: Posting[] }
TreasuryPosting = { roomName; locationKind; resource; delta（非零安全整数） }
```

- **两阶段协议（第四轮核心）**：`prepareTransaction(input)` 在调用真实 Game 写动作**之前**完成全部 Treasury 侧验证（幂等 → tick 开闭 → epoch 注册表 → 格式/合并/物理可行性 → admission 预留），成功即占用一个 receipt 容量槽（pending 有界集合，上限 64；其余 admission 的满容判定计入 pending——预留期间容量不被超卖）并返回 prepared handle（heap，tick 内有效）；此后 Game API 失败 → `abortPreparedTransaction`（释放预留，零状态），成功 → `commitPreparedTransaction`（重验物理后原子写入——prepare 之后 overlay 可能被其他 transaction 推进，重验失败拒绝 `prepare_invalidated` 且零写入，比记录与事实不符的投影更安全）。commit 兑现**不再因容量/版本/兼容性被拒**（槽位已预留）。prepared handle 是 tick 内资源：endTick/beginTick 全部作废（observation 是 tick 级物理快照，跨 tick 必须重新 prepare）；重复 prepare 同 id 幂等；重复 commit → already_settled；已 commit 不可 abort（already_finalized）。单阶段 `recordAcceptedTransaction` 保留（语义不变，等价于已确认 Game API 成功后的登记，不占槽）。
- **原子性**：一个动作（terminal.send / market deal / 搬运 / lab / factory）= 一个 transaction + 一或多腿 posting。全部 posting 先整体验证（格式 → receipt admission 预检 → 同 transaction 内同 key 合并 → 物理可行性）再一次性写入（journal + overlay + 容量聚合 + heap 缓存 + Memory receipt）；任一步失败则整笔回滚，零部分写入。
- **输入验证（第四轮补全）**：transactionId 格式（`[A-Za-z0-9:_\-.]{1,128}`）；kind/source 非空有限长；delta 一律**非零安全整数**（NaN/Infinity/0/非整数/非安全整数拒绝）；同 key 多腿合并结果溢出安全整数即拒绝（invalid_posting_delta）；**净零腿剔除、全部抵消的 no-op transaction 整笔拒绝**（no_op_transaction——无物理效果的登记不得占用幂等/容量语义）；交易后资源量非负且为安全整数（insufficient_amount）；交易后容量不越界且结果为安全整数（capacity_overflow，含同 tick 多笔累计口径）；resource ∈ RESOURCES_ALL；房间已知、位置存在（以 decision observation 为基线）。
- **transactionId 铸造双轨 + 成分防碰撞（第四轮）**：`formatTreasuryStableTransactionId(kind, ...自然键)`（无 tick 前缀）——跨 tick 重试的同一业务动作铸造恒相同 id；`formatTreasuryTransactionId`（`${Game.time}:...` 前缀）仅适用于每 tick 天然唯一、无跨 tick 重试语义的新动作。**两个 helper 的 kind 与每个 discriminator 一律校验为不含冒号的受限 token**（`[A-Za-z0-9_\-.]{1,64}`；数字成分须为非负安全整数；至少一个 discriminator）——`("a:b","c")` 与 `("a","b:c")` 这类 tuple 边界碰撞、空串/NaN/非法字符成分一律抛错（fail fast），绝不静默铸造歧义 id。
- **幂等（三段）**：① 幂等检查优先于一切验证（重放无论 payload 一律 already_settled）；② heap 本 tick 缓存；③ `Memory.runtime.treasury.receipts`（跨 tick 与 global reset 权威）。receipt 只存 transactionId → 结算 tick。
- **receipt 安全契约（第四轮重做为 version 3）**：
  - store 格式 version 3：settled key 一律 `"t:"+transactionId` 前缀编码（防 `__proto__`/`constructor` 等合法字面量的原型污染语义）+ `entryCount` 计数字段（admission 快路径 O(1) 权威，加载时校验）+ `nextExpiryTick` 过期调度元数据（空表 null；非空 = min(settledAt)+retention+1，与过期条件 settledAt < now−retention 严格一致）。
  - 驱逐契约：只自动回收**经过完整验证且超过 retention 窗口（5000 tick）**的正常条目；retention 窗口内的 receipt **绝不因容量压力驱逐**——宁可拒绝新 transaction。
  - **损坏 value fail closed（第四轮）**：settled tick 必须是 `[0, Game.time]` 内的安全整数；NaN/±Infinity/非整数/非安全整数/负数/未来 tick 一律视为损坏——迁移不跳过、cleanup 不删除、admission 整体阻断（receipt_store_incompatible，独立指标 receiptStoreIncompatibleFailures），只有显式管理/修复路径可解除；**已能可靠识别的旧 transaction（own key 存在且 value 有效）查询仍返回 already_settled**——store 损坏不得让幂等保证期内的 id 被遗忘；无法可靠判断（value 损坏的 id）整体阻断不乐观放行。
  - **迁移契约（第四轮）**：v1（裸键）→ v3——**raw key 原样作为 transactionId 输入安全编码，绝不 decode**（v1 中 `abc` 与 `t:abc` 是两个不同且都合法的 transactionId，decode 再 encode 会碰撞）；v2（前缀键+entryCount）→ v3 补 nextExpiryTick。迁移在临时结构完成全部校验（transactionId 格式 / settled tick 完整有效性 / 编码碰撞防御），自检（own key 数/entryCount/存储键格式/每个 settled tick/元数据一致性）通过后**一次性原子替换**原 store；发现碰撞、非法 key 或非法 value 时原 store 保持不变并 fail closed；只执行一次（版本提升后不再进入）。
  - **过期调度与扫描成本（第四轮）**：Game.time 未到 nextExpiryTick 时 beginTick 清理零扫描、满容 admission 直接 O(1) 拒绝（不反复全表扫描）；到达过期点执行一次清理并重算 nextExpiryTick；插入/迁移/清理后元数据始终一致；global reset 后 load 时对元数据做一次完整验证（损坏即 fail closed，不放宽容量）。确定性操作计数（可运行测试断言）：receiptFullScans / receiptAdmissionFastPaths / receiptAdmissionFullStoreBlocked / receiptExpiryCleanupScans / receiptStoreIncompatibleFailures / receiptStoreMigrationsExecuted / receiptSlotsRemaining / receiptNextExpiryTick。
  - admission 预检（写入任何状态之前）：已结算 id → already_settled（store 满不改变幂等结果）；未过期条目 + pending 预留达硬容量 4096 且未到过期点 → O(1) 拒绝 `receipt_capacity_exhausted`（零部分写入、零扫描）；到达过期点 → 一次有界回收后重判。
- **projected capacity**：overlay 与容量投影同步推进（按位置维护 capacityDeltas 聚合 map——commit 原子更新、endTick/reset 清空、projectedUsed/Free 与 receiver headroom 查询 O(1)，不扫描资源 overlay）；单调 projectionRevision 随每次提交递增（派生缓存失效与诊断）。验证层保证 projectedFree ∈ [0, physical]，读 API 与 observed 口径分离。
- **reconciler（两层，第三轮）**：endTick 归档投影终态（资源 finals + 房间/位置 manifest——owned 房间集合、每位置 exists/structureId/容量事实），下一 tick beginTick 两层对账：① manifest 结构层（每位置至多一条事件：空房间 new_room/room_lost、空 storage/terminal new_location/location_lost、structureId 替换 structure_replaced——零资源结构在稀疏 amounts 中不可见，只有 manifest 层能发现，且按位置计一次不随资源数重复）；② resource key union 层（数量差异按资源维度独立计数：inflow/outflow/new_resource，结构事件不在此层重复）。tick gap 与 global reset 显式标记；mismatch 样本携带相关 transaction id/kind 追溯（上一 tick journal 有界 heap 副本，cap 512）。

### 3.4 承诺索引（每 tick 重建，读侧零写；第二迭代：点时快照 + revision 失效；第三轮：receiver projected 实时化）

- **点时快照**：构建期一次性聚合为 primitive 值（不保留 task/reservation 对象引用；外部原地修改原对象不影响已构建索引）；receiver healthy incoming 构建期按房间预聚合（receiverCommitments 不回扫 live task store）；route merge 预构建 Map 索引（查询零线性扫描；同 route 重复 key 保留**第一个匹配**——与旧 findMergeablePendingTask 语义一致，不取最后写入）。
- **revision invalidation**：transfer tasks / production reservations 的全部 mutation 入口（创建/合并/取消/阻塞/解阻/进度/回收/清理/续租/释放/GC，resourceControl 任务字段直接写入的统一同步点 syncResourceControlTransferTask，以及 legacy schema 迁移 migrateResourceTransferTasksToV2——迁移改写任务权威数据同样通知失效）调用 `bumpTreasuryCommitmentRevision()`（模块级计数，global reset 后与缓存同步归零，无需 global 槽）；facade 每次访问比对 revision，变化即重建。`treasuryCommitmentInvalidationBoundaries` 架构测试守护全部 mutation 入口，防止新写入口绕过。
- transfer tasks：复用 canonical 谓词，提供 outgoing/pendingOutgoing/incoming/pendingIncoming/incomingTaskCount/route merge lookup。
- production reservations：活跃（未过期且未孤儿）条目聚合 + holder 存在性检查（孤儿计数，不删除）。**holder 解析默认走 typed 统一入口（第四轮）**：`nuker:<objectId>[:<resource>]` 逻辑名解析内嵌 objectId、`synthesis:<roomName>[:<resource>]` 逻辑名解析 owned 房间归属、其余整串按 Game object id 解析——logical holder 不再被统一按 Game object id 解释而误判 orphan（committed 低估 → 可用量高估 → 超卖风险）。
- receiver headroom（第一版口径）：`storageFree(observation) − healthy incoming task remaining`、`terminalFree − …`，observed 与 projected 双轨。**第三轮实时化**：projected 字段每次查询动态组合（静态承诺 + observed 容量 O(1) 读 + 当前 overlay 容量聚合 O(1) 注入）——绝不把依赖当前 overlay 的 projected 数值缓存进旧结果；同 tick 结算新 transaction 后的下一次查询立即反映最新投影（commitment revision 未变时不重建索引，只刷新 projected 组合）。**不含** safety reserve 与内存 ledger 的独立 reservation——完整语义在后续阶段由 `ReceiverCapacityLedger` 实例并入 Treasury 时提供，OpenSpec 任务表中登记。
- owner-aware（**第四轮 typed 化**）：查询可声明 `TreasuryQueryOwner { holderId, holderKind: "game-object" | "logical", roomName, scope: "production-reservation" }`——holder 必须真实存在（typed 统一解析：logical 命名空间或 game-object）、**声明 holderKind 必须与运行时解析类型一致**（防"知道 holderId 字符串就能冒充其他类型 owner"）、声明房间与真实归属一致，三者任一不满足即 fail closed（spendable=0、overcommitted=true，不返回乐观可用量）；验证通过后只在该归属房间排除自己的 production reservation（多房间查询时其他房间照常全额扣除）、其他 owner 一律照常扣除。完整 capability token / Contract Service 留待后续阶段。transfer task child reservation / receiver capacity owned reservation 的完整接入留待后续阶段，本轮接口语义固定。

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
  withhold?（调用方声明的策略保留量，如 market 保护/战略储备）;
  owner?（TreasuryQueryOwner；typed 解析 + 房间归属一致才生效，否则 fail closed）
}
→ TreasuryBalanceView = { observed, projected, committed, incoming, spendable, overcommitted, ownerStatus, contextStatus, epoch }
```

- **输入 fail-closed 规范化（第四轮补全）**：非法资源（∉ RESOURCES_ALL）、非法/重复/**非管辖（unknown 或 unowned）**房间、**空 rooms / 空 locations scope**（退化输入，不给"合法零集"错觉）、非法/重复位置（重复会双倍累计，绝不静默去重）、**非布尔开关字段**（allowProjected/allowIncoming/subtractOutgoing/subtractReservations 为 0/"true" 等真值时拒绝，不得静默当 true）、非有限非负 withhold（NaN/Infinity/负数）→ 返回保守全零视图（contextStatus=invalid_fail_closed、spendable=0、overcommitted=true；epoch 如实返回）并计数 queryInvalidContexts；合法输入 contextStatus=valid。管辖集合以注入房间源（getRooms）为权威。
- 视图映射：physical=observed（限定 rooms/locations）；accessible=限定 locations 的 observed；projected；committed；spendable=max(0, base−committed−withhold) 且当原始差值为负时 `overcommitted=true`（不静默钳制）；expected incoming/outgoing=承诺索引对应桶；transferable=locations=[terminal] 的 spendable。`production-feasible`/`sellable` 属于策略组合（配方知识、市场保护账本），由调用方以 withhold 参数表达，后续阶段再固化为专用视图。

## 4. Tick 生命周期（第二迭代：显式 begin/end）

1. **beginTick（显式，main.ts 固定挂载于一切市场预检/生产/物流/规划之前）**：幂等（同 tick 重复调用安全）；receipt 清理（只回收 retention 过期条目——未过期条目绝不因容量驱逐）→ global reset 检测 → 归档补救（若上一 tick 缺 endTick 则显式计数并补救）→ 清空 epoch 注册表并发行本 tick shared epoch（注册 exact observation 引用）→ 对账上一 tick 投影终态（manifest 结构层 + 资源 key union 层）→ 写 `Memory.runtime.treasury.lifecycle.lastBeginTick`。
2. **规划阶段**：消费者经 facade 查询带上下文余额、读承诺索引（revision 变化自动重建；receiver projected 字段随 overlay 实时组合）；分配决策仍属各模块（后续阶段迁入 Allocation Planner）。
3. **执行阶段（第四轮起两阶段优先）**：执行器先 `prepareTransaction()`（全部 Treasury 侧验证 + receipt 槽位预留）→ 调用 Game API → 失败 `abortPreparedTransaction()`（零状态）；成功 `commitPreparedTransaction()`（重验物理后原子写入，兑现不因容量/兼容性被拒）。单阶段 `recordAcceptedTransaction()` 保留（携带决策 epoch，物理验证用该 epoch 的 exact observation）供已确认成功的语义使用；失败不写 journal。
4. **endTick（显式，main.ts 固定挂载于 treasuryShadow 之后、最终 profiler flush 之前）**：幂等；归档投影终态（资源 finals + 结构 manifest）→ journal 转存有界追溯副本 → **作废全部未决 prepared handle（释放预留）** → 关闭本 tick（此后登记与 prepare 一律拒绝 `tick_closed`、fresh 发行一律拒绝返回 null）→ 写 `lastEndTick`。
5. **懒兜底**：`observation()`/`commitments()`/`query()` 在未 begin 时仍可安全访问（自动懒初始化并计数 lifecycleLazyInitializations），但懒路径零写 Memory（不清理 receipt、不写 lifecycle）——main 挂载后业务模块不应再触发。
6. 对账区分：正常相邻 tick（tickGap=false）/ tick gap（previousTick+1 ≠ currentTick，差异为 gap 累积值）/ global reset 恢复（heap 丢失但 Memory lifecycle 存在，afterGlobalReset=true、previousTick=null）/ 冷启动（无 Memory 记录）。market-fresh observation 不替代 shared 生命周期，只登记进同 tick 注册表供决策绑定。

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
