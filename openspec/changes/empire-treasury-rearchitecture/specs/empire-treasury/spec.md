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

国库必须（MUST）区分 Observed（观察到的物理资产）、Projected（Observed + 本 tick 已被 Game 接受的动作增量）与 Committed（已被任务/预留/合同占用但未执行）。计划、reservation 与 pending task 不得（MUST NOT）修改 Observed。只有调用方在 Game API 返回成功后显式登记的已接受动作才产生投影增量，且每个增量必须（MUST）携带幂等 actionId 与可追踪 source。

#### Scenario: 投影不回写观察

- **WHEN** 登记一个已接受动作产生投影增量
- **THEN** observation 的原始数值保持不变，projected 查询返回 observed+delta

#### Scenario: 失败动作不产生投影

- **WHEN** 执行器未调用登记接口（例如 Game API 返回非 OK）
- **THEN** 不存在任何投影增量

#### Scenario: 幂等结算

- **WHEN** 同一 actionId 被第二次登记（无论同 tick 或后续 tick）
- **THEN** 第二次登记被拒绝且不叠加增量，并记录 duplicateRejected

#### Scenario: stale epoch 拒绝写入

- **WHEN** 在 observation epoch 的 observedAtTick 不等于当前 tick 时登记动作
- **THEN** 登记被拒绝（stale_epoch），不得产生投影

### Requirement: 带上下文的余额查询

国库不得（MUST NOT）提供无上下文的可用量入口。任何可用量查询必须（MUST）声明资源、房间范围、位置范围、是否含投影、是否计入 incoming、是否扣除 outgoing/reservation 以及策略保留量。spendable 必须（MUST）非负；当物理-承诺-保留之差为负时必须（MUST）显式置位 overcommitted 而非静默钳制。stale observation 不得（MUST NOT）用于即时授权。

#### Scenario: spendable 非负且超卖可见

- **WHEN** 某资源 committed+withhold 超过 projected 物理量
- **THEN** spendable 返回 0 且 overcommitted=true

#### Scenario: stale epoch 不可支配

- **WHEN** 查询使用的 epoch observedAtTick 落后于当前 tick
- **THEN** 即时授权语义拒绝该数据源

### Requirement: 承诺统一索引零隐藏写入

国库必须（MUST）在每 tick 从既有持久权威（transfer tasks、production reservations）构建统一只读承诺视图，覆盖 outgoing/pendingOutgoing/incoming/pendingIncoming、receiver headroom 与 route merge lookup，且不得（MUST NOT）复制出第二套持久化任务数据。过期承诺必须（MUST）在读侧排除并计数；holder 已不存在的 reservation 必须（MUST）计为孤儿；原始记录的删除权必须（MUST）保留在其 owner。查询函数不得（MUST NOT）产生任何 Memory/Game 写入。

#### Scenario: 过期预留被排除但不被删除

- **WHEN** production reservation 的 expiresAt 早于当前 tick
- **THEN** 承诺聚合不计入该条目、expiredExcluded 递增，且 Memory 原始记录仍存在

#### Scenario: 查询无副作用

- **WHEN** 调用任一承诺/余额查询
- **THEN** Memory 与任务表内容保持不变

### Requirement: 跨 tick 对账不静默

国库必须（MUST）在构建新 tick 观察时，将上一 tick 的投影终态与本 tick 观察对账。任何非零差异必须（MUST）计入 reconciliation 计数（按流入/流出分桶）并保留有限差异样本，不得（MUST NOT）静默丢弃。

#### Scenario: 投影与现实的差异被记录

- **WHEN** 上一 tick 投影终态与本 tick 观察在某位置/资源上存在非零差异
- **THEN** reconciliation 计数递增且样本进入有界缓冲

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
