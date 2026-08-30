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

## 11. 第五轮 Write-Admission Correctness（tentative ledger / opaque handle / staged commit / typed owner / completeness）

- [x] 11.1 canonical transaction identity：transactionId 铸造 v2——canonical tuple 序列化（类型标签 s/n + 长度前缀，number 42 与 string "42"、元组边界、字段顺序、attempt sequence 全部可区分；Unicode/空格/冒号/空串为合法业务字段）+ 双 lane FNV-1a 稳定 hash 定长输出；stable（ts1_）与 per-tick（tt1_&lt;tick&gt;_）分命名空间不可碰撞；validator 不变（存量 receipt 键完全兼容）；固定 test vectors 锚定
- [x] 11.2 canonical snapshot + payload digest：prepare 载荷深复制 + postings 规范排序 + 逐层冻结（调用方 prepare 后修改原 input 不影响 canonical）；digest 覆盖 identity/kind/source/decision epoch/全部 canonical postings；相同 ID 相同 digest 重复 prepare 幂等返回同一 handle、不同 digest 返回 prepare_conflict
- [x] 11.3 tentative ledger：prepare 成功预留每 (room,location,resource) 净资源 delta + 每位置净容量 delta + receipt 槽；后续 prepare 与单阶段登记的授权计算计入全部 tentative（同一 handle 自身预留不重复计算）；tentative 不进入 public projected（gauge 只读诊断）；abort 原子释放、commit 转 committed
- [x] 11.4 opaque prepared handle：冻结 capability 对象 + 服务实例私有 WeakSet 对象身份验证（伪造对象/JSON round-trip 副本/跨 service generation 一律 invalid_handle）；tick 自校验（不依赖调用方先 beginTick）；状态机 prepared/executing/committing/committed/aborted/faulted/expired（commit 一次、abort 一次、terminal 不回退）
- [x] 11.5 commit 语义重做：tentative → committed 兑现，不做业务 admission——Game API 已 OK 后不再因资源/容量/receipt 条件拒绝；prepare_invalidated 正常路径删除（他笔 transaction 推进 overlay 不再使 commit 失败——tentative 预留保证不变量）
- [x] 11.6 staged commit + write fault：可预期失败前置 prepare；commit 拆 receipt 发布（commitSettledReceipt 返回 written/already_settled/fatal）→ heap 发布（journal/overlay 分段故障钩子）→ handle 状态三段；任一阶段意外失败 → faulted 终态（不当作普通 rejected/aborted）+ tentative/槽不释放 + 最小有界持久 write-fault marker（Memory.runtime.treasury.writeFault）+ 全部后续 writer fail closed（write_admission_locked）；global reset 后凭 marker 仍可发现；只有显式 clearTreasuryWriteFaultForRepair 解除；故障注入测试覆盖 receipt 前/receipt 后 heap 前/journal/overlay/handle 五个故障点（无静默半提交）
- [x] 11.7 endTick outstanding 审计：未决 prepared 计数 + 有界样本（transactionId/digest/preparedAtTick/kind/source，上限 8）+ leak 指标；executing 状态视为严重异常（write-fault marker + 全局锁）；普通 prepared tick 边界失效释放但留审计事件；绝不静默当作正常 abort；下一 tick 旧 handle 不可用
- [x] 11.8 安全执行包装器 executePreparedAction：prepare → Game API 恰好一次 → ok=true commit / ok=false abort / 抛错 abort+rethrow；prepare 失败不执行 callback；正常完整执行后 outstanding 恒为 0；生产 writer 唯一推荐入口
- [x] 11.9 typed reservation owner：持久 typed identity（game-object/logical-service/task/contract/legacy-unresolved + id/roomName/namespace/lifecycleRef），entry 平铺字段与 store key 不变（marketSaleProtectionAdapter 完全兼容）；版本化迁移 migrateResourceReservationsForTypedOwner（幂等标记/数值不动/bump revision/损坏计入 damaged 不乐观忽略）；typed mutation（reserve/renew/release ForOwner）为唯一新写入口，旧字符串入口降级 deprecated adapter；调用方迁移（nukerControl typed 预留释放、factory/synthesis 自排除 typed 化——仅 identity 表达，业务行为不变）
- [x] 11.10 保守占用与 owner-aware 查询：无法确证 owner 失效的预留（active-unresolved/missing-owner）全额计入 committed——只有 expiresAt 或显式 release 解除；orphan 降级为诊断分类 ownerStatus；自排除用完整 typed identity 比较（同字符串不同 kind/namespace 不互相排除）；legacy-unresolved 不允许被普通 owner declaration 排除；TreasuryQueryOwner 升级 ownerKind/ownerId/namespace
- [x] 11.11 commitment 验证与 completeness：task（status/resource/房间/amount/remaining≤amount/origin/tick/blocked）与 reservation（room/resource/amount/expiresAt/holder/owner）记录级验证；损坏不进聚合（负 amount 不抬高 spendable、NaN 不污染）、不删原数据；能定位 bucket 标 (room,resource) scope incomplete、否则 globally-incomplete；balance view 暴露 commitmentStatus 与 authorizationSafe（incomplete scope 的 spendable=0/overcommitted=true）；unrelated scope 保持 complete；owner 缺失但数值合法继续全额扣除（missing ≠ incomplete）；shadow 通道 3 同口径
- [x] 11.12 单阶段入口退役：recordAcceptedTransaction/recordAcceptedAction 移出 TreasuryService 公共 API；实现保留经 treasury/compat 兼容模块访问（仅供既有测试与迁移过渡）；架构边界测试守护 9 个生产 writer 模块不得引用单阶段/compat、故障注入器与修复入口仅测试可引用、reservation store 直接写入仅限 resourceReservation.ts
- [x] 11.13 查询与 receipt 指标补全：withhold 收紧非负安全整数；rooms/locations 查询入口防御性快照；receipt 扫描计数细化（entriesVisited/migrationScans/loadValidationEntries/expiryCleanupEntries/fatalInspectionEntries）；到期清理与 nextExpiry 重算合并单次遍历；fatal-store 巡检不再有未计数 Object.keys 全扫
- [x] 11.14 测试补齐：canonical vectors（类型/边界/顺序/attempt/Unicode/超长定长/跨 tick 稳定）；tentative ledger（100k 双 prepare 拒/abort 后可行/容量超配/跨资源聚合/tentative 不入 projected/abort 只释放自己/不相关并行/gauge 一致/单阶段不绕过）；opaque handle（伪造/JSON/跨 generation/跨 tick 未 begin/重复幂等/conflict/状态机终态）；safe wrapper（prepare 失败不调用/非 OK abort/抛错 abort+rethrow/恰好一次/outstanding=0/执行期占用）；fault injection（五故障点无静默半提交/锁/global reset 恢复/显式修复）；endTick 审计（outstanding 样本/executing 严重故障/下 tick 失效）；typed owner（持久化/迁移/幂等/损坏保留/保守扣除/同字符串不同 kind/logical 精确排除/legacy 不可排除）；completeness（负 amount/NaN/remaining&gt;amount/非法资源/incomplete scope 零 spendable/unrelated complete/零写入）；架构边界 5 项；性能 fixture（64 并行 prepare 零扫描/多桶授权/abort-commit 清理/4096 admission O(1)/512+3 commitment/重复 query 零重建）
> **第五轮边界声明（未完成项，不得视为已完成）**：ResourceControl/terminal/lab/factory/market writer 迁移；ReceiverCapacityLedger 全量整合；Budget/完整 Contract Service；1000 tick shadow 与 CPU canary 完成；旧系统删除。当前 Treasury 写路径零生产接入，真实 writer 仍待独立评审后经 executePreparedAction 接入

## 12. 第六轮 Fault Recovery & Authority Integrity

- [x] 12.1 typed owner 持久 key：ownerToken（kind 前缀 + logical-service namespace 段 + id）与 makeReservationStoreKey 收敛唯一权威；store key v3 编码完整 identity；同 id 不同 kind/namespace 共存与独立 release；外部模块不得自行拼接持久 key（架构测试）
- [x] 12.2 key 迁移 v3 原子化：临时结构全量验证（形状/legacy key 一致性/新 key 无碰撞）→ 一次性引用切换 + version=3 + bump revision；malformed/collision 终止且不部分覆盖、不推进版本、授权 fail closed；幂等可重复；测试覆盖成功/重复/中途 collision/中途 malformed/失败后数据不变
- [x] 12.3 durable quarantine：Memory.runtime.treasury.quarantine（q: 前缀键、64 条上限 + overflowed）；endTick/beginTick 补救对 executing/faulted 先落 quarantine 再释放 heap tentative；普通 prepared 正常 expire；跨 tick/跨 service generation/global reset 测试；同 id prepare 拒绝（transaction_quarantined）；query 授权计入流出占用、projectedFreeCapacity 扣减
- [x] 12.4 safe execute 结果语义：executed_unsettled（Game OK + commit fault，携带 actionResult/transactionId/digest/faultPhase/retryForbidden）；executed_abort_failed（Game 非 OK + abort 未确认）；callback 抛错 abort 确认后 rethrow、abort 未确认转 faulted+quarantine（abort_failed）后 rethrow；同 id 下次调用 callback 零计数
- [x] 12.5 显式 fault resolution：移除 clearTreasuryWriteFaultForRepair；faultResolution 模块 resolve-as-committed（补 receipt 幂等/清 quarantine/清匹配 marker/global reset 后可完成/防重放）与 resolve-as-not-executed（仅 executing_at_end_tick/abort_failed 允许；释放 quarantine、不写 receipt、返回 reprepareAllowed）；错误 id/digest/不允许 resolution 拒绝且 fault 不动；生产 tick 不可自动调用（架构测试）
- [x] 12.6 receipt corruption fail closed：commitSettledReceipt 对 corrupted 返回 fatal（不 already_settled、不发布 heap projection）；prepare 前 corruption callback 零调用；Game OK 后 corruption → durable fault/quarantine；prepare 后人为损坏 receipt 再 commit 的确定性测试
- [x] 12.7 handle 生命周期有界：WeakSet/WeakMap 承载防伪与全生命周期记录；active strong registry 只含未清理状态，commit/abort 即删、tick 边界 stub 化（丢 canonical/observation/shape 引用）；preparedActive=active registry 大小；压力测试（大量终态后回到 0、terminal handle 幂等可用）
- [x] 12.8 runtime input 验证前置：公开 writer 入口在 canonicalize/digest 前形状验证（input/postings/decision/数值）；malformed → 结构化 rejected（invalid_input）不 throw；零 tentative/零槽位/零 registry 污染/callback 零调用
- [x] 12.9 commitment completeness 补严：status/blockedReason 枚举校验；resource ∈ RESOURCES_ALL；聚合累加安全整数检查（溢出→scope incomplete）；无法定位 scope 的损坏→globally incomplete；receiver 房间 completeness 判定修复（\u0000 分隔解析）
- [x] 12.10 authorizationSafe 重定义：多条件联合（commitment complete + receipt healthy + 无 write fault + 无 unresolved quarantine + lifecycle open + service/tick 合法 + migration 完成）；authorizationBlockers 有界诊断；新条件不归零数量字段；clean/fault/corruption/closed/migration/quarantine 全场景测试
- [x] 12.11 端到端场景测试：14 项（同 id 双 owner 隔离/普通 prepared 跨 tick 释放/executing 跨 tick quarantine/global reset 后拒再执行/Game OK+commit fault 全链/resolve-as-committed 幂等/resolve-as-not-executed 释放/不允许 resolution 拒绝/corruption 非 already settled/malformed input 结构化拒绝/终态 handle 不增长/枚举损坏 fail closed/故障阻断 authorizationSafe=false/性能不退化）
- [x] 12.12 验证与预算：typecheck/build/全量 Jest/verify-jest-budget（新预算锚点，requiredBaselineCommit 指向含全部实现与测试的前置 commit）；evidence/round6-fault-recovery-local-validation.md 记录起始 HEAD/最终 commit/验证命令与真实结果；不部署、不接真实 writer

## 13. 第七轮 Quarantine Closure & Schema Activation

- [x] 13.1 全局 quarantine write blocker：prepare 在同 id quarantine 检查后增加全局阻断（任意 unresolved/overflow → quarantine_write_blocked、store 损坏 → quarantine_store_fatal），callback 零调用；marker 清除后仍有其它 quarantine 时持续阻断；A/B 双 quarantine 逐个解决测试
- [x] 13.2 quarantine fault-slot 预留：持久 entryCount + active handle 数 < 64 才允许 prepare（O(1)），满则在 callback 前拒（quarantine_capacity_exhausted）；commit/abort/expire 释放 slot；fault 原子转换 slot 为持久 entry；legacy overflowed fail closed + 显式 repair（faultResolution 内，生产禁调）
- [x] 13.3 quarantine 版本化权威（schema v1）：version/entryCount 元数据 + 全字段 shape validation（key 编码/transactionId/digest/枚举/安全整数/聚合溢出）；global reset 后首次 load 全量验证 + heap health cache + 损坏 fail closed（prepare 阻断/resolution 拒绝/原数据不动）；write-fault marker 严格 shape validation（损坏视为存在 fault）；单一 canonical deltas（容量由其派生，删除 capacityDeltas 双权威）
- [x] 13.4 quarantine 资源/容量保守口径：正净流入减少 free capacity（projectedFreeCapacity + commitments capacityDelta 回调统一，receiver headroom 同口径）；负流出不增加 free capacity；正资源 delta 不加 spendable；多资源净额聚合；聚合 revision 缓存（query 不全扫）
- [x] 13.5 callback throw = execution unknown：抛错不再 abort——立即 faulted + marker（phase=action_threw_execution_unknown + 有界异常诊断）+ durable quarantine + 锁定后 rethrow；同 id 再执行 callback 零调用；ok:false + abort 失败立即隔离（phase=action_returned_non_ok_abort_failed）；phase 枚举拆分（commit 类 vs execution-unknown 类）
- [x] 13.6 post-observation fault resolution：输入加 evidence（conclusion/observationTick/source）与 guard（activeTransactionIds/currentObservationTick，facade 提供）；active handle 检查、tick/observation 时序检查、evidence 匹配、still_uncertain 保持隔离；not-executed 仅 execution-unknown 类 phase；resolve-as-committed 以 resolution tick 写 receipt（5001+ tick 延迟测试）+ action tick 保留于 resolution tombstone（有界 256 + retention 惰性清理 + 幂等 already_resolved）；resolution 后 endTick 不重新 quarantine
- [x] 13.7 reservation schema activation gate（v4）：ensureReservationSchemaActivated（空店初始化/legacy 迁移/失败拒绝/corrupted 拒绝）；挂载 beginTick bootstrap + 每个 mutation 入口自检；memoryCleanup 保留幂等兜底；无混合 store 测试
- [x] 13.8 canonical owner identity v4：长度前缀 token（ow2:<kindCode>:<nsLen>:<ns><id>）消除字段边界歧义；identity=kind+namespace+id（roomName/lifecycleRef 不参与）；kind-specific 收紧（ls namespace 必填、非 ls 禁止）；migration v1/v2/v3→v4（entry.owner 权威、碰撞检测、原子替换）；固定 test vectors（冒号边界/同 id 不同 kind/不同 namespace/Unicode/空格/超长）
- [x] 13.9 reservation mutation 权威：结构化结果（room/resource/amount/ttl/expiresAt 溢出/owner/gate 全验证，非法与失败零写入，bump 只在实际 mutation 且单次）；deprecated adapter 不二次 bump；listProductionReservations 冻结深拷贝；gc 损坏 entry 不删除、置持久 corrupted 标志 + 显式 repair
- [x] 13.10 write admission readiness：query 返回 writeAdmission {ready, blockers}（context/owner/commitment/migration/corrupted/receipt health+slot/quarantine health+slot/unresolved/fault/lifecycle/tick 全条件）；数值字段不受影响；prepare 独立复查；clean/满载/slot 不足/unresolved/migration/corruption 全场景测试
- [x] 13.11 指标与性能：quarantine entries/slots reserved/slots remaining/store healthy/admission rejections/unresolved count；resolution committed/not-executed/uncertain/rejected；execution unknown count；reservation activation/mutation rejections；prepare blocker 与 slot admission O(1) 的 operation-count fixture
- [x] 13.12 架构边界扩展：生产模块不得 import faultResolution（既有）；reservation mutation 必须经 schema gate；quarantine store 不得由 facade 外部直接写入；ForRepair 入口生产禁调；无条件 clear fault 不得回归
- [x] 13.13 验证与预算：typecheck/build/全量 Jest/verify-jest-budget（新预算锚点）；evidence/round7-quarantine-schema-local-validation.md；不部署、不接任何真实 writer
