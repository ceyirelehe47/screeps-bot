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

### 3.13 第十一轮：Immutable Registries & Durable Cohort Closure

#### 3.13.1 Pre-execution authorization fault authority

`internal_authorization_fault` 的固定事实：execution outcome = `not_started`、authorization 状态已完整回滚（预算/容量/消费标记原样恢复、bundle 保持 active）、Game callback 未调用。当前只写全局 write-fault marker——marker 锁定全部 writer，但该 transaction 无 quarantine/intent entry，现有 fault resolution 协议（authority 来自 quarantine/intent）对其 `not_found`，marker 永不解除 → 永久锁死。

修复：`Memory.runtime.treasury.authorizationFaults`（version 1，entry key `"af:"+transactionId`，上限 64，load 全量验证，未知版本/损坏 fail closed）。redemption 注入故障回滚后、写 marker 前写入 entry：transactionId、contractId/contractDigest、actionKind、authorizationCohortDigest（有 cohort 时）、authorizationDigest、canonical postings（≤32 腿）、faultTick、`outcome:"not_started"`、`rollbackConfirmed:true`、source、有界 detail。恢复协议：`resolveUnresolvedTransaction` 的 unified authority 纳入 authorizationFaults 第三来源（`authorityKind:"pre_execution_authorization_fault"`）；该 kind 不需要 reconciliation capability（协议已证明 Game 未执行）——要求显式 `acknowledgeRolledBack:true`；验证完整 identity（digest + cohort digest）后写 not-executed final tombstone（`preExecution:true` 标志，进 cross-store proof 语义）→ 清 marker → 删 entry（幂等：tombstone 存在即 already_resolved）。其他 fault phase 的 authority 走 capability 路径不变；capability 路径遇到 pre-execution authority 拒绝；无任何无条件 clear-marker 入口。

#### 3.13.2 Immutable adapter registry

注册时快照化：`registerTreasuryActionAdapter` 提取固定函数引用（validate/derivePostings/execute/structureBindings/durableFacts/reconcile）+ 受控元数据，构造冻结 registration record——registry 不保存调用方可变对象；`findTreasuryActionAdapter` 返回冻结视图（结构兼容、内部 record 不泄漏）。每次合法注册生成 `registrationId = hash("adapter:"+kind+":"+version+":"+seq)` 与递增 registry generation；registration identity = `kind@v{version}:{registrationId}`。同 kind+同 version 重注册：同实现（全部函数引用相同）幂等，不同实现拒绝；替换须更高 version（contract 绑定 registration identity + version，演进后旧 contract 失效）。`sealTreasuryAdapterRegistryForProduction()` 后一切动态注册拒绝（生产装配点 runtimeServices.ts 调用；架构测试守护 seal 只在生产装配模块）。adapter 函数异常边界：validate/derivePostings/structureBindings/durableFacts 抛错 → `adapter_fault(op)` 结构化 contract 拒绝（callback 零调用）；execute 抛错 → 既有 execution unknown 协议；reconcile 抛错 → capability 签发拒绝（`reconciler_fault`）、authority 保持隔离。registry revision（成功注册计数）进入 write readiness（诊断）、contract 与 bundle cohort。

#### 3.13.3 Immutable policy registry + Treasury-computed decision digest

policy 注册快照化：policyId（非空字符串）、policyVersion（正安全整数）、evaluate 函数引用固定，record 冻结；同 policyId+version 不同 evaluate 实现拒绝；替换须提升 version 或换 policyId；可 seal。decision 输入接口删除 resolver 自报 digest——resolver 只返回业务事实 `{withhold, strategicReserve, emergencyOverride, auditReason?}`；Treasury 完整验证每字段（withhold/strategicReserve 非负安全整数、emergencyOverride 布尔）后自行计算 decision digest：`hash("policy-decision:"+registrationId+":"+canonicalContext+":"+withhold+":"+strategicReserve+":"+emergencyOverride)`，canonical context 绑定 contractId/contractDigest/actionKind/resource/sorted rooms/ownerIdentity/tick/policy registration identity。evaluate 抛错 → `policy_fault` fail closed。bundle 绑定 policyRegistrationId + 每 digest 的 cohort 串；redemption 验证 exact registration identity（当前 registry record 的 registrationId 相同）而非字符串前缀。

#### 3.13.4 Durable authorization cohort

bundle record 内的 cohort 事实持久化为有界 canonical `TreasuryAuthorizationCohortFacts`：ownerIdentity、policyId/policyVersion/policyRegistrationId/policyDecisionDigest（排序拼接 hash）、emergencyOverride、epochSeq、五元 revisions、adapterRegistrationId、contractId/contractDigest、transactionId、每 leg canonical 摘要（resource/sorted rooms/sorted locations/amount 长度前缀文本的 hash，≤8）、receiver capacity 摘要（capacityRequirement canonical 文本或 "none"）、issuedTick、authorizationDigest。`authorizationCohortDigest = hash("cohort:"+全字段 canonical 文本)`——owner/policy decision/emergency override/revision/leg/receiver capacity/contract 任一变化即变化。cohort facts（≤~400 字符）持久化进 intent/quarantine entry；unresolved authority、reconciliation capability、resolution prevalidation 均携带并比较 cohortDigest。不持久化 heap token 对象。

#### 3.13.5 统一 durable action identity

`durableAuthorityIdentityDigest = hash("durable-identity:"+transactionId+":"+canonicalDigest+":"+contractId+":"+contractDigest+":"+adapterRegistrationId+":"+actionKind+":"+canonicalPostings+":"+structureDescriptors+":"+durablePayloadText+":"+cohortDigest+":"+ownerIdentity+":"+policyIdentity+":"+source)`——全部为不可变事实；outcome/settlement 是可变 workflow 事实不进 identity（由语义矩阵与单调状态机保护）。intent v4/quarantine v3 entry 携带该 digest；intent 首写同 ID 比较变为 identity 比较（相同 → already_present 幂等；不同 → `identity_conflict`，store 原数据不动）；read-back、intent→quarantine 转移、quarantine 幂等、双权威一致性、capability 签发、resolution prevalidation、global reset recovery 全部以该 digest 为唯一权威比较。legacy entry（迁移时无法补全 cohort/descriptor 字段）identity digest 为空——空对空才匹配，且 legacy authority 不参与 contract-backed 路径。

#### 3.13.6 Outcome/settlement/phase 语义矩阵 + cross-store finalized proof

单一矩阵权威（semanticMatrix.ts）：每 outcome 的合法 settlement 集合——`not_started ∈ {ready, faulted(仅 pre-execution authorization fault), finalized}`、`started_unknown ∈ {executing, faulted, quarantined, resolving, finalized}`、`returned_non_ok ∈ {pending_abort, faulted, quarantined, resolving, finalized}`、`returned_ok ∈ {pending_commit, faulted, quarantined, resolving, finalized}`、`aborted_final` 仅 legacy 终态；quarantine phase→outcome 映射表（commit 类 → returned_ok、abort-failed → returned_non_ok、execution-unknown 类 → started_unknown、internal_authorization_fault → not_started）。progressTreasuryIntent 的目标组合必须过矩阵；intent/quarantine load 全量验证含矩阵检查——非法组合 → store unhealthy（fatal）→ authority 不可签发、resolution 拒绝、write readiness=false。cross-store finalized proof（recovery/semantic coordinator 在 load 与 beginTick 恢复时执行）：`finalized+returned_ok` 必须存在 settled receipt 或 final committed tombstone；`finalized+returned_non_ok/not_started` 必须存在 final not-executed/rolled-back tombstone（pre-execution tombstone 计入）；proof 缺失 → semantic store fault（fail closed，entry 保留不自动删除）；看到 finalized 不再直接释放 entry。

#### 3.13.7 Legacy quarantine 隔离

quarantine v3 entry 保留 `legacyV1` 标记（v1 迁移且无并存 intent 补全）。`issueTreasuryReconciliationCapability` 遇 legacyV1（或缺 contract/actionKind 完整事实）的 authority → `legacy_authority_isolated` 拒绝（不用当前 adapter reconciler 解释旧动作）；显式诊断 API `treasuryLegacyQuarantineDiagnostics()`（只读冻结快照）列出隔离 entry 摘要；entry 保持不动，只能显式人工 migration/reconciliation 处理；新 adapter version 不解释 legacy action（version mismatch 语义不变）；legacy migration 不伪造缺失的 contract/cohort identity。

#### 3.13.8 Resolution kernel 封闭

resolutionKernelChannel.ts（类比 writer kernel）：unique symbol `TREURY_RESOLUTION_KERNEL` non-enumerable 挂载于 service 运行时对象；kernel 接口含 capability validate/consume 与 staged resolution 内部操作。faultResolution 的两个 resolve 函数改为从持有对象读取 symbol kernel（伪造对象无 non-enumerable symbol 属性一律拒绝）；模块级 WeakSet 注册机制删除（`registerTreasuryResolutionKernelForService` 移除）。公共 TreasuryService 类型删除 `consumeReconciliationCapability`/`treasuryServiceGeneration`/`treasuryResolutionGuard`；testHarness 视图重挂两个 kernel symbol（嵌套包装支持）。架构测试：resolutionKernelChannel 的 import 白名单仅 facade/faultResolution/testHarness/架构测试自身；生产源码不得引用。capability 消费仍只在 staged resolution 写入成功后。

#### 3.13.9 完整 structure descriptor（AC4）

`TreasuryActionStructureBinding` 升级为完整 canonical descriptor：`bindingKind: "governed_location"|"game_object"`、`role: "source"|"target"|"fee_source"|"production_structure"|"auxiliary"`（受控枚举）、roomName、locationKind、objectId?、expectedType?、expectedRoom?、label?（仅诊断）、`required: boolean`（默认 true）、descriptor version（常量 1）。posting 自动 binding：负腿 role=source、正腿 role=target（同 location 双向时两条 descriptor）；adapter 显式 binding 声明 role。descriptor canonical 文本（全部字段长度前缀）进入 AC4 digest（替换 AC3 的 label→structureId 快照文本）；同 (identity, role) 去重、同结构不同 role 保留两条（不静默合并）、同 label 不同 descriptor 拒绝；required descriptor 的结构构建时必须存在、执行前 incarnation 重验（语义不变）。intent v4/quarantine v3 的 structureFacts 升级为完整 descriptor 数组（≤16，v3 简化三元组迁移为 governed_location/auxiliary/required）；descriptor 进入 durableAuthorityIdentityDigest；reconciler facts 携带完整 descriptor。

#### 3.13.10 facade 职责拆分（行为保持）

四个内部模块从 facade 抽出（依赖方向单向、无新循环依赖；actionContracts 对 facade 是 type-only import）：

- **authorizationLedger.ts**：authorization registry/budget（token WeakSet/Map、流出与容量预算）、bundle registry 与签发（authorizeTreasuryActionContract 主体：readiness 前置、policy 决策与 Treasury digest、cohort 构造、原子签发与回滚）、批量原子 redemption（staged 发布/前缀回滚/pre-execution fault authority 写入）、只读 bundle 解析、legs 预验证。
- **resolutionAuthority.ts**：capability registry（WeakSet）、validate/consume、resolution kernel 组装与挂载、resolveUnresolvedTransaction 的 capability 结论路由（含 pre-execution acknowledge 路由）。
- **recoveryCoordinator.ts**：intent↔quarantine 事实转移、semantic matrix 校验接入、cross-store finalized proof、pre-execution fault authority store 读写与恢复、beginTick 恢复分级。
- **readinessCollector.ts**：从各 store 收集 write-readiness 状态输入并调用 evaluateTreasuryWriteReadiness（query/authorize/prepare 三处共用同一收集器）。

facade.ts 保留生命周期编排（beginTick/endTick/epoch/observation）、prepared handle registry、executePreparedAction 执行顺序编排、公共 read/query facade 与模块组装；不再直接持有 bundle Maps/capability WeakSets/resolution kernel 细节。公开行为与错误语义保持兼容（现有测试不改断言通过）。

#### 3.13.11 临时脚本清理与 evidence 修正

删除 `src/runtime/treasury/fix-ac3.cjs` 与 `src/runtime/treasury/fix-resolution.cjs`（Round 10 开发期的一次性文本替换脚本，写死本地 Windows 路径，不属于运行时代码）。Round 10 evidence 的"已移除临时脚本"陈述修正为如实记录：fix-ac3.cjs 当时未被移除并误入提交，于第十一轮删除；历史提交事实不篡改。Round 11 evidence 明确记录该修正与删除的 commit。

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

### 3.14 第十二轮：Durable Integrity Proof & Stable Reconciler Identity

#### 3.14.1 持久不变量（新增）

1. write-fault marker（internal_authorization_fault）发布前必须存在可读回且完整身份一致（可重算）的 durable authority；authority 写入失败时发布显式 forensic phase marker（internal_authorization_fault_forensic），只能经显式 forensic acknowledge 通道解除——不存在"marker 存在但 authority 不存在"且不可解释的状态。
2. 同 transaction ID 的不同 action attempt 不得共享旧 tombstone / receipt settlement proof / finalized proof：一切 already_resolved 与 finalized 释放路径都按完整 attempt identity（digest + contractDigest + cohortDigest + durableIdentityDigest）匹配；proof 缺少现代身份事实（legacy proof）对现代 attempt 判定 insufficient（fail closed）。
3. digest 是持久事实的派生证明而非独立可信事实：cohort digest 与 durable identity 一律由持久事实重算（单一 identityProof helper）；篡改事实而未同步 digest → store unhealthy / authority inconsistent / identity_conflict；repair 绝不覆盖 digest。
4. global reset 后 reconciler 语义不漂移：authority 绑定的 stable semantic identity 与当前 registry 不一致（或缺失）→ 不得由当前 reconciler 解释（隔离）。
5. 不完整 authority 明确隔离：legacyV1（v1 迁移残留）与 forensic（intent 缺失防御性直写）是可区分的两种隔离来源，均不参与普通 capability/resolution。

#### 3.14.2 store 版本与迁移

| store | 版本 | 迁移行为 |
|---|---|---|
| authorizationFaults | v1 → v2 | v1 entry 身份事实不完整 → 原子迁移标记 legacyV1（仅按 digest 匹配的旧协议解除）；损坏 fatal 原数据保留 |
| resolutions | v2 → v3 | entries 原样保留；identity 字段缺省 = legacy proof（不得证明现代 attempt） |
| receipts | v1/v2/v3 → v4 | 纯数字 value → { settledAtTick }（无身份 legacy proof）；v4 写入绑定 attempt 身份 |
| intents / quarantine | 不升版本 | 新增可选字段（adapterRegistrationId/adapterSemanticIdentity/forensic）校验兼容缺省——additive 且不改既有字段语义 |

#### 3.14.3 stable adapter/reconciler identity 语义

- `semanticIdentity` 为 adapter 作者显式声明的稳定字符串（1..128），随代码版本化，注册时冻结；语义演进必须升级 adapter version（同 kind/version 不同语义身份被 registry 拒绝）。
- 不得以函数源码字符串/对象地址/注册序号充当；per-global registrationId 保留用于阻止当前 global 内动态替换（与 Round 11 一致）。
- 绑定点：AC4 contract digest（asi 段）、authorization cohort facts 与 cohortDigest、durableIdentityDigest（asi 段）、intent/quarantine/authorization-fault entry、reconciliation capability 签发校验。低层（非 contract）路径在 intent 写入时从当前 registry 绑定（与 contract 路径同一 durable identity 输入源）。

#### 3.14.4 legacy 与 forensic isolation 的区别

- legacyV1：v1 quarantine/fault store 迁移残留——历史 schema 的数据，缺合同事实；诊断 treasuryLegacyQuarantineDiagnostics。
- forensic：recovery coordinator 在 intent 缺失时防御性直写的最小 quarantine——正常运行不应出现的内部不变量破坏痕迹（两阶段 commit fault 亦归此类）；诊断 treasuryForensicQuarantineDiagnostics（reason=intent_missing_fallback）。
- 两者共用隔离机制（不签发普通 capability、不自动 resolve）但诊断原因可区分，不得互相冒充。

#### 3.14.5 digest 重算位置

新 entry 写入前（fault store / intent / quarantine 幂等与转移）；写入后 read-back（fault store）；global reset 首次 load 全量验证（intent/quarantine/authorization-fault store shape 校验）；capability 签发（resolveTreasuryUnresolvedAuthority 事实校验）；resolution prevalidation；intent→quarantine 转移；显式 repair（重算失败拒绝且不覆盖）。

#### 3.14.6 structure binding union

bindingKind 在 validateStructureBindings 唯一推导并显式写入 binding；governed_location 禁止 objectId/expectedType/expectedRoom；game_object 必须携带 objectId；构建期验证、执行前 revalidation、descriptor 派生、reconciler 输入全部按同一 discriminant 分支。

### 3.15 第十三轮：Receipt Migration Safety & Modern Proof Strictness

#### 3.15.1 normalized receipt lookup 与 receipt v5

- 单一 lookup 结果类型（absent / legacy_committed / modern_committed / corrupted / incompatible）成为 receipt 一切读写路径的判定入口；`typeof value === "number"` 与"只认对象"的分裂判定全部移除。
- receipt store v4 → v5：TreasurySettlementProof 增加显式 `level: "modern" | "legacy"`；modern 必填 digest 与 durableIdentityDigest（16 hex），可选 contractDigest/authorizationCohortDigest；legacy 禁携带任何身份字段。
- v3/v4 → v5 迁移定级规则（一次性、版本化）：数字 value → 显式 legacy committed proof；完整身份（digest + durableIdentityDigest）→ modern（保留全部身份字段）；部分身份字段 → 无法安全定级 → 迁移 fail closed（原 store 保留）。迁移临时结构全量校验（key/transactionId/value/entryCount/nextExpiryTick/编码碰撞）后一次性原子替换；重复运行幂等。
- 未迁移 v1/v2/v3 store 的只读查询：合法数字 value 零写识别为 legacy committed（不再判 corrupted）；v1 裸键以 raw key + 编码 key 双探测保持 O(1)；unknown version 仍 fail closed。

#### 3.15.2 already_settled 零发布与 commit 结果细化

- commitSettledReceipt 结果细化为 written / already_settled_match / already_settled_insufficient / identity_conflict / fatal；identity 未提供（compat 单阶段）时 existing 一律按已结算拒绝（零发布）。
- compat 单阶段（writeAcceptedTransaction）：非 written 结果 → 返回 already_settled，零 journal/overlay/capacity delta/heap settled cache/onRecorded/projectionRevision/tentative。
- staged commit 的 receipt 发布段：fatal/identity_conflict/insufficient → TreasuryCommitFaultError（receipt_publish，不发布 heap）；already_settled_match → 幂等继续（heap 首次发布）。
- post-callback 防御段（commitPreparedTransaction 的 settled-before-commit 检查）升级为完整 proof identity 比较：match → 幂等 already_settled（不重复 heap 发布、释放 intent）；legacy/insufficient / conflict → 返回明确拒绝 reason（settlement_proof_insufficient / identity_conflict）→ 上层 executed_unsettled 路径 quarantine 接管 authority、retryForbidden 阻断自动重试，不发布 heap committed state。

#### 3.15.3 identity-aware refresh 与 staged recovery 严格化

- refreshSettledReceiptForResolution：absent → 写 modern proof；modern+match → 仅刷新 settledAtTick（保留身份字段）；modern+conflict → blocked（保持 resolving authority）；legacy/insufficient → blocked（不覆盖、显式人工处理）；corrupted → fatal。blocked 与 fatal 都保留 authority、递延 finalize。
- recoverStagedResolutions 全部分支以 relation === "match" 为唯一释放许可；conflict 与 insufficient 独立计数（identityConflicts / identityInsufficientBlockers）与诊断，不再使用 !== "conflict"。

#### 3.15.4 显式 authorityLevel 与 modern required 矩阵

- intent v5 / quarantine v4 / authorization-fault v3 entry 携带显式 `authorityLevel: "modern" | "legacy" | "forensic" | "lowlevel"`。
- 版本化迁移一次性定级：modern 矩阵全齐 → modern；forensic 标志 → forensic；legacyV1 → legacy；仅 durableIdentityDigest（无完整 contract 事实）→ lowlevel；完全无现代身份事实 → legacy；定级后 load 不再推断。
- modern required 矩阵：contractId、contractDigest、actionKind、adapterVersion、adapterRegistrationId、adapterSemanticIdentity、durablePayload、durablePayloadVersion、structureFacts（每项过共享 descriptor validator）、authorizationCohort 与 authorizationCohortDigest 成对、durableIdentityDigest、policyIdentity、postings。任一缺失 → store unhealthy（fail closed，绝不降级 legacy）；authorityLevel 缺失/未知枚举（新版本 store）→ unhealthy。
- capability 签发拒绝 legacy/forensic authority（既有 legacyV1/forensic/semanticIdentity 检查保留，authorityLevel 作为显式第一道判定）。

#### 3.15.5 共享 validator 模块

- cohortValidation.ts：唯一 validateTreasuryAuthorizationCohortFacts（全字段 + 上限 + 安全整数 + nested + transaction/entry 交叉一致性），intent/quarantine/authorization-fault 三 store 共用；canonical 重算（recomputeTreasuryCohortDigest / verifyTreasuryEntryIdentity）全部经 try/catch Result 化——throwing Proxy/缺字段/null 返回结构化错误，永不中断 tick。
- structureDescriptorValidation.ts：唯一 descriptor validator（governed_location 禁 objectId/expectedType/expectedRoom；game_object 必填 objectId + structureId/objectId 语义一致）；intent/quarantine/authorization-fault 的持久 structureFacts 校验、durable identity 重算的 structureFacts 前置校验、actionContracts 的 descriptor 语义共用；分支权威唯一（bindingKind）。

#### 3.15.6 forensic attempt identity

- write-fault marker 扩展可选 attemptIdentity（contractDigest / authorizationCohortDigest / durableIdentityDigest）——原子 redemption 故障发布 forensic marker 时携带故障前已计算的完整 identity。
- forensic resolution tombstone 写入绑定 marker.attemptIdentity；already_resolved 幂等比较 treasuryAttemptIdentityRelation（完整 identity）；marker 无 identity（旧数据）→ legacy forensic proof，遇现代 tombstone/attempt 判 insufficient/conflict 不得 already_resolved。
- acknowledgeRolledBack 必填保留；无新增无条件 clear 接口。

#### 3.15.7 性能与可观测性

- legacy receipt 只读识别 O(1)（双键探测）；receipt 迁移每 heap 生命周期至多一次；正常 admission O(1)；identity relation 与 proof-level 校验 O(1) 或与单条 cohort/descriptor 线性；staged recovery 对单条 insufficient 仅计数跳过（不重扫 receipt 全表）。
- 新增 counters：receipt legacyLookups、identityMatchResults / identityConflictResults / identityInsufficientResults、proofLevelRejections；cohortValidation cohortValidationFailures；resolutionStore identityConflicts / identityInsufficientBlockers。


### 3.16 第十四轮：Resolution Proof Closure & Authority-Level Integrity

#### 3.16.1 三方 committed proof 闭环（recoverStagedResolutions）

释放条件从"receipt tick 足够 + tombstone↔authority match"升级为三方严格 match：

```text
durable authority ──┐
resolution tombstone ├── 三方 match + receipt.settledAtTick ≥ tombstone.settledAtTick
settlement receipt ──┘        才释放 authority / 清 marker / finalize
```

- tick 与 identity 是两个独立条件：receipt tick 充分不证明 receipt 属于当前 attempt（旧 attempt 在更晚 tick 写入的 proof / legacy proof 均 fail closed）。
- 无论 tick 是否充分，恢复第一步读取完整 receipt proof（readTreasurySettlementProof，O(1)）并按 tombstone 完整 attempt identity 验证 relation；receipt 不存在或 tick 不足才走 identity-aware refresh，成功后重新读取持久 proof 再验证。
- authority 已不存在（前一 global 已释放、finalize 前中断）：receipt ↔ tombstone match + tick 足够即补完成 finalize；conflict/legacy/insufficient 保持 resolving、write readiness 阻断。
- proof class ↔ authority 等级释放权限：identity-bound 只释放 modern、lowlevel 只释放 lowlevel、legacy/forensic 不释放 modern/lowlevel（错配 insufficient 阻断并计数）。

#### 3.16.2 authority level 兼容矩阵与 lowlevel 严格语义

| 组合 | 判定 |
|---|---|
| modern + modern | 允许继续比较完整 durable identity（durable/cohort digest 双方完整存在且相等、contract/adapterSemantic 一致） |
| lowlevel + lowlevel | 严格低层 identity（durable 完整且相等） |
| legacy + legacy | 受控 legacy 比较（digest/kind/postings） |
| forensic + forensic | 同一隔离记录才可合并 |
| 任何跨等级 | inconsistent fail closed |

lowlevel 不再是"modern 矩阵未通过的其余情况"：required（digest/kind/source/postings + durableIdentityDigest + lowlevelSource 来源标记）与 forbidden 现代字段（contractId/contractDigest/cohort(+digest)/authorizationDigest/adapterRegistrationId/ownerIdentity/policyIdentity）双向矩阵；运行时低层写入的 durable identity 由事实确定性派生（与 facade 同源）；production contract 路径的 partial-modern（contract 与 cohort 不成对）以 authority_invariant_violation 拒绝（callback 零调用）。

#### 3.16.3 迁移定级（classifyTreasuryAuthorityLevelForMigration）

- 带显式 authorityLevel 的上一版 entry（intent v5 / quarantine v4 / fault v3）：按 priorLevel 复验——显式 lowlevel 满足严格矩阵 → lowlevel（补 migrated-lowlevel@v1）；显式 modern 矩阵缺失 → forensic（残缺 modern 不得变 lowlevel）；显式 legacy 携带现代字段 → forensic；forensic 保留。
- 更旧版本（无显式等级）：forensic 标志 → forensic；legacyV1 → legacy；modern 矩阵完整且重算一致 → modern；完全无现代事实 → legacy；**其余 partial-modern → forensic（绝不 lowlevel）**。
- cohort XOR / digest 与事实重算矛盾 → fatal（原 store 保留）；迁移临时 entries 全量验证后原子替换、幂等。

#### 3.16.4 tombstone 显式 proof level（resolutions v4）

proofLevel ∈ { identity-bound, lowlevel, legacy, forensic }，required/forbidden 矩阵：

- identity-bound：required digest + contractDigest + cohortDigest + durable（modern contract authority 的完整绑定；唯一可释放 modern authority 的 class）；
- lowlevel：required digest + durable，禁止 contract/cohort digest；
- legacy：禁止任何现代身份字段（replay-only）；
- forensic：允许部分字段（显式隔离协议，不参与普通 capability resolution）。

同 id 覆盖（resolving → final）只允许保持同一 proof level 与完整 identity；v3 迁移按字段完整性定级（部分 → forensic，不"尽力猜 modern"）。

#### 3.16.5 durable 发布协议（durablePublication.ts）

三个 authority store 一致使用：写入前候选 identity 重算（不一致拒绝、bookkeeping 不变）→ Memory 发布 → read-back 从持久副本重算 + 23 项完整身份字段深度比较（等级/来源标记/digest 族/cohort/descriptors/postings/outcome/settlement/source）→ 不一致回滚写入并恢复 entryCount/revision/updatedAt（当前 global 即不可信，不等下次 reset 的 load）。intent → quarantine 转移的 read-back 同一比较器 + lowlevelSource 随事实转移。

#### 3.16.6 authorization-fault 健康门禁

轻量 probe O(1) 检查 metadata 矛盾（version 集合/entries 对象/entryCount 非负安全整数且不超容量/updatedAt 合法）；write readiness 的 fault source 与 authorizationSafe 联合判定升级为完整 validation（ensureTreasuryAuthorizationFaultStoreValidated：首次有界全表扫描、heap 缓存后 O(1)、store 不存在零写）——损坏 entry 不得等 redemption fault 后才发现，授权与 callback 在损坏期间零发生。

## 11. 第十五轮设计：resolution 单调性与跨 store authority 释放

### 11.1 新增窄职责模块

```
src/runtime/treasury/
  resolutionStateMachine.ts   tombstone 不可逆状态机（纯函数，唯一权威）
  committedProofVerifier.ts   三方 committed proof verifier（纯函数；normal/recovery 共用）
  authorityIdempotence.ts     authority-class same-ID 幂等比较器（三 store 唯一权威）
  forensicProvenance.ts       显式 forensic provenance 语义与形状校验
  durableSnapshot.ts          有界深冻结快照 helper（普通对象/数组、有界深度与键数）
```

依赖方向（无循环）：resolutionStore → { resolutionStateMachine, committedProofVerifier, unresolvedAuthority, forensicProvenance, durableSnapshot }；faultResolution → { committedProofVerifier, unresolvedAuthority }；三 store → { authorityIdempotence, durablePublication }；facade → resolutionStore（capability gate 只读单条 tombstone）。facade 不新增内联协议逻辑；resolutionStore 只承载持久 state 与迁移，不重复实现 authority 解析。

### 11.2 resolution 状态机（resolutions v5）

```text
absent ──create──▶ resolving committed ──finalize(保 identity/结论)──▶ final committed
   │                                            │
   └────────create────────▶ final not-executed   └─(禁止: → final not-executed / → resolving not-executed)

final committed / final not-executed：只允许 exact idempotent 重复写；任何字段差异 = conflict（原数据不动）
final → resolving：拒绝；同 ID 改 digest/proofLevel/attempt identity/actionTick/结论：拒绝；settledAtTick 降低：拒绝
```

- 写入口 `writeTreasuryResolutionTombstone` 内部全部经 `validateTreasuryResolutionTombstoneTransition` 判定（任意调用者无法构造自由状态更新）；recovery 的 finalize 同样先经状态机校验再原地推进 stage。
- v5 新增可选 `forensicProvenance`（显式管理协议证明）；migration-derived forensic（v3 partial / forensic 定级）无 provenance → 永久隔离。
- `deleteTreasuryResolutionTombstone` 收敛为仅 resolving 回滚（final 不可删除；retention 清理仍走独立的 evictExpiredTombstones 通道）。

### 11.3 cross-store authority 状态图

```text
resolveTreasuryUnresolvedAuthority(tx)
  ├─ not_found ─▶ 补完成分支：committed 须 receipt↔tombstone match（verifier）；not-executed 视为释放已完成
  ├─ ok(normalized authority) ─▶ 三方 verifier（tombstone + authority + receipt proof）
  └─ inconsistent ─▶ 零释放：intent 保留 / quarantine 保留 / tombstone 保留 / marker 保留 /
                      authorityInconsistent 计数 / readiness 阻断 / 零 refresh / 零 stage 变化
```

### 11.4 proof level → authority 自动释放矩阵（普通自动 recovery）

| proof level \ authority | modern | lowlevel | legacy | forensic |
|---|---|---|---|---|
| identity-bound | 释放 | 阻断 | 阻断 | 阻断 |
| lowlevel | 阻断 | 释放 | 阻断 | 阻断 |
| legacy | 阻断 | 阻断 | 阻断（replay blocker 保留） | 阻断 |
| forensic | 阻断 | 阻断 | 阻断 | 阻断（仅显式 provenance 流程） |

### 11.5 authority class same-ID 幂等矩阵

| class | same 判定（全部成立） | 任一不成立 |
|---|---|---|
| modern | level 相同；durableIdentityDigest 双方完整且相等；cohort digest 双方完整且相等；contractId/contractDigest 一致 | conflict |
| lowlevel | level 相同；受控 lowlevelSource 相同；durableIdentityDigest 双方完整且相等 | conflict |
| legacy | 完整 legacy signature：transactionId/digest/kind/actionKind/canonical postings/source/legacyV1 全等 | conflict（不再空对空幂等） |
| forensic | forensic reason/provenance 相同；已知 attempt facts 逐字段相等；digest/postings/source/phase/outcome 全等 | conflict / isolated（provenance 不足） |
| 跨等级 | —（永远 conflict） | conflict |

公共前置（全 class）：transactionId、digest、kind、actionKind、canonical postings、source 相等。

### 11.6 durable publication store-specific 验证矩阵

| store | 注入的语义 validator | 共享比较新增字段 |
|---|---|---|
| intent | validateTreasuryIntentEntryShape（含 level 矩阵/outcome-settlement 语义/modern required/cohort/descriptor） | phase、tick、recordedAt、createdAtTick、detail、legacyV1、forensic（深比较）、faultTick、rollbackConfirmed |
| quarantine | validateTreasuryQuarantineEntryShape（phase/outcome/settlement 矩阵/forensic provenance/legacyV1/deltas/contract 事实） | 同上 |
| authorization-fault | validateFaultEntryShape（outcome=not_started、rollbackConfirmed=true、faultTick、detail 边界、authority 矩阵） | 同上 |

回滚统一恢复 entry/entryCount/revision/updatedAt（authorizationFaults 修复为恢复原 updatedAt，不再错写 Game.time）。

### 11.7 committed verifier 复用路径

normal resolve-as-committed、beginTick staged recovery、finalize 补完成、already-resolved 检查 → 同一 `verifyTreasuryCommittedResolutionProof({tombstone, authorityResolution, receiptProof})`。immediate 流程：写 resolving → refresh → **重读持久 proof** → verifier → 通过才释放 → finalize；verifier 失败时 authority 与 resolving tombstone 保留（fail closed，恢复路径继续阻断）。

## 12. 第十六轮设计：attempt rearming 与 execution-fact cohesion

### 12.1 新增窄职责模块

```
src/runtime/treasury/
  attemptRearm.ts              显式 attempt rearm 协议（确定性 child ID 派生 + 受控前置校验；零写）
  executionFactCohesion.ts     跨 store execution-fact 唯一权威比较器（outcome/phase/settlement 矩阵 + 归一化合并）
  resolutionStateSemantics.ts  resolution tombstone 内在持久状态语义矩阵（load/migration/write/read-back/repair 共用）
  durableClone.ts              authority 写入候选的有界深拷贝 helper（写入侧；读取侧见 durableSnapshot）
```

依赖方向（无循环）：attemptRearm → { resolutionStore, unresolvedAuthority, writeFault, identityProof, transactionId }；unresolvedAuthority → executionFactCohesion → { quarantine, writeFault }；resolutionStore → { resolutionStateSemantics, durableClone }；faultResolution → attemptRearm（仅 child ID 派生）；facade → attemptRearm（rearm 入口委托壳）。rearm 协议与 ID 派生不内联在 facade.ts；execution fact 兼容矩阵只有一个权威模块；resolver 的 health-aware 读取集中在 unresolvedAuthority；resolution store 的内在状态 validator 与 transition validator 职责分离。

### 12.2 attempt rearm 状态图（same-ID 不可重试）

```text
business action
   ├─ attempt A（transaction ID A）
   │    ├─ committed → A 终结（receipt + final committed tombstone；同 ID 重放 → already_settled）
   │    └─ not-executed → final not-executed tombstone A（sameIdRetryAllowed=false）
   │                        │ authority 释放 + marker 清理完成后
   │                        └─ 显式 rearm（受控 service 方法，零写）
   │                              └─ child transaction ID B = tr1_<hash(协议版本 ‖ A ‖ A 的 attempt identity 全成分)>
   └─ attempt B（新 transaction identity；contract/bundle/intents 全部绑定 B）
        ├─ B 故障 → 独立 capability/resolution/receipt 生命周期（A 的 proof 不能证明 B）
        └─ B not-executed → 再 rearm → C（A→B→C 链式；每 attempt 最多一个直接 child）

同 ID 直接 prepare：final not-executed tombstone 存在 → rejected(rearm_required) + callback 零调用
rearm 前置：final not-executed tombstone ∈ {identity-bound, lowlevel} + authority not_found + marker 已清 + store 健康
```

child ID 生成是 O(1) 纯函数（现有 canonical tuple + 双 lane FNV-1a hash 基础设施；tr1_ 前缀独立命名空间）；不持久化无界 attempt sequence 表——同 parent 幂等由确定性派生天然保证；跨 global reset 结果恒定。

### 12.3 execution-fact cohesion 矩阵

```text
outcome 对等（任一不满足 → inconsistent，两份全保留）：
  not_started+not_started / started_unknown+started_unknown / returned_non_ok+returned_non_ok / returned_ok+returned_ok
  禁止：returned_ok 与任何非 returned_ok / returned_non_ok 与 started_unknown|not_started /
        started_unknown 与 not_started / aborted_final 与任何运行时事实

phase 类别严格对应（共同 outcome 下）：
  returned_ok   ∈ {receipt_publish, heap_publish, journal_publish, overlay_publish, handle_state, commit_unexpected, ok_pending_commit_unresolved}
  returned_non_ok = action_returned_non_ok_abort_failed
  started_unknown ∈ {executing_at_end_tick, action_threw_execution_unknown}
  not_started   ∈ {internal_authorization_fault, internal_authorization_fault_forensic}

intent settlement 并存集合：
  not_started     ∈ {quarantined, resolving, faulted}
  started_unknown ∈ {executing, quarantined, resolving, faulted}
  returned_non_ok ∈ {pending_abort, quarantined, resolving, faulted}
  returned_ok     ∈ {pending_commit, quarantined, resolving, faulted}
  （ready / finalized 不得与 unresolved quarantine 并存）

归一化合并：outcome=共同值；settlement=双方向更进展一方（ready<executing<pending_*=2<quarantined|faulted=3<resolving=4<finalized=5）；phase=quarantine（write-fault 权威）
```

### 12.4 resolver 四态与 marker 补完成流程

```text
resolveTreasuryUnresolvedAuthority(tx)
  ├─ store health 前置：已存在的 intent/quarantine store 触发 load validation
  │    └─ 任一 fatal → store_unhealthy（附各 store 错误）→ 零副作用（不折叠成 not_found、不选 healthy 一侧）
  ├─ not_found ─▶ final not-executed 补完成分支：
  │      marker 不存在 → 释放与清理均完成（移出 pending-release 索引）
  │      marker 存在 → transaction/digest/attemptIdentity relation=match/phase 矩阵/proof level 全匹配 → 清 marker
  │                → 他属|conflict|insufficient|phase 不兼容 → 保留（markerCleanupBlocked 计数）
  ├─ ok(normalized authority，execution facts 经合并规则) ─▶ 三方 verifier
  └─ inconsistent（identity 或 cohesion）─▶ 零释放全保留 + 独立计数
```

### 12.5 not-executed capability 发布顺序与恢复索引

```text
prevalidate → slot 预检 → consume capability → 写 final not-executed tombstone → 释放 authority → 清 marker → 移出索引
  consume 失败：零持久副作用（无 tombstone、authority/marker 保留）
  consume 成功 + tombstone 写失败：authority 保留（后续 tick 重签发 capability）
  tombstone 成功 + 释放前中断：beginTick pending-release 补完成（12.4）

heap 索引：resolvingIds / pendingReleaseIds（Set<string>）
  load 一次全表重建 → 写入/删除/retention/补完成同步维护
  beginTick：两索引皆空 → O(1) 直接返回（idleFastPath 计数）
  有待处理项 → 只遍历索引 ID；Memory 权威（索引 ID 失效即清理，不作安全 proof）
```

### 12.6 store 版本与迁移

- resolutions v6：新增可选 lowlevelSource（仅 proofLevel=lowlevel；新写入必须携带——v5 及更早的旧低层 tombstone 无此字段为来源不可证明的隔离态）；v2-v4 无 stage 的历史 entry 迁移补终态 stage=final；load 校验接入持久状态语义矩阵（语义非法 → fatal 原数据保留）。
- receipts v6：新增可选 lowlevelSource（modern proof 可携带、legacy 禁带；v5→v6 无损）；低层两阶段路径（无 contract）的 commit/refresh 随 attempt 携带 runtime 来源。
- intent（v6）/quarantine（v5）/authorization-fault（v4）版本不变：本轮只改写入深拷贝与读取快照行为，无持久 schema 变化。
- write-fault marker：无版本变化（写入深拷贝 attemptIdentity、读取深冻结快照）。

## 13. 第十七轮设计：Durable Attempt Lineage & Rearm Capability

### 13.1 新增模块与职责边界

| 模块 | 职责 |
| --- | --- |
| attemptLineage.ts | durable attempt lineage store（Memory 持久、版本 v1、硬容量 64、root/current/next O(1) 索引、状态机、retirement 三段、恢复） |
| retrySemanticIdentity.ts | retry semantic digest 单一权威（modern contract 版 + lowlevel 版；排除 tick/epoch/revision/policy/bundle 事实） |
| lineageBinding.ts | lineage/rearm binding digest 派生与比较（进 intent/quarantine/auth-fault/marker/receipt/tombstone proof 链） |
| rearmCapability.ts | service-issued opaque rearm capability authority（WeakSet 防伪、单次消费、generation/tick 绑定） |
| attemptOccupancy.ts | rearm 前的 parent 相反 proof 与 child 占用集中检查（各 store 单 key lookup） |
| markerAttemptIdentity.ts | class-aware marker attempt relation（authority class + lowlevelSource + lineage binding + generation 维度比较） |

Lineage store 不内联进 facade.ts；capability registry 与 consume 内核在 service closure 私有模块；retry semantic identity 与 tr1_ namespace gate 各只有一个权威实现（retrySemanticIdentity.ts / transactionId.ts 的 isTreasuryRearmAttemptId）；production service 不暴露 child derive 函数（架构扫描守护）。

### 13.2 lineage record schema（v1）

```text
Memory.runtime.treasury.attemptLineage = {
  version: 1,
  entries: { "l:<rootTransactionId>": record },
  entryCount, updatedAt
}

record = {
  lineageId            // 16hex：rootTransactionId + root identity 派生
  rootTransactionId, rootIdentity        // 尝试链起点（initial attempt，普通命名空间）
  currentTransactionId, currentIdentity  // 链上最新 attempt
  generation            // 非负安全整数；root=0；child 接管完成时 +1
  state                 // retiring|rearm_ready|capability_issued|child_intent_pending
                        // |child_active|chain_committed|non_rearmable_retired|forensic_isolated
  resolutionState       // unresolved|not_executed|committed（current 的 resolution）
  nextChildTransactionId?  // rearm 派生的确定性 child（capability 签发时写入）
  retrySemanticDigest?  // 当前 current 的重试语义（non-rearmable 缺失）
  authorityClass        // identity-bound|lowlevel
  lowlevelSource?       // authorityClass=lowlevel 时必填
  bindingDigest?        // 当前 current 为 rearm child 时的 lineage binding
  rearmable, nonRearmReason?
  retirement: { lineagePublished, authorityReleased, markerCleaned }
  recordRevision        // 每次写入 +1（capability lineage revision 绑定）
  createdAtTick, updatedAtTick
}
```

状态机（单调）：

```text
(创建) retiring ──三段完成──▶ rearm_ready ──issue capability──▶ capability_issued
  ▲                              ▲   │(tick 结束/global reset 恢复：heap capability 失效)     │
  │                              │   ◀────────────────────────┘        │begin 接管
  │                              │                                      ▼
  │                              │                              child_intent_pending
  │                              │(beginTick 回滚：intent 缺失/一致 not_started、释放 intent)
  │                              │   ◀──────────────────────────────┘        │intent read-back 一致 + consume capability
  │                              │                                           ▼
  │                              │                                     child_active（current 推进、generation+1）
  │                              │                                    ╱          ╲
  │                              └──(child not-executed：退休)── retiring            chain_committed（child committed：终态）
  non_rearmable_retired（创建即定：只有 retirement proof、无 retry 语义）
  forensic_isolated（identity 冲突/不可证明）
```

禁止：chain_committed 回退；同 generation 不同 child；child_active 再签第二个 child；改变 root/语义身份/class；复用旧 generation。

### 13.3 staged 顺序与故障矩阵

not-executed resolution（改造后）：prevalidate → resolution slot + lineage 容量预检 → consume reconciliation capability → 写 final tombstone → 写 lineage candidate + read-back → 释放 intent/quarantine → class-aware 清 marker → 三段完成 → rearm_ready。

| 中断点 | 恢复 |
| --- | --- |
| tombstone 写后、lineage 写前中断 | authority/marker 保留；beginTick 经 pendingRelease 索引重试 lineage publication |
| lineage 写后、release 前中断 | beginTick 补完成 release（lineage 已是持久 proof） |
| release 后、marker 清理前中断 | beginTick 用 class-aware relation 补清 marker；conflict/insufficient → cleanup_pending 保留 |

tr1_ child 接管（executePreparedAction）：capability 只读验证 + retry semantic 重算比较 → lineage → child_intent_pending → 写 intent（带 bindingDigest）→ read-back 一致 → consume capability → lineage → child_active（current 推进）→ Game callback。

| 中断点 | 处置 |
| --- | --- |
| child_intent_pending 后、intent 写前 | callback 零调用；beginTick：intent 缺失 → 回滚 rearm_ready（capability 作废可重签） |
| intent 写后、read-back/consume 前 | callback 零调用；beginTick：一致 not_started → 释放 intent + 回滚 rearm_ready；不一致 → forensic_isolated |
| child_active 后 | child 由 intent/quarantine/receipt/resolution 正常接管（无特殊恢复） |

### 13.4 capability 生命周期

```text
issue（facade.issueTreasuryRearmCapability）
  前置：cross-store parent 检查（occupancy 模块）+ child 占用全零 + lineage rearm_ready
  产物：冻结 capability 对象（WeakSet 注册；同 tick 同 lineage 幂等返回同一对象）
  durable 副作用：lineage rearm_ready → capability_issued（recordRevision+1）
validate / consume（service 闭包私有）
  对象身份 → 未消费 → serviceGeneration → tick → lineage revision 与 Memory record 一致
  consume：一次性（WeakSet consumed）——接管协议在 intent read-back 一致后调用
tick 结束 / global reset
  heap capability 全部失效；durable lineage capability_issued → beginTick 回退 rearm_ready
  新 service 重签发：child ID 确定性不变
接管完成（child_active）
  该 generation 永不可再签发（lineage 状态门禁）
```

### 13.5 tr1_ 门禁点与拒绝路径

单一权威 `isTreasuryRearmAttemptId`（transactionId.ts）。门禁点：prepareTransaction（无 capability 的 tr1_ → rearm_capability_required；root/current 索引命中的普通 ID → retired_attempt/rearm_required）、authorizeTreasuryActionContract（options.rearmCapability 必填 + retry semantic digest 重算比较）、redeemAuthorizationBundleAtomic（bundle record 内 rearm binding 校验）、executePreparedAction tr1_ 接管协议、compat recordAcceptedTransaction/recordAcceptedAction（tr1_ 无 binding 拒绝）、commit receipt（tr1_ intent 必须携带 bindingDigest）。全部拒绝路径 bundle 零签发、预算零变化、intent 零创建、callback 零调用。

### 13.6 tombstone retention 资格（O(1)）

evictExpiredTombstones 对 final not-executed 逐条：`lineageByAttemptId(tombstone.transactionId)` O(1) 命中且 retirement 三段全部完成且 state ∈ {rearm_ready, capability_issued, child_intent_pending, child_active, chain_committed, non_rearmable_retired}（即 lineage 已接管永久门禁）→ 允许按普通 retention 驱逐；未命中（无 lineage replacement——Round 16 遗留或 backfill 未完成）或任一 pending → pin。驱逐删除 tombstone 与 pendingRelease 索引项，但绝不触碰 lineage record。

### 13.7 marker v2 与 receipt proof class

marker 新增可选持久字段：authorityClass、lowlevelSource、lineageBindingDigest、attemptGeneration、markerVersion（=2）；旧 v1 marker（无这些字段）按 legacy identity 处理——class-aware 清除时 insufficient（不猜 class），保留 pending。清除 API 升级为接收完整 class-aware identity（markerAttemptIdentity.ts 的 relation 判定 match 才清除）。

receipts v7：proof level 三级 identity-bound/lowlevel/legacy（不再用 modern+lowlevelSource 隐式表达）；v6→v7 迁移按 modern±lowlevelSource/legacy 归类，矛盾 fail closed；identity-bound 禁 lowlevelSource、lowlevel 必带受控 lowlevelSource 且禁 contract/cohort 字段；释放矩阵 identity-bound→modern authority、lowlevel→lowlevel authority（runtime/migrated 不互证）、legacy 不释放任何 authority。

### 13.8 store 版本与容量

- attemptLineage v1（新增）：硬容量 64 条 chain；满载新 root 拒绝（fail closed）、同 chain 推进不占新 slot、普通 retention 永不删除 lineage record。
- resolutions 保持 v6：驱逐资格规则变化（lineage replacement 检查）不改变 entry schema。
- receipts v6 → v7：proof level 枚举扩展 + lowlevel class 字段矩阵。
- intents（v6）/quarantine（v5）：新增可选 lineageBindingDigest 字段（向后兼容，验证矩阵更新）。
- write-fault marker：新增 v2 可选字段（向后兼容读取）。


## 14. 第十八轮设计：Lineage Handoff Atomicity & Generation-Proof Closure

### 14.1 目标协议链（唯一权威顺序）

```text
parent/current attempt not-executed（resolver 路径）
  prevalidate → resolution slot 预检 → lineage 容量与 retry facts 预检
  → lineage retirement candidate 持久化 + read-back（identity 匹配验证）
  → consume reconciliation capability
  → final not-executed tombstone
  → 释放 quarantine/intent（authority release）
  → class-aware marker cleanup（检查清除结果）
  → 三段 verified → rearm-ready / non-rearmable 终态
（direct 路径：child non-OK + abort 确认 → 同步 retirement，
  publication 失败时 intent 保留、退化为 quarantine→resolver 收敛）

rearm-ready → capability_issued（handoff facts 持久化）
  → child_intent_pending（intent 写入 + read-back 含 lineage proof）
  → consume（严格 state=child_intent_pending + revision=issue+1）
  → intent execution-started（executing）
  → child_active（current/generation/binding 推进）
  → Game callback（唯一调用点）
  ├─ callback 前任意失败 → 回滚 rearm-ready / 保留 handoff-pending 供恢复
  ├─ callback non-OK + abort 确认 → 当前代 retirement → rearm-ready（下一代）
  ├─ callback 抛错/未知 → quarantine → resolver（同一 generation 推进）
  └─ callback OK + commit 成功 → chain_committed（receipt 先行；
     终态写失败 → executed_unsettled + beginTick 按 receipt 补完成）
```

### 14.2 publication-before-release 不变量

resolve-as-not-executed 的 lineage candidate 持久化被提前到 capability 消费与
tombstone 之前（candidate 即 root/current 的永久退休权威，可安全先行）；authority
release 的固定放行条件：store 健康、candidate 构造成功（含完整 attempt identity/
generation/binding/retry semantic 或明确 non-rearmable 原因）、candidate 持久化
成功、Memory read-back 成功且与 authority/tombstone identity 完全匹配、索引同步
一致。任一失败：intent/quarantine/marker/pending-release 索引全部保留、不返回
retirement 完成语义（`lineage_publication_pending`），下一轮从保留的 authority
重建完整 retry facts（不退化为只能 non-rearmable backfill）。pending-release 索引
移除、tombstone 驱逐资格、rearm-ready 三个后果都以三段全部 verified 为前提。

### 14.3 handoff 状态与中断窗口

handoff durable facts（capability_issued 起持久化）：child ID（nextChildTransactionId，
v2 generation-addressable）、parent/current attempt ID（currentTransactionId）、
target generation（record.generation+1）、pendingBindingDigest（写入时冻结、load
重算验证）、retry semantic digest（record 不可变字段）、authority class/
owner/lowlevel、expected current identity（currentIdentity）、协议版本（store
version）。capability consume 严格验证 lineage 处于 child_intent_pending 且
recordRevision 等于签发 revision+1（删除 skip-all-revision 旁路）。

中断窗口与恢复（beginTick，只处理 pending lineage ID）：
- capability_issued（跨 tick/global reset）→ 回退 rearm_ready，child ID 保留；
- child_intent_pending + intent 缺失 → 回滚 rearm_ready；
- + 一致 not_started/ready intent（binding/generation 匹配）→ 释放 intent 并回滚
  （正常窗口，不 forensic）；
- + binding/generation/child 冲突 → forensic_isolated（intent 保留）；
- + intent 已 executing/更后（或 intent 已转 quarantine 且 proof 匹配）→ 前向补完成
  child_active（identity 从 intent/quarantine facts 派生）——callback 可能已开始，
  不得回滚为未执行；
- child_active + 当前代 committed receipt 匹配 → 补完成 chain_committed。

execution-started（intent→executing）先于 lineage child_active 推进：armed 推进
失败时 intent 已在 executing（callback 可能开始的唯一持久信号），恢复走前向补完成；
execution-started 写失败时 lineage 仍在 child_intent_pending 且 intent 仍是
ready（callback 确定未开始）→ 回滚。generation 永不回退，同一 generation 的 child
ID 在回滚/重签间保持一致。

### 14.4 generation-addressable child ID 协议 v2

`tr1_<lineageId:16hex>_<generation:6hex>_<checksum:8hex>`（36 字符，charset 合法）；
checksum = hash16("treasury-attempt-rearm@v2" + lineageId + generation +
rootTransactionId) 前 8 hex——ID 自带 (lineageId, generation) 可 O(1) 解析并对照
record root 重算验证。同 lineage+generation 恒同一 ID（状态机保证每代唯一 child）；
不同 lineage/generation 必不同。多代 chain 的任意历史代 attempt ID 与其 binding
digest 都可以只凭 record（root + lineageId + generation）O(1) 重算——这是
per-generation tombstone verdict 与多代回收的基础，不需要无界 attempt 数组。
旧 v1 child ID（parent identity 派生）不可解析 → legacy 隔离：继续受 tr1_ 门禁，
相关 tombstone 永久 pin，不得猜测 generation。

### 14.5 per-generation tombstone replacement verdict

resolutionStore 驱逐 final not-executed 时按 entry 逐条查询
`replacementVerdict(transactionId)`（lineageGenerationRetirement.ts）：
- replacement_match：ID 解析（v2）或 root 命中 active record / terminal summary；
  generation ≤ record.generation（历史代：状态机已证明其 retirement 在推进前完成）
  或 === 当前代且三段完成；transactionId 等于该代期望 ID；binding 重算一致；
  proof class 与 record authorityClass 一致；当前代另比较 digest。→ 允许驱逐。
- replacement_pending（当前代 retiring/三段未全）/ replacement_conflict（class、
  binding、transactionId、当前代 digest 不匹配）/ replacement_missing（无 record
  且无 summary、或 v1 ID 不可寻址）/ store_unhealthy → pin（conflict 计数）。
committed 终态（chain_committed 或 summary committed）后的 committed tombstone
按既有普通 retention 处理。单 chain 多代推进不新增 active entry、历史 tombstone
在超龄后均可独立回收，Resolution store 不因单 chain 重试线性泄漏。

### 14.6 terminal 压缩与 retirement summary

active lineage store（容量 64）保留进行中/可 rearm 的 chain；chain_committed 与
non_rearmable_retired 在无 intent/quarantine/marker/pending 事实时压缩为
retirement summary（独立 store `lineageRetirementSummaries`，硬容量 128，key=
root transactionId）：{lineageId, rootTransactionId, rootIdentityDigest,
terminalState, finalGeneration, finalizedAtTick, schemaVersion}。summary 是精确
权威：永久阻止 root ID 重用（prepare 门禁 root∪current∪summary 三索引）、证明
终态、不依赖 receipt/tombstone retention；满载 fail closed（不删旧 summary、
不压缩、新 root 经 active 容量门禁拒绝）。forensic_isolated 不自动压缩。压缩在
beginTick 对 terminal 记录有界执行（terminalIds 索引，空闲 O(1)），成功后释放
active slot。Memory 成本：active ≤64×~700B，summary ≤128×~250B（evidence 记录推导）。

### 14.7 generation proof 与 store 版本

统一 proof 视图（lineageAttemptProof.ts）：{lineageId, lineageGeneration,
parentTransactionId, lineageBindingDigest}（+authorityClass 于 marker/proof class
矩阵）。durable identity 计算：tr1_ attempt 的 durableIdentityDigest 输入包含
lineage proof（单侧缺失/不一致 → conflict/insufficient，不得 match）；initial
attempt 完全不包含。store 升级：attemptLineage v1→v2（pendingBindingDigest/
retirementGeneration/lineageId 索引/v1 next-child 回退迁移）、intents v6→v7、
quarantine v5→v6、resolutions v6→v7、write-fault marker v3（+lineageId）、
receipts v7→v8（tr1_ receipt 携带完整 lineage proof；旧 tr1_ receipt 缺 proof →
只作 replay blocker，不释放当前 rearm authority）。迁移规则：tr1_ 缺 proof 且可
从 lineage 安全补全 → 原子补全并验证；不可证明 → forensic/store unhealthy；
non-tr1_ 携带 lineage 字段 → unhealthy。

### 14.8 adapter retry semantic v2 与 source 单一权威

adapter 协议新增 `retryFacts(args)`（可选）：从 canonical frozen args 派生有界
事实对象（string/number/boolean 值、键 ≤48、canonical 编码 ≤1024 字符、异常与
超限 fail closed），与 durableFacts 职责分离；必须覆盖全部改变真实 Game API 调用
语义的参数。retry digest v2（treasury-retry-semantic@v2）绑定 action kind/adapter
version/stable semantic identity/canonical retry facts/canonical postings/structure
descriptors/durable payload/source/owner——移除 per-global registrationId：注册顺序
变化与 global reset 不改变 digest。adapter 未实现 retryFacts → 动作正常执行、
not-executed 后 non-rearmable（不猜测）。

contract source 在 build 时确定（缺省 "action-contract"），进入 contract digest、
retry semantic、durable intent、authorization context；authorization 重算使用
contract.source（不再写死）；execution request.source 必须与 contract.source 完全
相同（不同 → callback 前拒绝）；parent/child source 变化 → retry semantic 不匹配
拒绝。

### 14.9 模块边界

新增窄职责模块：lineageHandoff.ts（handoff 状态机唯一权威：期望 revision 推导、
consume 校验参数、回滚/前向恢复）、lineageAttemptProof.ts（canonical proof 视图 +
required/forbidden 矩阵 + relation 单一实现）、lineageGenerationRetirement.ts
（verdict + 期望 attempt ID 派生）、lineageRetirementSummary.ts（terminal summary
store + 压缩编排）、lineageIndexIntegrity.ts（跨索引唯一性/冲突判定）、
adapterRetrySemantics.ts（retry facts 协议）。lineage staged publication 不内联进
faultResolution 大段逻辑；production service 不暴露 lineage 直接 mutation；
production 源码不得导入 test-only child derive helper（架构扫描全量覆盖）。

## 15. 第十九轮设计：Committed Lineage Resolution & Terminal Proof Compaction

### 15.1 committed resolution 的完整 proof 流（工作包 A 唯一权威顺序）

```text
unresolved authority（resolver 归一化，暴露并验证 lineage proof）
  → reconciliation capability 签发（透传完整 proof）
  → prevalidate（capability ↔ authority lineage 强比较）
  → resolving tombstone（携带完整 proof）
  → consume capability
  → receipt refresh（lineage-aware：保留/写入完整 proof）
  → 三方 verifier（receipt↔tombstone↔authority，每组含 lineage 维度）
  → verified → 释放 intent/quarantine → class-aware marker 清除（携带 proof）
  → final tombstone（携带完整 proof）
  → chain_committed（matching receipt 的 binding/generation 与 record 一致才推进）
```

断点不变量：任何一段 fail closed 时上游保留（resolving tombstone 保留 + authority 保留 + marker 保留），beginTick `recoverStagedResolutions` 以同一 verifier 语义幂等补完成，不依赖旧 heap capability。

### 15.2 双 authority handoff 恢复矩阵（工作包 B）

| intent | quarantine | 判定 |
|---|---|---|
| proof 冲突 | 任意 | forensic（保留全部 authority） |
| 任意 | proof 冲突 | forensic |
| not_started/ready | 不存在 | rollback + 释放 intent |
| not_started/ready | 匹配存在 | forward_complete（quarantine 是 callback 后事实——绝不回滚） |
| executing/更后 | 任意（无冲突） | forward_complete |
| 缺失 | 匹配存在 | forward_complete |
| 缺失 | 缺失 | rollback（零释放） |

forward 的 child identity 从验证后的持久事实派生：quarantine（proof 匹配）优先，其次 intent。

### 15.3 retirement 三阶段的证明来源（工作包 C）

- `lineagePublished`：retire 时 lineage candidate 持久化 + read-back（`child_active>retiring` 转换内置）。
- `authorityReleased`：统一 resolver 返回 `not_found`（`convergeTreasuryLineageRetirementFromFacts` 内验证）。
- `markerCleaned`：marker 不存在 / transactionId 不指向本 attempt / class-aware 清除成功后重读不存在；marker 指向本 attempt 但 digest/binding/generation 冲突或 class 不可证明 → cleanup pending（保持 retiring，不进 rearm_ready，无 eviction 资格）。

`completeTreasuryLineageRetirement` 只推进 state 并校验三段全 true；阶段置位只经 `markTreasuryLineageRetirementStageVerified`（单调 false→true）。

### 15.4 summary generation 证明（工作包 E）

active record 压缩后，历史 child tombstone 凭 tombstone 自身完整 lineage proof + summary 的 `(lineageId, rootTransactionId, finalGeneration, authorityClass, terminalState)` 精确重演验证：ID v2 派生 + checksum（绑定 root）、generation ≤ finalGeneration、binding 按 (lineageId, generation, parent=gen-1 派生 ID, child) 重算、proof class 与 summary authorityClass 一致、final 代 not-executed 只与 non_rearmable_retired 相容。无 proof 旧 tombstone、v1 迁移 summary（authorityClass 缺失）、future generation、错误 binding → pin/conflict，不猜测。
## 16. 第二十轮设计：Semantic Lineage Validation & Exact Terminal Proofs

### 16.1 shape proof 与 semantic proof 的两层分离

第十九轮的 lineageProof.ts 只证明"四字段形状合法 + 两个载体上相等"（shape proof）。本轮新增 semanticLineageValidation.ts（单一权威、版本化、无副作用 + 装配注入只读 source）证明"字段本身语义真实"：

```text
tr1_ transaction ID
  ├─ parse v2（legacy 不可解析 ID → legacy isolated，不猜测）
  ├─ ID 内嵌 (lineageId, generation) === proof 四字段对应项
  ├─ 从权威 source（active lineage record / terminal summary）取 root，
  │   重算 expected child ID（v2 派生 + checksum 绑定 root）
  ├─ expected parent = expectedTreasuryLineageAttemptId(gen-1)，
  │   proof.parentTransactionId 必须 === expected（gen1 parent=root）
  ├─ binding = computeTreasuryLineageBindingDigest(lineageId, gen,
  │   expectedParent, child) 重算比较（不信任载体自带 binding）
  └─ authority 状态验证（active lineage / terminal summary + exact
      retirement authority；generation 角色：current / pending_handoff /
      historical_exact）
        ▼
Semantic Lineage Verdict：match / conflict / insufficient(legacy isolated) /
store_unhealthy / no_authority
```

消费方（unresolved authority、handoff recovery、capability 签发与
prevalidation、receipt commit/refresh、resolution tombstone 写入、
committed 三方 verifier、tombstone replacement、terminal compaction、
finalized proof）全部复用同一结论；verdict 不得折叠成 undefined/false。
Store unhealthy 时 semantic validator 一律 fail closed（不返回 match）。
Retry semantic identity 仍是独立维度（active lineage 验证包含
retrySemanticDigest 一致性，但不并入 binding digest）。

validator 的 authority source 经装配注入（lineage record reader 由
attemptLineage 注册、summary reader 由 lineageRetirementSummary 注册、
exact retirement proof reader 由 generationRetirementAuthority 注册——
模块单向依赖，receipts/unresolvedAuthority 直接 import validator 不成环；
readers 未注册时 tr1_ 写入/验证路径 fail closed）。

### 16.2 handoff 恢复复用 unified exact authority + beginTick 证据保留顺序

handoff 恢复不再自行比较 lineage 外壳：child_intent_pending 窗口直接调
resolveTreasuryUnresolvedAuthority(childId)（或共享同一 authority cohesion
核心），在其完整一致性（identity 重算、authority level、proof class、
lowlevelSource、canonical digest、contract/cohort/durable identity、
postings/kind、lineage semantic proof、execution-fact cohesion、
settlement/phase）之上叠加 semantic lineage validation 与 record pending
facts 匹配：

| resolver 结果 | 附加条件 | 判定 |
|---|---|---|
| store_unhealthy | — | 保留两侧证据，不动作（pending） |
| inconsistent | — | forensic（保留全部 authority） |
| not_found | — | rollback（零释放——两侧均无） |
| ok | semantic=match、四字段与 record pending facts 一致、authorityClass/lowlevelSource/actionKind/adapterSemanticIdentity 与 record 一致、intent-only + not_started/ready | rollback + 释放 intent |
| ok | 同上但 quarantine 存在（authorityKind=quarantine）或 executing/更后 | forward_complete（child identity 从 resolver 结果构造） |
| ok | semantic ≠ match / class / provenance / action kind 冲突 | forensic |

beginTick 顺序固定：lineage handoff 双 authority 判定先于普通 Intent
recovery（recoverTreasuryLineageHandoffEvidenceAtTickBoundary 在
recoverTreasuryIntentsAtTickBoundary 之前执行；主 lineage recovery 对
child_intent_pending 的重入走同一 classifier，幂等）。Intent 与
Quarantine 并存时，二者完整一致性在任一侧删除前完成。

### 16.3 exact attempt identity 单一构造层

exactAttemptIdentity.ts 成为 prepared/Intent/Quarantine/Receipt/
Resolution tombstone/unresolved authority/active lineage current/terminal
proof 的规范 identity 视图的唯一构造实现（维度：transactionId、digest、
contractDigest、authorizationCohortDigest、durableIdentityDigest、
lowlevelSource、proof/authority class、lineage 四字段）。relation 对称
区分 match/conflict/insufficient；一方为 rearm 一方缺 lineage → conflict/
insufficient（由 transactionId 命名空间决定方向）。安全关键调用点
（receipt 幂等、prepared commit 预检、finalized intent proof 链、
resolution 补完成比较、authorization-fault 幂等、rearm parent identity、
committed 三方 verifier 输入）不得再手工展开字段子集——架构扫描保护。
marker 的 class-aware 子集视图是明确允许的诊断性简化（不用于 authority
release / receipt idempotence / compaction / tombstone eviction /
committed finalization）。

### 16.4 receipt 幂等 exact 化与写入门禁

- 既有 tr1_ receipt 的幂等比较构造完整 exact attempt identity（修复
  第十九轮把 lineage 四字段丢弃导致 matching rearm receipt 被误判
  identity_conflict 的缺陷）；proof class 变化同样 conflict。
- commitSettledReceipt 的 absent 写入路径对 tr1_ 强制：完整 lineage proof
  形状 + semantic lineage validation = match + active/terminal authority
  状态允许 commit；否则零写入 + 明确 fatal 结果（调用方进入安全 fault
  处理）。initial attempt 携带 lineage proof → 拒绝零写。
- refresh 沿用第十九轮方向门禁并叠加 semantic validation：matching
  proof 原样保留仅刷新 tick；旧 rearm proof 缺 exact semantic authority →
  replay blocker（不自动补全）；conflict 不覆盖。
- validator 未装配（readers 未注册）→ tr1_ production 写入 fail closed。

### 16.5 exact per-generation retirement authority

generationRetirementAuthority.ts（独立持久 store：
`Memory.runtime.treasury.generationRetirementProofs`，schema v1）：每个
final not-executed generation 在 retirement 三段全部完成、状态推进前写入
一条可独立验证的 exact retirement proof：

```text
{ lineageId, rootTransactionId, rootIdentityDigest, generation,
  transactionId, parentTransactionId(gen≥1), bindingDigest(gen≥1),
  digest, contractDigest?, authorizationCohortDigest?,
  durableIdentityDigest?, lowlevelSource?, authorityClass,
  retrySemanticDigest?, resolution: "not_executed",
  retirement: {lineagePublished, authorityReleased, markerCleaned} 全 true,
  completedAtTick }
```

- 写入顺序：三段收敛完成 → exact proof 写入 + Memory read-back 验证 →
  才推进 retiring → rearm_ready/non_rearmable_retired（失败保持
  retiring，fail closed）；
- 下一代 capability 门禁：preflight 校验当前 generation N 的 exact proof
  存在且解析一致，缺失 → 拒绝签发 N+1 capability（Round 18/19 旧数据
  缺 proof → 同样拒绝/保持 pin，不自动补现代 proof）；
- 容量：硬容量 384（resolution store 256 tombstone 依赖上界 + active
  lineage 64 当前代余量），满载 fail closed（不驱逐被依赖 proof、
  当前 lineage 保持 retiring）；lookup O(1)（扁平 key + heap 索引）；
- 回收：resolution tombstone 驱逐（verdict match）后释放对应 proof
  （驱逐方注入 release hook）；chain 压缩后清理该 lineage 中 tombstone
  已不存在的孤儿 proof（压缩路径有界遍历）。正常 tick 不全扫 proof。

### 16.6 historical generation 由 exact proof 证明（删除状态机推断）

lineageGenerationRetirement.ts 的 verdict 重写：

- active record 历史代（generation < record.generation）：必须命中
  (lineageId, generation) 的 exact retirement proof 且完整比较
  （transactionId/parent/binding 派生、proof class、digest 及
  contract/cohort/durable/lowlevel 维度）才 replacement_match；proof 缺失
  → replacement_missing（pin）；篡改 → conflict。删除
  "状态机曾推进 + generation 较旧即 match"的推断。
- root tombstone：不再仅凭 rootTransactionId 命中 summary——重算
  rootIdentityDigest（tombstone 的 digest/contract/cohort/durable/
  lowlevelSource 五元 identity）与 summary 比较 + proofLevel vs
  summary.authorityClass + terminal 语义 + generation 0 的 exact proof；
  同 root ID 不同 identity → conflict/pin。
- summary 历史代（压缩后）：summary 只提供定位与边界
  （finalGeneration 上界），membership 与 identity 由 exact retirement
  proof 证明；缺 proof → missing/pin（v1 迁移 summary 同样不猜测）。
- 当前代：保留三段 + retirementGeneration 归属检查，并叠加持久
  parentTransactionId 与 record.currentParentTransactionId 的完整比较。

### 16.7 terminal compaction 的 exact settlement identity 验证

压缩（chain_committed / non_rearmable_retired）前在既有门禁之上新增：

- chain_committed：matching committed receipt 与 active lineage current
  的完整 exact settlement identity 比较（digest/contract/cohort/durable/
  lowlevelSource + proof class + lineage 四字段）+ semantic lineage
  validation = match；
- non_rearmable：matching final not-executed tombstone 的完整 identity
  比较 + retirement 三段 + 当前代 exact retirement proof 存在 +
  semantic validation = match；
- 压缩前检查全部相关 store 健康（lineage/summary/exact retirement/
  receipt/resolution/intent/quarantine/authorization-fault/marker）；
- 幂等重入的 existing summary 比较扩展到 finalGeneration/finalAttemptId/
  authorityClass；
- 发布顺序固定：exact terminal candidate → summary 写入 + read-back →
  索引验证 → 历史 generation proof 可独立验证（exact proofs 在位）→
  才删除 active lineage → 清理孤儿 proof。

### 16.8 committed resolution 的语义验证闭环

- resolver（unresolved authority）：tr1_ authority 归一化叠加 semantic
  validation——conflict/insufficient(legacy)/no_authority → inconsistent
  fail closed；lineage/summary/retirement store unhealthy → store_unhealthy；
- resolving/final tombstone 写入前对 tr1_ 执行 semantic validator（结构
  完整但语义伪造的四字段不得落盘为现代 proof）；
- 三方 verifier 的调用方在 receipt↔tombstone↔authority 三组 relation 之上
  叠加 semantic lineage verdict（三者互相 match ≠ 真实 generation）；
  authority not_found 的补完成 finalize 同样需要 semantic lineage
  authority 可验证；
- chain_committed 推进的写入结果不得被忽略（失败保持可恢复 pending，
  beginTick 幂等补完成）；receipt 比较扩展为完整 exact identity。

### 16.9 模块边界与迁移

新增窄职责模块：semanticLineageValidation.ts（semantic verdict 单一
权威）、exactAttemptIdentity.ts（exact identity 构造单一实现）、
generationRetirementAuthority.ts（exact retirement proof store）。
lineageHandoff.ts 降级为 consume 期矩阵 + 恢复判定输入的纯决策模块
（不再自持简化 authority comparison）；散落的 startsWith("tr1_") 全部
收敛到 transactionId.ts 的 isTreasuryRearmAttemptId（namespace 权威内部
除外）；legacy v1 child ID / Round 18-19 缺 exact proof 的旧数据一律
replay blocker / pin / legacy isolated——不猜测、不自动升级、不通过
延长 retention 掩盖。所有 store 升级保持原子迁移（临时候选 → 全量验证
→ 一次替换 → 失败保留原 Memory → fail closed）。
