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
