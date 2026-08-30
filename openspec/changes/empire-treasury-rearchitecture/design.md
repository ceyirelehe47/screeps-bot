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

### 3.7 Write-Admission Correctness（第五轮：tentative ledger / opaque handle / staged commit / typed owner / completeness）

- **tentative ledger**：committed overlay 之外新增独立的 tentative 预留层。prepare 成功即预留每个 (room,location,resource) 的净资源 delta、每个位置的净容量 delta 与一个 receipt admission 槽；后续 prepare 与单阶段兼容登记的授权计算计入全部 tentative（同一 handle 重复校验排除自身预留）。public projected 只含 committed——tentative 绝不冒充已发生资产变化，仅经 gauge（tentativeResourceKeys/CapacityKeys）只读可见。
- **opaque prepared handle**：commit/abort 接收冻结 capability 对象，经服务实例私有 WeakSet 按对象身份验证——结构相同的伪造对象、JSON round-trip 副本、跨 service generation handle 一律 invalid_handle；handle 自带 tick 自校验（commit/abort 不依赖调用方先 beginTick）。状态机 prepared →（executing）→ committing → committed / aborted / faulted / expired：commit 只能成功一次（重复幂等 already_settled）、abort 只能一次（重复 already_finalized）、terminal 状态不可回退。
- **canonical payload 与 prepare_conflict**：prepare 深复制输入并规范排序冻结 postings（调用方此后修改原 input 不影响 Treasury 内部 canonical transaction）；payload digest（稳定 hash）覆盖 identity/kind/source/decision epoch/全部 canonical postings。相同 transactionId 重复 prepare：digest 相同幂等返回同一 handle，不同返回 prepare_conflict——同一 id 只能绑定一个 canonical payload。
- **commit = tentative → committed**：commit 不再重做业务 admission——prepare 时已验证并预留的资源/容量/槽位在 tentative 语义下不可被他笔侵吞，Game API 已返回 OK 后不再因资源、容量或 receipt 条件拒绝（prepare_invalidated 正常路径删除；他笔 transaction 只会在其自身 admission 被拒）。
- **staged commit 与 write fault**：可预期失败全部前置到 prepare；commit 拆 receipt 发布（Memory 权威先行，返回 written/already_settled/fatal）→ heap 发布（journal/overlay 分段故障钩子）→ handle 状态更新三段。任一阶段意外失败进入 faulted 终态：不当作普通 rejected/aborted，tentative 与槽位不释放，写入最小有界持久 marker（Memory.runtime.treasury.writeFault：transactionId/digest/tick/kind/source/phase/status），全部后续 writer（prepare/commit/abort/单阶段兼容）fail closed（write_admission_locked），global reset 后新实例凭 marker 仍可发现 unresolved fault；只有显式管理路径 clearTreasuryWriteFaultForRepair 解除，绝不自动清空。
- **outstanding prepared 审计**：endTick（与 beginTick 补救）绝不静默清空未决 handle——计数 outstanding、保留有界样本（transactionId/digest/preparedAtTick/kind/source，上限 8）并累加 leak 指标；executing 状态（Game API 结果未知）视为严重异常，写 marker 并全局锁；普通 prepared 在 tick 边界失效释放但留审计事件；下一 tick 旧 handle 一律不可用。
- **安全执行包装器 executePreparedAction**：prepare → 调用 Game API 恰好一次 → {ok:true} commit / {ok:false} 自动 abort / 抛错自动 abort 后 rethrow。prepare 失败时 callback 不执行；正常完整执行后 outstanding 恒为 0。生产 writer 的唯一推荐入口；低层 commit/abort 保留给测试与特殊集成。
- **typed reservation owner**：reservation 权威 entry 持久 typed identity（kind: game-object/logical-service/task/contract/legacy-unresolved + id/roomName/namespace/lifecycleRef），平铺字段与 store key 不变（marketSaleProtectionAdapter 完全兼容）。保守占用不变量：无法确证 owner 已失效的预留（active-unresolved/missing-owner）一律全额计入 committed，只有 expiresAt 或显式 release 解除；orphan 降级为诊断分类 ownerStatus。版本化迁移补写 owner（幂等标记/数值不动/bump revision/损坏保留计入 damaged）；typed mutation（*ForOwner）为唯一新写入口，旧字符串入口为 deprecated adapter；owner-aware 自排除用完整 typed identity 比较（同字符串不同 kind/namespace 不互相排除；legacy-unresolved 不允许普通声明排除）。
- **commitment completeness**：task/reservation 记录级验证（数值形状与 remaining≤amount 等字段关系）；损坏记录不进聚合、不删原数据——能定位 bucket 的标记 (room,resource) scope incomplete，连 scope 都无法定位的标记 globally-incomplete。balance view 暴露 commitmentStatus 与 authorizationSafe：incomplete scope 的 spendable=0、overcommitted=true、authorizationSafe=false；unrelated scope 保持 complete；owner 缺失但数值合法的预留继续全额扣除（missing ≠ incomplete）。receiver headroom 携带 commitmentComplete。
- **canonical hashed transaction identity**：铸造 v2——canonical tuple 序列化（类型标签 + 长度前缀：number 42 与 string "42"、元组边界、字段顺序、attempt sequence 全部可区分；Unicode/空格/冒号/空串为合法业务字段）+ 双 lane FNV-1a 64 位稳定 hash 定长输出；stable（ts1_）与 per-tick（tt1_&lt;tick&gt;_）分命名空间不可碰撞；validator 不变（存量 receipt 键完全兼容）；固定 test vectors 锚定实现。
- **单阶段入口退役**：recordAcceptedTransaction/recordAcceptedAction 移出 TreasuryService 公共 writer API；实现保留经 treasury/compat 兼容模块访问（仅供既有测试与迁移过渡，路径含 tentative 感知授权与 write admission 锁，不得抢占 prepared 预留）。架构边界测试守护：生产 writer 模块不得引用单阶段/compat；故障注入器与 write-fault 修复入口仅测试/显式管理可引用；reservation store 直接写入仅限 resourceReservation.ts。
- **本轮仍未接入真实 writer**：ResourceControl/terminal/lab/factory/market 写路径零生产改动；迁移须待独立评审后经 executePreparedAction 执行。

### 3.8 Fault Recovery & Authority Integrity（第六轮）

- **typed owner 持久身份（key 编码完整 identity）**：reservation store key 由 `${room}:${resource}:${owner.id}` 升级为 `${room}:${resource}:${ownerToken}`，ownerToken = kind 前缀 +（logical-service 的 namespace 段）+ id——`go:`/`ls:<ns>:`/`tk:`/`ct:`/`lu:`。kind 前缀保证不同 kind 永不碰撞；namespace 参与 logical-service 身份；相同 room+resource+id 不同 kind/namespace 的 owner 可同时存在、独立 release。ownerToken 构造的唯一权威在 ownerIdentity.ts（treasuryReservationOwnerToken），store key 拼接的唯一权威在 resourceReservation.ts（makeReservationStoreKey）——外部模块不得自行拼接持久 key（架构测试守护 store 直写仅限该文件）。entry 平铺字段（roomName/resource/holderId/amount/updatedAt/expiresAt）与 owner 字段不变。
- **key 迁移 v3（原子、幂等、fail closed）**：migrateResourceReservationsForTypedOwner 升级为版本 3——先在临时结构完成全部验证（entry 形状完整、legacy key 与 entry 平铺字段严格一致、owner 字段合法或可由 holderId 无损分类、新 key 无碰撞），全部通过后一次性引用切换替换 store、写 resourceReservationsOwnerVersion=3 并 bump commitment revision；任何 malformed/collision 返回 failed：原数据不动、版本不推进、授权侧经 authorizationSafe 的 migration 条件 fail closed。版本已是 3 幂等短路。失败可重复执行（修复后重试）。
- **durable quarantine（executing/faulted 跨 tick）**：Memory.runtime.treasury.quarantine（entry key = q:+transactionId 防危险字面量；字段 digest/tick/kind/source/phase/resourceDeltas/capacityDeltas/recordedAt；上限 64 条，溢出置 overflowed 持久标志）。写入点：endTick（与 beginTick 补救）审计发现 executing（Game 结果未知）或 faulted（commit 写故障）的 handle——前者同时写 write-fault marker（既有语义），后者 marker 已在故障时写入；二者一律先落 durable quarantine 再释放 heap tentative（heap 清空无害，占用由持久 quarantine 接替）。普通 prepared（确定未调用 Game API）仍按第五轮语义 expire+释放。quarantine 语义：跨 global reset 与 service 重建存活；不进 committed projection；授权计算计入（query 的 committed 追加 quarantine 负 delta 占用、projectedFreeCapacity 扣减 quarantine 负容量）；quarantine 未解决前同 id prepare 一律拒绝（transaction_quarantined）；全局 write-admission lock 继续使用但 quarantine 不依赖 lock 存活（管理路径错误不丢失占用事实）。
- **safe execute 结果语义（不可混淆状态集）**：prepare_rejected（callback 零调用，含 transaction_quarantined）；executed_committed；executed_aborted（Game 非 OK 且 abort 已确认）；executed_abort_failed（Game 非 OK 但 abort 未确认——不得报告已正常 abort）；executed_unsettled（Game callback 已成功但 Treasury commit 失败/锁定——携带原始 actionResult、transactionId/digest/faultPhase、retryForbidden: true；绝不返回 prepare_rejected/aborted 等暗示未执行的状态；同 id 下一次调用在 callback 前被拒、callback 计数保持）；already_settled。callback 抛错：abort 确认后 rethrow（零结算释放）；abort 未确认 → faulted + durable quarantine（phase abort_failed）后 rethrow（Treasury 侧保守，异常原样透传）。
- **显式 fault resolution（替代无条件 clear）**：clearTreasuryWriteFaultForRepair 移除。新模块 treasury/faultResolution.ts 提供 resolveTreasuryQuarantinedTransactionAsCommitted（补全/确认 receipt——幂等 written/already_settled 均可、清除对应 quarantine 与匹配的 write-fault marker、防重放由 receipt 保证、global reset 后可完成、重复调用幂等 already_resolved）与 resolveTreasuryQuarantinedTransactionAsNotExecuted（仅允许 Game 结果未确认的 phase：executing_at_end_tick/abort_failed；释放 quarantine、不写 receipt、不生成 committed projection、显式返回允许重新 prepare；Game 确认 OK 后的 commit 故障 phase 一律拒绝）。参数校验：未知 transactionId、digest 不匹配、不允许的 resolution → rejected 且 fault/quarantine 不动。resolution 完成前 write admission 持续锁定；生产 tick 不得自动调用（架构测试守护 faultResolution 仅测试可引用）。
- **receipt corruption fail closed**：lookupSettled 三值语义（tick=已结算 / undefined=未提交 / corrupted=损坏）在全路径保真——commitSettledReceipt 对 corrupted 返回 fatal（绝不 already_settled、绝不发布 committed heap projection）；admission/prepare 对 corrupted 拒绝（callback 零调用）；Game OK 后 commit 期间发现 corruption → faulted + durable quarantine（已执行事实不丢失）；resolution 路径同样 fatal 拒绝。
- **handle 生命周期有界化**：handle 防伪与全生命周期记录用 WeakSet/WeakMap（handle 被 GC 回收即整体回收——长寿命 global 不累积终态 handle/canonical payload/observation 强引用）；active strong registry（Map）只含未清理状态（prepared/executing/committing/faulted），commit/abort 成功即删除、tick 边界 stub 化（expired stub 只留 transactionId/digest/tick/generation/state，丢弃 canonical/observation/shape 引用）；terminal handle 在引用仍存在时经 WeakMap 返回稳定幂等结果。preparedActive gauge = active registry 大小（压力测试：大量 prepare/commit/abort/expire 后回到 0，不随历史增长）。heap-only handle 绝不持久化。
- **canonicalization 前的 runtime input 验证**：全部公开 writer 入口（prepareTransaction/executePreparedAction/单阶段 compat）在读取/遍历/digest/canonicalize 输入之前执行形状验证（input 对象、transactionId/kind/source 字符串、decision 对象与 scope/epochSeq/observedAtTick 类型、postings 数组且逐 posting 对象与字段类型）——malformed runtime input 返回结构化 rejection（invalid_input）而非 throw 中断 tick；零 tentative、零 receipt 槽、零 registry 污染、callback 零调用。
- **commitment completeness 补严**：task status 必须属于合法枚举（pending/done/cancelled/failed——未知值如 pendng 是损坏而非普通非 pending）；blockedReason 必须属于合法枚举（缺省合法）；resource 必须属于 RESOURCES_ALL；聚合累加后仍须为安全整数（溢出即该 scope incomplete）；reservation/task 损坏无法定位单一 scope 时全局 incomplete；receiver 房间 completeness 判定修复（按 \u0000 分隔解析 scope 键，房间内任一 resource scope incomplete 即 commitmentComplete=false）。损坏记录保留诊断可见但绝不静默跳过后继续授权。
- **authorizationSafe 重定义（多条件联合）**：true 当且仅当——查询上下文与 owner 合法、覆盖 scope 的 commitment index complete、receipt store healthy（无 fail-closed fatal）、无 unresolved write fault、无阻断性 unresolved quarantine（entries>0 或 overflowed）、Treasury lifecycle 处于 open（本 tick 未 endTick 且 service/tick 状态合法）、必要持久 migration 已完成（resourceReservationsOwnerVersion===3，或无可迁移数据）。任一失败：authorizationSafe=false + authorizationBlockers 有界诊断数组指出主因；新条件（receipt/quarantine/fault/lifecycle/migration）不归零数量字段（数值保留供观察，授权信号明确失败）；既有 owner invalid/commitment incomplete 路径维持 spendable=0 保守口径。

### 3.9 Quarantine Closure & Schema Activation（第七轮）

- **全局 quarantine write blocker**：prepare 门禁顺序（幂等优先保留）——input 形状 → ensureTickState → receipt 幂等（already_settled）→ 同 id quarantine（transaction_quarantined，精确 reason）→ **全局阻断**（quarantine store 损坏 → quarantine_store_fatal；存在任意 unresolved entry / legacy overflowed → quarantine_write_blocked）→ 同 id 幂等分支（prepare_conflict / handle_faulted / invalid_handle / 幂等 handle）→ tick_closed → write-fault marker 锁（write_admission_locked）→ epoch → 物理验证 → receipt admission → **quarantine fault-slot admission** → 签发。已结算幂等查询不受全局阻断影响；write-fault marker 不是唯一锁来源（marker 被解决但仍有其它 quarantine 时阻断持续）。authorizationSafe/write readiness 同口径 fail closed。
- **quarantine fault-slot 预留（admission 不变量）**：prepare 成功的前置条件 = 持久 quarantine entryCount + active handle 数（prepared/executing/committing/faulted）< TREASURY_QUARANTINE_MAX_ENTRIES(64)。计数全部 O(1)（validated store 的 entryCount + facade active registry size）。commit 成功 / abort 确认 / 普通 prepared 在 tick 边界 expire → slot 释放；fault（含 tick 边界 executing/faulted）→ 预留 slot 原子转换为持久 entry（entry +1、active −1，总和不变）——第 65 条 fault 在它 prepare 时已被拒绝，**永不**出现"达到上限后只置 overflowed 但不保存 entry"的路径（quarantineTreasuryTransaction 满载写入失败时保持 marker 锁定并计数，不静默）。legacy overflowed=true：health 永久 unhealthy、一切新 prepare 阻断、resolution 拒绝——只有 faultResolution 的显式 repair（全量验证现存 entries 合法且 count<MAX 后清除标志）可恢复。
- **quarantine 版本化持久权威（schema v1）**：store = {version:1, entries, entryCount, overflowed?}。entry key = "q:"+transactionId（transactionId 字符集 [A-Za-z0-9:_\-.]{1,128} 受限，前缀+受限字符集即无边界歧义，防危险字面量原型污染）。entry 字段：transactionId（合法 id）/digest（16 小写 hex）/tick 与 recordedAt（安全整数）/kind、source（string 1..128）/phase（合法枚举）/deltas（单一 canonical posting 事实：roomName 合法 + locationKind ∈ {storage,terminal} + resource ∈ RESOURCES_ALL + delta 非零安全整数）/recordedAt。**单一事实来源**：不再持久化 capacityDeltas——容量占用由 deltas 派生（per location 净流入 Σ delta，占用 = max(0, net)），消除双权威。load（global reset 后首次访问）全量验证：version===1、entries 普通对象、own key 数 === entryCount、key 编码与 entry.transactionId 一致、逐字段枚举/安全整数校验、聚合安全整数——任何损坏 fatal fail closed（原数据不删、health unhealthy、新 prepare 阻断、resolution 拒绝、聚合接口返回空但 blockers 报 blocking）。后续读取走 heap health cache（O(1)）。聚合（outflow/capacity occupancy）按模块内 revision 缓存（写路径 bump，query 复用，不随 query 次数全扫）。
- **write-fault marker 严格 shape validation**：transactionId 合法 / digest 16 hex / phase 枚举 / tick、recordedAt 安全整数 / status==="unresolved" / kind、source 有界 string / detail（可选，≤192 字符）。读取路径（isTreasuryWriteAdmissionLocked / readTreasuryWriteFault）对损坏 marker 一律视为存在 unresolved fault（fail closed，绝不当作"没有 fault"）；损坏 detail 有界诊断进 health。
- **quarantine 资源/容量保守口径**：资源——负 delta（可能已流出）计入 committed 占用；正 delta（可能已流入）不乐观计入 spendable；quarantine 不进 committed projection/journal，只作为未解决风险承诺参与授权。容量——per (room,locationKind) 的正净流入必须减少 free capacity（projectedFreeCapacity 与 commitments 的 capacityDelta 回调统一扣减，receiver headroom 同口径）；负净流出不得增加 free capacity；多资源 posting 按 location 净额聚合；聚合防安全整数溢出。
- **callback throw = execution unknown（状态机）**：进入 action callback 后抛错 → **不执行普通 abort**（callback 内可能已产生部分 Game 副作用）→ record.state=faulted、faultPhase=action_threw_execution_unknown、write-fault marker（含 ≤192 字符有界异常摘要，绝不持久化完整 Error 对象）+ durable quarantine 立即落库 → write admission 锁定 → rethrow 原始异常（Treasury 状态完整，不吞异常）。同 transaction 再执行：prepare 幂等分支拒 handle_faulted（callback 零调用）。只有 callback 正常返回明确非 OK（ok:false）才走普通 abort；其 abort 未确认时立即 faulted + marker + quarantine（phase=action_returned_non_ok_abort_failed），返回 executed_abort_failed。write-fault phase 枚举拆分为 commit 类（receipt_publish/heap_publish/journal_publish/overlay_publish/handle_state/commit_unexpected——Game 已 OK，不允许 not-executed resolution）与 execution-unknown 类（action_threw_execution_unknown/action_returned_non_ok_abort_failed/executing_at_end_tick——配合显式证据可 resolution）。
- **post-observation fault resolution（证据协议）**：resolution 输入 = {transactionId, digest?, evidence, guard}。evidence = {conclusion: observed_committed | observed_not_executed | still_uncertain, observationTick, source(1..128)}——表达故障后对账观察的 tick 与结论；guard = {activeTransactionIds, currentObservationTick}（facade 提供，service-aware）。验证链：input/evidence/guard 形状 → quarantine health（fatal 拒）→ 定位 entry（not_found 时查 resolution tombstone / receipt 得 already_resolved）→ digest 核对 → **active handle 检查**（∈ activeTransactionIds → active_handle_present 拒，quarantine/marker/receipt 不动）→ **tick 检查**（Game.time ≤ entry.recordedAt → 拒；evidence.observationTick ≤ entry.recordedAt → stale_observation 拒；observationTick > Game.time → 拒）→ **post-observation 检查**（guard.currentObservationTick ≤ entry.recordedAt → 拒：系统尚未建立故障后 shared observation）→ conclusion 匹配 resolution 类型（evidence_mismatch 拒；still_uncertain → 返回 uncertain，quarantine 保持不解锁）→ phase 允许性（not-executed 仅 execution-unknown 类 phase；commit 类一律 resolution_not_allowed）。resolve-as-committed：receipt 以 **resolution tick** 写入（完整 5000 retention 窗口——延迟 5001+ tick 后 resolution 的 receipt 仍存活完整窗口，下一 tick cleanup 不删）；原 action tick 保留在 resolution tombstone（审计）；不写当前 tick overlay/journal（避免与 observed 世界双算）；释放 quarantine、清匹配 marker、防重放由新 receipt 生效。resolve-as-not-executed：不写 receipt、释放 quarantine、清匹配 marker、返回 reprepareAllowed。resolution tombstone（Memory.runtime.treasury.resolutions，"r:"+transactionId）：{transactionId, digest, resolution, actionTick, settledAtTick?, observationTick, resolvedAtTick}——有界（上限 256，写入时惰性清理 resolvedAtTick+5000 过期项，超上限且无可清理 → 拒绝新 resolution fail closed）；使重复管理调用在 receipt 过期后仍返回 already_resolved 而非模糊 not_found。resolution 后 endTick 不得重新 quarantine（active handle 检查保证 handle 已不在 registry）。
- **reservation schema activation gate（v4）**：RESERVATION_OWNER_VERSION=4。gate（ensureReservationSchemaActivated）：store 不存在/空 → 原子初始化 {} + version=4（ready）；version===4 → ready；version 1/2/3 → 执行迁移（成功 ready / 失败 rejected: migration_failed）；version 非法 → rejected: unknown_version；持久 corrupted 标志存在 → rejected: store_corrupted。挂载点：facade.beginTick（非 lazy 分支，bootstrap phase——发生在全部 planner/reservation writer 之前）+ 每个 mutation 入口自检（双保险）；memoryCleanup 的 17 tick 迁移保留为幂等兜底。禁止混合 store：typed 与 deprecated adapter 一律经同一 gate；migration 失败期间一切 mutation 结构化拒绝（零写入）、授权 fail closed（既有 migration blocker）。
- **canonical owner identity v4（长度前缀）**：ownerToken = `ow2:<kindCode>:<nsLen>:<namespace><id>`（kindCode ∈ go/ls/tk/ct/lu，nsLen = namespace 的 UTF-16 code unit 长度）。token 相等 ⇔ (kindCode, nsLen, namespace, id) 相等——nsLen 决定 namespace/id 切分点，冒号/Unicode/空格/空串无歧义，id（≤128）与 namespace（≤64）保证 token 长度有界；同输入跨 tick 恒定。identity 字段 = kind + namespace + id（treasuryOwnerIdentityKey 与 token 同源）；roomName 由 store key 外层表达、lifecycleRef 是 metadata——均不参与身份比较与持久 key。kind-specific validation：logical-service 的 namespace 必填（1..64）；非 logical-service 的 namespace 必须缺省。migration v1/v2/v3→v4：以**经过完整验证的 entry.owner** 为 owner 杁威（logical-service 缺 namespace 时按 id 注册表前缀无损补全），不解析旧 token 字符串；旧 key 一致性按版本核验（v1/v2 平铺 key、v3 用 legacy v3 token）；重建全部 key、碰撞检测、原子替换 + version=4 + bump revision；失败原数据不动版本不推进。
- **reservation mutation 结构化权威**：reserve/renew/release（ForOwner 与 deprecated adapter 同一实现）返回 {status:"ok", mutated} | {status:"rejected", reason, detail}——验证 roomName 形状（^[WE]\d{1,3}[NS]\d{1,3}$）、resource ∈ RESOURCES_ALL、amount 正安全整数、ttl 正安全整数、Game.time+ttl 安全整数、owner kind-specific、schema gate ready、store 健康。非法输入/migration 失败零写入；实际 mutation 成功才 bump revision 且每次只 bump 一次（deprecated adapter 不二次 bump；no-op release/renew 不 bump）。listProductionReservations 返回冻结深拷贝快照（外部修改不影响 Memory、不绕过 revision）。gcProductionReservations：发现 malformed entry 不删除——置 Memory.runtime.resourceReservationsCorrupted（有界 detail，持久 fail closed：mutation 拒绝 + authorizationSafe/write readiness false），只有显式 repair（验证全 store 合法后清除标志）可恢复。
- **write admission readiness（与余额完整分立）**：query 返回独立 writeAdmission {ready, blockers}——条件：context/owner 合法、commitment complete、reservation migration complete、reservation store 无 corrupted 标志、receipt store healthy、receipt slot 可用、quarantine store healthy、quarantine fault slot 可用、无 unresolved quarantine、无 write fault、lifecycle open、tick state 当前。readiness=false 不影响数值字段（余额观察与写入准入分立）；prepare 各条件独立复查，绝不只信调用方读过 readiness。
- **指标（确定性计数）**：quarantineEntries / quarantineSlotsReserved / quarantineSlotsRemaining / quarantineStoreHealthy(bool) / quarantineAdmissionRejections / unresolvedQuarantines；resolution committed / not-executed / uncertain / rejected；executionUnknownQuarantines；reservation schema activation failures / mutation rejections。性能契约：prepare 的 quarantine blocker 与 slot admission 检查 O(1)（health cache + entryCount）；quarantine 聚合按 revision 缓存复用；global reset 后的首次全量验证是唯一允许的有界全扫；不新增每 tick 无条件全扫。

### 3.10 Durable Intent & Authorization Binding（第八轮）

#### 3.10.1 Durable Intent / WAL（treasury/intents.ts）

- **store（schema v1）**：`Memory.runtime.treasury.intents = {version:1, entries:Record<"i:"+transactionId,Entry>, entryCount, updatedAt}`。Entry = {transactionId（合法 id）、digest（16 小写 hex）、actionKind（1..128；无 contract 的直接路径 = input.kind）、kind、source、authorizationDigest?（授权 token 绑定的 digest 快照）、postings（canonical merged posting 数组，≤64 腿，roomName/locationKind/resource 枚举 + 非零安全整数）、phase（枚举）、structureId?（有界结构 incarnation）、auditSource?（≤128 审计来源）、createdAtTick、updatedAtTick}。**不持久化**完整 observation、service、journal 或任意大 payload——postings 是唯一资产事实副本（WAL 语义）。
- **phase 状态机**：`authorized`（授权已签发、prepare 前的瞬时记录位——只作为状态机语义区分，落盘时至少为 ready）→ `ready`（durable 已写入并验证；**Game API 尚未调用**——协议保证 execution-started 标记先于 callback 写入）→ `executing`（已标记 execution-started、callback 进行中——结果未知）→ `returned_non_ok`（callback 正常返回非 OK，关闭中）→ `ok_pending_commit`（callback 返回 OK、commit 发布中）→ `committed` / `aborted`（终态关闭位——正常路径 intent 随关闭立即删除，这两个枚举值仅用于表达状态机完整性）→ `execution_unknown`（callback 抛错/abort 未确认/边界 executing——quarantine 转换中）→ `quarantined`（quarantine 完整写入并验证——intent 可释放）→ `resolution_pending`（staged resolution 进行中）。核心区分：`ready` 与 `executing` 绝不混同——前者确认未调用 Game API，后者结果未知。
- **调用顺序（唯一安全顺序）**：authorize（签发授权 token + 占用 authorization budget）→ prepare tentative（handle + tentative + receipt/quarantine slot 预留）→ 持久化 intent(phase=ready，postings=canonical merged)→ 读回验证写入成功 → 标记 phase=executing → 调用注册 adapter 恰好一次 → 非 OK：phase=returned_non_ok → 关闭 intent（删除）+ abort tentative → OK：phase=ok_pending_commit → staged commit（receipt/journal/overlay）→ finalize（删除 intent）。**intent 写入失败**（store fatal/容量满）：callback 调用数必须为 0、tentative 与 receipt/quarantine slot 释放、返回结构化拒绝（intent_store_unavailable）。
- **slot 统一计数（3.5 重构）**：一笔 transaction 恒占**一个** recovery slot：`recoverySlots = quarantineEntryCount + intentEntryCount + activeHandles(无对应 intent 的)`。prepare admission（O(1)）检查该总数 < TREASURY_QUARANTINE_MAX_ENTRIES(64)；intent 写入时 slot 从"active handle"形态转为"durable intent"形态（总数不变）；fault 时 intent(phase=execution_unknown) 转换为 quarantine entry（quarantine +1、intent −1，守恒）；正常 commit/abort 时 handle 终态化 + intent 删除（−1）。指标 intentSlotsRemaining/quarantineSlotsReserved 证明守恒——"active faulted handle + durable quarantine 计为两条不同占用"的路径不复存在。
- **global reset 恢复（3.4）**：beginTick（显式分支，先于一切 planner/writer）加载并验证 intent store（版本化 load + health cache + fatal fail closed）。发现未完成 intent：全局 write blocker（新 writer 一律拒绝，callback 零调用）；`ready` → 协议保证 mark 先于 callback——确认未执行，释放 slot（删除 entry，计 intentRecoveries，审计样本）；其余 phase（executing/returned_non_ok/ok_pending_commit/execution_unknown/quarantined/resolution_pending）→ 保守转 execution-unknown quarantine（携带 postings；幂等 already_present 保留首条）后删除 intent（slot 守恒）；quarantine 写失败（store fatal/满）→ intent **保留**（见 3.10.5）。恢复幂等；无法确认 action 是否执行时一律保守 execution unknown。
- **健康契约（3.6）**：version/entryCount 元数据、key="i:"+transactionId 与 entry 一致、entry 全形状校验（id/digest/actionKind/kind/source/phase 枚举/postings 逐腿校验/安全整数/聚合溢出预检）、容量上限 64（与 quarantine 同上限——slot 统一计数的前提）、global reset 首次 load 全量验证、heap health cache、损坏与未知版本 fail closed（原数据不删、写入拒绝、writer 阻断、聚合空但 blockers 报 blocking）、显式 repair 边界（并入 faultResolution 的 repair）。prepare 不全表扫描（admission 用 entryCount + activeHandles O(1)）。

#### 3.10.2 资源授权（treasury/authorization.ts）

- **授权请求**：TreasuryAuthorizationRequest = {actionKind（1..128）、resource、rooms（管辖房间 scope）、locations?、amount（需要的消耗量，正安全整数）、owner?（TreasuryOwnerIdentity，可选——owner-aware 自排除）、withhold? 或 policyFingerprint?（二选一：策略保留量或策略指纹串，≤128）、allowProjected?（默认 true）、allowIncoming?（**默认 false**）、subtractOutgoing?（**必须非 false**）、subtractReservations?（**必须非 false**）、capacityRequirement?（可选，正安全整数）}。immediate Game write 授权默认四条硬约束（allowIncoming=false + 必扣 outgoing + 必扣 reservations + 必考虑 quarantine/tentative/commitment complete）——违反即 rejected（authorization_policy_violation）；未来某动作确需依赖 incoming 时由独立策略常量显式批准，普通布尔不得开启。
- **授权计算**：`available = exact observation + committed overlay − pending outgoing − production reservations（owner-aware 排除）− quarantine/intent 风险流出 − policy withhold − 其它未消费授权的 tentative 占用`；amount ≤ available 且各聚合安全整数；同时验证 commitment completeness（覆盖 scope）、reservation store health、write admission readiness（不含容量类准入的授权基础条件）、位置容量（capacityRequirement 有值时按 risk-adjusted free 判定）。多资源 action 的每个负 posting 分别授权（terminal.send 场景：被发送资源 + transaction energy + staging 承诺各自独立 token 或聚合请求覆盖）。
- **opaque token**：TreasuryAuthorizationToken = 冻结对象 + 服务实例私有 WeakSet 对象身份注册（heap-only，绝不持久化）。绑定字段：transactionId、actionKind、resource、rooms、amount、epoch {scope, epochSeq, observedAtTick}、commitmentRevision、projectionRevision、reservationStoreRevision、quarantineRevision、policyFingerprint（规范化）、ownerKey（canonical owner token；无 owner 为 ""）、serviceGeneration、tick、contractDigest?。**消费规则**：对象身份验证（伪造/JSON round-trip 失败）、单次使用（consume 置终态，重复消费 invalid）、跨 tick 失效、跨 service generation 失效、绑定 revision 任一变化失效（commitment revision 变化 = transfer task/reservation mutation；projection revision 变化 = 任何 commit；quarantine revision 变化 = quarantine 写/释放；reservation store revision = schema/mutation 计数）、scope 内 postings 全覆盖（每个负 posting 的 (room,location,resource) 在授权 scope 内且累计流出 ≤ amount）。
- **防超卖（4.4）**：授权成功即占用 authorization budget（facade 内 authorization ledger：按 (room,location,resource) 累计待执行流出量）——A 授权 60k 后 B 再授权 60k（物理 100k）被拒；不得等 action prepare 才防超卖。授权与 prepare 可经 executeTreasuryActionContract 合并为 Treasury 内部原子阶段（外部拿到的是已绑定资源承诺的 opaque capability）。prepare 消费 token 时 authorization budget 转 tentative（互换，不双算）。

#### 3.10.3 Action Contract 与 Adapter Registry（treasury/actionContracts.ts）

- **contract**：TreasuryActionContract = 冻结对象 {contractId（"ac:"+digest 定长）、actionKind、transactionId、args（冻结深拷贝——canonical action args）、source/target 对象或房间、resource、amount、feePostings、structureIds（incarnation 快照）、postings（**由 adapter.derivePostings(args) 确定性派生**，规范排序冻结）、authorizationDigest、epoch 绑定、builtAtTick、generation}。调用者只提供 canonical args + authorization——postings 与 Game API 参数同源（同一 args 派生），"声称 1 单位实发 10,000"的两套事实通道不复存在。
- **adapter 契约**：每个 action kind 注册 TreasuryActionAdapter = {kind、version、validate(args)：形状/语义校验、derivePostings(args)：确定性 postings 派生、execute(args)：恰好调用对应 Game API 一次并返回 {ok, ...}、structureIds(args)：incarnation 身份、reconcile?(contract, observation)：post-fault 对账 → committed|not-executed|uncertain}。注册边界：registerTreasuryActionAdapter 仅 actionContracts.ts 自身与测试可调用（架构测试守护）；重复 kind 注册拒绝。本轮内置测试 adapter（"test.transfer"：可配置多 posting、可注入副作用计数），不注册任何真实生产 writer。
- **执行入口**：executeTreasuryActionContract(service, contractOrRequest) —— 校验 adapter 存在且 kind 匹配（mismatch 拒绝）、args 与 contract 冻结副本一致（调用方事后修改原 args 不影响 canonical contract；不同 payload 同 transactionId 冲突拒绝）、structureId 与当前 observation incarnation 一致（变化拒绝 structure_replaced）、授权 token 消费并校验 scope/amount → 之后走 3.10.1 的唯一安全顺序（intent → executing → adapter.execute 恰好一次 → 非 OK abort / OK commit）。**executePreparedAction 降级为内部/test-only 低层原语**（保留给既有测试与特殊集成，生产模块禁用——架构测试扫描生产 writer 候选模块不得引用任意 callback 入口/compat/直接 prepareTransaction/直接构造 postings）。

#### 3.10.4 Quarantine per-transaction 保守聚合与快照封闭

- 聚合算法（替换第七轮的全局净额合并）：对每笔 transaction 先内部合并同 (room,location,resource) 腿得 net；`outflowOccupancy(rk) = Σ_tx max(0, −net_tx(rk))`、`capacityOccupancy(lk) = Σ_tx max(0, net_tx(lk))`。不同 transaction 之间正流入不得抵消另一笔负流出、正流入不得增加 spendable。A:+1000/B:−500 → 容量占用 1000（非 500）、资源流出占用 500。unresolved durable intents 以同一算法并入（intent.postings 是 quarantine 之外的保守权威副本）。每步（transaction 内合并、跨 transaction 求和）安全整数校验——溢出时 store unhealthy、write readiness false、聚合接口不返回乐观数值。
- 快照封闭：readTreasuryQuarantineEntry / listTreasuryQuarantineEntries / 风险聚合 / blockers/health 详情一律返回冻结深拷贝或新建只读 Map——绝不泄漏 store 内部对象或缓存 Map 引用；quarantine 写入路径对传入 entry 重新完整验证（不假设调用方传入 prepare 验证过的安全对象）。

#### 3.10.5 Quarantine 写失败时 Intent 接管（emergency intent authority）

intent 删除仅限四种情形：transaction 成功 settled（receipt committed）／确认 aborted（含 returned_non_ok 关闭）／quarantine 完整写入并验证（slot 转换完成）／resolution 完整 finalized。quarantine 写失败（store fatal／防御性容量分支）时：intent 保留完整 canonical postings、继续参与资源/容量风险占用（聚合并入 3.10.4）、writer 全局锁定、不释放 recovery slot；global reset 后从 intent 恢复占用与占用重试。query 的 committed 与 capacity 风险同时计入 quarantine entries 与 unresolved intents；write-fault marker 降为诊断根因（不再承担唯一资产事实——intent/quarantine 才是资产权威）。

#### 3.10.6 Staged Atomic Resolution 与既有 receipt 刷新

- **resolution store v2**：`Memory.runtime.treasury.resolutions = {version:2, entries:Record<"r:"+transactionId,Tombstone>, entryCount, updatedAt}`；Tombstone = {transactionId、digest、resolution、stage（"resolving"|"final"）、actionTick、settledAtTick?、observationTick、resolvedAtTick、reconcilerKind?、source}。健康契约：version/entryCount/key 一致/entry 完整 shape（枚举/安全整数/digest 16hex）/global reset 首次 load 全量验证/heap cache/未知版本 fail closed/损坏不自动删除/容量（256）满时**在任何原状态变化之前**拒绝；malformed 旧 tombstone 绝不当可清理垃圾删除（fail closed）。v1（第七轮）store：全量验证通过后无损升级 v2（补 entryCount），损坏 fatal。
- **staged 流程**：prevalidate（capability）→ **slot 预检**（tombstone store 满且无可清理 → rejected，零状态变化）→ 写 resolving tombstone（resolution-intent 落盘）→ 执行结算动作（committed：receipt refresh；not-executed：无 receipt）→ finalize（清匹配 marker → 写 final tombstone → 完成）。任何阶段失败：不得普通返回 rejected 却已解锁——quarantine/intent 保留、write readiness false、resolving tombstone 保留（global reset 后幂等恢复：检测 receipt 已写而 quarantine 仍在 → 继续 finalize；检测 resolving not-executed tombstone → 完成 quarantine 释放）。
- **resolve-as-committed 的既有 receipt 刷新**：refreshSettledReceiptForResolution(transactionId, tick)——own key 存在且 value 有效时**更新 settled tick 至 resolution tick**（不是 already_settled 短路），同步维护 entryCount（不变）、updatedAt、nextExpiryTick（单次有界重算：min(其余 settled, resolution tick)+retention+1）；receipt 计数 receiptRefreshes。actionTick 只用于审计（tombstone 保留）；不向当前 tick overlay/journal 重放历史动作；**统一 replay horizon**：prepare 幂等（already_settled）的判定顺序 = heap receipt → Memory receipt → committed resolution tombstone（settledAtTick + retention 窗口）——receipt 过期但 committed tombstone 仍在窗口内时，同 id prepare 仍拒绝（不得当全新动作）；三处使用同一 retention 常量。
- **resolve-as-not-executed**：先写 final tombstone（可写性预检通过后）→ 再释放 quarantine/intent（顺序固定）；失败时 quarantine 保留（函数返回 rejected 但 transaction 仍被 transaction_quarantined 阻断，绝无"可重新 prepare"的中间态）；重复调用稳定 already_resolved。

#### 3.10.7 Service-issued Reconciliation Capability

- **签发**：service.issueTreasuryReconciliationCapability({transactionId, digest?}) → 验证：transaction 存在于 durable intent 或 quarantine（否则 not_found）；对应 actionKind 有**已注册且带 reconciler** 的 adapter（否则 rejected: no_registered_reconciler）；transaction 不在 active handle registry；当前 tick > 故障 tick 且当前 shared observation 为故障后观察；service generation/tick 合法。然后调用 adapter.reconcile(contractFacts, 当前 exact observation) 得 conclusion（committed|not-executed|uncertain），签发 opaque capability：冻结对象 + 私有 WeakSet 注册，绑定 {transactionId、digest、actionKind、contractDigest?、conclusion、postFaultEpoch {scope,epochSeq,observedAtTick}、observationTick、structureIds、reconcilerKind、reconcilerVersion、serviceGeneration、tick、used}。调用者不能自填 conclusion——conclusion 只能来自注册 reconciler 对 post-fault observation 的判定。
- **防伪与验证**：普通对象伪造失败、JSON round-trip 失败、旧 service（generation 不匹配）失败、旧 epoch（observationTick/epoch 与当前不符）失败、capability 单次使用、跨 tick 失效。resolution 的两个 resolve 函数只接受 capability（旧 evidence/guard 自由对象入口移除）；验证链：capability 对象身份 → generation → tick/epoch 新鲜度 → transaction/digest 匹配 → reconciler kind 与 entry actionKind 匹配 → active handle 不存在 → current lifecycle。跨 global reset：旧 heap token 不恢复——新 service 依据持久 intent/quarantine + 当前 observation 重新签发。
- **uncertain**：reconciler 结论 uncertain → capability.conclusion=still_uncertain → resolution 返回 uncertain，quarantine 保持隔离不解锁。

#### 3.10.8 Owner Identity 统一与 Reservation Store 完整健康

- **统一比较 key**：treasuryOwnerIdentityKey 重定义为 canonical owner token（`ow2:<kindCode>:<nsLen>:<ns><id>`）的同一算法——持久 key 拼接、commitments byOwner 聚合 key、reservedProduction 自排除 key、resourceReservation mutation/release/renew 定位 key、migration collision 检测全部复用同一 token；独立 NUL 分隔比较键移除。id/namespace 含 NUL、冒号、Unicode、空格时 token 无边界歧义，比较结果与持久 token 恒一致（架构测试 + 向量测试锚定）。
- **store 完整 load validation**：validateReservationStoreHealth()（完整校验：store 对象、version、每 key === makeReservationStoreKey(entry.roomName, entry.resource, entry.owner 权威)、owner shape（kind-specific）、roomName/resource/amount/updatedAt/expiresAt 全安全整数与语义、聚合溢出、重复 identity（重建 key 集大小 === entryCount）、corrupted 标志）；结果 heap cache + revision（mutation/schema gate bump 失效）。**version=4 不等于 healthy**——必须经过完整 load validation。任何损坏：原数据保留、mutation 拒绝（store_unhealthy）、commitment 视图 incomplete、authorizationSafe=false、write readiness=false（新增 blocker reservation_store_unhealthy）。
- **mutation 顺序**：先验证本次输入（room/resource/amount/ttl/owner 形状）→ 再 schema gate → 再 store 完整健康 → 再写入。非法调用不得因 schema gate 而先修改整份 store（gate 触发的迁移只在输入合法后执行）。
- **只读 API**：get/list/owner snapshot/store health 详情不返回 live Memory 引用（既有冻结深拷贝延续）；旧兼容读取（getReservedProductionAmount*）跳过非安全整数 entry（NaN 不传播），完备性由 facade 的 store health blocker 保障（deprecated 路径不承担 completeness 判定）。

#### 3.10.9 Capacity View 分立

- `strictProjectedUsedCapacity(room,kind) = observed.used + overlay capacityDelta`；`strictProjectedFreeCapacity = observed.free − overlay capacityDelta`（**严格口径：used + free = physical capacity，不含任何风险扣减**）。
- `riskAdjustedFreeCapacity = strictFree − quarantineCapacityOccupancy − intentCapacityOccupancy`（admission/headroom 口径：可能已流入的 uncertain 资源占用空间）；`riskAdjustedReceiverHeadroom`（commitments 的 receiver 视图新增字段：free − healthy incoming − 风险占用）。receiver admission 使用 risk-adjusted 口径。
- 旧名称兼容：facade.projectedFreeCapacity/projectedUsedCapacity 保留为 deprecated 别名（projectedFreeCapacity → riskAdjustedFreeCapacity 同值；projectedUsedCapacity → strict 口径；文档与注释明确标注），receiverCommitments 的 projectedStorageHeadroom/projectedTerminalHeadroom 语义标注为 risk-adjusted（第七轮行为不变），新增 strictStorageHeadroom/strictTerminalHeadroom 与 riskAdjustedStorageHeadroom/riskAdjustedTerminalHeadroom 显式字段——消费者不再误混两个口径。

#### 3.10.10 指标与性能（第八轮）

新增确定性计数：authorizationIssued/Rejected/Invalidated/Active、actionContractsBuilt、actionAdapterMismatches、authorizationRevisionMismatches、durableIntents（gauge）、intentSlotsRemaining、intentRecoveries、intentQuarantineConversions、intentStoreHealthy（bool）、intentWriteFailures、resolutionInProgress/Faulted/Recovered、receiptRefreshes、reconciliationCapabilitiesIssued/Rejected、reservationStoreHealthy（bool）、riskAdjustedCapacityLookups。性能契约：authorize/prepare 不全扫 reservation/quarantine/intent store（commitment 按 revision 缓存、risk 聚合按 store revision 缓存、intent admission O(1)、token 验证 O(1) 或与 posting 数线性）；global reset 首次 load 有界验证；不每 tick无条件扫描 resolution tombstone（写入时惰性清理维持）。

#### 3.10.11 故障模型边界（exactly-once 声明）

Treasury 机制覆盖：tick 内 reset 恢复（heap 丢失、Memory 完整）、commit 阶段异常、write-fault 检测、quarantine/resolution 状态机中断恢复（staged + 幂等）。**不保证**：Screeps 运行时硬 CPU 中断（tick 中途进程终止导致 Memory 未 flush——该 tick 的全部 Memory 写入一并丢失，intent 与副作用可能同时消失，恢复按"无持久记录"处理，风险由 quarantine slot 预留与保守恢复兜底）；Memory 序列化边界外的持久化介质故障。设计上不声称超出该模型的 exactly-once。

### 3.11 Contract-Bound Authority & Recovery Closure（第九轮）

#### 3.11.1 安全 canonical encoding（canonicalEncoding.ts）

`canonicalizeTreasuryActionArgs(args)` 一次遍历完成"复制冻结 + 确定性文本编码"，输出 `{canonical（冻结深拷贝）, text}` 或结构化拒绝（绝不抛出中断 tick）：

- **拒绝集合**：cyclic（祖先路径栈检测）；accessor 属性（descriptor.get/set 存在即拒——检测先于读取，getter 零副作用读取）；非普通对象 prototype（Object.prototype/Array.prototype 之外——涵盖 class instance/Date/Map/Set）；function/symbol/bigint/undefined（对象属性值或数组元素任一出现即拒）；NaN/±Infinity；稀疏数组（`Object.keys(arr).length !== arr.length` 或数组含 hole）；键为非 string/symbol-free 的数字键（数组外普通对象的整数键规范化为字符串后参与排序——语义等价编码）。
- **确定性**：普通对象 key 经 `Object.keys` 枚举后**排序**再拼接（消除插入顺序差异）；数组保持元素顺序（顺序即语义）；文本编码沿用长度前缀风格（`t:<len>:<text>` / `n:<number>` / `b:true|false` / `n:null`），无 `{a:undefined}` vs `{}`、NaN vs null 的静默碰撞（undefined 压根不允许出现）。
- **有界**：深度 ≤ 16、编码文本 ≤ 4096 字符、数组长度 ≤ 256、对象自有键 ≤ 64——超限结构化拒绝。
- contract digest 改为 `AC2` 前缀：`AC2:ce:<encodingVersion>:k:<len>:<kind>:av:<adapterVersion>:t:<len>:<transactionId>:a:<len>:<canonicalArgsText>:p:<postings 长度前缀串>:s:<structures 长度前缀串>`。旧 AC1 digest 不再签发（无持久迁移需求——contract 是 heap-only 单 tick 对象）。

#### 3.11.2 受控结构引用与完整 incarnation 验证

adapter 的 `structureIds?(args): string[]`（任意字符串、收集不验证）替换为：

```ts
structureBindings?(args): readonly { roomName: string; locationKind: "storage" | "terminal"; label?: string }[]
```

- contract 构建时：`structureSnapshots` = posting 涉及的全部 (room,location) + `structureBindings` 声明的额外结构（label 缺省为 `${roomName}:${locationKind}`），每项捕获 structureId；adapter 声明的房间不在管辖/位置缺失 → contract 拒绝（不允许"声明了但无法验证"）。
- 执行前：`beginFreshObservation()` 必须 succeed（配额耗尽 → `fresh_observation_unavailable` 拒绝执行——**不退回 shared observation**）；对全部快照逐项重验 structureId（disappeared/replaced → `structure_replaced`，callback 零调用、授权零消费、tentative 不变）。

#### 3.11.3 Contract-first authorization 与原子 bundle

- `service.authorizeTreasuryActionContract(contract, options)`：contract 必须为本 service 本 tick 构建的合法对象（registry 身份 + builtAtTick === Game.time）；从 canonical postings 派生每资源授权请求（amount = Σ|负 delta|、rooms = 去重房间集、locations、actionKind、contractDigest 必填、adapterVersion 绑定）；逐资源签发 token——任一失败时**已签发 token 的预算全部回滚**（原子签发）；全部成功返回 `TreasuryAuthorizationBundle {tokens, contractId, digest, transactionId, actionKind, adapterVersion}`。授权前置 write admission ready（writeFault lock + quarantine/intent blockers + readiness 基础条件）。
- policy authority：`TreasuryAuthorizationRequest.policyFingerprint` 字段与 `pf:` 通道删除；token.policyFingerprint 值域收紧为 `"wh:<n>" | ""`（仅 Treasury 计算的受控 withhold）。
- `authorizeResourceUse` 降级 @internal test-only（service 对象保留；架构测试禁止生产调用）。

#### 3.11.4 原子 redemption 顺序（writer kernel execution options）

`executePreparedAction(input, action, execution?)`，`execution = {redeemAuthorization?, intentContract?}`：

```text
contract 防伪/跨 tick/adapter 校验
→ bundle 只读预验证（全部 token：身份/generation/tick/revisions/contract identity+digest/
   actionKind/adapterVersion/transactionId/重复/coverage/累计 amount/capacity/policy）
→ 结构 incarnation 重验（fresh 必需）
→ prepareTransaction（全门禁；拒绝 = 零消费零 callback）
→ redeemAuthorization()（tentative 已接管后、intent 前；失败 = 释放 tentative、零 callback）
→ writeTreasuryIntentEntry(phase=ready, 绑定 contract identity + durable payload)
→ read-back 验证（digest/contract/postings 一致，不一致 = 零 callback 保守关闭）
→ transition ready→executing（任一失败含 not_found = 零 callback 保守关闭）
→ adapter.execute 恰好一次
→ OK: transition executing→ok_pending_commit（失败=不普通 commit→durable fault）
→ 非 OK: transition executing→returned_non_ok（失败=不普通 abort→durable fault）
→ 抛错: execution_unknown emergency authority（quarantine 写失败时 intent 保留）
```

消费点位于 tentative 接管之后 = "授权预算 → tentative ledger"的原子转移；prepare 拒绝时零消费。任一 token 预验证失败时前 N−1 个不被消费（预验证纯只读，消费只发生在 redeem 一次完成）。

#### 3.11.5 intent 合同身份与严格 phase 状态机（intents v2）

- `TreasuryIntentEntry` v2 新增 optional 字段：`contractDigest`（16hex）、`adapterVersion`（正整数）、`durablePayload`（≤512 字符，adapter.durableFacts(args) 的版本化有界对账事实——替代持久化完整 args）。v1 → v2 无损升级（新字段全 optional），未知版本 fail closed 不变。
- `transitionTreasuryIntentPhase(transactionId, target, expect)`：`expect = {from?: readonly phase[], digest?, contractId?}`；entry 缺失 → not_found；identity 不匹配 → identity_mismatch；当前 phase 不在 expect.from 且 ≠ target → predecessor_mismatch；当前 phase === target 且 identity 匹配 → 幂等 marked。合法迁移表：`ready→executing`、`executing→{returned_non_ok|ok_pending_commit|execution_unknown|quarantined}`、`returned_non_ok→{execution_unknown|quarantined|resolution_pending}`、`ok_pending_commit→{execution_unknown|quarantined|resolution_pending|committed}`、`execution_unknown→{quarantined|resolution_pending}`、`quarantined→resolution_pending`。旧 `markTreasuryIntentPhase` 移除。
- **read-back**：intent 写入后立即 `readTreasuryIntentEntry` 比对 transactionId/digest/contractId/postings——不一致按 store 不可信处理（callback 零调用 + 保守关闭）。

#### 3.11.6 recovery phase 事实等级映射

| intent phase | 恢复动作 | quarantine write-fault phase | not-executed resolution |
|---|---|---|---|
| ready | 确认未执行释放（协议保证 mark 先于 callback） | — | — |
| executing / execution_unknown / quarantined / resolution_pending | 保守转 execution-unknown quarantine | executing_at_end_tick | 允许（unknown 类） |
| returned_non_ok | 保留"Game 已返回非 OK"事实 | action_returned_non_ok_abort_failed | 允许（Game 明确未成功） |
| ok_pending_commit | commit 类隔离（**事实单调**：已知 OK 不降级为可能未执行） | ok_pending_commit_unresolved（新增 commit 类枚举） | **拒绝**（只能 committed） |
| committed / aborted | 终态残留：幂等释放（receipt/abort 已完成） | — | — |

emergency intent（quarantine 写失败保留）phase 原样保留，等价参与 authority。

#### 3.11.7 unified unresolved authority

`resolveTreasuryUnresolvedAuthority(transactionId)`（faultResolution 私有，签发/恢复/释放共用）：

- quarantine 与 intent 同 id 双存在 → digest/postings（规范逐腿比较）/kind 三者必须全等，否则 `authority_inconsistent` fail closed（不任选其一）；
- 一致或单一存在 → 归一化 facts：`{authorityKind: "quarantine"|"intent", transactionId, digest, kind, actionKind, phase, recordedAt, postings, contractId?, contractDigest?, adapterVersion?, durablePayload?}`；
- intent-only 的 not-executed 允许性：intent phase ∈ {executing, returned_non_ok, execution_unknown} 允许；ok_pending_commit 拒绝（事实单调）；quarantined/resolution_pending 保守允许（隔离中的 unknown）。

resolution 成功释放路径：releaseTreasuryQuarantineEntry + releaseTreasuryIntentEntry（均幂等）+ clearTreasuryWriteFaultMarkerForResolution（digest 双匹配）；任一步失败不回滚 tombstone（恢复协议幂等补完成）。

#### 3.11.8 私有 capability 与 service 校验

- reconciliation.ts 的 registry/validate/consume 全部移入 facade 的 `createTreasuryService` 闭包（与 authorizationRegistry 同模式）；模块只保留类型与 conclusion 枚举。`registerTreasuryReconciliationCapability` 等符号不再导出——架构测试扫描导出面。
- resolve 函数签名：`resolveTreasuryFaultAsCommitted(service, {transactionId, digest?, capability})`——`service.consumeReconciliationCapability(capability)` 承载"身份 + 单次 + generation + tick"校验并消费（generation 取闭包值，调用者无法提交）；resolve 不再接收 serviceGeneration。
- capability 扩展绑定：authorityKind、contractId/contractDigest（authority 有绑定时必须匹配）、adapterVersion、durablePayloadVersion、结构 incarnation 摘要、reconcilerKind+Version。
- reconciler 输入：完整 durable facts（actionKind/transactionId/contractDigest/postings 全量/durablePayload/adapterVersion）——移除 `postings[0].resource` 与单一负数 amount 汇总。

#### 3.11.9 staged 恢复与 retention 规则（resolutionStore）

- resolving committed 恢复判定：`receiptTick = hasSettledReceipt(id)`；finalize 当且仅当 `entry.settledAtTick !== undefined && receiptTick !== undefined && receiptTick >= entry.settledAtTick`。未达标（旧 action tick receipt / 无 receipt）→ 幂等续做 `refreshSettledReceiptForResolution(id, entry.settledAtTick)`（刷新到**原定** settledAtTick——不缩短 replay horizon）；refresh fatal → 保留 resolving + 报告 blocker（绝不直接 finalize、绝不回滚丢弃 resolution-intent）。
- `evictExpiredTombstones` 只删除 `stage === "final"` 且超 retention 的条目；resolving 永不驱逐——满载且无可清理 final 项时 fail closed 拒绝新 resolution（与既有容量语义一致）。
- final not-executed 恢复补完成：quarantine release + intent release + marker 清除（authority 双查，intent-only 场景同样补完成）。

#### 3.11.10 架构封闭（writer kernel）

架构测试从固定 PRODUCTION_WRITER_MODULES 列表升级为**全量扫描 src 下全部生产 .ts**（排除 treasury 协议实现白名单：facade.ts、actionContracts.ts、compat.ts、faultResolution.ts、resolutionStore.ts、intents.ts、quarantine.ts、receipts.ts、writeFault.ts、reconciliation.ts、authorization.ts、canonicalEncoding.ts、ownerIdentity.ts、commitmentRevision.ts、resolutionEvents.ts、transactionId.ts、shadow.ts、types.ts）：普通生产模块不得调用 `executePreparedAction`/`prepareTransaction`/`consumeTreasuryAuthorization`/`authorizeResourceUse`/`compatRecord*`/`registerTreasuryActionAdapter`，不得 import faultResolution；新增生产模块自动受约束。service 公共接口上这些方法标注 @internal（TS 类型保留，测试可用）。

#### 3.11.11 性能与容量（第九轮）

bundle 预验证复杂度 O(tokens + postings)（与历史 transaction 无关）；授权/prepare 快路径维持既有 operation-count 契约；无随历史 transaction 无界增长的 heap strong Map（capability/authorization registry 均 WeakSet/WeakMap 或 tick 级清空）；durablePayload ≤ 512 字符/entry、canonical args 编码 ≤ 4096、intent store 64、resolution store 256（resolving 不参与 GC——满载 fail closed 即上限）；structureSnapshots 受 structureBindings 声明数有界（≤ 16 项）。新增 operation-count 测试证明 bundle 预验证与 fresh 结构校验不退化为全表扫描。

#### 3.11.12 非目标重申

本轮不接任何真实生产 writer（ResourceControl/terminal/carrier/lab/factory/market/nuker/synthesis 零改动）；不部署、不合并 main；不声称 Screeps 硬 CPU 中断下的 exactly-once（3.10.11 边界继续有效）；自由字符串 policy 仍非 policy authority（通道已移除）。


### 3.12 Durable Authority Cohesion & Bundle Atomicity（第十轮）

#### 3.12.1 Execution outcome 与 settlement state 拆分

intent v3 的 entry 以正交二元组取代单一 `phase` 字符串：

- `outcome: TreasuryExecutionOutcome` —— Game API 调用的**事实等级**（单调、不可回退）：
  - `not_started`：callback 从未被调用（协议保证 execution-started 标记先于 callback）；
  - `started_unknown`：callback 已开始但结果未知（执行中/抛错/中断）；
  - `returned_non_ok`：Game 已明确返回非 OK；
  - `returned_ok`：Game 已明确返回 OK；
  - `aborted_final`：终态专用（正常 abort 完成不落盘；仅用于旧 phase `aborted` 的无歧义迁移——不冒充任何执行事实）。
- `settlement: TreasurySettlementState` —— Treasury 工作流状态：
  `ready | executing | pending_abort | pending_commit | quarantined | resolving | finalized | faulted`。

outcome 单调迁移表（唯一合法边）：`not_started → started_unknown`（execution started 标记时）、`started_unknown → returned_ok | returned_non_ok`（callback 正常返回时）。故障、恢复、quarantine 转换、intent 写失败、commit fault 一律**只改 settlement**：callback 抛错 = `(started_unknown, faulted)`；OK 后 commit 故障 = `(returned_ok, faulted)`（事实不再丢失）；OK 后 quarantine 写失败 = intent 保留 `(returned_ok, faulted)`（intent-only authority 仍携带 returned-ok）。

resolution eligibility 只依据 outcome：`returned_ok` 只能 resolve-as-committed 或 still-uncertain（永不 not-executed）；`not_started` 才可无证据安全关闭；`returned_non_ok` 完成 abort 收尾；`started_unknown` 必须真实 reconciliation。

旧 phase → `(outcome, settlement)` 迁移表（load 时一次性、保守单调）：`ready→(not_started,ready)`、`executing→(started_unknown,executing)`、`returned_non_ok→(returned_non_ok,pending_abort)`、`ok_pending_commit→(returned_ok,pending_commit)`、`committed→(returned_ok,finalized)`、`aborted→(aborted_final,finalized)`、`execution_unknown→(started_unknown,faulted)`、`quarantined→(started_unknown,quarantined)`、`resolution_pending→(started_unknown,resolving)`；未知 phase 值 fail closed（store fatal）。

#### 3.12.2 Durable authority cohesion（quarantine v2）

quarantine store 升级 version 2，entry 在 v1 最小事实（transactionId/digest/tick/kind/source/phase/deltas/recordedAt）之上新增完整合同与权威字段：`outcome`、`settlement`、`contractId`、`contractDigest`、`actionKind`、`adapterVersion`、`durablePayload`（≤512）、`durablePayloadVersion`、`authorizationDigest`（bundle digest）、`ownerIdentity`、`policyIdentity`、`structureFacts`（有界数组：roomName/locationKind/structureId，≤16）。`phase` 保留为 fault reason（write-fault 枚举）。

事实转移协议（intent → quarantine）：quarantine v2 写入（携带 intent 的全部合同事实）**并读回验证一致后**才释放 intent；写失败或读回不一致 → intent 保留为 emergency authority（slot 守恒语义不变）。双权威并存窗口内 `resolveTreasuryUnresolvedAuthority` 以 quarantine 为主、intent 补充校验，身份不一致 fail closed。recovery slot 计数按 `|intentIds ∪ quarantineIds|` 去重（同 ID 双存在只占一 slot）。

迁移：v1 → v2 在 load 时原子执行——outcome/settlement 按 3.12.1 表从 phase 推导；若同 ID 并存 intent 则合并合同字段（digest 不一致 → store fatal）；无并存 intent 的 legacy entry 合同字段留空并标记 `legacyV1: true`（不参与 contract-backed capability 签发——fail closed，不冒充完整权威）。未知 version → store fatal。

adapter version 演进后，resolution 校验 authority.adapterVersion 与当前注册 adapter/reconciler version——不得用新 reconciler 解释旧 action。

#### 3.12.3 Opaque authorization bundle

production bundle 改为 service 闭包签发的 opaque capability：

- 类型 `TreasuryAuthorizationBundle` 收缩为仅 `__brand` 的不透明句柄——生产调用者只能持有与传递引用，无法读取或重组 token 数组；
- facade 闭包 `bundleRegistry: WeakMap<object, BundleRecord>` 保存 legs 与 cohort（owner canonical identity、policy identity/version/digest、contractId/contractDigest、transactionId、actionKind、adapterVersion、epoch、全部 revision、service generation、tick、签发时各 leg 授权额度）；
- 同一 bundle 的全部 legs 必须同 owner、同 policy、同 epoch、同 revision cohort——签发时原子校验，任一不符整体拒绝；
- 验证只认对象身份（registry 命中）——JSON round-trip 副本、手工构造对象、品牌字段伪装一律失败；
- bundle 生命周期：`active → redeemed`（一次性）——成功交给 tentative 后终态；tick/service generation/相关 revision 变化后失效。

`executeTreasuryActionContract` 只接受 opaque bundle：裸 token 与 token 数组返回 `authorization_invalid`；test-only token 路径经独立 test harness（不在生产 service 接口上）。

#### 3.12.4 批量原子 redemption

kernel 方法 `redeemAuthorizationBundle`（executePreparedAction 的 redemption 阶段调用）：

1. 只读预验证：bundle registry 身份 + cohort 一致性（contract 匹配/tick/generation/revisions/policy digest 与当前 resolver 一致）+ 全部 legs 逐项校验 + 联合 posting coverage——零状态变化；
2. 构造 staged change（纯数据）：每 leg 的授权预算减少、capacity 预算减少、bundle registry 终态、tentative 接管关系；
3. 一次发布：按序 apply 全部 staged 项。注入点（测试 fault injector）：`first_leg`/`middle_leg`/`last_leg`/`before_budget_publish`/`before_tentative_handoff`/`before_bundle_state`——任一触发即回滚已 apply 前缀（budget/capacity 恢复、bundle 保持 active、tentative 不残留），并写入 `internal_authorization_fault` write-fault marker（阻断后续 writer）；
4. 成功路径 budget→tentative 恰好一次；重复 redeem 被终态拒绝，不重复释放。

不再循环调用单 token consume；不依赖"预验证后理论不会失败"——apply 阶段的任何异常同样回滚并进入 internal fault。

#### 3.12.5 Writer kernel 双边界

- 生产可见 `TreasuryService`：beginTick/endTick、observation 系列、commitments、query、authorizeTreasuryActionContract、executeTreasuryActionContract（actionContracts 模块函数）、issueTreasuryReconciliationCapability、service-private resolution 方法（3.12.8）、metrics/审计/容量视图。
- 内部 `TreasuryWriterKernel`（raw authorize、token consume、bundle redeem、prepare、execute prepared、direct commit/abort、capability register/consume kernel）：经 `kernelChannel.ts` 导出的 unique symbol `TREASURY_WRITER_KERNEL` 以 non-enumerable 属性挂载在 service 运行时对象上；公共类型不含该成员；treasury 协议栈内部模块（actionContracts 等）经 symbol 取得。
- `testHarness.ts`（测试专用，架构扫描白名单）：`treasuryTestService(service)` 返回公共方法 + 低层 kernel 方法的联合视图，供既有测试与协议实验使用；不在生产导出面。
- 架构测试全量扫描 `src/**/*.ts`：非 treasury 生产模块不得 import kernelChannel/testHarness 或引用 kernel symbol；新文件自动受约束；不依赖 @internal 注释作为边界。

#### 3.12.6 Contract digest AC3

AC3 在 AC2 成分（canonical encoding version、action kind、adapter version、transactionId、canonical args、canonical postings、canonical structures）之上绑定：`durablePayloadVersion`、`durablePayload` 的稳定 hash、`reconciliationContractVersion`（adapter 提供 reconciler 时必填 durable facts）。durable facts 变化 → digest 变化；同 adapter version 下 payload 变化不得复用旧授权（digest 已变）；contractId 与 digest 一一对应。固定 test vector（treasuryTransactionIdVectors）防编码无意漂移。

#### 3.12.7 Intent 完整 identity 与幂等冲突

intent v3 新增 `authorizationDigest`（bundle digest，contract 路径必填——不再 optional 永缺失）、`ownerIdentity`、`policyIdentity`。`already_present` 判定从 transactionId 单键升级为完整 identity 元组：transactionId、digest、contractId/contractDigest、actionKind、adapterVersion、authorizationDigest、ownerIdentity、policyIdentity、canonical postings、structure facts、durable payload/version、outcome、settlement——全部一致才幂等；任一不同 → `intent_conflict`（fail closed，不静默接受不同 contract）。read-back 验证覆盖全部 identity 字段；低层 test path 写入的同 ID 旧 intent 不被 production contract 接管。

#### 3.12.8 Service-private resolution

resolution 对外入口成为 service 方法（`resolveUnresolvedTransaction`，按 evidence 结论路由 committed/not-executed/uncertain）；kernel 不再公开接受结构兼容 authority——resolve 逻辑在 service 闭包内执行，generation 完全内部。capability 处理顺序重排：

只读验证对象身份 → 只读验证 tick/generation/未使用 → 验证 stores 健康 → 解析 unresolved authority → 校验完整 contract/bundle/outcome identity（contract-backed authority 的 contractId/contractDigest/adapterVersion/durablePayloadVersion/actionKind/executionOutcome/authorityKind/reconcilerVersion **全部必存在且完全匹配**——弱 optional 检查删除）→ 校验 observation/evidence → 校验 resolution slot → 写 staged resolution intent → **此时才消费 capability** → 执行 resolution 状态转换。

staged resolution intent 写入前发生任何拒绝，capability 不被烧掉；staged 写入后即使 capability 已消费，跨 global reset 仅凭 durable staged state 恢复。resolution 管理入口不得被生产 tick 自动调用（架构测试守护）。

#### 3.12.9 Treasury-owned policy authority

`policyAuthority.ts`：注册制 policy resolver（`policyId`/`policyVersion`/`evaluate(context) → decision{strategicReserve, resourceFloor, withhold, emergencyOverride, digest}`）；注册边界集中管理（架构测试守护）。production contract authorization 不接受调用方 withhold——每资源授权额度由 resolver 决策计算；bundle 绑定 policy identity/version/digest 与计算结果摘要；redemption 预验证比较当前 resolver digest（policy 变化 → 旧 bundle 失效）。无注册 resolver 时 production 授权 fail closed（`policy_not_ready`）。emergency override 必须显式、可审计、版本化。自由字符串 policy name 不赋予权威。完整 Budget Service 明确延期。

#### 3.12.10 统一 write readiness

单一内部评估器 `evaluateTreasuryWriteReadiness(purpose)`：一套 blocker 枚举（lifecycle/staleness/write-fault marker/reservation 面/receipt 面/intent 面/quarantine 面/resolution 面/recovery slot/policy/authorization 容量）、一套优先级、一套状态来源（store health cache + 计数器，O(1) 或已缓存）。使用方：query 的 writeAdmission 视图、contract authorization 前置、prepare/execute 的独立复查（TOCTOU 防护）、metrics diagnostics。三处不再各自拼装条件。

#### 3.12.11 Structure binding canonical authority

binding identity 为受控判别联合：`{kind:"governed_location", roomName, locationKind}` 与 `{kind:"game_object", objectId, expectedType?, expectedRoom?}`；label 降级为纯诊断字段（不作为权威 key）。构建期：posting 自动 binding 与 adapter 声明 binding 重合时——identity 完全相同则合并，label 相同但 identity 不同则拒绝 contract；所有 required structure 构建时必须真实存在（`undefined` 一律拒绝，不存在 `undefined === undefined` 通过）；object-ID binding 验证对象存在、类型、room 归属。执行期：fresh observation 重验全部 required structure 存在且 incarnation 一致，不存在或被替换 → 拒绝（bundle 不消费）。快照容器使用 Map + 序列化为数组（`__proto__`/`constructor` 等特殊 label 不污染原型链）。structure facts 进入 contract digest（3.12.6）与 durable authority（3.12.2）。

#### 3.12.12 Canonicalization 反射异常边界

canonicalEncoding 的全部反射操作（`Object.getPrototypeOf`/`getOwnPropertyDescriptor`/`keys`/`getOwnPropertySymbols`/property value 读取/array iteration）置于统一 try/catch 边界：revoked Proxy、throwing trap、异常 descriptor 一律返回结构化 rejection（`reflection_fault` detail），不抛出、不中断 tick；getter 仍然零调用（descriptor 检查先于任何 value 读取）。public contract build 入口整体异常安全：内部编程错误（非反射类）同样捕获并返回明确 `canonicalization_fault` rejection——callback 零调用、授权与 contract registry 零变化。

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
