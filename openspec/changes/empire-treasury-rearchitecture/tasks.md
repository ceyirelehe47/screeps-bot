# Tasks

## 1. 阶段 A：OpenSpec 与迁移地图

- [x] 1.1 建立 `openspec/changes/empire-treasury-rearchitecture/`（proposal/design/tasks/specs）
- [x] 1.2 记录权威数据边界、职责边界、tick/contract 生命周期、18 条不变量落实位置
- [x] 1.3 迁移地图（8 个消费者顺序）+ 旧模块删除清单 + adapter 删除条件

## 2. 阶段 B：Treasury Core

- [x] 2.1 `types.ts`：LocationKind/Epoch/JournalEntry/QueryContext/BalanceView/Metrics
- [x] 2.2 `observation.ts`：不可变稀疏 observation（storage+terminal）、多方向索引、observedAtTick/epochSeq、fresh scope 独立构建；复用 TickContext myRooms；每 Store 单次 Object.keys；无 Game 引用保留；无 Memory 持久化
- [x] 2.3 `projection.ts`：transaction journal、幂等结算（stale epoch 拒绝/already_settled 拒绝）、projected overlay、reconciler（差异计数+样本，不静默）
- [x] 2.4 `facade.ts`：TreasuryService（observation/commitments/query/recordAcceptedAction/metrics/resetForTest）+ RuntimeServices 注册（无新 global 槽）
- [x] 2.5 带上下文查询：observed/projected/committed/spendable/incoming/outgoing/transferable；spendable 非负 + overcommitted 置位；无无上下文 available API

## 3. 阶段 C：承诺统一索引

- [x] 3.1 transfer tasks：outgoing/pendingOutgoing/incoming/pendingIncoming/taskCount/route merge lookup（复用 canonical 谓词，零复制持久数据）
- [x] 3.2 production reservations：活跃聚合、holder 存在性（孤儿计数）、过期排除（不删除原始记录）
- [x] 3.3 receiver commitments：healthy incoming 聚合 + 轻量 headroom（口径差异在 design.md 声明）
- [x] 3.4 后续（非本轮）：ReceiverCapacityLedger 内存实例并入、Budget Service、Contract Service（authorize 语义）

## 4. 阶段 D：Shadow 与兼容

- [x] 4.1 `shadow.ts`：Treasury vs empireInventoryIndex core + 独立直读双通道对比；覆盖房间 storage/terminal 资源、帝国总量、capacity、缺失位置、stale epoch、承诺重复计数
- [x] 4.2 零行为写入（无 intent API、无生产行为变化）；低频采样（40 tick）+ force 通道；mismatch 环形缓冲 cap + 聚合计数；低频快照 Memory.runtime.treasuryPerf（断言写入，沿用 inventoryPerf 先例）
- [x] 4.3 挂载 main.ts treasuryShadow phase（empireInventoryShadow 之后）
- [x] 4.4 兼容层：本轮直接替换 productionMonitor（无 adapter）；hubProgress adapter 待消费者迁移阶段建立时再定义删除条件

## 5. 阶段 E：消费者迁移

- [x] 5.1 productionMonitor storage/terminal energy 读取改走 Treasury observation（行为输出等价）
- [ ] 5.2 （下阶段）hubProgress/console 面板迁移 + 新旧输出 shadow 对比
- [ ] 5.3 （下阶段）resourceControl 热路径替换（getStoredResources / 重复采集点）

## 6. 验证与门禁

- [x] 6.1 新增测试：observation 不可变/稀疏枚举/总量=Σ桶/查询无副作用；projected 不改 observed/成功才产生 delta/幂等/跨 tick 不重复结算；承诺过期排除/孤儿计数/headroom 非负/spendable 非负/stale epoch 拒绝；shadow 零写；RuntimeServices reset
- [x] 6.2 确定性操作计数断言（storeEnumerations/resourceKeysEnumerated/roomFindCalls=0）
- [x] 6.3 `npm run typecheck`、`npm run build`、全量 Jest 通过（区分本次回归 vs 既有失败）
- [x] 6.4 Jest 预算治理：collect → apply-budget → verify 锚点更新 → `npm run test:budget`
- [x] 6.5 市场安全相关既有测试保持通过（零市场代码改动）

## 7. 审查修复轮（第二迭代：架构阻断项）

- [x] 7.1 显式 tick 生命周期：`beginTick()`/`endTick()` API + main.ts 固定挂载（treasuryBeginTick 在一切业务前 / treasuryEndTick 在 treasuryShadow 后 flush 前）+ phase 契约 39→41；懒初始化保留为安全兜底（零写、计数 lifecycleLazyInitializations）
- [x] 7.2 原子 transaction journal：单腿 action 升级为多 posting transaction（recordAcceptedTransaction 权威入口 + recordAcceptedAction convenience）；全 posting 先验证后一次性写入（零部分写入）；同 transaction 内同 key 先合并再验证
- [x] 7.3 幂等 receipt 持久化：Memory.runtime.treasury.receipts（version/retention 5000 tick/cap 4096/当前 tick 保护/版本不兼容冷启动）；heap 本 tick 缓存 + Memory 跨 tick 与 global reset 权威；>512 单 tick 洪峰无淘汰
- [x] 7.4 decision epoch 绑定：epoch 注册表（shared 1 + fresh N/每 tick 清空）；登记必携 decision 上下文并校验（stale/unknown/scope_mismatch 拒绝，幂等优先）；无绕过 Gateway 的登记入口（convenience 同样强制）
- [x] 7.5 reconciliation 完整性：previous-finals ∪ current-observed key 并集；分类 inflow/outflow/new_resource/new_location/new_room/room_lost/location_lost/structure_replaced；tick gap 与 global reset 显式标记；mismatch 样本携带 transactionId/kind 追溯（上一 tick journal 有界副本）
- [x] 7.6 commitment 点时快照：primitive 化（无 task/reservation 对象引用）；route merge 预构建索引（零线性扫描）；receiver healthy incoming 构建期预聚合（不回扫 live store）；revision invalidation（bumpTreasuryCommitmentRevision + 架构边界测试守护全部 mutation 入口）
- [x] 7.7 owner-aware 查询：TreasuryQueryOwner（holderId+scope）；自身 reservation 排除、其他 owner 保留、无 owner 保守、非法 fail closed（spendable=0/overcommitted）
- [x] 7.8 projected capacity 与输入验证：projectedUsed/FreeCapacity；transaction 验证（transactionId 格式/kind/source/posting delta 整数非零/RESOURCES_ALL/位置存在/金额非负/容量不越界）；receiver headroom observed+projected 双轨
- [x] 7.9 resetForTest 修复：journal/overlay/heap 幂等缓存/previousJournal/metrics 全清；只读快照冻结副本（journalSnapshot/reservationSnapshot/samples）；持久状态经 clearTreasuryPersistenceForTest 显式清理
- [x] 7.10 metrics 与 Memory 类型化：全部计数器接线（含 commitmentIndexQueries/生命周期/epoch 拒绝/receipt 清理）；Memory.runtime.treasury（receipts/lifecycle）与 treasuryPerf 正式声明 + memoryDeclarationBoundaries 指纹更新
- [x] 7.11 测试补齐：lifecycle（幂等/无消费者/tick_closed/缺 end 补救/gap/reset/冷启动/懒初始化）、transaction（两腿/三腿/中间非法回滚/NaN/容量/位置/格式/单 tick 601 笔/跨 tick/global reset 重放）、epoch（shared/fresh/stale×2/scope 混用/unknown/Facade 级）、reconciliation（key 并集全分类/追溯/有界）、commitments（快照不可变/revision 失效/零写/projected headroom）；新增 treasuryLifecycle.test.ts 与 treasuryCommitmentInvalidationBoundaries.test.ts

## 8. 上线门槛（后续阶段，非本轮）

- [ ] 8.1 Treasury shadow 连续 1000+ tick 零 mismatch 后迁移 resourceControl 热路径
- [ ] 8.2 market-fresh epoch 接入前独立安全评审（不破坏 fresh floor/双读/CAS/WAL/permit）
- [ ] 8.3 旧模块按删除清单分批退役，每批附 shadow 证据

## 9. 第三轮数据安全修复（P1：receipt 驱逐 / fresh 基线 / receiver 缓存）

- [x] 9.1 receipt 安全驱逐契约重做：store 升级 version 2（settled key "t:"+transactionId 前缀编码防原型污染 + entryCount 计数）；只自动回收 retention 过期条目，未过期条目绝不因容量驱逐；admission 预检（写入任何状态前）满容且无过期可回收时拒绝 receipt_capacity_exhausted（独立指标，零部分写入；已结算 id 仍优先 already_settled）；满容 admission 低频回收（O(1) 快路径）；v1→v2 无损迁移（只执行一次+指标）；未知版本/entryCount 损坏 fail closed（原数据保留、持续拒绝、有界诊断）
- [x] 9.2 decision epoch 绑定 exact observation：epoch 注册表条目保存该 epoch 的 exact immutable observation 引用（heap-only 每 tick 清空）；recordAcceptedTransaction 物理验证（位置/数量/容量/incarnation）使用 decision 指向的观察，不回退 shared；overlay 跨 epoch 共享防同 tick 超卖（代码注释固定三层语义）；endTick 后 beginFreshObservation 返回 null
- [x] 9.3 receiver projected headroom 实时化：projected 字段每次查询动态组合（静态承诺 + observed 容量 + 当前 overlay 容量聚合），不缓存依赖 overlay 的旧结果；locationCapacityDelta 改按位置 capacityDeltas 聚合 map（commit 原子更新/endTick/reset 清空/查询 O(1)）；单调 projectionRevision 暴露（缓存失效与诊断）
- [x] 9.4 空结构/空房间两层对账：endTick 归档 room/location manifest（owned 房间集合、exists/structureId/容量事实）；reconcile 拆 manifest 结构层（new_room/room_lost/new_location/location_lost/structure_replaced，每位置至多一条）+ 资源 key union 层（inflow/outflow/new_resource 独立计数）；样本 dimension 标记结构/资源维度
- [x] 9.5 owner 验证强化：TreasuryQueryOwner 增加 roomName；deps.resolveHolderRoom 运行时解析 holder 存在性与归属房间；声明不一致/不存在 fail closed；多房间查询只在其合法归属房间排除自己；不再接受"任意非空字符串即可排除"
- [x] 9.6 查询输入 fail-closed 规范化：非法资源/非法或重复房间/非法或重复位置/NaN/Infinity/负 withhold → 保守全零视图（contextStatus=invalid_fail_closed）+ queryInvalidContexts 计数；合法路径 contextStatus=valid
- [x] 9.7 receipt key 编码与 transactionId 语义：settled 一律 "t:" 前缀编码（__proto__/constructor 等合法 id 字面量恒为普通自有键）；新增 formatTreasuryStableTransactionId（无 tick 前缀，跨 tick 重试恒同 id，receipt 幂等跨 tick 生效）；tick 前缀 helper 文档限定为无重试语义的新动作
- [x] 9.8 权威 mutation 覆盖补全：migrateResourceTransferTasksToV2（legacy schema 迁移改写任务）通知 commitment revision 失效；route merge 同 route 重复 key 恢复"第一个匹配"（旧 findMergeablePendingTask 语义）
- [x] 9.9 Memory 类型与治理联动：runtime.d.ts receipts 类型升级 v2（前缀键/entryCount 注释含驱逐契约与 fail-closed 规则）；memoryDeclarationBoundaries 指纹重算；metrics 新增 receiptCapacityRejections/receiptStoreMigrationsExecuted/receiptStoreIncompatibleFailures/receiptsCorruptedEvicted/queryInvalidContexts（treasuryPerf 快照自动含新字段）
- [x] 9.10 测试补齐：receipt admission（满容拒绝/最老保护/零部分写入/过期恢复/601 笔/reset 恢复/v1 迁移/未知版本/entryCount 损坏/__proto__ 防护）；fresh exact 绑定（低基线拒/小容量拒/journal 保留 scope/双 fresh 各自验证/overlay 防超卖/endTick 后拒/old-unknown-scope 拒）；receiver 实时性（同 tick transaction 后立即减少/observed 不变/流出恢复/多资源聚合/索引不重建）；manifest 两层（空房间/空 terminal/structureId 替换每位置一次）；owner（不存在/房间不符/多房间归属/无预留正常）；query 输入（非法资源/重复房间位置/NaN withhold）；稳定 id 跨 tick 幂等；merge 第一个匹配；性能边界架构断言（admission O(1)/capacityDelta O(1)/exact observation 不回退）

## 10. 第四轮 Pre-Write Hardening（receipt v3 / 两阶段协议 / typed holder）

- [x] 10.1 v1 迁移碰撞修复：v1 裸键 raw key 原样作为 transactionId 输入安全编码（绝不 decode——`abc` 与 `t:abc` 不碰撞）；迁移在临时结构完成全部校验（格式/value 有效性/编码碰撞防御）+ 自检（own key 数/entryCount/存储键格式/每个 settled tick）后一次性原子替换原 store；发现非法 key/value/碰撞时原 store 不变并 fail closed；v1/v2→v3 双链迁移（v2 补 nextExpiryTick）、只执行一次
- [x] 10.2 损坏 value fail closed：settled tick 须为 [0, Game.time] 安全整数（NaN/±Inf/非整数/非安全/负数/未来 tick 判损坏）；迁移不跳过、cleanup 不删除、admission 整体阻断（receipt_store_incompatible）；已可靠识别的旧 id 查询仍 already_settled；损坏 id 阻断不乐观放行；cleanup 只删完整验证且超 retention 的正常条目
- [x] 10.3 过期调度元数据：store 升级 version 3（+nextExpiryTick=min(settledAt)+retention+1，空表 null）；未到点 beginTick 零扫描、满容 admission O(1) 拒绝不反复全表扫描；到点一次清理并重算；global reset 后 load 完整验证（entryCount/键格式/value/元数据一致性，损坏 fail closed 不放宽容量）；插入/迁移/清理后元数据恒一致
- [x] 10.4 确定性操作计数：receiptFullScans/admissionFastPaths/admissionFullStoreBlocked/expiryCleanupScans/storeIncompatible/migrations/slotsRemaining/nextExpiryTick（metrics 聚合 + treasuryPerf 快照）；可运行次数断言测试（满载重试零扫描/beginTick 未到点零扫描/到点一次扫描）
- [x] 10.5 两阶段 transaction 协议：prepareTransaction（Game 动作前完成全部验证 + receipt 槽位预留，pending 有界 64 且其余 admission 计入预留数）→ abort（零状态释放）/commit（重验物理后原子写入；prepare_invalidated 零写入）；commit 兑现不因容量/兼容性被拒；handle tick 内有效（endTick/beginTick 作废）；重复 prepare 幂等/重复 commit already_settled/已 commit 不可 abort；单阶段入口保留
- [x] 10.6 typed holder 解析：新建 holderResolution（`nuker:` 内嵌 objectId / `synthesis:` owned 房间归属 / 裸 Game object id 三形态统一解析，返回 {kind, roomName}）；commitments 默认 holderExists 走 typed 解析（logical holder 不再被误判 orphan 导致 committed 低估）；TreasuryQueryOwner 增加必填 holderKind 且须与运行时解析一致（冒充其他类型 fail closed）
- [x] 10.7 stable id 铸造成分防碰撞：kind 与每个 discriminator 校验为不含冒号的 [A-Za-z0-9_\-.]{1,64} token（数字须非负安全整数、至少一个 discriminator），tuple 边界碰撞（("a:b","c") vs ("a","b:c")）/空串/NaN/非法字符一律抛错；tick 前缀 helper 同样校验
- [x] 10.8 查询 fail-closed 补全：非管辖（unknown/unowned）房间拒绝（管辖集合=注入房间源）；空 rooms/locations scope 拒绝；allowProjected/allowIncoming/subtractOutgoing/subtractReservations 非布尔真值（0/"true"）拒绝
- [x] 10.9 验证补全：delta 非零安全整数；同 key 合并溢出拒绝；净零腿剔除 + 全抵消 no-op transaction 整笔拒绝（no_op_transaction）；金额/容量结果安全整数校验；epochSeq 单点递增（每发行恰好 +1 无空洞）；fresh 每 tick 上限 8（超限 null + freshEpochLimitRejections，下一 tick 恢复）
- [x] 10.10 Memory 类型与治理联动：runtime.d.ts receipts 升级 v3（+nextExpiryTick，注释含迁移链/损坏规则/调度语义）；memoryDeclarationBoundaries 指纹重算；metrics 新增 12 字段（receipt 计数 8 项 + fresh 上限 + 两阶段 3 项，treasuryPerf 快照自动含）
- [x] 10.11 测试补齐：receipt v3（v1 碰撞/危险字面量无损、v2→v3、v1 损坏 fail closed、v1 非法 key、v3 value 损坏可靠 id 仍幂等、元数据损坏、满载 O(1) 重试零扫描、到点一次扫描）；两阶段（成功兑现/abort 零状态/槽位预留他人填满仍成功/prepare_invalidated 零写入/跨 tick 失效/endTick 作废/already_finalized/重复 prepare 幂等）；typed owner（logical 排除自己/kind 冒充拒/holderResolution 默认解析）；query 补全（非管辖房间/空 scope/非布尔）；no-op/2^53/合并溢出；formatter 边界（碰撞 throw/合法往返）；fresh 上限与 epochSeq 连续性；commitments 默认解析（logical 不 orphan）
