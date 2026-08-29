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

transaction 必须（MUST）由一或多腿 posting 原子表达：全部 posting 整体验证通过后一次性写入 journal/overlay/receipt；任一 posting 非法时整笔回滚，不得（MUST NOT）出现部分写入。posting 的 delta 必须（MUST）为非零有限整数；resource 必须（MUST）合法；交易后资源量与容量不得（MUST NOT）越界（负量拒绝、超物理容量拒绝，含同 tick 多笔累计口径）。

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

### Requirement: 幂等 receipt 最小持久化

国库必须（MUST）将 transaction 幂等 receipt 持久化到 Memory（仅 transactionId → 结算 tick 的最小映射），使跨 tick 与 global reset 后的重放仍被拒绝。receipt 必须（MUST）有明确 retention 窗口、容量上限与清理规则；清理不得（MUST NOT）让仍可能重放的当前 tick receipt 被驱逐；不得（MUST NOT）持久化 overlay、observation、journal 或任何物理事实副本。

#### Scenario: global reset 后重放被拒

- **WHEN** 服务实例因 global reset 重建（heap 缓存丢失、Memory 保留）后重放已结算 transaction
- **THEN** 凭 Memory receipt 拒绝重放（already_settled），不产生重复投影

#### Scenario: receipt 按规则回收

- **WHEN** receipt 结算 tick 早于 now−retention 窗口，或总量超过容量上限
- **THEN** 按最老优先回收；驱逐遇到当前 tick 的 receipt 立即停止并计数（blocked）

### Requirement: 带上下文的余额查询

国库不得（MUST NOT）提供无上下文的可用量入口。任何可用量查询必须（MUST）声明资源、房间范围、位置范围、是否含投影、是否计入 incoming、是否扣除 outgoing/reservation 以及策略保留量。spendable 必须（MUST）非负；当物理-承诺-保留之差为负时必须（MUST）显式置位 overcommitted 而非静默钳制。stale observation 不得（MUST NOT）用于即时授权。

查询必须（MUST）支持 owner 声明（holderId + scope）：合法 owner 查询时排除自己持有的 production reservation、其他 owner 照常扣除；owner 不存在或格式非法时必须（MUST）fail closed（spendable=0、overcommitted=true），不得（MUST NOT）返回乐观可用量。projected capacity 必须（MUST）与 observed capacity 分离暴露，且随 posting 推进（流入增 used 减 free、流出反向、多资源聚合）。

#### Scenario: spendable 非负且超卖可见

- **WHEN** 某资源 committed+withhold 超过 projected 物理量
- **THEN** spendable 返回 0 且 overcommitted=true

#### Scenario: owner 查询排除自身预留

- **WHEN** 合法 owner 声明查询且自己持有同房间/资源的 production reservation
- **THEN** committed 只扣除其他 owner 的预留；其他 owner 的预留照常扣除

#### Scenario: owner 非法 fail closed

- **WHEN** owner 声明 holderId 为空或 scope 未知
- **THEN** spendable=0 且 overcommitted=true（observed 物理事实仍如实返回）

#### Scenario: projected capacity 与 observed 分离

- **WHEN** 本 tick 已结算流入 posting
- **THEN** projectedUsedCapacity 上升、projectedFreeCapacity 下降（多资源聚合），observation 的 used/free 保持不变

### Requirement: 承诺统一索引零隐藏写入与点时快照

国库必须（MUST）在每 tick 从既有持久权威（transfer tasks、production reservations）构建统一只读承诺视图，覆盖 outgoing/pendingOutgoing/incoming/pendingIncoming、receiver headroom（observed 与 projected 双轨）与 route merge lookup，且不得（MUST NOT）复制出第二套持久化任务数据。过期承诺必须（MUST）在读侧排除并计数；holder 已不存在的 reservation 必须（MUST）计为孤儿；原始记录的删除权必须（MUST）保留在其 owner。查询函数不得（MUST NOT）产生任何 Memory/Game 写入。

索引必须（MUST）是点时快照：构建期聚合为 primitive 值，不保留可被外部原地修改的 task/reservation 对象引用；receiver 维度构建期预聚合（查询不回扫 live task store）；route merge 查询基于预构建索引。权威数据 mutation 后，下一次承诺查询必须（MUST）看到新状态（统一 revision 失效机制，架构测试守护全部 mutation 入口）。

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

- **WHEN** 权威 mutation（reserve/cancel/progress/GC 等）发生后再次访问承诺索引
- **THEN** 索引按新 revision 重建并反映新状态，查询自身仍零写

### Requirement: 跨 tick 对账不静默

国库必须（MUST）在构建新 tick 观察时，将上一 tick 的投影终态与本 tick 观察按 key 并集对账（previous finals ∪ current observed）。任何非零差异必须（MUST）计入 reconciliation 计数并保留有限差异样本，不得（MUST NOT）静默丢弃。对账必须（MUST）显式分类：外部流入/流出、新资源/新位置/新房间首次出现、房间丢失/位置丢失、structureId 替换（incarnation 变化，金额一致也须记录）、tick gap（差异为 gap 累积值）与 global reset 恢复（无严格对账基准时显式标记）。mismatch 样本必须（MUST）可追溯至相关 transaction（id/kind）。

#### Scenario: 投影与现实的差异被记录

- **WHEN** 上一 tick 投影终态与本 tick 观察在某位置/资源上存在非零差异
- **THEN** reconciliation 计数递增且样本进入有界缓冲，样本携带相关 transaction id

#### Scenario: 新增资产被对账发现

- **WHEN** 本 tick 出现上一 tick 不存在的资源/位置/房间，或 storage/terminal 被新建、摧毁、structureId 替换
- **THEN** 对账产出对应分类（new_resource/new_location/new_room/location_lost/room_lost/structure_replaced），不静默

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

国库必须（MUST）支持独立 fresh observation scope（如 market-fresh）。fresh 构建不得（MUST NOT）污染或替换 shared observation 缓存，也不得（MUST NOT）复用共享 snapshot 供需要新鲜读取的安全路径使用。

#### Scenario: fresh 构建不影响 shared 缓存

- **WHEN** 调用 beginFreshObservation 构建 market-fresh 观察
- **THEN** shared observation 引用与内容不变，后续 shared 访问仍复用原缓存

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
