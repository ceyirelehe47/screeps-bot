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
