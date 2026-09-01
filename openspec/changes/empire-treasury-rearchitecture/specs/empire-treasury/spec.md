## ADDED Requirements

### Requirement: 物理观察不可变且稀疏

国库必须（MUST）在每个 tick 为全部 owned room 的 storage 与 terminal 构建至多一次不可变稀疏物理观察。观察必须携带 observation tick 与单调 epoch 序号，不得保留可被后续修改的 Game Store/Structure 引用，不得将物理事实持久化到 Memory。帝国级总量必须（MUST）等于所有位置桶之和。扫描必须（MUST）对每个受管辖 Store 只做单次 key 枚举，不得执行 `RESOURCES_ALL` 全量探测，不得触发 `room.find`，且必须（MUST）复用 TickContext 已有的房间与结构事实。

#### Scenario: 同 tick 重复访问返回同一引用

- **WHEN** 同一 tick 内多个消费者获取 shared observation
- **THEN** 返回同一冻结对象引用，且任何查询方法都不得改变其内容（写入冻结字段必须抛错或被拒绝）

#### Scenario: 物理总量守恒

- **WHEN** 观察构建完成
- **THEN** 每资源帝国总量等于全部 storage/terminal 位置桶之和

#### Scenario: 不持久化物理事实

- **WHEN** 任一 tick 结束
- **THEN** Memory 中不存在物理库存观察副本（仅允许指标快照）

### Requirement: 三层余额语义分离

国库必须（MUST）区分 Observed（观察到的物理资产）、Projected（Observed + 本 tick 已被 Game 接受的动作增量）与 Committed（已被任务/预留/合同占用但未执行）。计划、reservation 与 pending task 不得（MUST NOT）修改 Observed。只有调用方在 Game API 返回成功后显式登记的已接受 transaction 才产生投影增量，且每笔必须（MUST）携带幂等 transactionId 与可追踪 kind/source。

transaction 必须（MUST）由一或多腿 posting 原子表达：全部 posting 整体验证通过后一次性写入 journal/overlay/receipt；任一 posting 非法时整笔回滚，不得（MUST NOT）出现部分写入。posting 的 delta 必须（MUST）为非零安全整数（NaN/±Infinity/0/非整数/非安全整数拒绝；同 key 多腿合并结果溢出安全整数拒绝）；resource 必须（MUST）合法；全部 postings 合并后净值为零的 no-op transaction 必须（MUST）整笔拒绝；交易后资源量与容量不得（MUST NOT）越界（负量拒绝、超物理容量拒绝、结果须为安全整数，含同 tick 多笔累计口径）。

真实 Game 写动作的执行必须（MUST）支持两阶段协议：prepare 在动作执行前完成全部 Treasury 侧验证并预留 receipt 容量槽（有界 pending，其余 admission 计入预留数）；Game API 失败 → abort 释放（零状态）；成功 → commit 重验物理后原子写入，兑现不得（MUST NOT）再因容量/版本/兼容性被拒；prepare→commit 期间世界变化导致重验失败时必须（MUST）拒绝（prepare_invalidated）且零写入。prepared handle 是 tick 内资源：endTick/beginTick 全部作废，跨 tick 必须（MUST）重新 prepare；重复 prepare 同 id 幂等；重复 commit 返回 already_settled；已 commit 不得（MUST NOT）被 abort。

#### Scenario: 两阶段 prepare→commit 成功兑现

- **WHEN** prepare 成功后真实动作成功并 commit
- **THEN** journal/overlay/receipt 全部生效；prepare 本身零状态

#### Scenario: abort 零状态

- **WHEN** prepare 成功后 Game API 失败并 abort
- **THEN** journal/overlay/receipt 零写入，预留释放，同 id 可重新 prepare

#### Scenario: prepare 预留容量槽

- **WHEN** prepare 成功后其他 transaction 把 receipt store 填满硬容量
- **THEN** 该 prepared handle 的 commit 兑现仍成功（槽位已预留，不因容量被拒）

#### Scenario: commit 重验失败零写入

- **WHEN** prepare 之后其他 transaction 推进 overlay 使 prepare 基线不再可行，然后 commit
- **THEN** 拒绝（prepare_invalidated）且零写入，可审计计数

#### Scenario: 跨 tick prepared handle 失效

- **WHEN** prepare 后进入下一 tick（endTick/beginTick 边界）再 commit
- **THEN** 拒绝（unknown_prepare），必须重新 prepare

#### Scenario: no-op transaction 拒绝

- **WHEN** 一笔 transaction 的全部 postings 合并后净值为零（完全抵消）
- **THEN** 整笔拒绝（no_op_transaction），不占用幂等/容量语义

#### Scenario: 非安全整数与合并溢出拒绝

- **WHEN** posting delta 为非安全整数（如 2^53），或同 key 多腿合并结果溢出安全整数
- **THEN** 整笔拒绝（invalid_posting_delta），零写入

#### Scenario: 投影不回写观察

- **WHEN** 登记一笔已接受 transaction 产生投影增量
- **THEN** observation 的原始数值保持不变，projected 查询返回 observed+delta

#### Scenario: 多腿原子交易

- **WHEN** 登记一笔携带两腿（storage 流出 / terminal 流入）的 transaction
- **THEN** 两腿 overlay 与 projected capacity 同时正确推进，observed 不变

#### Scenario: 中间 posting 非法整笔回滚

- **WHEN** 一笔 transaction 的第二腿引用未知房间或非法资源
- **THEN** 整笔拒绝（journal/overlay/receipt 零写入），拒绝原因可区分

#### Scenario: 幂等结算

- **WHEN** 同一 transactionId 被第二次登记（无论同 tick、后续 tick，还是 global reset 后服务重建）
- **THEN** 第二次登记被拒绝（already_settled）且不叠加增量；幂等判断优先于 payload 验证

#### Scenario: 单 tick 洪峰不淘汰

- **WHEN** 同一 tick 结算超过固定上限（512+）笔唯一 transaction 后重放第一笔
- **THEN** 第一笔仍被拒绝（already_settled），当前 tick receipt 绝不因容量上限被驱逐

#### Scenario: stale epoch 拒绝写入

- **WHEN** 决策上下文的 observedAtTick 不等于当前 tick 时登记 transaction
- **THEN** 登记被拒绝（stale_epoch），不得产生投影

#### Scenario: 决策 epoch 绑定

- **WHEN** 登记携带的 decision epochSeq 未在本 tick 注册表发行，或声明的 scope 与注册表不符
- **THEN** 登记被拒绝（unknown_epoch / scope_mismatch），不存在绕过注册表校验的公开登记入口

#### Scenario: endTick 后拒绝结算

- **WHEN** 本 tick 已调用 endTick 后再登记 transaction
- **THEN** 登记被拒绝（tick_closed），下一 tick 恢复正常

### Requirement: 幂等 receipt 最小持久化（version 3）

国库必须（MUST）将 transaction 幂等 receipt 持久化到 Memory（仅 transactionId → 结算 tick 的最小映射），使跨 tick 与 global reset 后的重放仍被拒绝。不得（MUST NOT）持久化 overlay、observation、journal 或任何物理事实副本。

store 格式必须（MUST）为 version 3：settled key 一律 `"t:"+transactionId` 前缀编码（transactionId 字符集允许 `__proto__`/`constructor` 等危险字面量，裸键赋值普通对象会触发原型污染语义；前缀编码后恒为普通自有键）；entryCount 计数（admission 快路径 O(1) 权威，加载时与实际自有键数校验）；nextExpiryTick 过期调度元数据（空表 null；非空 = min(settledAt)+retention+1）。

安全驱逐契约必须（MUST）保持：只自动回收超过 retention 窗口**且 value 完整验证通过**的条目；retention 窗口内的 receipt 绝不（MUST NOT）因容量压力被驱逐——未过期条目达硬容量且未到过期点时，新 transaction 必须（MUST）在写入任何状态之前被 O(1) 拒绝（receipt_capacity_exhausted，独立指标可审计，不做全表扫描）；已结算 id 的重放必须（MUST）仍优先返回 already_settled，store 满不得改变幂等结果。

settled value 必须（MUST）是 [0, Game.time] 内的安全整数。任何损坏 value（非 number/NaN/±Infinity/非整数/非安全整数/负数/未来 tick）不得（MUST NOT）在迁移中被跳过、不得（MUST NOT）在 cleanup 中被删除，必须（MUST）使整个 admission 进入 fail-closed（receipt_store_incompatible）：原数据不动、拒绝一切新 transaction、有界诊断与指标，直至显式管理修复；已能可靠识别的旧 transaction（自有键存在且 value 有效）查询仍必须（MUST）返回 already_settled——store 损坏不得让幂等保证期内的 id 被遗忘；value 损坏的 id 本身无法可靠判断，必须（MUST）整体阻断不乐观放行。

版本迁移必须（MUST）无损且原子：v1（裸键）的 raw key **原样**作为 transactionId 输入安全编码（`abc` 与 `t:abc` 是两个不同且都合法的 transactionId，decode 再 encode 会碰撞）；v2（前缀键 + entryCount）补 nextExpiryTick；迁移在临时结构完成全部校验（transactionId 格式 / settled tick 完整有效性 / 编码碰撞防御）并自检（own key 数 / entryCount / 存储键格式 / 每个 settled tick / 元数据一致性）通过后一次性替换原 store；发现碰撞、非法 key 或非法 value 时原 store 保持不变并 fail closed；迁移只执行一次；未知/更高版本 fail closed（原数据保留、不冷启动重建）。

过期调度必须（MUST）避免正常路径全表扫描：Game.time 未到 nextExpiryTick 时 beginTick 清理零扫描、满容 admission 直接 O(1) 拒绝（不反复全表扫描）；到达过期点执行一次清理并重算 nextExpiryTick；插入/迁移/清理后元数据必须（MUST）保持一致；global reset 后对元数据做一次完整验证，损坏即 fail closed 不放宽容量。必须（MUST）提供确定性操作计数（receipt full scans / admission fast-path / admission full-store blocked / expiry cleanup scans / store incompatible / migration count / slots remaining / next expiry tick），并以可运行的次数断言测试（不得只靠源码字符串检查证明性能）。

#### Scenario: global reset 后重放被拒

- **WHEN** 服务实例因 global reset 重建（heap 缓存丢失、Memory 保留）后重放已结算 transaction
- **THEN** 凭 Memory receipt 拒绝重放（already_settled），不产生重复投影；容量与 entryCount 从 Memory 恢复

#### Scenario: retention 内绝不因容量驱逐

- **WHEN** 未过期 receipt 已达硬容量且无过期可回收，此时登记新 transaction 或重放最老 receipt
- **THEN** 新登记被拒绝（receipt_capacity_exhausted，journal/overlay/receipt 零部分写入）；重放仍返回 already_settled

#### Scenario: 过期回收后容量恢复

- **WHEN** 满容 store 中的过期条目被回收（到达 nextExpiryTick 后的一次清理）
- **THEN** 新 transaction 可再次接纳，过期点被重算

#### Scenario: v1 迁移不碰撞

- **WHEN** v1（裸键）store 同时含 `abc` 与 `t:abc`（不同且都合法的 transactionId）及 `__proto__`/`constructor` 等危险字面量
- **THEN** 迁移到 v3 后分别成为不同的编码存储键，全部 transactionId 与结算 tick 无损、都能通过原 id 命中幂等、迁移只执行一次并计数

#### Scenario: v2 迁移补元数据

- **WHEN** Memory 中存在 v2（前缀键 + entryCount）store
- **THEN** 无损迁移到 v3 并补齐 nextExpiryTick，幂等立即生效

#### Scenario: 迁移遇损坏 fail closed

- **WHEN** v1/v2 store 含损坏 settled tick（NaN/负数/未来 tick）或非法 transactionId key
- **THEN** 原 store 保持不变、拒绝一切新登记（receipt_store_incompatible），不静默跳过或删除任何条目

#### Scenario: v3 value 损坏整体阻断但可靠 id 仍幂等

- **WHEN** v3 store 某条目 value 损坏
- **THEN** 新 transaction 与损坏 id 均被拒绝（receipt_store_incompatible）；value 仍有效的旧 id 查询返回 already_settled；原数据不被修正或删除

#### Scenario: 元数据损坏 fail closed

- **WHEN** entryCount 与实际自有键数不符，或 nextExpiryTick 与实际 min(settledAt)+retention+1 不一致
- **THEN** fail closed（不放宽容量、不静默重建），原数据保留

#### Scenario: 未知版本 fail closed

- **WHEN** receipt store 版本未知/更高
- **THEN** 拒绝一切新登记（receipt_store_incompatible）、原数据不被删除、fail-closed 计数可审计

#### Scenario: 危险字面量 id 的原型污染防护

- **WHEN** transactionId 为 `__proto__`/`constructor` 等合法但危险的字面量
- **THEN** 经 key 编码后只产生普通自有属性键，幂等读写命中且不污染原型

#### Scenario: 过期调度零扫描（可运行操作计数）

- **WHEN** Game.time 未到 nextExpiryTick 时执行 beginTick 清理或满载下反复 admission
- **THEN** 全表扫描计数不增长（满容拒绝 O(1)）；到达过期点后恰好一次清理扫描并重算过期点

### Requirement: 带上下文的余额查询

国库不得（MUST NOT）提供无上下文的可用量入口。任何可用量查询必须（MUST）声明资源、房间范围、位置范围、是否含投影、是否计入 incoming、是否扣除 outgoing/reservation 以及策略保留量。spendable 必须（MUST）非负；当物理-承诺-保留之差为负时必须（MUST）显式置位 overcommitted 而非静默钳制。stale observation 不得（MUST NOT）用于即时授权。

查询必须（MUST）支持 typed owner 声明（holderId + holderKind: "game-object" | "logical" + roomName + scope）：holderId 的两种形态并存（真实 Game object id 与 `nuker:`/`synthesis:` 等逻辑名）——运行时必须（MUST）以 typed 统一解析入口识别两种形态（逻辑名解析内嵌对象/房间归属，不得统一按 Game object id 解释而把逻辑名 holder 误判 orphan 导致 committed 低估）；holder 必须真实存在、声明 holderKind 必须（MUST）与运行时解析类型一致（不得仅凭知道 holderId 字符串冒充其他类型 owner）、声明房间必须与真实归属一致，任一不满足即 fail closed（spendable=0、overcommitted=true），不得（MUST NOT）返回乐观可用量；验证通过后只在该归属房间排除自己的 production reservation——查询多房间时其他房间照常全额扣除，其他 owner 一律照常扣除。projected capacity 必须（MUST）与 observed capacity 分离暴露，且随 posting 推进（流入增 used 减 free、流出反向、多资源聚合）。

查询输入必须（MUST）fail-closed 规范化：非法资源、非法/重复/**非管辖（unknown 或 unowned）**房间、**空 rooms / 空 locations scope**、非法/重复位置（重复会双倍累计，绝不静默去重）、**非布尔开关字段**（0/"true" 等真值不得静默当 true）、非有限非负 withhold（NaN/Infinity/负数）一律返回保守全零视图（contextStatus=invalid_fail_closed）并计数，不得（MUST NOT）报乐观可用量。

#### Scenario: spendable 非负且超卖可见

- **WHEN** 某资源 committed+withhold 超过 projected 物理量
- **THEN** spendable 返回 0 且 overcommitted=true

#### Scenario: owner 查询排除自身预留

- **WHEN** 合法 owner 声明查询且自己持有同房间/资源的 production reservation
- **THEN** committed 只扣除其他 owner 的预留；其他 owner 的预留照常扣除

#### Scenario: owner 存在性与房间归属验证

- **WHEN** owner 声明的 holder 不存在，或声明的 roomName 与运行时解析的 holder 真实归属房间不一致
- **THEN** fail closed（spendable=0、overcommitted=true，observed 物理事实仍如实返回）

#### Scenario: owner 多房间查询只排除归属房间

- **WHEN** 合法 owner 查询多个房间且在其他房间也持有 reservation
- **THEN** 只有其合法归属房间排除自己；其他房间（含该 owner 自己在他处的预留）照常全额扣除

#### Scenario: owner 非法 fail closed

- **WHEN** owner 声明 holderId 为空、holderKind 非法或 scope 未知
- **THEN** spendable=0 且 overcommitted=true（observed 物理事实仍如实返回）

#### Scenario: holderKind 冒充拒绝

- **WHEN** owner 声明 holderKind="game-object" 但 holderId 运行时解析为 logical 形态（或反之）
- **THEN** fail closed（spendable=0、overcommitted=true）——不得仅凭知道 holderId 字符串冒充其他类型 owner

#### Scenario: logical holder 不被误判 orphan

- **WHEN** production reservation 的 holderId 为 `nuker:<id>:<resource>` 等逻辑名且内嵌对象真实存在
- **THEN** 该预留照常计入 committed（不 orphan 排除、不低估承诺）；只有确证不存在的 holder 才计为孤儿

#### Scenario: 查询输入非法 fail closed

- **WHEN** 查询携带非法资源、重复房间/位置、非管辖（unknown/unowned）房间、空 rooms/locations scope、非布尔开关字段（如 allowProjected=1）或 NaN withhold
- **THEN** 返回保守全零视图（contextStatus=invalid_fail_closed）并计数 queryInvalidContexts

#### Scenario: projected capacity 与 observed 分离

- **WHEN** 本 tick 已结算流入 posting
- **THEN** projectedUsedCapacity 上升、projectedFreeCapacity 下降（多资源聚合），observation 的 used/free 保持不变

### Requirement: 承诺统一索引零隐藏写入与点时快照

国库必须（MUST）在每 tick 从既有持久权威（transfer tasks、production reservations）构建统一只读承诺视图，覆盖 outgoing/pendingOutgoing/incoming/pendingIncoming、receiver headroom（observed 与 projected 双轨）与 route merge lookup，且不得（MUST NOT）复制出第二套持久化任务数据。过期承诺必须（MUST）在读侧排除并计数；holder 已不存在的 reservation 必须（MUST）计为孤儿；原始记录的删除权必须（MUST）保留在其 owner。查询函数不得（MUST NOT）产生任何 Memory/Game 写入。

索引必须（MUST）是点时快照：构建期聚合为 primitive 值，不保留可被外部原地修改的 task/reservation 对象引用；receiver 维度构建期预聚合（查询不回扫 live task store）；route merge 查询基于预构建索引且同 route 重复 key 时返回第一个匹配（与旧 findMergeablePendingTask 语义一致）。权威数据 mutation（含 legacy schema 迁移）后，下一次承诺查询必须（MUST）看到新状态（统一 revision 失效机制，架构测试守护全部 mutation 入口）。receiver projected headroom 必须（MUST）每次查询动态组合静态承诺与当前 overlay 容量聚合——同 tick 结算 transaction 后的下一次查询立即反映最新投影，不得（MUST NOT）缓存依赖当前 overlay 的 projected 数值到旧结果；capacity delta 查询必须（MUST）O(1)（按位置聚合，不扫描资源 overlay）。

#### Scenario: 过期预留被排除但不被删除

- **WHEN** production reservation 的 expiresAt 早于当前 tick
- **THEN** 承诺聚合不计入该条目、expiredExcluded 递增，且 Memory 原始记录仍存在

#### Scenario: 查询无副作用

- **WHEN** 调用任一承诺/余额查询
- **THEN** Memory 与任务表内容保持不变

#### Scenario: 构建后原对象被修改，旧快照不变

- **WHEN** 索引构建后原 task 对象被原地修改（remainingAmount/status）
- **THEN** 已构建索引的聚合结果保持构建时点数值

#### Scenario: mutation 后失效重建

- **WHEN** 权威 mutation（reserve/cancel/progress/GC/legacy 迁移等）发生后再次访问承诺索引
- **THEN** 索引按新 revision 重建并反映新状态，查询自身仍零写

#### Scenario: receiver projected headroom 实时反映 overlay

- **WHEN** 先查询 receiver headroom、再结算一笔流入该 receiver 的 transaction、随后再次查询
- **THEN** projected headroom 立即减少（流出后恢复），observed 口径不变，且承诺 revision 未变时不重建整个索引

### Requirement: 跨 tick 对账不静默

国库必须（MUST）在构建新 tick 观察时执行两层对账：① manifest 结构层——endTick 归档房间/位置 manifest（owned 房间集合、每位置 exists/structureId/容量事实），下一 tick 与当前观察比对，空房间/空 storage/terminal 的出现与丢失、structureId 替换按位置各计一次（不随资源数重复）；② 资源 key union 层——previous finals ∪ current observed，数量差异按资源维度独立计数。任何非零差异必须（MUST）计入 reconciliation 计数并保留有限差异样本，不得（MUST NOT）静默丢弃。对账必须（MUST）显式分类：外部流入/流出、新资源、结构生命周期事件、tick gap（差异为 gap 累积值）与 global reset 恢复（无严格对账基准时显式标记）。mismatch 样本必须（MUST）可追溯至相关 transaction（id/kind）。

#### Scenario: 投影与现实的差异被记录

- **WHEN** 上一 tick 投影终态与本 tick 观察在某位置/资源上存在非零差异
- **THEN** reconciliation 计数递增且样本进入有界缓冲，样本携带相关 transaction id

#### Scenario: 新增资产被对账发现

- **WHEN** 本 tick 出现上一 tick 不存在的资源/位置/房间，或 storage/terminal 被新建、摧毁、structureId 替换
- **THEN** 对账产出对应分类（new_resource/new_location/new_room/location_lost/room_lost/structure_replaced），不静默

#### Scenario: 零资源结构变化被 manifest 层发现

- **WHEN** 空房间出现/丢失、空 storage/terminal 新建/摧毁或空结构 structureId 替换（稀疏资源枚举完全不可见）
- **THEN** manifest 结构层产出对应事件（每位置至多一条）；资源维度 inflow/outflow 独立计数不与之重复

#### Scenario: tick gap 与 global reset 显式标记

- **WHEN** 生命周期出现 tick gap 或服务因 global reset 重建
- **THEN** 对账结果分别携带 tickGap / afterGlobalReset 标记；reset 后无前序 finals 时不假装严格对账

### Requirement: 显式 tick 生命周期

国库必须（MUST）提供显式 beginTick/endTick 生命周期并由主循环固定挂载：beginTick 位于一切市场预检/生产/物流/规划之前（发行 shared epoch、清理 receipt、对账），endTick 位于本 tick 全部业务之后、最终 flush 之前（归档投影终态并关闭本 tick）。二者必须（MUST）幂等。业务模块不得（MUST NOT）决定 Treasury 的首次构建时间；未 begin 时的访问走零写懒兜底并计数。

#### Scenario: 每 tick 固定生命周期

- **WHEN** 主循环执行一个完整 tick（无论是否有 Treasury 消费者）
- **THEN** shared epoch 恰好发行一次，endTick 归档完成且写入 Memory lifecycle 标记

#### Scenario: 同 tick 重复调用幂等

- **WHEN** beginTick/endTick 在同一 tick 被重复调用
- **THEN** 不重复发行 epoch、不重复归档、计数不重复

#### Scenario: 缺 endTick 的异常路径补救

- **WHEN** 上一 tick 未经 endTick 直接进入下一 tick
- **THEN** beginTick 补救归档并显式计数（missingEnd），对账不静默跳过

### Requirement: 共享快照与 fresh epoch 隔离

国库必须（MUST）支持独立 fresh observation scope（如 market-fresh）。fresh 构建不得（MUST NOT）污染或替换 shared observation 缓存，也不得（MUST NOT）复用共享 snapshot 供需要新鲜读取的安全路径使用。epoch 注册表必须（MUST）保存每个 epoch 的 exact immutable observation：transaction 物理可行性验证必须（MUST）使用 decision 指向的那一次观察（数量/容量/结构存在性），不得（MUST NOT）回退 shared observation，同时必须（MUST）叠加本 tick overlay（跨 epoch 共享的已接受 intents）防同 tick 超卖。endTick 后必须（MUST NOT）再发行 fresh epoch。每 tick fresh 发行数必须（MUST）有硬上限（fresh 观察是全房间扫描，无上限即无界 CPU 风险）：超限拒绝并计数，下一 tick 恢复额度。epochSeq 必须（MUST）单点递增——每发行一个 epoch 恰好 +1（shared 与 fresh 连续编号无空洞），与实现注释一致。

#### Scenario: fresh 构建不影响 shared 缓存

- **WHEN** 调用 beginFreshObservation 构建 market-fresh 观察
- **THEN** shared observation 引用与内容不变，后续 shared 访问仍复用原缓存

#### Scenario: fresh exact 基线绑定

- **WHEN** shared 基线较高而 fresh 观察（决策时点物理骤降后）较低，基于 fresh 的超量流出/容量溢出
- **THEN** 以 fresh 基线拒绝（insufficient_amount/capacity_overflow），不得回退 shared 放行

#### Scenario: overlay 跨 epoch 共享

- **WHEN** fresh 发行前已有本 tick 已接受 transaction（overlay 占用）
- **THEN** 基于 fresh 的后续 transaction 同样受 overlay 限制，不能借 fresh 基线超卖

#### Scenario: endTick 后拒绝 fresh 发行

- **WHEN** 本 tick 已 endTick 后调用 beginFreshObservation
- **THEN** 返回 null（不再发行 fresh epoch）

#### Scenario: fresh 每 tick 数量上限

- **WHEN** 本 tick fresh 发行数已达硬上限后继续调用 beginFreshObservation
- **THEN** 返回 null 并计数（freshEpochLimitRejections）；下一 tick 额度恢复

#### Scenario: epochSeq 单点递增无空洞

- **WHEN** 依次发行 shared、多个 fresh、下一 tick shared
- **THEN** epochSeq 连续 +1（1、2、3…），无重复递增造成的空洞

### Requirement: Treasury Shadow 零行为写入

新旧对比 shadow 必须（MUST）以低频采样运行，对比 Treasury 观察与旧索引及独立直读通道（房间 storage/terminal 资源、帝国总量、capacity、缺失位置、stale epoch、承诺重复计数），差异必须（MUST）进入有界样本与聚合计数。shadow 不得（MUST NOT）执行任何 Game intent 写入、市场/物流/生产动作或生产行为变更。

#### Scenario: shadow 无游戏写

- **WHEN** shadow 检查运行
- **THEN** 不发生任何 store 写入、terminal.send、market deal 或任务状态变更

#### Scenario: stale 观察不产出对比结论

- **WHEN** Treasury epoch 落后于当前 tick
- **THEN** 记录 stale mismatch 且不使用该数据产出等价性结论

### Requirement: 单一 Gateway 与服务挂载

国库必须（MUST）作为 RuntimeServices 的服务被访问，全部状态由服务实例持有，不得（MUST NOT）新增未登记的 global 私有槽或冻结声明之外的 Memory schema 字段。业务模块不得（MUST NOT）绕过 Treasury Gateway 建立第二套资源承诺权威。

#### Scenario: 服务挂载与测试隔离

- **WHEN** 测试调用 resetForTest
- **THEN** observation/journal/overlay/承诺索引与指标全部清空并可重建

### Requirement: Write admission 两阶段协议（tentative ledger + opaque handle + staged commit）

Treasury 的写入授权必须（MUST）满足：prepare 成功即预留 transaction 所需的资源、容量与 receipt 槽（tentative ledger）；后续 prepare 与单阶段兼容路径的授权计算计入全部 tentative（同一 handle 自身预留不重复计算）；同一资产不得（MUST NOT）被两笔 prepared transaction 超额授权。public projected 只表示已 commit 的动作，tentative 不得（MUST NOT）混入。

prepared handle 必须（MUST）是 heap 内不可伪造的冻结 capability：结构相同的普通对象、JSON round-trip 副本、其他 service generation 的 handle 一律 invalid_handle；handle 只在签发 tick 与 generation 内有效，commit/abort 自行校验（不依赖调用方先 beginTick）。prepare 保存深复制并规范冻结的 canonical transaction 与 payload digest；相同 transactionId、相同 digest 重复 prepare 幂等返回同一 handle，不同 digest 必须（MUST）返回 prepare_conflict。状态机 committed/aborted/faulted/expired 为终态：commit 只能成功一次（重复幂等 already_settled）、abort 只能一次（重复 already_finalized）、终态不可回退。

commit 必须（MUST）执行 tentative → committed 兑现而非重新业务 admission：Game API 已返回 OK 后不得（MUST NOT）再因资源、容量、epoch 或 receipt 条件拒绝合法 handle（prepare_invalidated 正常路径删除）。abort 必须（MUST）原子释放 tentative 资源/容量/receipt 槽且零结算写入。

commit 必须（MUST）staged 发布：receipt（Memory 权威，返回明确结果）→ heap（journal/overlay 分段）→ handle 状态。任一阶段意外失败进入 faulted 终态：不得（MUST NOT）当作普通 rejected/aborted，tentative 与槽位不释放，写入最小有界持久 write-fault marker，全部后续 writer fail closed（write_admission_locked）直至显式修复路径解除；global reset 后仍可发现 unresolved fault。endTick 遇到未决 prepared 必须（MUST）计数并保留有界样本（绝不静默当作正常 abort）；executing 状态视为严重异常并进入 write-fault。安全执行包装器必须（MUST）保证 prepare 失败不执行 Game API、callback 恰好一次、非 OK 自动 abort、抛错 abort 后 rethrow、OK 必走 commit。

#### Scenario: 双 prepare 不得超额授权同一资产

- **WHEN** 100k 资产上 A prepare -60k 成功后 B prepare -60k
- **THEN** B 被 tentative 感知授权拒绝（insufficient_amount）；A abort 后 B 同量 prepare 成功

#### Scenario: tentative 不进入 public projected

- **WHEN** prepare 成功后查询 projected/容量口径
- **THEN** projected 与 observed 容量不变（tentative 仅 gauge 可见）；commit 后 tentative 消失、committed projected 生效

#### Scenario: commit 兑现不受他笔 transaction 影响

- **WHEN** prepare -90k 成功后他人单阶段尝试流出同资产 95k
- **THEN** 他人在其自身 admission 被拒；prepared handle 的 commit 仍 committed（不再返回 prepare_invalidated）

#### Scenario: 伪造与跨上下文 handle 无效

- **WHEN** 以结构相同的伪造对象、JSON 反序列化副本或另一 service 实例的 handle 调用 commit/abort
- **THEN** 一律 invalid_handle；previous tick 的 handle 即使未先 beginTick 也 handle_expired

#### Scenario: 相同 ID 不同 payload 冲突

- **WHEN** 相同 transactionId 以不同 canonical payload 重复 prepare
- **THEN** 返回 prepare_conflict（不再无条件返回 prepared）；相同 payload 幂等返回同一 handle

#### Scenario: prepare 后修改原 input 不影响 canonical

- **WHEN** prepare 成功后调用方原地篡改原 postings/kind
- **THEN** Treasury 内部 canonical payload 不变，commit 兑现 prepare 时的数值

#### Scenario: staged commit 故障进入显式 faulted 而非静默半提交

- **WHEN** receipt/heap（journal/overlay）/handle 状态任一发布阶段发生意外故障
- **THEN** handle 进入 faulted 终态、tentative 与 receipt 槽不释放、write-fault marker 持久记录 phase、后续全部 writer 被 write_admission_locked 阻断；marker 不随 tick 生命周期自动清除，只有显式修复路径解除

#### Scenario: global reset 后仍可发现 unresolved write fault

- **WHEN** 写故障发生后 heap 全失（新 service 实例、Memory 保留）
- **THEN** 新实例凭 Memory marker 持续锁定全部 writer

#### Scenario: endTick outstanding 审计与 executing 严重异常

- **WHEN** endTick 时存在未决 prepared（未终态）
- **THEN** 计数 outstanding、保留有界样本（transactionId/digest/preparedAtTick/kind/source）并累加 leak 指标；executing 状态写 write-fault marker 并全局锁；下一 tick 旧 handle 一律不可用

#### Scenario: 安全执行包装器语义

- **WHEN** 经 executePreparedAction 执行 prepare → Game API → 终态
- **THEN** prepare 失败时 callback 不执行；callback 恰好一次；非 OK 自动 abort；抛错自动 abort 并 rethrow；OK 后必走 commit；正常完整执行后 outstanding prepared 为 0

### Requirement: typed reservation owner 权威与保守占用

production reservation 的 owner 必须（MUST）持久为 typed identity（kind: game-object/logical-service/task/contract/legacy-unresolved + 稳定 id + 可选 room scope/namespace/lifecycle 引用），平铺字段与 store key 保持既有格式（保护路径兼容）。安全默认：无法确证 owner 已失效的预留（active-unresolved/missing-owner）必须（MUST）保守全额计入 committed——只有 expiration 或显式 release 才能（MAY）解除占用；orphan 语义仅是诊断分类。自排除必须（MUST）比较完整 typed identity（同 kind + 同 id + 同 namespace）：同字符串不同 kind 不得（MUST NOT）互相排除；legacy-unresolved 不允许普通 owner declaration 排除；task/contract 暂无运行时存在性权威，声明即 fail closed。版本化迁移必须（MUST）无损（数值字段与 store key 不动、幂等版本标记、迁移后 bump commitment revision），损坏条目保持原样并显式计数，不得（MUST NOT）乐观忽略。

#### Scenario: legacy 裸字符串无损迁移

- **WHEN** 存量裸 holderId 条目首次迁移
- **THEN** 按已知 namespace/object id/task/contract 形状分类补写 owner（其余 legacy-unresolved），room/resource/amount/expiresAt 与 store key 不变，revision 失效，版本标记幂等短路

#### Scenario: owner 消失仍保守占用

- **WHEN** game-object owner 的对象暂时不存在（或 legacy-unresolved）
- **THEN** 预留继续全额计入 committed（missing ≠ 可重新支配）；只有 expiresAt 到期或显式 release 解除

#### Scenario: 同字符串不同 kind 不互相排除

- **WHEN** 某稳定 id 字符串同时作为 game-object 与 logical-service 存在，查询声明其一
- **THEN** 只排除同 kind + 同 namespace 的预留；legacy-unresolved 的同字符串预留照常扣除

### Requirement: commitment 数据验证与 completeness

承诺索引必须（MUST）对 task 与 reservation 做记录级验证（字段形状与 remaining≤amount 等数值关系）。损坏记录不得（MUST NOT）进入聚合（负 amount 抬高 spendable、NaN 污染求和均禁止）、不得（MUST NOT）被读取路径删除；必须（MUST）标记受影响 scope：能定位 bucket 的标 (room,resource) incomplete，无法定位的标 globally-incomplete。incomplete scope 的 spendable 必须（MUST）为 0、overcommitted 为 true、authorizationSafe 为 false；unrelated scope 保持 complete。owner 缺失但数值合法的预留继续全额保守扣除（missing ≠ incomplete）。

#### Scenario: 损坏数值不得提高 spendable

- **WHEN** 某房间 reservation amount 为负或 NaN
- **THEN** 该 (room,resource) scope incomplete、spendable=0、authorizationSafe=false；聚合值不含该记录；原始 Memory 不被删除

#### Scenario: scope 粒度隔离

- **WHEN** U 资源维度存在损坏记录
- **THEN** 同房间 energy 查询与其他房间 U 查询保持 complete 且可正常授权

#### Scenario: 授权不得只看 spendable

- **WHEN** 查询覆盖的任一 scope incomplete 或全局 incomplete
- **THEN** balance view 的 commitmentStatus 反映最差状态且 authorizationSafe=false

### Requirement: canonical hashed transaction identity 与单阶段退役

transactionId 铸造必须（MUST）基于版本化 canonical tuple 序列化（类型标签 + 长度前缀）：number 与 string、元组边界、字段顺序、attempt sequence 全部可区分；Unicode/空格/冒号/空串为合法业务字段；输出为稳定 hash 的定长合法 id（不依赖随机数、相同输入跨 tick 恒定）；stable 与 per-tick 命名空间使用不同且不可重叠的前缀；存量 id validator 保持兼容；固定 test vectors 锚定。正式生产 writer 不得（MUST NOT）调用单阶段登记入口：该入口必须（MUST）从公共 TreasuryService API 移除并隔离到 compat 模块（架构边界测试守护 terminal/market/factory/lab/carrier/ResourceControl 等生产模块禁用），未来 writer 一律经 prepare + 安全执行包装器 + commit/abort。

#### Scenario: 类型与边界不碰撞

- **WHEN** number 42 与 string "42"、("a","b:c") 与 ("a:b","c") 分别铸造
- **THEN** 产出互不相同的 id；超长业务字段产出固定长度合法 id；固定 test vectors 跨实现版本稳定

#### Scenario: 生产 writer 禁用单阶段入口

- **WHEN** 架构边界测试扫描生产 writer 模块与 compat 模块引用面
- **THEN** 任何生产模块不引用单阶段入口/compat；compat 仅 Treasury 测试与迁移过渡可用；reservation store 直接写入仅限权威 mutation 模块


### Requirement: typed owner 持久身份与原子迁移

reservation 持久 key 必须（MUST）编码完整 typed owner identity（kind + namespace + id）：不同 kind、不同 namespace、相同 id 的 owner 不得（MUST NOT）在持久层碰撞；相同房间/资源/相同 id 不同 kind 或 namespace 的 owner 必须（MUST）可以同时存在且独立 release。ownerToken 与 store key 的构造必须（MUST）收敛到唯一权威 helper（ownerIdentity.ts / resourceReservation.ts），外部模块不得（MUST NOT）自行拼接持久 key。key 迁移必须（MUST）先在临时结构完成全部验证（形状完整、legacy key 与平铺字段一致、新 key 无碰撞），验证全部通过后一次性原子替换并推进版本 + bump commitment revision；任何 malformed 或 collision 必须（MUST）终止整个迁移：原数据不动、版本不推进、授权状态 fail closed；迁移必须（MUST）幂等可重复执行。

#### Scenario: 同 id 不同 kind/namespace 共存与独立 release

- **WHEN** 相同 room+resource+id 分别以 game-object 与 logical-service（或不同 namespace）身份 reserve，随后 release 其中一个
- **THEN** 两条 reservation 同时存在（不同持久 key）；release 只删除被指定的 owner 条目，另一条完整保留并继续计入 committed

#### Scenario: 迁移失败不部分覆盖、版本不推进

- **WHEN** 迁移遍历中发现 malformed entry 或新 key collision
- **THEN** 整个迁移终止：store 保持原样（无部分写入）、resourceReservationsOwnerVersion 不变、授权侧因 migration 未完成 fail closed；修复后重复执行迁移成功

### Requirement: durable quarantine（executing/faulted 跨 tick 占用）

tick 边界发现 executing（Game 结果未知）或 commit-faulted 的 prepared transaction 时必须（MUST）写入持久 quarantine（跨 global reset 与 service 重建存活），且不得（MUST NOT）将其 tentative 资源/容量当作普通 prepared 释放。quarantine 必须（MUST）继续占用资源、容量与 transaction identity（授权计算计入流出量），不得（MUST NOT）进入 committed projection；quarantine 未解决前同一 transactionId 的 prepare 必须（MUST）被拒绝。普通、确定未调用 Game API 的 prepared transaction 仍必须（MUST）在 tick 边界正常 expire 并释放。quarantine 存储必须（MUST）有界（上限条目数 + 溢出标志），且不得（MUST NOT）只依赖全局 write-admission lock 存活。

#### Scenario: executing 跨 tick 进入 quarantine 且资源不释放

- **WHEN** transaction 进入 executing 后 tick 结束（endTick）
- **THEN** 该 transaction 出现在持久 quarantine；下一 tick（含模拟 global reset / 新 service 实例）同 id prepare 被拒；query 的 committed 计入其流出占用

#### Scenario: 普通 prepared 跨 tick 正常释放

- **WHEN** 普通未执行 prepared transaction 在 tick 边界作废
- **THEN** tentative 资源/容量与 receipt 槽释放（不留 quarantine）；下一 tick 同 id 可重新 prepare

### Requirement: safe execution 结果语义不可混淆

安全执行包装器的返回必须（MUST）区分：prepare 拒绝（callback 零调用）、Game 非 OK 且 abort 已确认、Game 非 OK 且 abort 未确认、Game OK 且 commit 成功、**Game OK 但 Treasury commit 失败或进入 write fault**、已结算。Game callback 成功后的 Treasury 故障绝不能（MUST NOT）返回暗示未执行的状态（prepare_rejected/aborted）；该状态必须（MUST）保留原始 Game API 结果与 transaction/fault identity，并明确禁止自动重试；同一 transaction 的下一次调用必须（MUST）在 callback 前被拒绝且 callback 计数为零。callback 返回非 OK 后 abort 失败时不得（MUST NOT）报告已正常 abort。

#### Scenario: Game OK 后 commit fault 的结果语义

- **WHEN** Game callback 返回 ok:true 且随后 commit 注入写故障
- **THEN** 返回 executed_unsettled（携带原始 actionResult 与 fault identity、retryForbidden）；transaction 进入 durable quarantine；下一次同 id 调用 callback 计数为零

### Requirement: 显式 fault resolution（无无条件解锁入口）

不得（MUST NOT）保留任何调用方可直接删除 fault marker 后继续写的入口。fault 解决必须（MUST）经显式 resolution 协议：resolve-as-committed 补全/确认 receipt（幂等、最多提交一次）、释放对应 quarantine、清除匹配的 write-fault marker、防后续重放、global reset 后仍可完成；resolve-as-not-executed 仅允许（MUST）在证据允许（Game 结果未确认的 phase）时执行：释放 quarantine、不生成 committed projection、明确是否允许重新 prepare。错误 transactionId/digest、已解决或不允许的 resolution 必须（MUST）被拒绝且 fault 不被删除。resolution 必须（MUST）幂等，且在完成前 write admission 持续锁定；生产 tick 不得（MUST NOT）自动调用 resolution。

#### Scenario: resolve-as-committed 幂等且补全 settlement

- **WHEN** 对 quarantined transaction 执行 resolve-as-committed（含模拟 global reset 后）并重复调用
- **THEN** receipt 补全且只计账一次；quarantine 与对应 marker 清除；重复调用幂等返回；同 id 重新 prepare 命中 already_settled

#### Scenario: 不允许的 resolution 被拒绝

- **WHEN** 对 Game 已确认 OK 的 commit-fault transaction 执行 resolve-as-not-executed，或 digest 不匹配
- **THEN** resolution 被拒绝；fault marker 与 quarantine 保持不变；write admission 仍锁定

### Requirement: receipt corruption fail closed

settled tick、undefined、corrupted 三态必须（MUST）在全路径保真：只有有效 settled tick 可解释为 already settled；corrupted 必须（MUST）立即 fail closed——不得（MUST NOT）被当作 already_settled、不得（MUST NOT）发布 committed heap projection；prepare 前发现 corruption 时 callback 必须（MUST）零调用；Game callback 成功后 commit 期间发现 corruption 必须（MUST）进入 durable fault/quarantine（已执行事实不丢失）。

#### Scenario: prepare 后损坏 receipt 再 commit

- **WHEN** prepare 成功后人为破坏 receipt store（value 损坏）再 commit
- **THEN** commit 进入 faulted + durable quarantine，绝不返回 already_settled，绝不发布 heap projection

### Requirement: prepared handle 生命周期有界

prepared handle registry 必须（MUST）不形成长寿命 global heap 的无界强引用：只有 active（未清理）transaction 可被强引用；commit/abort/expire/fault 后必须（MUST）立即从 active strong registry 删除；terminal handle 在引用仍存在时可返回稳定幂等结果但不得（MUST NOT）形成全局无界强引用；tick 边界后不再需要的 canonical payload/observation/大对象引用必须（MUST）释放；heap-only handle 不得（MUST NOT）持久化到 Memory。

#### Scenario: 大量终态 handle 不增长 active registry

- **WHEN** 大量 prepare→abort / prepare→commit / prepare→expire 循环后
- **THEN** active registry 计数回到 0（不随历史 transaction 数量增长）；仍被引用的 terminal handle 幂等判定可用

### Requirement: runtime input 验证先于 canonicalization

所有公开 Treasury writer 入口必须（MUST）在读取、遍历、digest 或 canonicalize 输入之前完成基本形状验证（null/undefined input、postings 非数组或含 null/错误类型、decision 缺失或形状错误、数值非 finite/非整数/非安全整数等）。malformed runtime input 必须（MUST）返回结构化 rejection/fault 而非抛出中断整个 tick；且不得（MUST NOT）创建 tentative reservation、不得占用 receipt slot、不得污染 active handle registry、callback 必须（MUST）零调用。

#### Scenario: malformed input 结构化拒绝

- **WHEN** 以 null input、非数组 postings、缺失 decision 等调用 prepareTransaction/executePreparedAction
- **THEN** 返回结构化 rejected（invalid_input）不抛出；tentative/receipt 槽/handle registry 零变化；callback 零调用

### Requirement: commitment completeness 与 authorizationSafe 联合判定

commitment 索引必须（MUST）严格验证枚举字段（task status、blockedReason 属于合法集合）、resource（RESOURCES_ALL）、数值（finite/整数/安全）与聚合安全整数（溢出即 incomplete）；无法定位单一 scope 的损坏记录必须（MUST）使索引 globally incomplete；损坏记录不得（MUST NOT）被静默跳过后维持 authorizationSafe。authorizationSafe 必须（MUST）仅在以下条件全部满足时为 true：commitment complete、receipt store healthy、无 active write fault、无阻断性 unresolved quarantine、lifecycle open、service/tick 状态合法、必要持久 migration 已完成。任一失败时 authorizationSafe=false 且 diagnostics 指出主要阻断原因；不得（MUST NOT）以数值归零掩盖原因（新阻断条件不改变数量字段）。

#### Scenario: 未知枚举/非法资源/聚合溢出 fail closed

- **WHEN** task status 为未知值（如 pendng）、blockedReason 非法、resource 不在 RESOURCES_ALL、聚合溢出安全整数或损坏无法定位 scope
- **THEN** 对应 scope（或全局）incomplete；受影响查询 authorizationSafe=false

#### Scenario: 故障阻断下 authorizationSafe=false 且数值保留

- **WHEN** 存在 write fault、receipt unhealthy、lifecycle closed（endTick 后）、migration 未完成或 quarantine unresolved
- **THEN** authorizationSafe=false 且 authorizationBlockers 指出主因；observed/projected 等数量字段照常返回供观察

### Requirement: unresolved quarantine 为全局 write blocker（第七轮）

存在任何 unresolved quarantine、quarantine store overflow 或 corruption 时，一切新的 Game write callback 必须（MUST）被阻止在开始之前：新 transaction 的 prepare 在 callback 前被拒（同 id 已 quarantined 的返回 transaction_quarantined，其余返回明确的 quarantine/write-admission blocker）；已结算 transaction 的幂等查询仍可（MAY）返回 already_settled。write-fault marker 不得（MUST NOT）是唯一锁来源：marker 被解决但仍有其它 unresolved quarantine 时，write admission 与 readiness 必须（MUST）继续阻断。overflowed 状态不得（MUST NOT）通过简单删除 marker 恢复。

#### Scenario: 双 quarantine 逐个解决期间持续阻断

- **WHEN** A、B 两笔 quarantine 共存，先解决 A（root marker 随之清除）后新 transaction C prepare
- **THEN** C 在 callback 前被拒且 callback 零调用；解决 B 后 write admission 与 readiness 恢复

### Requirement: prepare 预留 durable quarantine fault slot（第七轮）

prepare 成功前必须（MUST）保证最坏情况下仍有空间持久化该 transaction 的 quarantine：持久 quarantine 数 + active prepared 数达到上限时，prepare 必须（MUST）在 Game callback 之前拒绝。正常 commit 或确认 abort 后 fault slot 必须（MUST）释放；transaction fault/execution unknown 时预留 slot 必须（MUST）原子转换为持久 entry；不得（MUST NOT）出现"达到上限后只置 overflowed 但不保存 entry"的路径。legacy overflowed 标志必须（MUST）fail closed 且只有显式 repair 可清除。

#### Scenario: 63 条 quarantine + 1 条 prepared 后拒绝新 prepare

- **WHEN** 持久 quarantine 已有 63 条且存在 1 条 active prepared，再 prepare 新 transaction
- **THEN** 新 prepare 在 callback 前被拒；abort/commit 释放 slot 后可恢复；fault 将 slot 转换为持久 entry 且 transactionId 可查

### Requirement: quarantine 版本化与健康契约（第七轮）

quarantine store 必须（MUST）是版本化持久权威：version、entryCount 元数据与 entries 形状（key 编码与 transactionId 一致、transactionId/digest 合法、tick 安全整数、phase/locationKind/resource 枚举、delta 非零安全整数、聚合不溢出）在 global reset 后首次 load 全量验证，后续读取使用 heap health cache。损坏时必须（MUST）fail closed：原数据不删、新 prepare 全部阻断、authorization/write readiness 为 false、fault resolution 拒绝、提供有界诊断。不得（MUST NOT）在未验证 store 上直接聚合。write-fault marker 同样必须（MUST）严格 shape validation，损坏 marker 不得（MUST NOT）被当作"没有 fault"。canonical posting 事实必须（MUST）单一持久来源，容量占用由其派生（或双字段严格一致校验）。

#### Scenario: quarantine store 损坏 fail closed

- **WHEN** entries 为 null、version 未知、delta 非法、resource/location 非法或聚合溢出
- **THEN** 结构化 fail closed：新 prepare 拒绝（callback 零调用）、readiness false、resolution 拒绝、原数据保留

### Requirement: quarantine 资源与容量保守方向（第七轮）

unresolved 负资源 delta（可能已流出）必须（MUST）继续占用对应资源；unresolved 正资源 delta（可能已流入）不得（MUST NOT）乐观计入 spendable；quarantine 不进入 committed projection/journal。对某 location 的 unresolved 正净容量 delta 必须（MUST）减少 free capacity（含 receiver headroom 口径）；负净容量 delta 不得（MUST NOT）增加 free capacity；多资源 posting 按 location 净额聚合。

#### Scenario: 容量方向

- **WHEN** quarantine 含 +1000 流入 posting（同 location）与另一条 -500 流出 posting
- **THEN** 该 location free capacity 因 +1000 减少而不因 -500 增加；observed/projected 基础数值不被 quarantine 冒充修改

### Requirement: callback 抛异常为 execution unknown（第七轮）

action callback 一旦抛出异常，默认必须（MUST）视为 execution unknown：不得（MUST NOT）执行普通安全 abort；transaction 必须（MUST）进入 durable quarantine（receipt/fault slot/identity 保留）；write admission 必须（MUST）锁定；原始异常信息保留为有界诊断（不持久化完整 Error 对象）后 rethrow 或返回结构化 execution-unknown 结果。同 transaction 再执行时 callback 必须（MUST）零调用。只有 callback 正常返回明确非 OK 才可（MAY）走普通 abort；其 abort 失败必须（MUST）立即隔离（phase 与 callback throw 区分）。phase 枚举必须（MUST）区分 action_returned_non_ok_abort_failed / action_threw_execution_unknown / executing_at_end_tick / commit 类，且 not-executed resolution 的允许性按此区分。

#### Scenario: callback 抛错进入 execution unknown

- **WHEN** callback 内产生模拟副作用计数后抛出 Error
- **THEN** 副作用计数只增加一次；transaction 进入 quarantine 且 tentative 不释放为可重用资产；下一次执行 callback 零调用；无证据时 resolve-as-not-executed 被拒

### Requirement: post-observation fault resolution 证据协议（第七轮）

fault resolution 不得（MUST NOT）在 transaction 仍属于当前 active handle registry 时执行；不得（MUST NOT）在当前 tick 不大于故障 tick、或尚未建立故障后 shared observation 时执行。resolution 必须（MUST）携带显式 reconciliation evidence（结论、post-action observation tick、证据来源）并与 transaction/digest 匹配：evidence 观察早于或等于故障 tick、或 stale/非法时拒绝；still uncertain 保持 quarantine 不解锁；commit 类 phase 不允许 not-executed resolution（除非更强显式证据）。resolve-as-committed 必须（MUST）以 resolution/settlement 当前 tick 写 receipt（完整 retention 窗口），原 action tick 保留用于审计但不缩短 retention；not-executed resolution 应（SHOULD）拥有有界幂等 tombstone 使重复调用返回 already_resolved。resolution 必须（MUST）幂等且不得（MUST NOT）在 endTick 重新 quarantine 刚解决的 transaction。

#### Scenario: 延迟 5001 tick 后 resolve-as-committed

- **WHEN** fault 后延迟超过 5000 tick 才执行 resolve-as-committed
- **THEN** receipt 使用 resolution tick（下一 tick cleanup 不删除）；action tick 保留在审计记录；重复调用幂等

#### Scenario: active handle 与证据校验

- **WHEN** 对仍存在于当前 service active registry 的 faulted handle 执行 resolution，或 evidence 不匹配/观察早于故障 tick
- **THEN** resolution 拒绝；quarantine/marker/receipt 不变；下一 tick 建立 post-observation 后合法 resolution 可完成且 endTick 不重新 quarantine

### Requirement: reservation schema 激活先于一切 mutation（第七轮）

任何 reservation mutation（typed 与 deprecated adapter）之前必须（MUST）完成 schema activation：空 store 原子初始化为当前版本；legacy store 必须先迁移成功才允许 mutation；migration 失败时 mutation 必须（MUST）返回结构化拒绝（零写入）且 authorization/write readiness fail closed。不得（MUST NOT）出现混合版本 store（legacy key 与新 key 并存、version 缺失 + 新 key、migration 运行中继续 mutation）。schema 版本必须（MUST）升级到 canonical owner token 版本，迁移覆盖 legacy v1 / owner v2 / token v3 / 新 canonical 版本，以验证过的 entry.owner 为权威重建全部 key 并检测碰撞。

#### Scenario: bootstrap activation 与失败拒绝

- **WHEN** 空 store 首次 mutation、legacy store mutation 前、migration 失败后 mutation
- **THEN** 空店自动激活新版本；legacy 先迁移成功后 mutation 生效且无混合 key；失败时 mutation 结构化拒绝、原数据不动、授权 fail closed；memoryCleanup 不是唯一激活路径

### Requirement: canonical owner identity 与 mutation 权威（第七轮）

owner 持久 identity 的比较键与持久 key 必须（MUST）使用同一套无歧义 canonical 编码（字段边界无歧义、kind/namespace/id 参与身份、长度有界、同输入稳定、不同 tuple 于已知边界不碰撞）；identity 与 metadata 必须明确区分（roomName 由 store key 外层表达、lifecycleRef 不参与身份）。kind-specific validation 必须（MUST）一致（logical-service namespace 必填、非 logical-service 禁止 namespace）。mutation API 必须（MUST）返回结构化结果并验证 roomName/resource/amount/ttl/expiresAt 溢出/owner/schema gate；非法输入与 migration 失败零写入；实际 mutation 成功才 bump revision 且不重复 bump；list 必须（MUST）返回冻结快照（外部修改不影响 Memory）；GC 遇损坏 entry 不得（MUST NOT）删除后恢复乐观授权（置持久 corrupted 标志 fail closed，显式 repair 解除）。

#### Scenario: 冒号边界与身份区分

- **WHEN** namespace "a" + id "b:c" 与 namespace "a:b" + id "c"（及同 id 不同 kind/namespace）
- **THEN** canonical token 互不相同且 store key 不碰撞；排除比较使用同一 canonical identity

#### Scenario: mutation 验证与快照

- **WHEN** NaN/Infinity/零/负 amount、非法 resource、NaN/负 TTL、expiresAt 溢出、修改 list 返回值
- **THEN** 结构化拒绝且零写入、revision 只在实际 mutation 时增加一次；修改 list 快照不影响 Memory

### Requirement: write admission readiness 与余额完整分立（第七轮）

Treasury 对外必须（MUST）区分"余额视图完整"（authorizationSafe）与"当前确实允许开始新的 Game write"（write admission readiness）：readiness 为 false 当 receipt 已满、quarantine slot 不足、schema 未激活、store 损坏、存在 unresolved quarantine/write fault、lifecycle closed、tick stale、context/owner/commitment 非法等任一条件；blockers 必须（MUST）明确指出原因；readiness 判定不得（MUST NOT）归零余额数值字段；prepare 必须（MUST）独立复查全部条件，不得只信调用方读过 readiness。

#### Scenario: readiness 全条件

- **WHEN** clean 系统查询 readiness；再分别构造 receipt 满载、quarantine slot 不足、unresolved quarantine、migration incomplete、quarantine/writeFault 损坏
- **THEN** clean 时 ready=true；各故障场景 ready=false 且 blockers 指出对应原因；数值字段不受影响

### Requirement: durable intent 先于 Game API（第八轮）

任何进入 Game API 的写动作在调用开始之前必须（MUST）已持久化最小 durable intent（transaction identity、payload digest、action kind、canonical postings、authorization identity、创建 tick、执行 phase、必要结构身份、有界审计来源；不得持久化完整 observation/service/大 payload）。intent 写入失败时 Game callback 调用数必须（MUST）为 0，tentative 与 receipt/quarantine slot 释放，并返回结构化拒绝。intent 状态机必须（MUST）区分"尚未调用 Game API"（ready）与"已进入 callback、结果未知"（executing 及之后）——不得（MUST NOT）混同。intent 只有在 settled、确认 aborted、quarantine 完整写入并验证、或 resolution 完整 finalized 后才可（MAY）删除。

intent store 必须（MUST）版本化并具备完整健康契约：version、entryCount、容量上限、key 与 transaction identity 一致、entry 完整形状校验（canonical postings/phase 枚举/安全整数/聚合溢出）、global reset 首次 load 全量验证、heap health cache、损坏与未知版本 fail closed、显式 repair 边界；prepare 必须（MUST） O(1)（不全表扫描）。

global reset 后、任何 planner/writer 之前必须（MUST）加载验证 intent store：存在未完成 intent 时新 writer 阻断；ready 相按协议确认未执行关闭；其余保守转 execution-unknown quarantine（保留 canonical postings、幂等恢复）；无法确认 action 是否执行时保守进入 execution unknown；intent 成功转 quarantine 或 settlement 后才释放 intent slot。

recovery slot 必须（MUST）统一计数：一笔 transaction 只有一个 recovery slot（prepare 预留；durable intent 接管；正常 abort/commit 释放；fault 从 intent 状态转 quarantine 不额外占第二个 slot；active faulted handle + durable quarantine 不得（MUST NOT）计为两条占用）；指标必须（MUST）能证明 slot 守恒。

#### Scenario: intent 写失败 callback 零调用

- **WHEN** intent store 处于损坏/满载状态时执行写动作
- **THEN** Game callback 调用数为 0；tentative 与槽位释放；返回结构化拒绝（intent_store_unavailable）；无 intent entry 残留半写

#### Scenario: intent 落盘后 callback 前 reset

- **WHEN** intent 已持久化（phase=ready）、execution-started 标记前发生 global reset
- **THEN** 下一 tick 恢复发现 ready intent：确认未执行关闭（不进 quarantine、不计 receipt）、释放 slot、新 writer 恢复；恢复幂等

#### Scenario: execution-started 后 reset 转 execution unknown

- **WHEN** phase=executing 时发生 global reset
- **THEN** 下一 tick 该 transaction 转入 execution-unknown quarantine（postings 完整保留、资源/容量保守占用）；同 id 重新执行被拒

#### Scenario: quarantine 写失败时 intent 保留权威

- **WHEN** callback 已执行且 quarantine 写入失败（store 损坏）
- **THEN** intent 保留完整 canonical postings、继续参与资源/容量风险占用、writer 全局锁定、recovery slot 不释放；global reset 后仍能恢复 transaction identity 与 postings 且不能重新执行

#### Scenario: slot 转换守恒

- **WHEN** 观察一笔 transaction 从 prepare → durable intent → fault → quarantine 的完整生命周期
- **THEN** recoverySlots 总数每一步守恒（无双重计数）；正常 commit/abort 后 slot 回收

### Requirement: 资源授权 token（第八轮）

真实写动作不得（MUST NOT）只凭物理余额通过：每个资源流出必须（MUST）被 Treasury 签发的授权覆盖——授权计算必须（MUST）考虑 transfer outgoing commitments、production reservations（owner-aware）、policy withhold、commitment completeness、quarantine 与 unresolved intent 风险、tentative/其它授权占用、observation/projected、reservation store health、write readiness、位置容量与安全整数。immediate write 授权默认必须（MUST）不得把 pending incoming 当作可花费资产（allowIncoming=false、必扣 outgoing、必扣 reservations、commitment complete）；incoming 依赖只能由独立策略显式批准。多资源 action 的每个负 posting 必须（MUST）分别获得授权。

授权成功必须（MUST）立即占用 authorization budget（防止 A/B 双授权后各自 prepare 超卖），不得（MUST NOT）等到 prepare 才防超卖。授权 token 必须（MUST）是 heap-only、冻结、对象身份验证的 opaque capability：不可 JSON round-trip 伪造、单次使用、跨 tick/generation 失效；必须（MUST）绑定 exact observation epoch、commitment revision、projection revision、reservation schema/store revision、quarantine revision、policy fingerprint、owner canonical identity、action kind、resource/location/amount scope、service generation、tick 与 payload/contract digest；任一相关 revision 变化后旧授权必须（MUST）失效。调用者不得（MUST NOT）自行声明授权或伪造授权上下文。

#### Scenario: 授权扣除全部占用

- **WHEN** 物理 100k、production reservation 80k，申请流出 60k
- **THEN** 授权被拒（可用 20k）；owner 查询自身 reservation 时仅合法排除自身；pending outgoing 与 policy withhold 均被扣除；commitment incomplete 拒绝；immediate write 不能依赖 incoming

#### Scenario: token 失效矩阵

- **WHEN** 分别构造 transfer task mutation、reservation mutation、projection commit、quarantine revision 变化、owner 变化、policy fingerprint 变化、observation epoch 变化、跨 tick、跨 service、重复消费、伪造/JSON 复制 token
- **THEN** 旧 token 一律失效/拒绝；授权在被消费前 revision 未变时保持有效

### Requirement: action contract 与注册 adapter（第八轮）

实际 Game API 参数必须（MUST）与 action contract 和 canonical postings 一致：contract 由 Treasury 或受注册 adapter 根据授权构造（action kind、业务身份、源/目标、resource、amount、费用、结构 incarnation、由参数确定性派生的 canonical postings、authorization digest、transaction identity）；调用者不得（MUST NOT）独立提供"Game API 参数"与"postings"两套可不一致事实——任意 callback 不得（MUST NOT）声称发送 1 单位却实际执行 10,000 单位。每个 action kind 的 adapter 契约（canonical args → validate → derive postings → execute exact Game API → classify result → reconcile）必须（MUST）经统一注册边界注册；本轮不接真实生产 writer（测试专用 mock adapter + 多 posting fixture），生产模块不得（MUST NOT）调用任意 callback 入口/compat/直接 prepareTransaction/自行构造 postings（架构测试守护）；executePreparedAction 降为内部/test-only 低层原语。

#### Scenario: contract 派生一致性

- **WHEN** 由 canonical args 构造 contract 并执行
- **THEN** postings 与 action args 完全一致；调用者事后修改原 args 不影响 canonical contract；不同 payload 同 transactionId 冲突拒绝；伪造 contract 失败；adapter kind 不匹配拒绝；structureId 变化拒绝；实际动作不能超出 authorization scope

### Requirement: quarantine 按 transaction 保守聚合（第八轮）

uncertain 风险聚合必须（MUST）按 transaction 保守：每笔 transaction 内先合并同 key 腿，occupiedOutflow = Σ max(0, −net)（跨 transaction 求和），capacityOccupancy = Σ max(0, net)——不同 transaction 的正流入不得（MUST NOT）抵消另一笔负流出、不得（MUST NOT）增加 spendable。每步聚合必须（MUST）安全整数校验；无法聚合时 store unhealthy、write readiness false、不返回乐观数值。unresolved durable intents 必须（MUST）以同一口径并入风险占用。quarantine/风险读取 API 不得（MUST NOT）返回内部可变对象或 Map（冻结副本/只读 view）；写入前必须（MUST）重新完整验证 entry。

#### Scenario: A/B 不互相抵消

- **WHEN** quarantine A 含 +1000 流入、B 含 −500 流出（同 location）
- **THEN** 容量风险占用为 1000（非 500）；资源流出占用为 500；同一 transaction 内部先净额合并；聚合溢出 fail closed

### Requirement: staged atomic resolution 与 receipt 刷新（第八轮）

resolution store 必须（MUST）具备版本化健康契约（version/entryCount/key 一致/entry 完整 shape/global reset 首次 load 验证/heap cache/未知版本 fail closed/损坏不自动删除/容量满时在任何原状态变化之前拒绝）；malformed 旧 tombstone 不得（MUST NOT）被当作可清理垃圾删除。resolution 必须（MUST）是可恢复的 staged 状态转换：预留 resolution slot → 写 durable resolving marker → 执行 receipt refresh 或 not-executed 结论 → finalize——不得（MUST NOT）先删除 quarantine 再尝试写 tombstone；任何阶段失败不得（MUST NOT）"返回 rejected 却已解锁"（quarantine/intent 保留、readiness false，或进入明确 resolution_fault 并在 global reset 后幂等恢复）；not-executed 失败时不得（MUST NOT）形成"函数失败但可重新 prepare"的状态；重复调用稳定 already_resolved；同一 transaction 的 intent/quarantine/receipt/resolution 最多结算一次。

resolve-as-committed 时既有 receipt 必须（MUST）真正刷新到当前 resolution tick（同步维护 entryCount、nextExpiryTick 与 retention）；actionTick 只用于审计；不得（MUST NOT）向当前 tick overlay/journal 重放；receipt 过期但 committed tombstone 仍在时 prepare 不得（MUST NOT）将其当全新动作；prepare、receipt 与 resolution 必须（MUST）使用统一 replay horizon。

#### Scenario: 既有 receipt 刷新

- **WHEN** tick 1 receipt 已写后 heap 故障入 quarantine，tick 5001 resolve-as-committed
- **THEN** 既有 receipt 实际刷新到 tick 5001（完整 retention 窗口）；下一 tick cleanup 不删除；同 id prepare 命中 already_settled/committed tombstone 而非全新动作

#### Scenario: 阶段故障可恢复

- **WHEN** 分别注入 resolution slot 满、resolving marker 写失败、receipt refresh 失败、quarantine release 失败、marker clear 失败、tombstone finalize 失败、以及各阶段后 global reset
- **THEN** 每个场景可幂等恢复、不重复结算、不丢风险占用、不错误解锁

### Requirement: service-issued reconciliation capability（第八轮）

resolution 结论不得（MUST NOT）由普通调用者自行填写。当前 Treasury service 必须（MUST）基于 exact post-fault observation、durable intent/quarantine 与**受注册 action reconciler** 签发 opaque reconciliation capability（绑定 transaction/digest/action kind/contract/post-fault epoch/structure incarnation/reconciler 版本/conclusion/service generation/tick）。普通对象伪造、JSON round-trip、旧 service、旧 epoch 的 capability 必须（MUST）失败；未注册 reconciler 的 action kind 必须（MUST）拒绝；uncertain 保持隔离；resolution 只接受 capability（自由 evidence/guard 对象入口移除）；跨 global reset 由新 service 依据持久状态重新签发而非恢复旧 heap token。

#### Scenario: capability 防伪与 reconciler 边界

- **WHEN** 以普通对象/JSON 副本/旧 generation/旧 epoch 的 capability 调用 resolution，或对无注册 reconciler 的 action kind 申请 capability
- **THEN** 一律拒绝；测试 reconciler 产生 committed/not-executed 结论并驱动 resolution 完成；uncertain 保持隔离；调用者不能自行改 conclusion

### Requirement: owner identity 统一与 reservation store 完整健康（第八轮）

owner 的持久 token、比较 key、聚合 key、self-exclusion key、mutation 定位 key 与 migration collision key 必须（MUST）全部使用同一 canonical identity 算法（不得保留独立的分隔符拼接比较键）；id/namespace 含 NUL、冒号、Unicode、空格时不得（MUST NOT）碰撞，比较结果与持久 token 恒一致。reservation store version 为当前值不等于健康——必须（MUST）经过完整 load validation（store 形状/version/key 与 entry 及 owner token 一致/owner shape/room/resource/amount/时间戳安全整数/聚合溢出/重复 identity/corrupted 标志/entryCount），验证结果以 heap cache/revision 复用；任何损坏时原数据保留、mutation 拒绝、authorizationSafe 与 write readiness false。非法 mutation input 必须（MUST）在任何 schema migration 或 Memory 写入之前被拒绝。只读 API 不得（MUST NOT）返回 live Memory 引用，旧兼容读取不得（MUST NOT）传播 NaN。

#### Scenario: 比较 key 与持久 token 一致

- **WHEN** id 与 namespace 分别含 NUL、冒号、Unicode，同 id 不同 kind/namespace
- **THEN** canonical token 互不碰撞；比较 key 与持久 token 恒一致；v4 store key/entry 不一致或 owner 非法或聚合溢出时 fail closed；非法 mutation 不触发 migration 写入；只读 snapshot 修改不影响 Memory

### Requirement: strict projected 与 risk-adjusted capacity 分立（第八轮）

严格 projected（observed + committed overlay；used + free = physical capacity）与 risk-adjusted（另行扣除 quarantine/unresolved intent 正流入风险，用于 admission/headroom）必须（MUST）以独立 API 暴露（strictProjectedUsedCapacity/strictProjectedFreeCapacity/riskAdjustedFreeCapacity/riskAdjustedReceiverHeadroom）；旧名称若保留必须（MUST）明确标注兼容语义；receiver admission 必须（MUST）使用 risk-adjusted 口径；消费者不得（MUST NOT）再误把两个口径当作互补的同一口径。

#### Scenario: 双口径分离

- **WHEN** 存在 quarantine 正流入风险 +1000
- **THEN** strictProjectedUsed+Free = physical capacity（不含风险）；riskAdjustedFree 单独扣除 1000；receiver admission 采用 risk-adjusted 口径；旧名称返回文档标注的兼容语义

### Requirement: contract-first authorization（第九轮）

生产资源授权必须（MUST）以本 service 本 tick 构建的合法 action contract 为前提（authorizeTreasuryActionContract）；授权需求（actionKind/rooms/locations/每资源 amount/contractDigest/adapter version）必须（MUST）全部从 contract 的 canonical postings 与 adapter 元数据派生；token 的 contract digest 不得（MUST NOT）可选；授权阶段必须（MUST）要求 write admission ready；自由字符串 policyFingerprint 不得（MUST NOT）再赋予 policy authority（通道移除，仅受控 withhold 数值）；authorizeResourceUse 自填请求入口必须（MUST）降级为 test-only（生产禁用，架构测试守护）。

#### Scenario: 授权绑定具体 contract

- **WHEN** 为 action A 的 contract 签发 bundle 后尝试执行 action B 的 contract（或同 kind 不同 digest、不同 transactionId、不同 adapter version）
- **THEN** 预验证拒绝且零 token 消费、零 callback；token 不得用于不同 action kind/adapter version/contract/transaction

#### Scenario: 调用者自填 policy fingerprint 无 authority

- **WHEN** 调用方在授权请求中携带任意字符串 policy fingerprint（或以任何方式提交自由字符串）
- **THEN** 该请求结构化拒绝；token 的 policy 表达只可能来自 Treasury 计算的受控 withhold

### Requirement: 原子 bundle redemption（第九轮）

多 token 执行必须（MUST）全有或全无：全部 token 一次性只读预验证（身份/generation/tick/revisions/contract identity+digest/action kind/adapter version/transactionId/重复 token/exact posting coverage/每资源累计 amount/receiver capacity/policy binding）通过后才可消费；结构 incarnation 校验与 fresh observation 检查必须（MUST）先于消费（fresh 配额耗尽必须拒绝执行，不得退回 shared observation）；授权预算向 tentative ledger 的转移必须（MUST）是原子协议（prepare 成功 tentative 接管后、Game callback 前一次消费）；任一失败时必须（MUST）零 token 消费、authorization budget 不变、callback 零调用、tentative ledger 不变、无"授权已消费但 tentative 未接管"窗口。

#### Scenario: 第 N 个 token 无效

- **WHEN** 多资源 bundle 的第 N 个 token 预验证失败（重复/digest 不匹配/scope 超范围/revision 过期）
- **THEN** 前 N−1 个 token 未被消费、预算不变、callback 零调用

#### Scenario: incarnation mismatch 与 fresh 耗尽零消费

- **WHEN** 执行前结构 incarnation 变化、或 fresh observation 配额耗尽
- **THEN** 拒绝执行（structure_replaced / fresh_observation_unavailable）；token 不被消费、tentative 不变、callback 零调用

### Requirement: writer kernel 封闭（第九轮）

任意 callback 的 executePreparedAction、prepareTransaction、授权消费原语不得（MUST NOT）对普通生产模块公开（service 对象保留 @internal 实现）；架构边界测试必须（MUST）扫描全部生产 TypeScript 源码（而非固定文件清单）——新增生产模块自动受约束；actionContracts 必须（MUST）经窄内部接口（execution options）访问 writer kernel。

#### Scenario: 新增生产模块自动受约束

- **WHEN** 任何 src 下生产文件（treasury 协议实现白名单之外）调用 executePreparedAction/prepareTransaction/consumeTreasuryAuthorization/authorizeResourceUse/compatRecord*/registerTreasuryActionAdapter 或 import faultResolution
- **THEN** 架构测试失败（无论文件是否在既有清单中）

### Requirement: intent 完整合同身份与严格 phase 状态机（第九轮）

contract 执行路径写入的 durable intent 必须（MUST）绑定 contractId/contractDigest/actionKind/adapterVersion/authorizationDigest/结构 incarnation/有界 durable payload（≤512，不持久化完整 args/observation）；phase 迁移必须（MUST）验证期望前序状态与 digest/contract 一致（幂等仅限同 identity 且已处目标 phase）；not_found/store fatal/非法前序/identity mismatch/read-back 不一致必须（MUST）callback 零调用；callback 返回后 phase 写入失败必须（MUST）按事实等级进入 durable fault（OK→不得普通 commit；非 OK→不得普通 abort；抛错→execution unknown），不得（MUST NOT）静默忽略 phase 写入结果。

#### Scenario: not_found 与前序非法零 callback

- **WHEN** ready→executing 迁移返回 not_found、或 entry 当前 phase 不在合法前序集合、或 read-back digest/contract/postings 不一致
- **THEN** callback 零调用、预留释放、结构化拒绝（intent_store_unavailable / 内部不一致处置）

#### Scenario: callback 后 phase 写失败

- **WHEN** callback 返回 OK 但 ok_pending_commit 写入失败（或返回非 OK 但 returned_non_ok 写入失败）
- **THEN** 不执行普通 commit/abort；进入 durable emergency fault（executed_unsettled / executed_abort_failed）；intent/quarantine 至少一个保留完整权威；阻断自动重试

### Requirement: recovery phase 事实等级（第九轮）

intent recovery 必须（MUST）保留事实等级：ready→确认未执行关闭；executing/execution_unknown→execution-unknown quarantine；returned_non_ok→保留"Game 已返回非 OK"事实；ok_pending_commit→commit 类隔离（ok_pending_commit_unresolved）且永不允许（MUST NOT）resolve-as-not-executed；committed/aborted 终态残留幂等释放。已知 Game 返回 OK 不得（MUST NOT）在恢复后退化为"可能未执行"。

#### Scenario: ok_pending_commit 恢复不降级

- **WHEN** intent 处于 ok_pending_commit 相发生 global reset 后 beginTick 恢复
- **THEN** quarantine entry 的 phase 为 commit 类（ok_pending_commit_unresolved）；后续 not-executed resolution 被拒绝（只能 resolve-as-committed）

#### Scenario: returned_non_ok 恢复保留事实

- **WHEN** intent 处于 returned_non_ok 相恢复
- **THEN** quarantine phase 为 action_returned_non_ok_abort_failed（不被当作 callback 仍在执行）；not-executed resolution 允许

### Requirement: unified unresolved authority（第九轮）

capability 签发、prevalidation、resolution、recovery、release 必须（MUST）使用同一套 authority resolution（durable quarantine entry 或 durable emergency intent entry）；同 id 双存在时 digest/postings/kind 不一致必须（MUST）fail closed；intent-only authority 必须（MUST）可签发 capability、resolve-as-committed、phase 允许时 resolve-as-not-executed（ok_pending_commit 拒绝）；resolution 不得（MUST NOT）因"没有 quarantine entry"拒绝已存在的 emergency intent；resolution 成功必须（MUST）幂等释放 quarantine+intent+匹配 marker，释放失败保持可恢复。

#### Scenario: intent-only authority 完整参与

- **WHEN** quarantine 写失败、emergency intent 保留（任意 unresolved phase）
- **THEN** 可对其签发 reconciliation capability；resolve-as-committed 成功；phase 允许（executing/returned_non_ok/execution_unknown）时 resolve-as-not-executed 成功；ok_pending_commit 拒绝 not-executed

#### Scenario: 双权威不一致 fail closed

- **WHEN** 同一 transactionId 的 quarantine 与 intent entry 的 digest/postings/kind 任一不一致
- **THEN** capability 签发与 resolution 均 fail closed 拒绝（不任选其一）

### Requirement: 私有 reconciliation capability（第九轮）

capability registry 必须（MUST）由 Treasury service 闭包控制（reconciliation 模块不得导出 register/validate/consume）；resolve 必须（MUST）接收当前 service 且 generation 由 service 自身校验（调用者提交的 serviceGeneration 数字不再接受）；capability 必须（MUST）绑定 authorityKind/contract ID+digest/adapter kind+version/durable payload version/post-fault epoch/结构 incarnation/reconciler version，保持对象身份防伪、单次使用、cross-tick/cross-generation 失效；reconciler 输入必须（MUST）是完整 contract-specific durable facts。

#### Scenario: 公开注册与 generation 绕过不可得

- **WHEN** 普通模块尝试调用 capability 注册入口（已不存在）、或通过提交任意 serviceGeneration 数字、或使用旧 service 签发的 capability
- **THEN** 全部失败（导出面封闭 + service 闭包校验 + cross_generation 拒绝）；架构测试禁止其它生产模块访问 capability 注册/消费内核

#### Scenario: capability 与 contract/reconciler 不匹配

- **WHEN** capability 绑定的 contract digest/adapter version/reconciler kind 与目标 authority 不一致
- **THEN** resolution 拒绝且 fault 不动

### Requirement: staged receipt refresh recovery（第九轮）

resolving committed tombstone 必须（MUST）记录预期 settlement tick（settledAtTick）；恢复只在 receipt tick ≥ settledAtTick 时 finalize；旧 action tick 的 receipt 不得（MUST NOT）被误判为已刷新；未刷新时必须（MUST）幂等续做 refresh（至原定 settledAtTick，不缩短 replay horizon）或保留 resolving（绝不直接 finalize）；refresh 与 finalize 中断后必须（MUST）可幂等恢复。

#### Scenario: 旧 receipt 不误判

- **WHEN** 旧 action tick 的 receipt 已存在 → 写 resolving tombstone → refresh 前 global reset → beginTick recovery
- **THEN** 恢复检测 receipt tick < settledAtTick，不误 finalize；幂等续做 refresh 至 settledAtTick 后才 finalize

### Requirement: resolving tombstone retention 与 recovery closure（第九轮）

只有 stage=final 的 tombstone 才允许（MAY）按 retention 自动删除；stage=resolving 永不得（MUST NOT）被普通垃圾回收或容量压力驱逐（满载 fail closed）；超龄 resolving 必须（MUST）保持并进入诊断；final not-executed 的 recovery 必须（MUST）补完成 quarantine release + intent release + 匹配 marker 清除；receipt/store fatal 时 unresolved authority 不得（MUST NOT）释放。

#### Scenario: 满载不驱逐 resolving

- **WHEN** resolution store 满载且唯一可清理候选是超龄 resolving tombstone
- **THEN** 不删除 resolving；新 resolution 拒绝（fail closed）

#### Scenario: final not-executed 恢复补释放

- **WHEN** final not-executed tombstone 已写但 quarantine/intent 未释放（中断窗口）后 beginTick recovery
- **THEN** 补完成 quarantine release、intent release、marker 清除；重复调用幂等

### Requirement: 安全 canonical contract encoding（第九轮）

contract 构建必须（MUST）先 canonicalize 再 validate/derive/execute（adapter 三函数观察同一 canonical frozen args）；canonical 编码必须（MUST）确定性（key 排序、长度前缀、数组保序）；cyclic/getter/setter/自定义 prototype/class instance/function/symbol/bigint/undefined/NaN/±Infinity/稀疏数组/非普通对象必须（MUST）结构化拒绝（零抛出、getter 零副作用读取）；{a:undefined} 与 {}、NaN 与 null 不得（MUST NOT）静默碰撞；调用方构建 contract 后修改原 args 不得（MUST NOT）改变 postings/digest/执行参数；contract registry 保持对象身份防伪。

#### Scenario: 编码确定性与碰撞拒绝

- **WHEN** 相同语义、不同 key 插入顺序构建两个 contract；或不同语义 args
- **THEN** 前者 digest 相同、后者 digest 不同；undefined/NaN/Infinity/function/symbol/class instance 输入被结构化拒绝

### Requirement: 完整结构 incarnation 验证（第九轮）

contract 构建必须（MUST）捕获全部 action-relevant 结构（posting locations + adapter 经受控 structureBindings 声明的额外结构——不得接受任意字符串 structureIds）；执行前必须（MUST）对全部声明结构重新验证；structure disappeared/replaced/room mismatch/kind mismatch 时必须（MUST）callback 零调用、授权零消费、tentative 不变；fresh observation 不可用时必须（MUST）fail closed 拒绝执行。

#### Scenario: 额外声明结构被验证

- **WHEN** adapter 声明额外结构（factory/lab/terminal 动作实体），构建后该结构被替换或消失
- **THEN** 执行前校验拒绝；token 不被消费、callback 零调用

### Requirement: execution outcome 与 settlement state 正交拆分（第十轮）

durable intent 必须（MUST）以正交二元组记录执行事实与工作流状态：outcome ∈ {not_started, started_unknown, returned_non_ok, returned_ok, aborted_final} 单调不可回退（not_started→started_unknown→{returned_ok|returned_non_ok} 为唯一合法边）；settlement ∈ {ready, executing, pending_abort, pending_commit, quarantined, resolving, finalized, faulted}。故障、恢复、quarantine 转换、intent 写失败与 commit fault 必须（MUST NOT）只改 settlement、不得（MUST NOT）改变已记录的 outcome；已返回 OK 永不退化为 unknown、已返回 non-OK 永不变 OK。旧 phase 迁移必须（MUST）保守单调，未知 phase 值必须（MUST）fail closed。

#### Scenario: OK 后故障不降级

- **WHEN** callback 返回 OK 后 commit 故障且 quarantine 写入失败（intent-only authority）
- **THEN** intent 保留 outcome=returned_ok（settlement=faulted）；not-executed resolution 永久拒绝；跨多次 recovery 仍保持 returned_ok

#### Scenario: 非 OK 与抛错的 outcome 保持

- **WHEN** callback 返回非 OK 后 abort 未确认、或 callback 抛错
- **THEN** 权威分别保留 outcome=returned_non_ok 与 started_unknown；returned_non_ok 不会变成 started_unknown

### Requirement: durable authority 完整合同事实（第十轮）

quarantine entry（v2）必须（MUST）保留完整 contract identity 与 reconciliation facts（contractId/contractDigest/actionKind/adapterVersion、canonical postings、durable payload/version、authorization bundle digest、owner/policy identity、structure incarnation facts、execution outcome、settlement state、action tick、recorded tick、source、fault reason）；intent → quarantine 事实转移必须（MUST）在读回验证一致后才释放 intent；一笔 transaction 双存在时必须（MUST）只占一个 recovery slot；同 ID 双权威合同字段不一致必须（MUST）fail closed；v1 迁移必须（MUST）原子（无歧义映射、并存 intent 合并、legacy 标记不参与 contract-backed resolution），未知版本必须（MUST）fail closed；adapter version 演进后不得（MUST NOT）用新 reconciler 解释旧 action。

#### Scenario: contract-backed intent 转 quarantine 后事实完整

- **WHEN** contract 执行路径的 intent 发生 fault 并成功转 quarantine
- **THEN** quarantine entry 仍携带 contract ID/digest、adapter version 与 durable payload；global reset 后可重建完整 action-specific reconciler 输入

#### Scenario: 双权威合同字段不一致 fail closed

- **WHEN**同 ID 的 quarantine 与 intent entry 的 contractDigest/adapterVersion 任一不一致
- **THEN** capability 签发与 resolution fail closed

#### Scenario: adapter version 演进防护

- **WHEN** adapter v1 的 unresolved authority 在 registry 升级 v2 后请求 capability
- **THEN** 拒绝（不得用 v2 reconciler 解释 v1 action）

### Requirement: opaque service-issued authorization bundle（第十轮）

production contract execution 只接受（MUST）Treasury service 闭包 registry 签发的 opaque authorization bundle；普通对象伪造、JSON round-trip 副本、品牌字段伪装必须（MUST）失败；bundle 不得（MUST NOT）向生产调用者暴露可重组的 token 数组；bundle 必须（MUST）统一绑定 owner/policy/contract/action kind/adapter version/epoch/revisions/service generation/tick——同 bundle 禁止混用不同 owner、不同 policy 或不同 revision cohort；bundle 只能（MUST）redeem 一次；裸 token 与 token 数组不得（MUST NOT）进入 production 执行入口（仅 test harness）。

#### Scenario: 伪造与 round-trip 失败

- **WHEN** 以手工构造对象、JSON.parse(JSON.stringify(bundle)) 或裸 token/token 数组调用 executeTreasuryActionContract
- **THEN** 一律 authorization_invalid 拒绝（零消费、零 tentative）

#### Scenario: cohort 混用拒绝

- **WHEN** 组成 bundle 的 legs 存在不同 owner/policy/revision cohort
- **THEN** bundle 签发整体拒绝（原子，无部分签发）

#### Scenario: 单次 redemption

- **WHEN** 同一 bundle 第二次进入 redemption
- **THEN** 拒绝；budget 不重复释放

### Requirement: 批量原子 bundle redemption（第十轮）

bundle redemption 必须（MUST）先只读预验证全部 legs，再以 staged ledger change 一次发布全部变更（授权预算减少、bundle 终态、tentative 接管关系、capacity 变化）；任何注入故障（首腿/中间腿/末腿后、budget publish 前、tentative handoff 前、bundle state 更新前）必须（MUST）零状态变化（前缀完整回滚）或进入明确 internal authorization fault 并阻断 writer；不得（MUST NOT）出现部分 token 被消费、tentative 已接管但 bundle 仍可用、bundle 已消费但 tentative 未接管、budget 总量与 active bundle 记录不一致。

#### Scenario: 注入点全量回滚

- **WHEN** 在任一注入点触发故障
- **THEN** 全部 authorization budget/capacity 保持原值；bundle 未消费；tentative 不残留；internal_authorization_fault marker 阻断后续 writer

#### Scenario: 正常路径恰好一次

- **WHEN** 正常 redemption
- **THEN** budget→tentative 转移恰好发生一次；重复 redeem 不重复释放

### Requirement: writer kernel 类型与运行时封闭（第十轮）

公共 TreasuryService 类型必须（MUST NOT）不再包含低层方法（raw authorize、token consume、validate redeem、prepare、execute prepared、direct commit/abort、capability register/consume kernel）；运行时对象必须（MUST NOT）以普通可枚举属性暴露 kernel（unique symbol non-enumerable 挂载，treasury 协议栈内部经 kernelChannel 访问）；test harness 必须（MUST）独立于生产导出面；架构测试必须（MUST）全量扫描 src/**/*.ts——非 Treasury 内部模块不得引用 kernel/testHarness（新文件自动受约束，不依赖 @internal 注释）。

#### Scenario: 低层方法不可达

- **WHEN** 生产模块（非 treasury 协议栈、非测试）尝试调用 prepareTransaction/executePreparedAction/authorizeResourceUse/consumeTreasuryAuthorization 或 import kernelChannel/testHarness
- **THEN** 架构测试失败（类型层与扫描层双重守护）

### Requirement: contract digest 绑定 durable facts（第十轮）

contract identity（AC3）必须（MUST）绑定 canonical encoding version、action kind、adapter version、transactionId、canonical args、canonical postings、structure bindings/snapshots、durable payload version 与内容 hash、reconciliation contract version；durable facts 变化必须（MUST）导致 digest 变化；同 adapter version 下 payload 变化不得（MUST NOT）复用旧授权；contractId 与 digest 必须（MUST）一一对应；production adapter 提供 reconciler 时 durable facts 必须（MUST）必填；固定 test vector 必须（MUST）防止编码无意漂移。

#### Scenario: durable facts 变化改变 digest

- **WHEN** 同一 args 但 durable payload 或其 version 变化
- **THEN** contract digest 变化；旧 bundle 因 digest 绑定失效

### Requirement: intent 完整 identity 与幂等冲突（第十轮）

intent already_present 幂等必须（MUST）覆盖完整 identity（transactionId/digest、contract ID/digest、action kind、adapter version、authorization bundle digest、owner identity、policy identity、canonical postings、structure facts、durable payload/version、execution outcome、settlement）；任一字段不同必须（MUST）返回 intent_conflict（fail closed，不静默接受不同 contract）；authorization bundle digest 必须（MUST）实际写入 contract 路径 intent（不再 optional 永缺失）；低层 test path 写入的同 ID 旧 intent 不得（MUST NOT）被 production contract 接管。

#### Scenario: already_present 身份冲突

- **WHEN** 同 transactionID 但 contract ID 或 bundle digest 不同
- **THEN** intent_conflict 拒绝（prepare 阶段 fail closed）

### Requirement: service-private resolution 与 capability 消费时点（第十轮）

fault resolution 的对外入口必须（MUST）是当前 Treasury service 的方法（闭包 authority，不接受结构兼容伪 service，service generation 完全内部）；capability 处理顺序必须（MUST）为：只读身份验证→只读 tick/generation/未使用验证→stores 健康验证→authority 解析→完整 contract/bundle/outcome identity 强匹配（contract-backed authority 的 contractId/contractDigest/adapterVersion/durablePayloadVersion/actionKind/executionOutcome/authorityKind/reconcilerVersion 全部必存在且完全匹配——弱 optional 检查删除）→observation/evidence 校验→resolution slot 校验→写 staged resolution intent→此时才消费 capability→执行状态转换；staged 写入前的任何拒绝不得（MUST NOT）烧掉 capability；staged 写入后必须（MUST）仅凭 durable staged state 跨 reset 恢复；resolution 管理入口不得（MUST NOT）被生产 tick 自动调用。

#### Scenario: 前置失败不消费 capability

- **WHEN** store health 检查失败或 authority identity 不匹配
- **THEN** capability 未被消费（可重试）；拒绝结构化返回

#### Scenario: 伪 service 无法调用 resolution

- **WHEN** 构造结构兼容的伪 authority 对象尝试 resolution
- **THEN** 无法通过任何公开入口执行（kernel 仅 service 闭包内可达）

#### Scenario: staged 后跨 reset 恢复

- **WHEN** staged resolution intent 写入后发生 global reset
- **THEN** 恢复仅凭 durable staged state 完成（不依赖旧 capability 对象）

### Requirement: Treasury-owned policy authority（第十轮）

production contract authorization 不得（MUST NOT）接受调用方直接提供的 withhold；strategic reserve/resource floor/action-specific withhold/emergency override 必须（MUST）由注册 policy resolver 计算（显式、可审计、版本化）；authorization bundle 必须（MUST）绑定 policy ID/version/digest 与计算结果；policy 变化必须（MUST）使旧 bundle 失效；无注册 resolver 时 production 授权必须（MUST）fail closed；writer 不得（MUST NOT）通过省略参数或传 0 绕过；自由字符串 policy name 不赋予权威。

#### Scenario: writer 不能自选 withhold

- **WHEN** production contract authorization 请求携带 withhold 字段
- **THEN** 拒绝（invalid_input）；额度只由 policy resolver 决定

#### Scenario: policy 变化使 bundle 失效

- **WHEN** bundle 签发后 policy version/digest 变化再执行 redemption
- **THEN** bundle 失效拒绝

#### Scenario: 无 resolver fail closed

- **WHEN** 未注册任何 policy resolver
- **THEN** production contract authorization 拒绝（policy_not_ready）

### Requirement: 统一 write readiness 权威（第十轮）

query 的 writeAdmission 视图、contract authorization 与 prepare/execute 复查必须（MUST）使用同一内部评估器（一套 blocker 枚举、一套优先级、一套状态来源）；contract authorization 只在 readiness=true 时签发 bundle；prepare 必须（MUST）独立复查（防 TOCTOU）；blocker 消失后 readiness 必须（MUST）恢复；正常路径评估必须（MUST）O(1) 或基于已缓存 health/counters。

#### Scenario: 三处同一 blocker

- **WHEN** 任一阻断条件成立（如 receipt 满载、resolution store fatal、resolving tombstone、policy 未就绪）
- **THEN** query/authorization/prepare 返回同一核心 blocker；blocker 消失后三处一致恢复

### Requirement: structure binding canonical authority（第十轮）

structure binding 必须（MUST）使用受控 canonical identity（governed location / explicit game object ID）——label 仅诊断不作唯一身份；posting 自动 binding 与 adapter 声明 binding 重合时同 identity 合并、label 相同但 identity 不同必须（MUST）拒绝 contract；required structure 构建时必须（MUST）真实存在（undefined 拒绝，不得 undefined===undefined 视为通过）；执行前必须（MUST）仍存在且 incarnation 一致；object-ID binding 必须（MUST）验证对象存在、类型与 room 归属；容器必须（MUST）防原型污染（特殊 label 不污染结构快照）；structure facts 必须（MUST）进入 contract digest 与 durable authority。

#### Scenario: label 碰撞但身份不同

- **WHEN** adapter binding 与 posting binding 的 label 相同但 room/location/object identity 不同
- **THEN** contract 构建拒绝

#### Scenario: required structure 缺失/被替换

- **WHEN** 构建时 required structure 不存在、或执行前被替换（incarnation 变化）
- **THEN** 分别在构建/执行期拒绝；执行期拒绝时 bundle 不消费

### Requirement: canonicalization 反射异常边界（第十轮）

public contract build 入口不得（MUST NOT）因任意 runtime input 抛错而中断 tick；Object.getPrototypeOf/getOwnPropertyDescriptor/keys/getOwnPropertySymbols/property value 读取/array iteration 必须（MUST）置于统一异常边界——revoked Proxy、throwing trap、异常 descriptor 均返回结构化 rejection（不抛出）；getter 仍必须（MUST）零调用；内部编程错误必须（MUST）返回明确 canonicalization fault（callback 零调用、授权与 contract registry 零变化）。

#### Scenario: 异常 Proxy 结构化拒绝

- **WHEN** args 含 revoked Proxy、throwing ownKeys/getPrototypeOf trap 或异常 descriptor
- **THEN** build 返回结构化 rejection（不抛出）；授权、contract registry、callback 零变化


### Requirement: pre-execution authorization fault 可恢复 authority（第十一轮）

internal_authorization_fault（Game callback 未调用且 authorization 状态已完整回滚）必须（MUST）在写全局 marker 前建立有界 durable authority（version 化 store、load 全量验证、未知版本 fail closed），保存 transaction/contract/cohort 身份、canonical postings、fault tick、outcome=not_started、rollback 确认事实；必须（MUST）提供专用恢复协议：仅适用于该类 fault（其他 commit/execution fault 不得使用）、不需要 action reconciler（协议已证明 Game 未执行）、验证完整 authority identity、解决后释放 marker 与 authority、幂等、global reset 后仍可完成；不得（MUST NOT）存在任何无条件 clear-marker 入口；该 fault 不得（MUST NOT）再形成无恢复路径的永久全局锁。

#### Scenario: 注入故障后可恢复

- **WHEN** bundle redemption 注入故障，状态完整回滚、callback 零调用
- **THEN** durable not-started authority 建立；global reset 后仍存在；专用 rolled-back resolution 可解除；解除后 marker 与 authority 均清除；重复 resolution 幂等

#### Scenario: 其他 fault 不可使用该通道

- **WHEN** commit 类或 execution unknown fault 尝试 acknowledge-rolled-back 路径
- **THEN** 拒绝（只能走 capability resolution）

### Requirement: immutable adapter registry（第十一轮）

adapter 注册必须（MUST）快照固定全部函数引用并冻结 registration record（不保存调用方可变对象；读 API 不泄漏内部可变 record）；每次合法注册必须（MUST）生成稳定 registration identity（kind+version+registry generation+implementation ID）并绑定进 contract；同 kind+同 version 的不同实现必须（MUST）拒绝（替换须更高 version）；注册后调用方修改原对象不得（MUST NOT）影响 registry 内实现；execution 与 reconciliation 必须（MUST）使用同一 registration record；registry 必须（MUST）可 seal（生产装配后动态注册拒绝）；全部 adapter 函数调用（validate/derivePostings/structureBindings/durableFacts/execute/reconcile）必须（MUST）有异常边界（执行前异常结构化拒绝零 callback；execute 异常走 execution unknown；reconcile 异常 capability 签发拒绝且 authority 保持隔离）。

#### Scenario: 原对象修改不影响 registry

- **WHEN** 注册后修改原 adapter 对象的 execute/reconcile 属性再执行 contract
- **THEN** registry 仍按注册时快照的函数执行

#### Scenario: 同 kind/version 不同实现被拒

- **WHEN** 同 kind+version 注册函数引用不同的新实现
- **THEN** 注册拒绝（fail closed）

#### Scenario: seal 后动态注册拒绝

- **WHEN** 生产装配 seal 后调用注册
- **THEN** 拒绝动态注册

### Requirement: immutable policy registry 与 Treasury 计算 decision digest（第十一轮）

policy 注册必须（MUST）快照固定 evaluate 引用并冻结 record；policyVersion 必须（MUST）为正安全整数；同 policyId+version 的不同实现必须（MUST）拒绝；policy decision digest 必须（MUST）由 Treasury 根据 canonical context（contract ID/digest、actionKind、resource、rooms、owner identity、tick、policy registration identity）与 validated decision 自行计算——不得（MUST NOT）信任 resolver 自报 digest；evaluate 抛错必须（MUST）结构化 fail closed；emergency override 必须（MUST）显式进入 cohort 与审计；bundle redemption 必须（MUST）验证 exact policy registration identity 与 decision digest（不得使用字符串前缀比较）。

#### Scenario: 自报 digest 不可信

- **WHEN** resolver 返回不同决策但自报相同 digest
- **THEN** Treasury 计算的 digest 不同（policy identity 变化、旧 bundle 失效）

#### Scenario: evaluate 抛错 fail closed

- **WHEN** 注册 resolver 的 evaluate 抛出异常
- **THEN** 授权结构化拒绝（policy_fault），无 bundle 签发

### Requirement: durable authorization cohort（第十一轮）

authorization bundle 的完整 cohort 事实（owner canonical identity、policy ID/version/registration identity/decision digest、withhold/strategic reserve/emergency override、exact observation epoch、五元 revision cohort、adapter registration identity、contract ID/digest、transaction ID、每 authorization leg canonical 摘要、receiver capacity 摘要、service/tick 签发信息、bundle identity）必须（MUST）以有界 canonical 形式持久化进 intent 与 quarantine；Treasury 必须（MUST）计算 canonical authorizationCohortDigest（owner/policy decision/emergency override/revision/authorization legs/receiver capacity/contract 任一变化 → digest 变化）；cohort digest 必须（MUST）进入 unresolved authority、reconciliation capability 与 resolution prevalidation 的绑定比较；不得（MUST NOT）持久化 heap token 对象。

#### Scenario: cohort 变化可辨别

- **WHEN** owner、policy 决策、authorization leg 或 receiver capacity 变化
- **THEN** cohort digest 变化（旧 bundle/cohort 失效）

#### Scenario: global reset 后 cohort 可读

- **WHEN** 授权执行后发生 global reset
- **THEN** intent/quarantine 中完整 cohort 事实仍可读取（哪个 owner、哪个 policy 决策、是否 emergency override、exact epoch 与 revision、哪些 legs 覆盖哪些 postings）

### Requirement: 统一 immutable durable action identity（第十一轮）

系统必须（MUST）定义单一 durableAuthorityIdentityDigest，绑定 transaction identity、canonical transaction digest、contract ID/digest、adapter registration identity、action kind、canonical postings、完整 structure descriptor、durable payload/version、authorization cohort digest、owner/policy identity 与 immutable action metadata（execution outcome 与 settlement 为可变 workflow 事实、不得进入 identity）；intent 首次写入、同 ID 幂等、read-back、intent→quarantine 事实转移、quarantine 同 ID 幂等、intent/quarantine 双权威一致性、capability 签发、resolution prevalidation 与 global reset recovery 必须（MUST）全部比较同一 identity digest；同 transaction ID 但 identity digest 不同必须（MUST）返回 identity_conflict（store 原数据不动、writer fail closed、callback 零调用）、永远不得（MUST NOT）作为 already_present 幂等通过。

#### Scenario: 同 ID 不同 identity 冲突

- **WHEN** 同 transaction ID 但 owner/policy/structure descriptor/durable payload 任一不同
- **THEN** identity_conflict（intent 与 quarantine 两 store 均如此）

#### Scenario: 完整 identity 幂等

- **WHEN** 同 ID 且完整 identity digest 相同重试
- **THEN** 幂等成功（already_present 语义）

### Requirement: outcome/settlement/phase 语义矩阵与 cross-store finalized proof（第十一轮）

系统必须（MUST）建立单一语义矩阵权威（每 outcome 的合法 settlement 集合；quarantine fault phase 与 outcome 的强制映射）；progressTreasuryIntent 的目标组合、intent 与 quarantine 的 load 全量验证必须（MUST）执行矩阵检查；非法组合必须（MUST）使 store unhealthy（authority 不可签发、resolution 拒绝、write readiness=false）；returned_ok 不得（MUST NOT）通过损坏数据或错误组合退化为可 not-executed；finalized+returned_ok 必须（MUST）存在 settled receipt 或 final committed resolution tombstone、finalized+returned_non_ok/not_started 必须（MUST）存在 final not-executed/rolled-back tombstone——proof 缺失必须（MUST）转为 semantic store fault（fail closed，不得自动删除 entry、不得见到 finalized 就直接释放）。

#### Scenario: 非法组合 fail closed

- **WHEN** 损坏数据产生 commit phase + started_unknown、returned_ok + pending_abort 等非法组合
- **THEN** store unhealthy、write readiness=false、authority 签发与 resolution 拒绝

#### Scenario: finalized proof 强制

- **WHEN** finalized intent 无对应 receipt/tombstone
- **THEN** 不释放、semantic fault fail closed；proof 存在时恢复幂等

### Requirement: legacy authority 版本化隔离（第十一轮）

legacyV1（或缺乏完整 adapter/contract facts）的 quarantine authority 不得（MUST NOT）使用当前 adapter reconciler 解释；普通 issueTreasuryReconciliationCapability 遇 legacy authority 必须（MUST）拒绝（明确诊断）；legacy entry 必须（MUST）保持隔离不动（只能显式人工 migration/reconciliation 处理）；新 adapter version 不得（MUST NOT）解释 legacy action；legacy migration 不得（MUST NOT）伪造缺失的 contract/cohort identity。

#### Scenario: legacy 拒绝当前 reconciler

- **WHEN** legacyV1 quarantine 尝试经当前 adapter reconciler 签发 capability 或 resolution
- **THEN** legacy_authority_isolated 拒绝；entry 原样保留；显式诊断可读

### Requirement: resolution 内部完全封闭（第十一轮）

生产 TreasuryService 公开接口必须（MUST）只保留 issueTreasuryReconciliationCapability 与 resolveUnresolvedTransaction（capability consume/validate、service generation、resolution guard、kernel registration 不得出现在公共面或公开模块边界）；resolution kernel 必须（MUST）经内部 unique symbol 通道由 service closure 直接调用（模块级注册函数移除）；capability 消费必须（MUST）仍只在 staged resolution 写入成功之后；test-only 低层入口必须（MUST）独立于生产面；架构测试必须（MUST）扫描全部生产源码禁止普通模块引用 resolution 内部模块。

#### Scenario: 公共面不存在内部方法

- **WHEN** 检查公共 TreasuryService 类型与运行时枚举
- **THEN** 无 consumeReconciliationCapability/treasuryServiceGeneration/treasuryResolutionGuard；普通对象无法提前消费 capability

#### Scenario: 正常 resolution 不受影响

- **WHEN** 经 service.resolveUnresolvedTransaction 以合法 capability resolution
- **THEN** 正常完成（staged 写入后才消费）

### Requirement: 完整 structure binding descriptor（第十一轮）

structure binding 必须（MUST）升级为完整 canonical descriptor（binding kind：governed location/explicit game object；action-specific role：source/target/fee source/production structure/受控扩展；room；location kind；object ID；expected structure type；expected room；snapshot/incarnation ID；required/optional 语义；descriptor version）并全部进入 contract digest（AC4）、intent、quarantine 与 durable authority identity；同结构不同 role 不得（MUST NOT）静默合并；label 仅诊断；required descriptor 的结构缺失必须（MUST）构建拒绝；reconciler 必须（MUST）获得完整 descriptor；global reset 后必须（MUST）仍能按原 descriptor 解释动作；descriptor 数组必须（MUST）有界。

#### Scenario: descriptor 字段变化改变 digest

- **WHEN** role/expectedType/expectedRoom/object ID 任一变化
- **THEN** contract digest 变化（旧 bundle 失效）

#### Scenario: 同结构不同 role 不合并

- **WHEN** 同一结构被声明为 source 与 fee_source 两个 role
- **THEN** 保留两条 descriptor（各自进 digest 与 durable authority）

### Requirement: facade 职责拆分（第十一轮）

facade 必须（MUST）将 authorization ledger（registry/budget/bundle 签发/atomic redemption/policy-cohort 处理）、resolution authority（capability registry/issuance/consume/staged resolution 调用）、recovery coordinator（intent/quarantine 转移、semantic matrix、cross-store finalized proof、pre-execution fault recovery）与 write-readiness state collector（状态收集+单一评估器）拆分为内部模块；facade 只保留生命周期编排、公开 read/query facade 与模块组合，不得（MUST NOT）再直接持有 bundle Maps、capability WeakSets 或 resolution kernel 细节；模块依赖方向必须（MUST）清晰且无新循环依赖；拆分必须（MUST）行为保持（现有公开行为兼容）；不得（MUST NOT）借拆分接入真实 writer 或大改业务策略。

#### Scenario: 拆分行为保持

- **WHEN** 拆分后运行全部既有 treasury 测试
- **THEN** 公开 API 行为不变（既有断言不改即通过）

#### Scenario: 架构边界阻止绕过

- **WHEN** 新模块尝试绕过 kernel/store 边界
- **THEN** 架构测试失败（全量生产源码扫描）

### Requirement: 临时脚本清理与 evidence 一致性（第十一轮）

`src/runtime/treasury/fix-ac3.cjs` 与同类一次性 patch 脚本必须（MUST）从 git tree 删除；Round 10 evidence 必须（MUST）修正为如实记录（不声称该文件已移除、如实说明于第十一轮删除、不篡改历史提交事实）；git tree 中不得（MUST NOT）存在写死开发者本地绝对路径的临时修补脚本。

#### Scenario: 清理后仓库一致

- **WHEN** 检索 fix-ac3.cjs 与写死本地路径的临时 patch 脚本
- **THEN** 均不存在；evidence 陈述与仓库实际一致

### Requirement: 统一 normalized receipt lookup 与 v5 显式 proof 等级（第十三轮）

Treasury 必须（MUST）提供单一 normalized receipt lookup 语义，其结果至少区分 absent、valid legacy committed proof、valid modern committed proof、corrupted 与 incompatible store；hasSettledReceipt、readTreasurySettlementProof、admitTreasuryReceipt、reserveTreasuryReceiptAdmission、commitSettledReceipt、refreshSettledReceiptForResolution、cleanup/migration、projection.isSettled、prepareTransaction 与 finalized proof 路径必须（MUST）复用该语义，不得（MUST NOT）在不同路径使用互不一致的 already-settled 判定（如一处 `typeof === "number"`、另一处只认对象）。receipt store 必须（MUST）升级至 v5：settlement proof 携带显式 `level`（modern 必填 digest 与 durableIdentityDigest；legacy 不得（MUST NOT）携带身份字段）。

#### Scenario: v3 数字 receipt 的零写识别

- **WHEN** Memory 中存在未迁移的 v1/v2/v3 receipt store 且某 transactionId 对应合法数字 value
- **THEN** 只读查询（hasSettledReceipt / readTreasurySettlementProof）将其识别为已结算（legacy committed）且 Memory 零写入；合法数字不得（MUST NOT）被当作 corrupted

#### Scenario: admission 在迁移后命中 already-settled

- **WHEN** v3 store 经 admission/load 触发 v5 迁移后同 transactionId 再次 admission
- **THEN** 返回 already_settled（无论显式 legacy 还是 modern proof）；receipt slot、recovery slot、tentative、intent 与 authorization bundle 均不被消费；Game callback 保持零调用

#### Scenario: 迁移原子、幂等、fail closed

- **WHEN** v3/v4 → v5 迁移遇到编码碰撞、损坏 value 或无法安全定级的部分身份字段
- **THEN** 原 store 保持不变并 fail closed（拒绝登记）；重复运行已完成的迁移幂等；迁移后的 legacy proof 显式标记 level=legacy，modern proof 保留完整 attempt identity

### Requirement: already_settled 是零发布终态（第十三轮）

compat 单阶段路径遇到 already_settled 结果时必须（MUST）零发布：不写 journal、不写 overlay、不写 capacity delta、不写 heap settled cache、不触发 onRecorded、不修改 projectionRevision、不修改 tentative。prepared/contract 路径在 Game callback 之前的历史 receipt 必须（MUST）令 prepare/execution 返回 already_settled（bundle 不 redeem、intent 不写入、adapter.execute 零调用）；Game callback 之后的防御路径必须（MUST）读取完整 settlement proof 并按 attempt identity 区分：完全 match 可按幂等结算处理（不重复 heap 发布）、legacy/insufficient 不得（MUST NOT）假装属于当前 modern attempt、conflict 进入明确 internal settlement fault——后两种不得（MUST NOT）发布 heap committed state 且必须（MUST）保留 intent/quarantine 并阻断自动重试。receipt 写入结果必须（MUST）细化区分 written、already-settled-match、already-settled-legacy/insufficient、identity-conflict 与 corrupted/fatal，不得（MUST NOT）把所有 existing proof 折叠成无法判断身份的单一 already_settled。

#### Scenario: compat 路径零 heap 状态变化

- **WHEN** compat 单阶段登记遇到 already_settled 结果
- **THEN** journal、overlay、capacity delta、heap settled cache、projectionRevision、tentative 全部零变化

#### Scenario: post-callback identity conflict 不发布 heap

- **WHEN** Game callback 已返回 OK 后 commit 段发现同 ID existing modern proof 与当前 attempt identity conflict
- **THEN** 不发布 heap committed state；intent/quarantine 保留；进入明确 internal settlement fault 并阻断自动重试

### Requirement: receipt refresh 与 staged recovery 的 identity 严格性（第十三轮）

refreshSettledReceiptForResolution 必须（MUST）身份感知：absent → 可写 modern proof；existing modern proof 且 identity 完全 match → 仅刷新 settledAtTick；identity conflict → 拒绝刷新并保持 resolving authority（write readiness 继续阻断）；existing legacy/insufficient proof → 不得（MUST NOT）自动升级或覆盖（保持隔离、要求显式人工处理）；corrupted → fatal fail closed；resolution tick 只在成功 identity 验证后更新。recoverStagedResolutions 及一切同类 staged 恢复逻辑必须（MUST）以 identity relation 等于 "match" 作为唯一释放许可；conflict 与 insufficient 都不得（MUST NOT）释放 intent、quarantine、marker 或其他 authority，且必须有（MUST）独立诊断与计数，不得（MUST NOT）再以 `relation !== "conflict"` 作为释放条件。

#### Scenario: legacy receipt 阻断 refresh 覆盖

- **WHEN** resolving 状态的 modern attempt 遇到同 ID legacy receipt
- **THEN** 不覆盖 proof、不 finalize、authority 保留并报告 legacy/insufficient blocker

#### Scenario: insufficient 与 conflict 同样保持隔离

- **WHEN** staged committed recovery 的 receipt proof 对当前 attempt 为 insufficient 或 conflict
- **THEN** quarantine/intent/marker 全部保留，不释放；两者分别计数与诊断

### Requirement: 显式 proof / authority 等级与 modern required 字段矩阵（第十三轮）

intent、quarantine、authorization-fault 持久记录必须（MUST）携带显式 authorityLevel（modern contract authority、legacy migrated authority、forensic incomplete authority、low-level 四级），不得（MUST NOT）再由 optional 字段存在性隐式推断。modern authority 的 required 字段矩阵（contractId/contractDigest、actionKind、adapterVersion、adapterRegistrationId、stable adapter semantic identity、canonical postings、完整 structure descriptors、authorization cohort facts 与 cohort digest 成对、durableIdentityDigest、policyIdentity、必要 durable reconciliation facts）任一缺失时必须（MUST）判定 store unhealthy 或显式隔离为 forensic：capability 不得（MUST NOT）签发、resolution 不得（MUST NOT）自动执行，绝不（MUST NOT）自动视为 legacy。legacy 只能（MUST）来自版本化 migration 的显式标记且不得（MUST NOT）伪造缺失现代事实；legacy proof 可保守阻止同 transaction ID 重放但不得（MUST NOT）证明或释放 modern authority。forensic 必须（MUST）继续阻断 writer、不签发普通 capability、不走普通 resolution。同 ID 一方 modern、一方 legacy 的双 authority 必须（MUST）判 inconsistent，不得（MUST NOT）任选一方。

#### Scenario: 删除现代事实不得降级

- **WHEN** modern intent/quarantine 的任一 required 字段（cohort facts、cohort digest、durable identity、stable semantic identity、structure descriptors 等）被删除
- **THEN** 该 store unhealthy（或显式 forensic 隔离），不得（MUST NOT）降级为 legacy 兼容记录

#### Scenario: cohort facts 与 digest 成对

- **WHEN** modern 记录只有 cohort facts 或只有 cohort digest
- **THEN** store unhealthy（不再自动当 legacy）

### Requirement: 集中异常安全 cohort validator（第十三轮）

必须（MUST）存在唯一的 cohort facts validator（语义上 validateTreasuryAuthorizationCohortFacts），覆盖普通对象形状、owner identity、policy ID/version/registration identity、policy decision digest、emergency override、epoch、全部 revisions、adapter registration 与 stable semantic identity、contract ID/digest、transactionId、authorization leg digests、receiver capacity digest、issued tick、authorization digest、数组上限、字符串上限、安全整数、nested object 与 transaction/entry 交叉一致性；intent、quarantine、authorization-fault 必须（MUST）共用该 validator。cohort 重算必须（MUST）返回 Result 不得（MUST NOT）抛出：缺字段、null、错误类型、throwing Proxy 等一律返回有界结构化错误。store load、write、read-back、migration、repair、transfer、capability issuance 与 resolution prevalidation 均不得（MUST NOT）让异常逃逸并中断 tick。

#### Scenario: throwing Proxy 不逃逸

- **WHEN** cohort facts 为对属性访问抛错的 Proxy 对象
- **THEN** validator/重算返回结构化错误，不抛出异常、不中断 tick

#### Scenario: 篡改事实保留旧 digest

- **WHEN** 篡改 policy/owner/revision 而 digest 未同步变化
- **THEN** store unhealthy；repair 不得（MUST NOT）自动覆盖 digest

### Requirement: 统一持久 structure descriptor 校验（第十三轮）

必须（MUST）存在唯一共享的 structure descriptor validator 供 action contract canonicalization、intent、quarantine、authorization-fault、durable identity 重算、capability 签发与 reconciler 输入共同使用。governed_location 必须（MUST）禁止 objectId、expectedType、expectedRoom 且 room/location 受控、structureId 语义合法；game_object 必须（MUST）要求 objectId 必填、expectedType/expectedRoom 按规则校验、structureId 与 objectId 语义一致、room 与对象归属一致、required/role/version 合法。分支权威必须（MUST）单一（只按 bindingKind 分支），不得（MUST NOT）一处看 bindingKind、另一处看 objectId 是否存在。持久 Memory 中出现矛盾 descriptor 时必须（MUST）判 store unhealthy。

#### Scenario: 持久 governed_location 携带 objectId

- **WHEN** 持久 intent/quarantine 的 descriptor 为 governed_location 且携带 objectId（或 expectedType）
- **THEN** store unhealthy

#### Scenario: 同一 validator、同结构异 role

- **WHEN** contract、intent、quarantine 与 reconciler 输入使用同一 descriptor 形状
- **THEN** 使用同一 validator 判定；同一结构不同 role 仍产生不同 descriptor

### Requirement: forensic marker 与 tombstone 绑定 attempt identity（第十三轮）

forensic authorization-fault marker 必须（MUST）在既有事实允许时保存 redemption 故障前已计算的完整 attempt identity（contract digest、authorization cohort digest、durable identity digest 或专门 forensic attempt identity）；forensic resolution tombstone 必须（MUST）携带同一 identity；already_resolved 必须（MUST）比较完整 identity——同 ID、同普通 digest 但不同 owner/policy/cohort 的 attempt 不得（MUST NOT）共享 forensic tombstone。真正缺失 identity 的旧 marker 必须（MUST）显式按 legacy forensic proof 处理（不得（MUST NOT）证明 modern attempt）。acknowledgeRolledBack 显式管理要求必须（MUST）保留；不得（MUST NOT）新增无条件 clear marker 接口。forensic resolution 重复调用只在完整 identity 相同时幂等。

#### Scenario: 旧 forensic proof 不解决新 attempt

- **WHEN** 同 ID、同 contract digest 但不同 cohort 的第二次 forensic attempt 遇到旧 tombstone
- **THEN** 旧 tombstone 不能解决新 attempt（fail closed）

#### Scenario: marker 携带完整 identity

- **WHEN** 原子 bundle redemption 故障发布 forensic marker
- **THEN** marker 保存故障前已计算的完整 attempt identity；后续 forensic resolution 的 tombstone 绑定同一 identity


### Requirement: 第十四轮 Resolution Proof Closure & Authority-Level Integrity

staged committed resolution 的 authority 释放必须（MUST）以 receipt、tombstone、authority 三方完整 attempt identity 严格 match 为唯一许可——receipt settledAtTick 满足 tombstone 要求只是独立的时间条件，不得（MUST NOT）替代 identity 验证；receipt proof 必须在 tick 充分时同样被完整读取并按 tombstone 的完整 attempt identity（digest / contractDigest / authorizationCohortDigest / durableIdentityDigest）验证。authority 已被释放（前一 global 已释放、finalize 写入前中断）时，恢复仍必须（MUST）证明 receipt 与 tombstone identity match 后才可补完成 finalize。

#### Scenario: receipt tick 充分但 identity 冲突

- **WHEN** resolving committed tombstone 对应的 receipt settledAtTick 等于或晚于 tombstone 要求，但 receipt 绑定的 durable identity 与 tombstone/authority 不一致
- **THEN** 不 finalize、不释放 authority、不清 marker（conflict 独立计数）

#### Scenario: authority 已释放后 receipt 冲突

- **WHEN** resolving committed tombstone 的 authority 已不存在，receipt 与 tombstone identity conflict / 为 legacy / insufficient
- **THEN** tombstone 保持 resolving、write readiness 保持阻断（不伪造 authority）

#### Scenario: refresh 成功但持久 proof 与声明不符

- **WHEN** identity-aware refresh 返回成功，但重新读取的持久 receipt proof 与 tombstone identity 不匹配
- **THEN** 保留 resolving tombstone 与全部 authority（不凭 refresh 返回值释放）

同 id 双 authority（intent + quarantine 并存）必须（MUST）先分别从持久事实重算 identity（任一失败 → 整体 inconsistent），再显式比较 authorityLevel：任何跨等级组合（modern+legacy / modern+lowlevel / modern+forensic / lowlevel+legacy / lowlevel+forensic / legacy+forensic 等）必须（MUST）inconsistent fail closed——不得任选其一、不得退回 optional 字段子集比较。modern+modern 只有 durableIdentityDigest 与 authorizationCohortDigest 双方完整存在且相等、contractId/contractDigest/adapterSemanticIdentity 一致时才可（MAY）合并（quarantine 优先）。双 authority 不一致时 capability 签发与 resolution 必须（MUST）零副作用。

#### Scenario: 跨等级双 authority

- **WHEN** 同 id 的 quarantine 与 intent 显式等级不同（即使 durable digest 字符串相同）
- **THEN** authority inconsistent——capability 拒绝签发、resolution 拒绝执行、两份 authority 原样保留

lowlevel authority 必须（MUST）满足严格矩阵：required（canonical digest、action kind、source、canonical postings 非空、durableIdentityDigest 可由事实重算一致、显式 lowlevelSource 来源标记）且不得（MUST NOT）携带任何 modern contract/authorization 字段（contractId/contractDigest、authorizationCohort(+Digest)、authorizationDigest、adapterRegistrationId、ownerIdentity、policyIdentity）。production contract 路径在 contract 事实与 cohort redemption 不成对（partial-modern）时必须（MUST）拒绝执行（authority_invariant_violation、Game callback 零调用），不得（MUST NOT）写 lowlevel authority。

#### Scenario: production contract 路径不写 lowlevel

- **WHEN** executePreparedAction 收到 intentContract 但无对应 cohort redemption（或反之）
- **THEN** 结构化拒绝 authority_invariant_violation，callback 零调用、预留释放

旧版本 entry 迁移定级必须（MUST）保守：partial-modern（携带部分现代事实但 modern 矩阵不齐）一律 forensic 隔离，不得（MUST NOT）自动定级 lowlevel；只有携带显式 authorityLevel="lowlevel" 的受支持上一版 entry（intent v5 / quarantine v4 / fault v3）在满足严格低层矩阵（无 forbidden 字段 + durable 可重算）时才可（MAY）迁移为 lowlevel 并补 migrated 来源标记；cohort facts 与 digest 不成对或 digest 与事实重算矛盾必须（MUST）fatal（原 store 保留）；迁移必须（MUST）先构造临时结构全量验证后原子替换且幂等。

#### Scenario: 残缺 modern 旧 entry 不得变 lowlevel

- **WHEN** 旧 entry 显式 modern 但 cohort 字段被删除（残留 contract/adapter 字段）
- **THEN** 迁移定级 forensic 隔离（不得使用当前 reconciler）

resolution tombstone 必须（MUST）携带显式 proof class（identity-bound / lowlevel / legacy / forensic）且按 class 的 required/forbidden 身份字段矩阵校验：identity-bound 缺任一 required 身份字段必须（MUST）store unhealthy（绝不降级 legacy）；legacy proof 禁止携带部分现代身份字段；forensic proof 不参与普通 capability resolution 且不得（MUST NOT）释放 modern/lowlevel authority。同 id 覆盖（resolving → final）必须（MUST）保持同一 proof class 与完整 attempt identity。

#### Scenario: legacy proof 不释放 lowlevel authority

- **WHEN** final not-executed tombstone 为 legacy/forensic proof class 而仍存在的 authority 为 lowlevel
- **THEN** 释放被阻断（insufficient 计数、authority 保留）

intent / quarantine / authorization-fault 的写入必须（MUST）在发布前从候选事实重算 cohort 与 durable identity（不一致拒绝且 bookkeeping 不变），并在发布后从 Memory 持久副本再次重算并比较完整身份字段集（等级、来源标记、digest 族、cohort、structure descriptors、canonical postings、outcome、settlement、source 等）——read-back 不一致必须（MUST）回滚本次写入并恢复 entryCount/revision/updatedAt。intent → quarantine 转移只有目标持久副本完整证明与源 authority 一致（含 authorityLevel 与 lowlevelSource）后才可（MAY）删除源 intent；同 id 既有 entry 自身 identity 不可重算时不得（MUST NOT）返回 already_present。

#### Scenario: 发布后 read-back 被篡改

- **WHEN** store 写入后、read-back 验证前 Memory 中的身份字段被篡改
- **THEN** 写入回滚、entryCount/revision/updatedAt 恢复、调用方收到结构化 store fault

authorization-fault store 的轻量健康探测必须（MUST）检查 metadata 矛盾（version 受支持集合、entries 普通对象、entryCount 非负安全整数且不超硬容量、updatedAt 合法安全整数）且不扫描 entries 全表；write readiness 与 authorization 联合判定在 store 存在时必须（MUST）触发完整 load 验证（首次有界全表扫描、heap 缓存后 O(1)）——损坏期间授权拒绝、Game callback 零调用。

### Requirement: 第十五轮——自动恢复统一 unresolved authority resolver

staged resolution 的全部自动恢复路径（resolving committed 的 beginTick 恢复、final not-executed 的补完成释放、global reset 补完成）必须（MUST）经唯一的 `resolveTreasuryUnresolvedAuthority` 读取 authority，不得（MUST NOT）自行实现 quarantine 优先、intent fallback、等级比较或 durable identity 比较。status=ok 时只允许（MAY）使用返回的 normalized authority 继续 proof 验证；status=inconsistent 时必须（MUST）保留 intent、quarantine、tombstone 与 write-fault marker，记录独立 authorityInconsistent 计数，write readiness 保持阻断，零 authority 释放、零 receipt refresh、零 tombstone stage 变化；status=not_found 时只允许（MAY）进入"authority 已在前一阶段释放"分支（committed 仍须 receipt ↔ tombstone identity match 且 tick 足够才补完成 finalize；not-executed 视为释放已完成），不得（MUST NOT）伪造新 authority。

#### Scenario: 双 authority 不一致时零释放

- **WHEN** resolving committed tombstone 存在，同 ID quarantine（modern）与 intent（legacy/modern 不同 identity）并存且 resolver 判 inconsistent
- **THEN** 两份 authority 原样保留、tombstone 保持 resolving、marker 保留、authorityInconsistent 计数独立增加、write readiness 保持阻断

#### Scenario: 完全一致的双 authority 正常恢复

- **WHEN** 同 ID quarantine 与 intent 身份完全一致（resolver ok）
- **THEN** normalized authority 路径正常继续三方 proof 验证与释放

### Requirement: 第十五轮——resolution tombstone 不可逆状态机

resolution store（v5）的每次写入必须（MUST）经不可逆状态机判定：合法创建只有 absent → resolving committed 与 absent → final not-executed；合法更新只有 resolving committed → final committed，且必须（MUST）保持 transactionId、digest、proofLevel、完整 attempt identity、resolution kind、actionTick、observationTick、reconcilerKind、source、settledAtTick 与 forensic provenance 不变（仅 stage 与 resolvedAtTick 单调推进、必要 finalization 审计字段可变）。resolving committed → final not-executed、resolving committed → resolving not-executed、final committed → final not-executed、final not-executed → final committed、final → resolving、同 ID 改变 resolution kind / digest / proofLevel / attempt identity / actionTick、降低 settledAtTick 必须（MUST）全部拒绝且原 tombstone 完全不变。已有 tombstone 时只允许（MAY）全部安全关键字段完全一致的 exact idempotent 重复写，不得（MUST NOT）以覆盖写实现幂等。

#### Scenario: resolving committed 不能变为 final not-executed

- **WHEN** 已存在 resolving committed tombstone，尝试写入同 ID 的 final not-executed（即使 digest 相同）
- **THEN** 拒绝，原 tombstone 完全不变

#### Scenario: final tombstone 的 exact idempotence

- **WHEN** 已存在 final tombstone，重复写入全部安全关键字段完全一致的内容
- **THEN** 幂等返回（already-present 语义），原数据不变；任一字段不同则 identity/state conflict

### Requirement: 第十五轮——resolving 期间 reconciler 与 capability 互斥

capability 签发路径必须（MUST）在调用 adapter.reconcile 之前读取 resolution tombstone：stage=resolving 时不得（MUST NOT）调用 reconciler、不得签发新 capability，必须（MUST）返回 resolution_in_progress（等待 staged recovery 继续原结论）；stage=final 且完整 attempt identity 与当前 authority match 时必须（MUST）返回 already-resolved 语义且 reconciler 零调用；tombstone 存在但 identity conflict 或 proof insufficient 时必须（MUST）fail closed（reconciler 零调用）。resolving tombstone 不得（MUST NOT）被第二个相反结论覆盖。

#### Scenario: resolving 期间 reconciler 零调用

- **WHEN** resolving committed tombstone 存在（staged resolution 进行中）且请求签发 capability
- **THEN** 拒绝 resolution_in_progress、adapter.reconcile 调用数为 0、不签发第二份普通 capability

### Requirement: 第十五轮——forensic proof 显式管理 provenance

forensic proof 必须（MUST）绑定显式管理 provenance（协议版本、acknowledgement 类型、管理操作身份或 capability digest、attempt identity、确认时间、来源、自动补完成许可）才能参与任何显式 forensic 流程；migration-derived forensic tombstone（旧 partial identity 迁移）必须（MUST）永久隔离——不得（MUST NOT）由普通 beginTick 自动释放、不得（MUST NOT）参与普通 capability resolution、不得（MUST NOT）假装已有人确认。普通自动 recovery 的 proof 释放矩阵必须（MUST）收敛为 identity-bound → modern 与 lowlevel → lowlevel；legacy 与 forensic proof 一律不得（MUST NOT）通过普通自动 recovery 释放 authority（legacy replay blocker 语义保留，但不作为 authority release proof）。缺少显式 forensic provenance 的 forensic proof 与 authority 保持隔离并提供（MUST）诊断（来源保留）。

#### Scenario: migration-derived forensic 不被 beginTick 释放

- **WHEN** forensic proof tombstone 与 forensic authority 并存（等级相同），普通 beginTick recovery 运行
- **THEN** authority 不释放（proof-level 矩阵阻断）、隔离与诊断保留

### Requirement: 第十五轮——按 authority class 的 same-ID 幂等

intent / quarantine / authorization-fault 三个 store 的 same-ID 写入必须（MUST）经唯一的 authority-class 幂等比较模块，不得（MUST NOT）以"durable identity digest 空对空匹配"作为通用幂等证明。modern：authorityLevel 相同、durableIdentityDigest 双方完整存在且一致、cohort identity 存在且一致、contract identity 一致；lowlevel：authorityLevel 相同、受控 lowlevelSource 相同、durableIdentityDigest 存在且一致、digest/kind/actionKind/source/canonical postings 一致；legacy：受控 legacy signature（transactionId、digest、kind/actionKind、canonical postings、source 或已定义 legacy provenance、legacyV1 标记）完全相同才幂等；forensic：forensic reason/provenance、已知 attempt identity、digest、canonical postings、source、fault phase/outcome 全部相同才幂等。跨 authority level 的 same-ID entry 必须（MUST）永远冲突；缺少足够 provenance 时必须（MUST）不视作 same（保持已有 entry，返回 conflict/isolated）。

#### Scenario: legacy 空 durable 不同 digest 不幂等

- **WHEN** 同 ID legacy entry 与新写入 legacy 候选 durableIdentityDigest 均为空但 digest（或 canonical postings / source）不同
- **THEN** identity conflict（不返回 already_present），原数据不动

#### Scenario: 跨等级 same-ID 冲突

- **WHEN** 同 ID 既有 modern entry，新写入候选声明 lowlevel（或相反）
- **THEN** identity conflict，原数据不动

### Requirement: 第十五轮——store-specific durable publication 语义验证

durable publication read-back 必须（MUST）支持注入 store-specific 完整 shape 与语义校验：intent（authority level 矩阵、outcome/settlement 语义矩阵、lowlevel provenance、modern required 字段、cohort/descriptor）；quarantine（phase/outcome/settlement 语义矩阵、forensic provenance、legacy 标记、tick/recordedAt、deltas、contract/cohort/descriptor 事实——必须检出 phase 被篡改但 digest 未变）；authorization-fault（outcome 恒 not_started、rollbackConfirmed 恒 true、faultTick、source、detail 边界、authority 矩阵、cohort/descriptor、forensic/legacy 信息）。共享比较字段集必须（MUST）覆盖全部安全关键不可变字段（phase、outcome、settlement、forensic 对象、legacyV1、faultTick、rollbackConfirmed、authority level、lowlevel provenance、结构与 cohort 嵌套事实、tick/recordedAt/createdAtTick、detail）。read-back 失败必须（MUST）回滚并恢复 entry、entryCount、revision、updatedAt 与相关缓存——不得留下当前 global 暂时可信、下次 reset 才 fatal 的 entry。

#### Scenario: quarantine phase 篡改触发回滚

- **WHEN** quarantine 发布后、read-back 前 Memory 中的 phase 被篡改（digest 未变）
- **THEN** read-back 失败、本次写入回滚、entryCount/revision 恢复、调用方收到结构化 store fault

#### Scenario: authorization-fault 固定事实篡改触发回滚

- **WHEN** authorization-fault 发布后 faultTick 被篡改或 rollbackConfirmed 变为 false
- **THEN** read-back 失败并回滚，bookkeeping 恢复

### Requirement: 第十五轮——authority 读取完整深冻结

readTreasuryIntentEntry、readTreasuryQuarantineEntry、readTreasuryAuthorizationFaultEntry、readTreasuryResolutionTombstone 与全部 list / diagnostic API 必须（MUST）返回完整深拷贝并深冻结的快照：postings/deltas、structure descriptors、authorization cohort（含 revisions 与 authorization leg digests）、forensic provenance、嵌套 policy/owner 事实与任何嵌套数组或普通对象。调用者修改返回对象的任意嵌套字段时 Memory 必须（MUST）不变、store revision 不得（MUST NOT）被绕过、heap health cache 不得（MUST NOT）被外部对象污染。深冻结 helper 必须（MUST）只处理明确有界的普通对象/数组（有界深度与键数），不得（MUST NOT）使用通用无限递归 clone 处理任意对象。

#### Scenario: 修改 read quarantine 的 cohort revisions

- **WHEN** 调用者修改 readTreasuryQuarantineEntry 返回快照的 authorizationCohort.revisions（或 forensic 对象）
- **THEN** Memory 中的权威 entry 不变

### Requirement: 第十五轮——lowlevel provenance 受控权威

lowlevelSource 必须（MUST）是受控来源集合的成员（runtime-lowlevel@v1、migrated-lowlevel@v1；test-only 来源只能经测试通道），不得（MUST NOT）接受任意非空字符串。production 代码不得（MUST NOT）自行传任意字符串；未知 source 必须（MUST）拒绝。migration 只能（MAY）生成 migrated 来源；runtime 来源只能由 store 内部写入路径缺省声明；来源必须（MUST）进入 lowlevel same-ID 比较（source 变化 → conflict）。旧任意字符串 source 迁移时无法证明来源必须（MUST）定级 forensic 隔离，不得（MUST NOT）直接信任。

#### Scenario: 未知 lowlevel source 拒绝

- **WHEN** 携带未知 lowlevelSource 字符串的 lowlevel entry 通过 store 写入或 load 校验
- **THEN** 拒绝/ unhealthy（fail closed）

### Requirement: 第十五轮——immediate 与 staged recovery 共用三方 verifier

必须（MUST）存在唯一的 committed proof verifier（输入 tombstone、normalized authority 解析结果与持久 receipt proof；输出 verified / conflict / insufficient / authority_inconsistent / receipt_absent / receipt_stale），normal resolve-as-committed、beginTick staged recovery、finalize 补完成与
 already-resolved 检查共同复用。immediate resolve-as-committed 必须执行：写 resolving tombstone → refresh receipt → 重新读取持久 receipt proof → 调用统一三方 verifier → verifier 通过才释放 authority → finalize；不得仅凭 refresh 返回成功释放。refresh 成功后持久 receipt 被篡改、双 authority 变 inconsistent、receipt proof 变 legacy/insufficient 时必须不释放（authority 与 resolving tombstone 保留，独立计数），且任意拒绝路径 Game callback 零调用。

#### Scenario: refresh 成功但 receipt 被篡改

- **WHEN** immediate resolve-as-committed 的 receipt refresh 返回成功，但重新读取的持久 proof 与 tombstone attempt identity 不一致
- **THEN** 不释放 authority、不 finalize、resolving tombstone 保留

### Requirement: 第十五轮——resolution health 版本兼容

resolution store 轻量 health probe 的受支持版本集合必须与 loader 一致（v1/v2/v3/v4/v5 均为 supported migration pending，不误报 unknown fatal）；未知版本仍必须 fail closed。未 load 时轻量 probe 不得执行全表扫描（resolving 计数由 heap 缓存承载，写路径触发完整 load/migration）；write readiness 的 resolving blocker 在 store 存在时必须触发完整 load 验证后读取缓存计数。

#### Scenario: v3 store 轻量 health 不误报

- **WHEN** 持久 resolution store 为 v3（loader 支持 v3→v5 迁移）且未 load
- **THEN** 轻量 probe 报告 healthy（migration pending），不报 unknown version；写路径触发完整迁移

#### Scenario: unknown 版本仍 fail closed

- **WHEN** 持久 resolution store 版本为未知值（如 99）
- **THEN** 轻量 probe 报 unhealthy（fail closed）

### Requirement: 第十六轮——显式 attempt rearm（same-ID 不可重试）

同一个 transaction ID 永远只对应一个执行 attempt。resolve-as-not-executed 不得返回任何"同 ID 可重新执行"语义（`sameIdRetryAllowed` 恒为 false）；同 ID 存在 final not-executed tombstone 时 prepare（两阶段与单阶段 compat）必须拒绝（reason=rearm_required，Game callback 零调用）。重试的唯一合法通道是受控 service 方法 rearmResolvedNotExecutedAttempt：零写、纯确定性派生 child transaction ID（canonical tuple 绑定 rearm 协议版本 + parent ID + parent attempt identity 全部成分含 lowlevelSource；输出满足现有 transaction ID validator、长度有界、不依赖随机数、跨 global reset 恒定、同 parent 幂等、不同 parent identity 得到不同 child；A→B→C 链式，每个 attempt 最多一个直接 child，不持久化无界 attempt sequence 表）。rearm 前置校验：parent final not-executed tombstone 存在、proofLevel 为 identity-bound/lowlevel（legacy/forensic 不足 proof 不能 rearm）、expectedParentIdentity（可选）完整 match、parent durable authority 已释放（resolver not_found）、parent marker 清理已完成、各 store 健康。parent tombstone 继续证明 parent attempt 已结束、不阻断 child ID、不能证明或释放 child attempt；child 的 contract/bundle/intents 全部绑定 child transaction ID，故障后独立签发 capability、resolution 与 receipt。

#### Scenario: 同 ID 直接 prepare 被拒

- **WHEN** transaction 已 final not-executed（authority 已释放）且调用方以相同 transaction ID 再次 prepare
- **THEN** prepare 返回 rejected（reason=rearm_required）、Game callback 零调用；不存在"未 rearm 先执行"路径

#### Scenario: 显式 rearm 幂等且跨 reset 稳定

- **WHEN** 同一 parent（final not-executed、marker 已清、authority 已释放）重复调用 rearm，或 global reset 后再次调用
- **THEN** 返回同一 child transaction ID（纯确定性派生）；不同 parent 或不同 parent identity 得到不同 child

#### Scenario: rearm 前置阻断

- **WHEN** parent 仍有 unresolved authority、或 marker 未清理、或 tombstone 为 resolving/committed、或 proofLevel 为 legacy/forensic、或任一 store fatal
- **THEN** rearm 拒绝并返回对应 reason；不生成 child attempt、零副作用

#### Scenario: parent proof 不能证明 child

- **WHEN** child attempt 独立发生故障并请求 resolution
- **THEN** parent 的 tombstone/receipt/marker/capability 均不得证明或释放 child authority；child 可独立 rearm 生成孙代

### Requirement: 第十六轮——跨 store execution-fact cohesion

双 authority 归一化必须在 immutable identity 之上比较 execution facts（唯一权威模块 executionFactCohesion.ts）：outcome 必须完全相同（returned_ok 单侧存在、aborted_final 与运行时事实并存、任意不同 outcome 组合 → inconsistent，绝不"选择更强事实"）；quarantine phase 类别必须与共同 outcome 严格对应（returned_ok 只配 commit 类、returned_non_ok 只配 abort-failed、started_unknown 只配 execution-unknown 类中副作用未知的 phase、not_started 只配 internal authorization fault 类——跨类上探并存禁止）；intent settlement 必须属于共同 outcome 的并存集合（ready/finalized 不得与 unresolved quarantine 并存）；归一化 authority 的 execution facts 经明确合并规则（outcome=共同值、settlement=双方向更进展一方、phase=quarantine 权威）。cohesion 不一致 → resolver 返回 inconsistent、两份 authority 全保留、not-executed capability 不签发、recovery 零 release 零 refresh。

#### Scenario: returned_ok 永不被 started_unknown 覆盖

- **WHEN** intent.outcome=returned_ok 而 quarantine.outcome=started_unknown（immutable identity 相同）
- **THEN** resolver 返回 inconsistent；returned_ok 事实保留；not-executed capability 不签发

#### Scenario: 相同 outcome 合法组合归一化

- **WHEN** 双 authority outcome 均为 returned_ok 且 intent.settlement=faulted、quarantine phase 为 commit 类、settlement=quarantined
- **THEN** 归一化成功；execution facts 为明确合并结果（outcome=returned_ok、settlement 取更进展一方、phase=quarantine 权威）

### Requirement: 第十六轮——final not-executed 残留 marker 安全补完成

final not-executed tombstone 已写、authority 已释放、marker 尚未清除时（中断窗口），beginTick recovery 不得因 authority not_found 直接跳过：必须检查 write-fault marker——不存在视为释放与清理均完成；存在且 transaction/attempt ID 匹配 + digest 匹配 + marker attemptIdentity 完整且与 tombstone identity relation=match + phase 与 not-executed 结论兼容（preExecution 矩阵）+ tombstone proof level 与 marker identity 兼容，才可清除 marker；marker 属于另一 attempt、identity conflict/insufficient、phase 不兼容 → 保留 marker 与 tombstone、write readiness 继续阻断、独立诊断计数、不伪造 authority。marker 读取必须返回有界深冻结快照（不泄漏嵌套 attemptIdentity 引用）。marker 未完成清理前 rearm 必须拒绝。

#### Scenario: matching marker 补清

- **WHEN** final not-executed + authority 已释放 + marker 与 tombstone 完整匹配
- **THEN** beginTick 清除 marker 并将 transactionId 移出 pending-release 索引；补完成幂等

#### Scenario: conflict/insufficient marker 保持锁定

- **WHEN** marker 属于另一 attempt、或 identity conflict/insufficient、或 phase 与结论不兼容
- **THEN** marker 保留、write readiness 保持阻断、独立计数；不得清除或伪造 authority

### Requirement: 第十六轮——resolver 四态语义（store_unhealthy）

resolveTreasuryUnresolvedAuthority 必须区分 ok / not_found / inconsistent / store_unhealthy：先检查 intent 与 quarantine store health（对已存在 store 触发必要 load validation）；store 不存在是合法的"无 entry"来源；只有两个 store 均可信且都确实无 entry 时才返回 not_found；任一 store fatal → store_unhealthy（附各 store 有界诊断），固定零副作用（不 refresh receipt、不释放 authority、不清 marker、不 finalize、不签发 capability、零 reconciler），绝不折叠成 not_found 也绝不选 healthy 一侧。capability 签发、normal resolution prevalidate、staged resolution recovery、final not-executed 补完成、committed proof verifier（authority_store_unhealthy 独立 verdict，不归入 authority not_found）、rearm、readiness diagnostics 全部路径必须处理 store_unhealthy。

#### Scenario: store fatal 不是 not_found

- **WHEN** intent store fatal 而 quarantine store 不存在（或任一组合）
- **THEN** resolver 返回 store_unhealthy（附 store 错误）；不是 not_found

#### Scenario: 一侧 healthy 一侧 fatal

- **WHEN** 一侧 store healthy 且有 authority、另一侧 store fatal
- **THEN** resolver 返回 store_unhealthy；不选择 healthy 一侧；零副作用

### Requirement: 第十六轮——resolution 持久状态语义矩阵

resolution store 必须有单一内在状态 validator（resolutionStateSemantics.ts，与形状校验、转换校验职责分离）供 load 全量校验、migration、写入候选、read-back、repair 共同使用：stage 必须显式（v1-v4 迁移补终态 stage=final）；resolving 只能 committed（resolving not-executed 非法）、settledAtTick 必填（staged 目标 tick）、proofLevel 只能 identity-bound/lowlevel、不携带 forensic provenance 与 preExecution；final committed 必须有 settledAtTick、不携带 preExecution；final not-executed 不得携带 settledAtTick、preExecution 与来源一致（source 为 acknowledge-rolled-back 受控通道）；forensic provenance 只配 forensic proof level；final 终态 settledAtTick/observationTick 不得晚于 resolvedAtTick。发现非法持久状态 → store unhealthy（fatal 原数据保留、write readiness=false、recovery 不删除 entry）；recovery 的"防御分支删除 tombstone"路径废除。写入上下文追加：proofLevel=lowlevel 的新写入必须携带 lowlevelSource（旧数据缺失为隔离态，不猜测 runtime 来源）；identity-bound 禁止携带 lowlevelSource。

#### Scenario: resolving not-executed 持久 entry

- **WHEN** 持久 store 出现 stage=resolving 且 resolution=not-executed（或 resolving 缺 settledAtTick、resolving forensic/legacy、final committed 缺 settledAtTick、provenance 与 proof 矛盾）
- **THEN** load 校验判 store unhealthy（原 entry 保留）；recovery 不自动删除

#### Scenario: 合法历史版本迁移继续通过

- **WHEN** v1-v5 resolution store 数据合法
- **THEN** 迁移至 v6 成功（v2-v4 无 stage 的历史 entry 补终态 stage=final）；原数据语义不变

### Requirement: 第十六轮——authority 写入输入别名隔离

intent / quarantine / authorization-fault / resolution tombstone / write-fault marker 的全部写入口在写入 Memory 前必须构造完全独立的有界深拷贝（durableClone.ts 唯一 helper；普通对象/数组/嵌套 revisions/authorization leg digests/structure descriptors/forensic provenance/attemptIdentity）；发布顺序统一为 clone 输入 → 验证 clone → 重算 clone identity → Memory 写入 clone → read-back 验证。写入成功后调用方修改原输入的任何嵌套字段，Memory 必须完全不变、store revision 不发生隐式变化。

#### Scenario: 写入后修改原输入

- **WHEN** quarantine 写入成功后调用方原地修改原输入的 cohort.revisions / authorizationLegDigests / structureFacts / forensic / attemptIdentity
- **THEN** Memory 权威副本完全不变；store revision 不变

### Requirement: 第十六轮——lowlevel provenance 进入完整 proof 链

lowlevelSource 是 lowlevel attempt identity 的组成部分：attempt identity 视图与 relation 比较纳入 lowlevelSource 维度（attempt 携带时 proof 必须同样携带且相等：缺失=insufficient、不等=conflict；attempt 不带而 proof 带=conflict）；capability 绑定 authority 的 lowlevelSource（prevalidate 强校验：lowlevel authority 双方一致携带、非 lowlevel 禁携带）；resolution tombstone v6 携带 lowlevelSource（仅 proofLevel=lowlevel、新写入必须携带、v5 旧数据为来源不可证明的隔离态不自动释放不猜测来源）；receipt v6 携带 lowlevelSource（modern proof 可携带、legacy 禁带、commit 与 refresh 随低层 attempt 写入）；committed proof verifier 三方比较 lowlevel provenance（tombstone 缺=insufficient、与 authority 不同=conflict）；runtime-lowlevel 与 migrated-lowlevel 不能互相证明；modern proof 不能释放 lowlevel authority。

#### Scenario: 不同来源不能互相证明

- **WHEN** lowlevel authority 来源为 runtime-lowlevel@v1 而 tombstone/receipt proof 来源为 migrated-lowlevel@v1（或反之）
- **THEN** relation=conflict；authority 不释放；零副作用

#### Scenario: 旧 proof 缺来源隔离

- **WHEN** v5 旧 lowlevel tombstone 无 lowlevelSource
- **THEN** verifier 判 insufficient（来源不可证明）；隔离不释放；不猜测为 runtime 来源

### Requirement: 第十六轮——not-executed capability 消费顺序与 pending 恢复 O(1) 索引

resolve-as-not-executed 的安全顺序必须是：完整 prevalidate → resolution slot 预检 → consume capability → 写 final not-executed tombstone → 释放 authority → 清 marker。consume 失败不得写 tombstone（authority 与 marker 保留，beginTick 无 proof 可自动释放——不存在"未成功消费 capability 却已持久化可自动释放 authority 的 final proof"）；consume 成功但 tombstone 写失败 → authority 保留（后续 tick 重新签发 capability 重试）；tombstone 成功后释放前中断 → beginTick pending-release 补完成。resolution store 运行态必须维护 pending 恢复索引（resolving transaction IDs 与 final not-executed pending-release IDs）：global reset 首次 load 一次有界全表扫描重建；写入/删除/retention/补完成同步维护；beginTick 无待处理项时 O(1) 直接返回（不扫描 resolution entries）；有待处理项时只遍历索引 ID（不扫描历史 final proof）；Memory tombstone 仍是权威（索引仅用于定位待处理项，索引 ID 失效即清理，不得作为安全 proof）。

#### Scenario: consume 失败零持久副作用

- **WHEN** capability 消费失败（已消费/跨 tick 等同步窗口失效）
- **THEN** 不产生 final tombstone；authority 保留；marker 保留；不存在可自动释放的 final proof

#### Scenario: 空闲 beginTick O(1)

- **WHEN** 无 resolving 且无 pending-release 索引项
- **THEN** recoverStagedResolutions 直接返回（idleFastPath）；不扫描 resolution entries；有待处理项时只遍历索引 ID

## Requirement: 第十七轮——durable attempt lineage store（版本化、有界、fail closed）

每条业务重试链在 Memory.runtime.treasury.attemptLineage（v1，key `l:<rootAttemptId>`，entryCount，硬容量）持久保存一个有界 lineage record：lineageId、root/current attempt ID 与完整 identity、attempt generation、状态、resolution 状态、next child ID、retry semantic digest、authority/proof class、lowlevelSource、parent/child 绑定摘要、rearmable 与 nonRearmReason、retirement 三段完成标志（lineagePublished/authorityReleased/markerCleaned）、创建/更新时间。状态机单调：retiring → rearm_ready → capability_issued → child_intent_pending → child_active → chain_committed（或 non_rearmable_retired / forensic_isolated）；禁止已完成 chain 回退为 ready、同一 generation 生成不同 child、child active 时签发第二个 child、改变 root attempt、改变 retry semantic identity、改变 authority class、复用旧 generation。新 root chain 占一个 slot；同 chain 的代际推进更新同一 record 不新增 slot；普通运行不得自动删除 record；满载时新 not-executed resolution 在消费 capability 与释放 authority 前拒绝（原 authority 保持、不产生无 lineage replacement proof 的 final 终态）；不得通过驱逐旧 record 恢复容量。root/current/next-child 维护 O(1) 可验证索引：global reset 首次 load 允许一次有界全表验证和索引重建；正常 lookup O(1)；index 不是安全 proof、Memory record 是权威；index 与 record 不一致时 store unhealthy。root attempt ID 只要存在 lineage record 即永久视为 retired（tombstone 过期后 prepare 仍返回 retired_attempt/rearm_required 语义）。

#### Scenario: 满载 fail closed

- **WHEN** lineage store 已达硬容量且存在新的 final not-executed resolution
- **THEN** 在消费 capability 与释放 authority 之前拒绝（结构化 lineage 满载拒绝）；原 authority 保持；不写 lineage；不驱逐任何既有 record

#### Scenario: 同 chain 推进不新增 slot

- **WHEN** A not-executed → rearm B → B not-executed → rearm C
- **THEN** 三代同用一个 lineage record（entryCount 不变）；generation 单调递增；旧 ID A、B 都不能再直接重用

#### Scenario: 索引是定位器不是 proof

- **WHEN** 索引项指向的 Memory record 不存在或 identity 不一致
- **THEN** store unhealthy（fail closed）；恢复/签发/门禁路径零副作用；不以索引为准修复 record

## Requirement: 第十七轮——final not-executed 的 lineage replacement staged 协议与结果语义

resolve-as-not-executed 的安全顺序必须是：完整 prevalidate → lineage 容量与占用预检 → consume reconciliation capability → 写 final not-executed tombstone → 写 lineage candidate 并 read-back 验证 → 释放 intent/quarantine → identity-aware 清 marker → 标记 pending release 与 lineage publication 均完成。lineage 容量不足时 capability 不消费、tombstone 不写、authority 不释放；final tombstone 已写但 lineage 写失败时 authority 与 marker 保留、beginTick 能重试 lineage publication；lineage 写成功但 authority release 前中断时 beginTick 补完成 release；authority release 完成但 marker cleanup 前中断时 beginTick 补完成 marker 清理；只有 lineage、release、marker 三项均完成 parent 才进入 rearm-ready、pending 索引移除、tombstone 才具备普通 retention 驱逐资格。not-executed 结果不得向 production 暴露 rearmChildTransactionId 字符串——结果表达 same-ID 不可重试、retirement 是否完整、rearm 是否可申请、cleanup 是否 pending；真正的 child ID 只在成功签发 opaque rearm capability 时交付。

#### Scenario: lineage 写失败后恢复

- **WHEN** final tombstone 已写入而 lineage candidate 写入失败（注入）
- **THEN** authority 与 marker 保留；不签发 rearm capability；beginTick 重试 lineage publication 并最终补完成三段

#### Scenario: 结果不再携带 child 字符串

- **WHEN** resolve-as-not-executed 成功
- **THEN** 结果不含 rearmChildTransactionId 字符串字段；调用方只能经 issueTreasuryRearmCapability 获取 child ID

## Requirement: 第十七轮——service-issued opaque rearm capability

rearm capability 是不可伪造的 heap-only 能力对象：冻结、私有 WeakSet 验证对象身份、JSON 复制失效、单次使用、跨 tick/跨 service/跨 parent/跨 child/lineage revision 变化后失效。capability 绑定 lineage ID、lineage revision、parent attempt ID 与 identity、child attempt ID、attempt generation、retry semantic digest、action kind、adapter 语义身份、owner 或 lowlevelSource、service generation、tick、nonce。Production 公开接口只暴露 issueTreasuryRearmCapability → { capability, childTransactionId }；纯 derive helper 模块私有或 test-only（架构测试禁止 production 源码导入）。capability 未使用而 tick 结束/global reset → heap capability 失效但 durable lineage 保持 ready、新 service 重签发新 capability、child ID 一致；capability 已成功接管 child durable intent 后该 generation 不得重新签发；同 tick 重复 issuance 幂等返回同一 capability（不得产生两个可同时消费的 capability）。

#### Scenario: 防伪矩阵

- **WHEN** JSON round-trip 副本、手工构造普通对象、跨 service/跨 tick/已消费/绑定其它 parent 或 child 的 capability 进入验证
- **THEN** 全部拒绝（invalid/已消费/跨代等结构化 reason）；零 lineage mutation；零 callback

#### Scenario: global reset 后重签发

- **WHEN** capability 签发后未使用即发生 global reset
- **THEN** 新 service 重新 issue 得到新 capability 且 childTransactionId 与旧签发一致

## Requirement: 第十七轮——tr1_ 保留命名空间强制 capability 门禁

tr1_ 是 Treasury 保留的 rearm attempt 命名空间：任何 production transaction ID 以 tr1_ 开头都必须绑定匹配的 service-issued opaque rearm capability/binding——contract authorization、bundle redemption、prepare、durable intent publication、compat/lowlevel production 路径、receipt commit 全部检查。手工拼接 tr1_ ID、调用公开 hash helper 得到 child ID、无 capability 的 child contract、capability 属于另一 parent/另一 child/已消费/过期/与 contract retry 语义不匹配，全部拒绝且 bundle 零签发、authorization 预算零变化、intent 零创建、callback 零调用。initial attempt 不得使用 tr1_ 命名空间（继续使用 stable/per-tick 命名空间）。

#### Scenario: 手工构造 tr1_ 被拒

- **WHEN** 调用方手工拼接 tr1_deadbeef00000000 且无 capability 进入 prepare/authorization
- **THEN** 拒绝（rearm capability required/invalid）；callback 零调用

#### Scenario: 正确 capability + 正确 contract 放行

- **WHEN** capability 与 lineage、child ID、retry semantic digest 全部匹配
- **THEN** child contract 可进入 authorization 与执行协议

## Requirement: 第十七轮——retry semantic identity（child 必须是 parent 动作的语义重试）

retry semantic digest 是稳定、确定性、版本化的单一权威实现（retrySemanticIdentity.ts）：modern contract 版绑定 action kind、adapter version、adapter registration/稳定语义身份、canonical action args 业务语义、canonical postings、structure descriptors 与角色、durable reconciliation payload/version、source、owner identity；排除 parent/child transaction ID、tick、observation epoch、当前 commitment/projection revision、policy decision digest、authorization bundle ID（child 必须重新经过当前状态授权，但实际 Game 动作语义必须与 parent 一致）。lowlevel 版绑定 kind、source、canonical postings、受控 lowlevelSource、durable payload 或等价语义事实——旧 lowlevel proof 缺少受控 source 或 retry facts 时 non-rearmable、不签发 capability。child contract 构建后 Treasury 重新计算 digest 并与 capability 绑定值比较：资源、数量、room、source/target、action kind、adapter 语义、structure role/object、durable payload 语义任一变化拒绝；相同 Game 动作不同 child transaction ID digest 一致；policy revision 变化但当前 policy 重新授权通过允许（不复用旧 policy）；owner 变化默认拒绝。

#### Scenario: 语义漂移拒绝

- **WHEN** child contract 的资源/数量/room/target/action kind/adapter 语义/structure/durable payload 与 capability 绑定不一致
- **THEN** 拒绝（retry semantic mismatch）；capability 不消费；零 callback

#### Scenario: 排除事实不参与

- **WHEN** 相同 Game 动作语义、不同 child transaction ID、不同 tick/epoch/policy revision/bundle ID
- **THEN** retry semantic digest 一致；child 重新授权后可执行

## Requirement: 第十七轮——capability 与 authorization bundle / durable intent 原子接管

child contract authorization 验证 opaque rearm capability；bundle 私有 record 绑定 capability identity、lineage digest、child ID、retry semantic digest、parent identity。policy 与资源授权失败时 capability 不消费、lineage 保持 ready（同 tick 修正后重试或下 tick 重新签发）。Game callback 之前：child intent 已持久化且携带 lineage/rearm binding、lineage 已确认 child 为当前 active attempt、两者 read-back identity 一致；capability 消费早于 callback、晚于全部 contract/authorization/readiness 检查、与 child durable 接管原子或可恢复。任一写入失败 callback 零调用、不留下半 active child 或留下明确 staged 状态供 beginTick 恢复：child_intent_pending 且 intent 缺失或一致 not_started → 回滚 lineage ready 并释放 intent（capability 未消费或作废，可重签）；intent identity 不一致 → forensic 隔离。global reset 发生在 intent 与 lineage 接管之间时不产生第二个 child。一旦 Game callback 开始，lineage generation 不可重新签发 capability，child 后续由 intent/quarantine/receipt/resolution 接管。

#### Scenario: intent 写失败零 callback

- **WHEN** child durable intent 写入失败（注入）
- **THEN** callback 零调用；lineage 不进入 child-active 终态；可恢复（重签或回滚）

#### Scenario: 接管中断恢复

- **WHEN** intent 写入后、lineage 确认前发生 global reset
- **THEN** beginTick 对一致 not_started intent 回滚 lineage 至 ready 并释放 intent（或补完成一致接管）；不产生第二个 child

## Requirement: 第十七轮——lineage binding 进入全部 durable proof 链

lineage/rearm binding digest（lineageId + generation + parent/child ID 派生）必须进入 child contract、authorization bundle、durable intent、quarantine、authorization-fault、write-fault marker、receipt、resolution tombstone、reconciliation capability、committed proof verifier 与 attempt identity relation。tr1_ attempt 缺少 lineage binding → modern/lowlevel store unhealthy 或 forensic，不得自动解释成普通 attempt；不同 lineage、不同 generation 或不同 parent 的 proof 不能互相证明；parent proof 不能证明 child、child proof 不能证明 parent；同 child ID 但 lineage digest 不同 → identity conflict；initial 非 rearm attempt 不得携带 lineage binding。

#### Scenario: binding 继承一致

- **WHEN** child 经 intent 故障转 quarantine、resolution 写 tombstone、commit 写 receipt
- **THEN** 三者携带的 lineage binding digest 与 lineage record 一致；跨 lineage/generation 比较判 conflict

## Requirement: 第十七轮——rearm 前的 parent 相反 proof 与 child 占用检查

rearm capability 签发前完成完整 cross-store 检查（attemptOccupancy.ts 集中管理，各 store 单 key lookup）。parent 侧：lineage store 健康、retirement record 存在、not-executed proof 完整、authority 已释放、marker 已清理、pending cleanup 完成、receipt store 健康、不存在 committed receipt、不存在 committed final tombstone、不存在 resolving committed tombstone、无 identity 冲突、authority class 允许 rearm、lowlevelSource 完整、retry semantic facts 完整。同时存在 final not-executed + committed receipt / committed tombstone → proof_conflict（零 capability、零 lineage mutation、不删除任何 proof、write readiness fail closed 或 lineage 隔离）。child 侧：child ID 在 receipt、resolution tombstone、intent、quarantine、authorization-fault、write-fault marker、当前 prepared handle、当前 authorization bundle、其它 lineage 的 root/current/next 索引全部不存在才可签发；任一占用 → child_identity_occupied（不签发、不生成第二个 child）。任一相关 store unhealthy → 零 capability、零 lineage mutation、零 callback、明确诊断。

#### Scenario: parent 相反 proof 冲突

- **WHEN** parent 同时存在 final not-executed tombstone 与 committed receipt（或 committed/resolving tombstone）
- **THEN** proof_conflict；零 capability；不删除任何 proof；fail closed

#### Scenario: child 占用拒绝

- **WHEN** child ID 已存在于任一 store（receipt/tombstone/intent/quarantine/auth-fault/marker/prepared handle/bundle/其它 lineage）
- **THEN** child_identity_occupied；零签发；零 lineage mutation

## Requirement: 第十七轮——final tombstone retention 与 lineage replacement 联动

final not-executed tombstone 只有在 lineage replacement record 已持久化并验证、lineage 状态允许其承担永久 retirement 门禁、authority release 完成、marker cleanup 完成、pending-release 索引已完成、无 proof conflict 时才具备普通 retention 驱逐资格（驱逐资格检查只做 O(1) 索引查询，不扫描全部 lineage）。lineage publication pending、authority release pending、marker cleanup pending、proof conflict、store unhealthy、forensic/legacy isolation、lineage record 不完整、current child 接管尚未完成任一存在时 tombstone 永不普通驱逐（pin）。tombstone 驱逐后 parent root ID 仍由 lineage store 永久阻断、rearm 仍可从 lineage record 签发、child ID 保持确定性、parent proof 不被遗忘。Round 16 旧 tombstone backfill：identity 事实足够构建 rearmable lineage；只有 attempt proof 缺 retry 语义 → non-rearmable retired lineage（永久阻断 parent ID 重用、不签发 rearm capability）；partial identity 或矛盾 → pin 并 forensic 隔离；lineage 容量不足 → pin tombstone 不驱逐 fail closed。

#### Scenario: 无 replacement 不驱逐

- **WHEN** final not-executed tombstone 超过 retention 但无 lineage replacement（或任一 pending/cleanup 未完成）
- **THEN** tombstone 保持 pin 不驱逐；parent ID 永久不可直接执行

#### Scenario: 驱逐后仍可 rearm

- **WHEN** lineage replacement 完整且 tombstone 已按普通 retention 驱逐
- **THEN** rearm capability 仍可从 lineage record 签发；child ID 与驱逐前一致；parent ID prepare 仍被永久拒绝

## Requirement: 第十七轮——write-fault marker v2（class-aware attempt identity）

marker 持久语义升级：绑定 marker schema/version、transactionId、digest、authority/proof class、contract digest、cohort digest、durable identity digest、lowlevelSource、lineage/rearm binding digest、parent/child generation、fault phase、source/kind、recorded tick。marker 清除必须使用完整 class-aware attempt relation（markerAttemptIdentity.ts 集中管理）——不得只依赖 transactionId+digest 或缺少 lowlevelSource 的部分 identity；runtime-lowlevel marker 不得清 migrated-lowlevel tombstone、parent marker 不得清 child proof、不同 lineage marker 不得互相清除、modern marker 不得被 lowlevel/legacy proof 清除、legacy marker 不得自动清 modern attempt。immediate not-executed 路径必须检查 marker 清除结果：只有 marker 不存在或 matching marker 成功清除才标记 pending-release 完成、lineage 进入 rearm-ready、返回 rearm-capability 可申请；marker conflict/insufficient 时 tombstone 与 pending 索引保留、lineage 保持 cleanup-pending、返回结构化 resolved_pending_cleanup 状态、不签发 rearm capability。malformed marker 时 rearm 结构化拒绝不抛异常；marker 读取的嵌套 identity 无法修改 Memory。

#### Scenario: class-aware 清理矩阵

- **WHEN** 清除方与 marker 的 authority class、lowlevelSource、lineage binding、generation 任一不匹配
- **THEN** 清除失败（conflict/insufficient）；marker 保留；pending 索引保留；rearm 不可申请

## Requirement: 第十七轮——receipt proof class 显式三级（identity-bound / lowlevel / legacy）

receipt settlement proof 的 level 显式三级：identity-bound（拥有 modern contract attempt 需要的完整 identity，禁携带 lowlevelSource）；lowlevel（拥有 digest、durable identity、受控 lowlevelSource、可选 lineage binding；禁携带 modern contract/cohort 字段）；legacy（不携带现代身份，只能 replay blocker 与历史诊断，不得释放 modern/lowlevel authority、不得 rearm、不得证明 child attempt）。v6 迁移：modern 且无 lowlevelSource → identity-bound；modern 且有合法 lowlevelSource → lowlevel；legacy → legacy；字段矛盾 → fail closed 不猜测缺失 lowlevelSource。lookup、commit、refresh、finalized proof、committed verifier、migration、cleanup、metrics 全部更新；identity-bound proof 不能释放 lowlevel authority、lowlevel proof 不能释放 modern authority、runtime-lowlevel receipt 不能证明 migrated-lowlevel authority；所有合法 proof 仍作为 replay blocker。

#### Scenario: 迁移矩阵

- **WHEN** v6 receipt（modern 无 source / modern 有 runtime source / legacy）首次 load
- **THEN** 分别迁移为 identity-bound / lowlevel / legacy；矛盾组合 fail closed（原数据不动）

#### Scenario: 跨 class 不互相释放

- **WHEN** identity-bound proof 试图释放 lowlevel authority（或反之、或跨 runtime/migrated 来源）
- **THEN** 释放矩阵拒绝；authority 保持；零副作用


## Requirement: 第十八轮——lineage replacement publication-before-release 原子性

resolve-as-not-executed 在 lineage retirement candidate 持久化并 read-back 验证（与 authority/tombstone identity 完全匹配、索引同步一致）之前，不得释放 unresolved authority、不得清理 marker、不得移除 pending-release 索引。publication 写入/read-back/索引/identity 任一失败时：intent 与 quarantine 保留、marker 保留、pending-release 保留、不返回 retirement 完成语义（`lineage_publication_pending`），下一 beginTick 仍能从保留的 authority 重建完整 retry facts（不得退化为只能 non-rearmable backfill）。只有 publication/release/marker 三段全部 verified，才允许移除 pending-release 索引、授予 tombstone 驱逐资格、进入 rearm-ready。

#### Scenario: lineage candidate 写入失败时 authority 不释放

- **WHEN** resolve-as-not-executed 的 lineage candidate 持久化失败
- **THEN** intent/quarantine/marker/pending-release 索引全部保留
- **AND** 返回 lineage_publication_pending，不进入 rearm-ready
- **AND** 下一 beginTick 可从保留 authority 重试完整 publication

## Requirement: 第十八轮——child handoff 状态机与 reset 恢复

capability_issued 起 lineage 持久化完整 handoff facts（child ID、parent/current attempt ID、target generation、pendingBindingDigest、retry semantic digest、authority class、owner/lowlevel、expected current identity）。capability 消费必须验证 lineage 处于预期 handoff 状态且 recordRevision 等于 capability 允许的明确 revision（不得跳过全部 revision 检查）。tr1_ 接管顺序：capability 验证 → child_intent_pending → intent 写入（携带 lineage proof）→ read-back → consume → execution-started → child_active → callback。global reset 窗口恢复：capability_issued → rearm_ready（child ID 稳定）；handoff-pending + intent 缺失 → 回滚；+ 一致 ready intent → 释放并回滚（不 forensic）；+ binding/generation 冲突 → forensic；+ intent executing 或更后（或 quarantine 已接管且 proof 匹配）→ 前向补完成 child_active。callback 前任意失败：callback 调用数 0、回滚 rearm-ready 或保留明确 pending 供恢复、不产生第二 child、同 generation child ID 一致。

#### Scenario: consume 遇非预期 lineage revision

- **WHEN** capability 消费时 lineage recordRevision 不等于签发 revision+1 或 state 不是 child_intent_pending
- **THEN** 拒绝消费且 Game callback 零调用

## Requirement: 第十八轮——child 结果终态（non-OK / unknown / committed）

child 明确 non-OK 且 abort 确认：持久化当前 generation not-executed proof（lineage child_active→retiring→rearm-ready；final tombstone 携带 tr1_ lineage proof；清除上一代 next-child 事实；当前 generation retirement 独立重置），下一次 capability 以当前 child 为 parent 生成下一代（同一 lineage record）；publication 失败时 intent 事实保留、lineage 不丢失；abort 失败进入 quarantine，不得当 not-executed 完成。callback 抛错/结果未知：保留 authority 与完整 proof，后续 resolution 推进同一 generation。commit 成功：receipt 先行携带 lineage proof，lineage 进入 chain-committed；终态更新失败不忽略——intent 保留、返回 executed_unsettled、beginTick 按 matching receipt 补完成（receipt 与 generation 冲突时不补完成）；chain-committed 后不得再签发下一代 capability。

#### Scenario: A→B non-OK 后可继续 C

- **WHEN** B（tr1_ child）non-OK 且 abort 确认并完成 retirement
- **THEN** 以 B 为 parent 签发下一代 capability 得到新 child C（ID 不同）
- **AND** lineage 停留同一 record、active entryCount 不增长

## Requirement: 第十八轮——generation proof 进入统一 durable identity 与全部 store

tr1_（及未来版本 rearm ID）的 durable entry 必须携带完整 lineage proof（lineageId/generation/parentTransactionId/bindingDigest）；initial attempt 完全不携带；单侧缺失或不同 lineage/generation/parent/binding → conflict 或 insufficient（不得 match）。proof 传播至 action contract、authorization bundle、intent、quarantine、authorization-fault、write-fault marker、receipt、resolution tombstone、reconciliation capability、finalized proof、committed verifier、same-ID 幂等、intent→quarantine 转移与 child occupancy。tr1_ entry 缺 proof → store unhealthy 或 forensic；non-tr1_ 携带 → unhealthy。迁移：tr1_ 缺 proof 且可从 lineage 安全补全 → 原子补全并验证；不可证明 → forensic/store unhealthy；旧 receipt/tombstone proof 缺 generation → 只作旧 replay blocker，不得释放当前 rearm authority。

#### Scenario: tr1 intent 缺 binding → store unhealthy

- **WHEN** intent store 载入 tr1_ entry 缺任一 lineage proof 字段且无法从 lineage 补全
- **THEN** intent store unhealthy（fail closed），不得当普通 modern/lowlevel entry

## Requirement: 第十八轮——lineage 索引完整性、exact idempotence 与 transition 允许字段

lineageId/root/current/next 四索引全部 O(1) 且全局唯一：跨索引冲突（duplicate lineageId/current/next、record A current = record B root/next 等）→ 整个 store unhealthy，不得由 Map.set 静默覆盖、不自动删除任一 record；写入产生冲突时原 store 不变。publication read-back 比较全部安全关键字段（root/current identity、action kind、adapter stable identity、owner、generation、state、resolution、child ID、retry semantic、class/source、binding、retirement、revision、protocol version）。exact 重复写（revision 一致 + 完整一致）真正幂等；合法状态推进 revision 严格 +1；每条转换有允许变化集合，lineageId/root/root identity/authority class/lowlevel source/action kind/adapter stable identity/owner/retry semantic 协议/created tick 冻结；current identity/generation/binding 只在接管转换同时变化；updatedAt 不回退、generation 不回退；进入新 generation 时 retirement 按 generation 重置（上一代完成标志不得授权当前代驱逐）。

#### Scenario: exact 相同 record 写入幂等

- **WHEN** 以与现有 record 完整一致（含 recordRevision）的内容重复写入
- **THEN** 返回 idempotent 且 recordRevision 不增加

## Requirement: 第十八轮——per-generation tombstone replacement 与多代有界退休

tombstone 驱逐资格由该具体 attempt generation 的 replacement proof 决定，verdict ∈ {replacement_match, replacement_pending, replacement_conflict, replacement_missing, store_unhealthy}。rearm child ID 协议 v2 generation-addressable（`tr1_<lineageId16>_<generation6>_<checksum8>`，checksum 绑定 root；O(1) 解析与重算验证；旧 v1 tr1_ ID 继续门禁但不可寻址 → 相关 tombstone 永久 pin，不猜测 generation）。match：lineage/generation/transaction ID/attempt identity（当前代完整、历史代经 ID 协议+状态机链）/binding（按 (lineageId,generation) 重算）/proof class/resolution=not-executed/三段完成。pending/conflict/unhealthy/missing → pin（conflict 计数）。A→B→C 的 A/B tombstone 在 replacement 完成后可独立回收；旧 ID 仍不可直接执行；单 chain 多代重试不线性耗尽 Resolution store；active entryCount 不随 generation 增长。

#### Scenario: B replacement pending 时 B tombstone pin

- **WHEN** B 的 not-executed retirement 三段未全部完成且 B tombstone 超龄
- **THEN** B tombstone 被 pin 不驱逐，且上一代 A 的全 true retirement 不得授权 B 驱逐

## Requirement: 第十八轮——terminal lineage 压缩与退休摘要

chain_committed（无 intent/quarantine/marker/pending handoff/pending finalization）与 non_rearmable_retired（三段完成、无 pending authority/marker）可从 active store 压缩为 retirement summary（独立 store、独立硬容量）：summary 精确权威——永久阻止 root ID 重用（prepare 门禁含 summary 索引）、证明终态、绑定 root identity 与 lineageId、区分 committed/non-rearmable、O(1) 查询、不依赖普通 receipt/tombstone retention。summary 满载 fail closed：不删除旧 summary、不压缩 active record、新 chain 按容量门禁拒绝。压缩成功释放 active slot。forensic_isolated 不得自动压缩。

#### Scenario: 压缩后 root 仍永久拒绝

- **WHEN** chain committed 压缩后以 root ID prepare
- **THEN** 拒绝（retired），且 summary store 损坏时 prepare fail closed

## Requirement: 第十八轮——rearm preflight 完整 proof 与 store health

capability 签发前检查 lineage、retirement summary、receipt、resolution、intent、quarantine、authorization-fault、write-fault marker 全部 store 健康：任一 unhealthy → 零 capability、零 lineage mutation、零 callback。tombstone 存在时验证 tombstone ↔ lineage current generation retirement proof 完整匹配（attempt identity/proof class/lowlevel source/lineage/generation/binding）；tombstone 已合法驱逐时由 lineage generation proof 或 terminal summary 证明；相反 proof 继续阻断；child 占用检查区分 absent/occupied/store unhealthy（损坏 store 不当 absent）。

#### Scenario: resolution store 损坏时零 capability

- **WHEN** resolution store unhealthy 时申请 rearm capability
- **THEN** 拒绝且零 lineage mutation、零 callback

## Requirement: 第十八轮——稳定 adapter retry semantic（显式版本化 retry facts）

adapter 显式声明 `retryFacts(args)`：从 canonical frozen args 派生有界事实（shape validation、canonical encoding、大小上限、异常边界），与 durableFacts 职责分离，覆盖全部改变真实 Game API 调用语义的参数。retry digest v2 绑定 action kind/adapter version/stable semantic identity/retry semantic protocol/canonical retry facts/postings/structure/durable payload/source/owner，移除 per-global registration sequence/global 对象身份/函数源码字符串：注册顺序变化与 global reset 后相同 stable 语义与 retry facts 得到相同 digest。adapter 未实现 retryFacts → 动作正常执行、not-executed 后 non-rearmable；retry facts 抛错/超限 → non-rearmable 或 fail closed；改变一个真实 Game 参数 → digest 变化；policy revision 变化 → digest 不变但重新授权；durable payload 相同而 retry facts 不同 → digest 不同；retry semantic 版本变化 → 旧 capability 拒绝。

#### Scenario: 注册顺序变化 digest 稳定

- **WHEN** 同一 stable semantic identity 的 adapter 以不同注册顺序注册于两个 global
- **THEN** 相同 args 的 retry semantic digest 相同

## Requirement: 第十八轮——contract source 单一权威

source 在 contract build 时确定并进入 contract identity（digest）、retry semantic、durable intent、authorization context 与 reconciliation facts。authorization 阶段使用 contract source 重算（不得写死 action-contract）；execution request 的 source 必须与 contract source 完全相同（不同 → callback 前拒绝）；parent 与 child source 变化 → retry 拒绝。

#### Scenario: execution 试图覆盖 contract source

- **WHEN** execution request 携带与 contract 不同的 source
- **THEN** callback 前拒绝且 Game callback 零调用

## Requirement: 第十九轮——committed lineage resolution 全链 proof

unified unresolved authority 必须暴露并验证 lineage proof：tr1_ 必携带完整四字段、initial 禁止携带、双存在四字段完全一致（一侧有一侧无 inconsistent——不静默选择一侧）、单侧同样经持久事实验证。reconciliation capability 绑定完整 proof（签发透传 + prevalidation 强比较——capability 不得仅凭 transactionId/digest/普通 durable identity 证明 child generation）。resolve-as-committed 的 resolving/final tombstone、receipt refresh、三方 verifier（receipt↔tombstone↔authority 每组含 lineage 维度）、marker 清除、chain_committed 推进全部携带并比较完整 proof；chain_committed 只能由 matching receipt 的 binding/generation 与 record 一致推进。receipt refresh lineage-aware：match 保留既有 proof 只刷 tick（不降级 legacy）、absent 从 authority 写入完整 proof、tr1_ 缺 proof 的 refresh fail closed 不写 legacy、既有缺 proof receipt 仅 replay blocker。

#### Scenario: tr1_ committed resolution receipt 写入前 commit fault

- **WHEN** tr1_ child callback OK 但 receipt 发布前 commit fault（executed_unsettled + quarantine）
- **THEN** 显式 resolve-as-committed 后 receipt 从 authority 写入完整 lineage proof、final tombstone 同源、lineage chain_committed、无 generation 混用

#### Scenario: refresh 保留既有 proof

- **WHEN** tr1_ receipt 已带完整 proof 且与刷新 identity 完全匹配
- **THEN** refresh 只刷新 settledAtTick，四字段原样保留（不降级 legacy）

## Requirement: 第十九轮——handoff 双 authority 恢复

child_intent_pending 恢复始终检查 intent 与 quarantine 两个 store（不得"intent 存在就不读 quarantine"）。任一侧 proof 冲突 → forensic isolation（保留全部 authority）。rollback 仅当 intent 一致 not_started/ready 且无任何匹配或冲突 quarantine 且无其他 execution-started 持久信号；intent ready 与 quarantine 并存（转移中断窗口：quarantine 写成功、intent 删除前中断）→ forward_complete 绝不回滚。forward 的 child identity 从验证后的统一持久事实派生（quarantine proof 匹配优先）。

#### Scenario: intent ready + quarantine 并存

- **WHEN** child_intent_pending 窗口 intent 为 not_started/ready 且同 id quarantine 存在（proof 匹配）
- **THEN** 前向补完成 child_active，不回滚 rearm_ready

## Requirement: 第十九轮——retirement 三阶段分别证明

completeTreasuryLineageRetirement 不得无条件三段全 true：publication 只由 lineage candidate 持久化+read-back 证明（retire 转换内置）；authorityReleased 只由统一 resolver not_found（或等价受控 release 结果）证明；markerCleaned 只由 marker 不存在/不指向本 attempt/匹配 marker 成功清除证明——marker 指向本 attempt（匹配未清或 digest/binding 冲突或 class 不可证明）一律 cleanup pending。阶段置位只经单调 markStage helper；三段全 true 才允许完成（否则保持 retiring，不进 rearm_ready、无 eviction 资格）。运行时路径与 beginTick 恢复（含 child_active 防御路径）共用同一 converge 收敛函数；pending-release 索引移除与 retirement 完成共享阶段事实。

#### Scenario: marker 匹配未清时不完成

- **WHEN** retiring record 的当前代 marker 仍存在且指向本 attempt
- **THEN** converge 返回 cleanup pending、lineage 保持 retiring、tombstone replacement verdict 为 replacement_pending

## Requirement: 第十九轮——lineage 索引 same-record 判定与 duplicate 检测

same-record 判定必须使用 store entry identity（rootTransactionId），不得用 lineageId 相等：两个不同 root 携带相同 lineageId 是 duplicate 冲突而非同一 record。duplicate lineageId/current/next、root/current/next 跨 record 冲突、record 内组合矛盾在 load 全表校验与写入候选预检均 fail closed（原 store 与索引不变、不静默覆盖、不自动删除）。

#### Scenario: duplicate current

- **WHEN** store 中两条 record 的 currentTransactionId 相同（lineageId 各自合法）
- **THEN** load 判整个 store unhealthy，两条 entry 原样保留

## Requirement: 第十九轮——terminal summary 历史代证明与压缩资格

summary v2 携带 authorityClass（v1→v2 原子迁移：entry schemaVersion 一并提升、失败保留原数据 fail closed；迁移 summary 缺 class → 历史代 verdict 保守 pin，root 门禁不受影响）。active record 压缩前必须验证外部终态证明：chain_committed 需 matching committed receipt 的完整 lineage proof；non_rearmable_retired 需 matching final not-executed tombstone lineage proof + 三段完整；任一 authority/marker/intent/quarantine 残留不压缩。压缩后历史 child tombstone 凭自身完整 lineage proof 按 lineageId 定位 summary 并重演验证（v2 ID 派生+checksum 绑定 root、generation ≤ finalGeneration、binding 按 (lineageId, generation, parent, child) 重算、proof class、final 代 not-executed 只与 non_rearmable_retired 相容）；无 proof 旧 tombstone、future generation、错误 binding/class/lineageId → pin/conflict。summary 写入+read-back 先于删除 active record；满载 fail closed；root prepare 永久门禁压缩后继续有效。

#### Scenario: 压缩后历史代回收

- **WHEN** A→B→C chain（A root not-executed、B gen1 not-executed、C gen2 committed）压缩为 summary 后 B 的 final not-executed tombstone 到期
- **THEN** verdict 按 summary 重演验证返回 replacement_match，B tombstone 可回收、root ID 仍永久阻断

## Requirement: 第十九轮——receipt health 版本认可与迁移一致

轻量 health probe 认可 loader 实际支持原子迁移的全部版本（receipt v6/v7、resolution v6——migration pending 而非 unknown fatal），peek 仍零迁移零写；真正 load 执行现有原子迁移（临时结构验证 → 一次替换 → 失败保留原数据 fail closed）；tr1_ 旧 receipt 缺 proof 迁移后仍为 replay blocker。

#### Scenario: v6/v7 raw store peek

- **WHEN** 部署环境 receipt store 仍为 v6/v7 且未 load
- **THEN** 轻量 health 报 healthy（migration pending），Memory 原样；load 后原子迁移 v8


## Requirement: 第二十轮——semantic lineage validation 单一权威

lineage proof 的结构相等（shape proof）与语义真实（semantic proof）是两层独立验证：shape 由 lineageProof 矩阵承载；semantic 由 semanticLineageValidation 单一权威承载（版本化、无副作用、装配注入只读 source）。tr1_ attempt 必须通过 semantic validation：child ID 内嵌 lineageId/generation 与 proof 一致、parent 为确定性上一代 attempt（gen1 parent=root）、binding 由权威算法重算匹配、active lineage 存在时与 record 状态/current/next/history 语义/authority class/lowlevelSource/retry semantic 相容、active lineage 不存在时由 terminal summary + exact retirement authority 证明。verdict 至少区分 match/conflict/insufficient(legacy isolated)/store_unhealthy/no_authority，消费方不得折叠。store unhealthy 时 validator fail closed 不返回 match；legacy 不可解析 ID 与无法语义验证的旧 proof 一律 legacy isolated/replay blocker（不猜测、不自动升级）。

#### Scenario: 四字段一致但共同错误

- **WHEN** Intent 与 Quarantine 的 lineage 四字段完全相同但与 child ID 内嵌 (lineageId, generation) 派生不一致
- **THEN** semantic validator 返回 conflict（一致复制的错误事实不是证明），resolver 判 inconsistent

## Requirement: 第二十轮——handoff 复用 unified exact authority 且判定前保留证据

beginTick 中 lineage handoff 双 authority 一致性判定先于普通 Intent recovery/cleanup 执行（或等价 pin 机制），Intent 与 Quarantine 并存时二者完整一致性的判定先于任一侧删除。handoff 恢复直接复用 unified resolver 的完整一致性（identity 重算、authority level、proof class、lowlevelSource、canonical digest、contract/cohort/durable identity、postings/kind、lineage semantic proof、execution-fact cohesion、settlement/phase），不得只调用 lineage proof matcher。rollback 仅当 resolver 证明只有 Intent、完整 identity 与 handoff facts 匹配、outcome=not_started、settlement=ready、无 Quarantine/marker/receipt/resolution 等 execution-started 事实；forward 的 child identity 从统一 resolver 结果构造。

#### Scenario: 双 authority 判定前 Intent 不被删除

- **WHEN** child_intent_pending 窗口的 ready Intent 与匹配 Quarantine 并存且 beginTick 执行
- **THEN** 通用 Intent recovery 不先删除该 Intent，handoff 完整判定后 forward_complete

## Requirement: 第二十轮——exact attempt identity 单一构造

安全关键路径（receipt 幂等、prepared commit 预检、finalized intent proof 链、resolution 补完成、authorization-fault 幂等、rearm parent identity、committed 三方 verifier 输入）的 attempt identity 视图由 exactAttemptIdentity 单一构造实现生成（transactionId + digest + contract/cohort/durable identity + lowlevelSource + proof class + lineage 四字段），调用点不得手工展开部分字段。一方为 rearm 一方缺 lineage → conflict/insufficient；不同 generation/parent/binding → conflict。既有 tr1_ Receipt 在 global reset 后重入 commit 时按完整 exact identity 幂等识别（already_settled_match），不得误判 conflict/insufficient。

#### Scenario: matching tr1_ receipt 重入

- **WHEN** tr1_ child receipt 已写入后 global reset，prepared/commit 路径再次读取同一 receipt
- **THEN** exact identity match 返回 already_settled_match（或安全 finalization），不进入永久 fault

## Requirement: 第二十轮——receipt 写入边界强制语义 proof

commitSettledReceipt 对 tr1_ 新写入强制完整 lineage proof + semantic lineage validation = match + active/terminal authority 状态允许 commit；否则零写入并返回明确 fatal/blocked 结果。initial attempt 携带 lineage proof 拒绝零写。refresh 保留 matching proof 仅刷新 tick；旧 rearm proof 缺 exact semantic authority 为 replay blocker 不自动补全；conflict 不覆盖。validator 未装配时 tr1_ production 写入 fail closed。

#### Scenario: tr1_ 新 commit 缺 proof

- **WHEN** tr1_ commit 不携带完整 lineage proof 或 binding 重算不匹配
- **THEN** 零写入、返回 fatal，调用方进入安全 fault 处理

## Requirement: 第二十轮——exact per-generation retirement authority

每个 final not-executed generation 在 retirement 三段全部完成后、状态推进前形成可独立验证的 exact retirement proof（transactionId/generation/parent/binding/完整 attempt identity/authority class/resolution=not-executed/三段完成），持久化并 read-back 后才允许推进；Generation N+1 capability 只有 N 的 exact proof 持久化后才能签发。proof store 有硬容量、满载 fail closed、lookup O(1)、不保存无界数组；回收只发生在依赖（tombstone/active record）消失后。historical generation 的 replacement/eviction 必须命中 exact proof 并完整比较（transactionId/parent/binding/proof class/identity 维度），不得因 generation < currentGeneration 或状态机曾推进而 match；旧数据缺 proof → pin。

#### Scenario: 下一代 capability 门禁

- **WHEN** Generation N retirement 的 exact proof 写入 read-back 失败或缺失
- **THEN** 不签发 Generation N+1 capability，lineage 保持可恢复状态

## Requirement: 第二十轮——terminal compaction 与 tombstone replacement 的 exact 身份验证

terminal compaction 验证完整 settlement identity（receipt/tombstone ↔ active lineage current exact identity：digest/contract/cohort/durable/lowlevelSource/proof class/lineage 四字段 + semantic validation）；non-rearmable 叠加三段与当前代 exact proof。压缩前检查全部相关 store 健康；summary 写入 read-back 先于 active 删除；满载 fail closed。root tombstone replacement 重算 rootIdentityDigest 与 summary 比较（不只凭 root ID 命中）；child tombstone 验证 ID 解析/lineage/generation/expected parent/持久 parent/binding 重算/proof class/lowlevelSource/完整 attempt identity/exact generation retirement authority；summary finalGeneration 只是边界不是 membership proof。

#### Scenario: 同 digest 不同 contract 不压缩

- **WHEN** chain_committed receipt 与 active lineage current 的 digest 与 lineage 四字段相同但 contractDigest 不同
- **THEN** 不压缩，active record 保留

## Requirement: 第二十轮——committed resolution 语义闭环与架构收敛

tr1_ 的 resolver 归一化、capability 签发/prevalidation、resolving/final tombstone 写入、三方 verifier 调用方、authority not_found 的补完成 finalize、chain_committed 推进全部叠加 semantic lineage validation；chain_committed 写入结果不被忽略（失败保持可恢复 pending）。production 源码不再散落 raw startsWith("tr1_")（namespace 权威内部除外）；安全关键调用点不再手工构造不完整 attempt identity（架构扫描保护）；production 模块不导入 child ID test helper；所有拒绝路径 Game callback 调用数为 0；本轮不接入真实 writer。

#### Scenario: 三方一致但 semantic 错误

- **WHEN** Receipt/Tombstone/Authority 的 lineage 四字段互相一致但与 child ID 派生/binding 重算冲突
- **THEN** verifier 调用方拒绝 finalize，authority 保留
