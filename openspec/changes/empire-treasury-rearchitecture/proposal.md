# 帝国国库重构（Empire Treasury Rearchitecture）

## Why

当前帝国资源事实分散在 `ResourceControlSnapshot`、`resourceControl.ts`、`empireInventoryIndex.ts`、Hub 自建聚合、production reservation、transfer task、receiver capacity ledger、synthesis/factory 库存计算、market sellable projection 与 telemetry 拼接层中，存在四类结构性问题：

1. **物理事实与策略混合**：`ResourceControlSnapshot` 同时持有物理库存、策略底线（floor/reserve）、Game 活对象引用与同 tick 可变投影；任何消费者拿到的都是四层语义的混合体。
2. **口径不统一**：storage/terminal/lab/carrier/incoming 在不同模块各自聚合，`ResourceControlSnapshot` 默认 `rooms × RESOURCES_ALL` 全量探测 terminal，nuker/synthesis 兼容规划每 tick 最多重复采集 4 次快照。
3. **承诺重复风险**：production reservation、transfer task、receiver capacity、market protection 各自维护承诺扣除，owner 感知的子分配语义只在 `ReceiverCapacityLedger` 局部成立。
4. **投影无审计**：`setTerminalResourceAmount` 等投影直接覆写快照值，无 journal、无幂等结算、无下一 tick 对账。

`empireInventoryIndex`（影子阶段 Phase 1-3，1443 tick 零 mismatch）与 `empireInventoryShadow` 证明只读三层索引 + 稀疏 Store 枚举 + oracle 校验在 live 可行，但它只是观察层原型，不承载承诺、预算、投影与对账。本变更把它升级为完整的帝国国库（Empire Treasury）。

## What Changes

- 新建 `src/runtime/treasury/` 模块族，作为帝国资源事实、承诺、预算授权、合同、同 tick 投影与跨 tick 对账的统一入口：
  - **Asset Observation**：storage/terminal 的不可变稀疏物理观察（冻结数据、无 Game 引用、observation tick/epoch 标识、多方向查询索引），复用 TickContext 房间快照与结构事实，每受管辖 Store 只 `Object.keys` 一次，不做 `RESOURCES_ALL` 全量探测，不 `room.find`。
  - **Transaction Journal + Projected Overlay**：只有显式报告“Game API 已接受”的动作才能写入 journal 并叠加投影；幂等 actionId，同一动作跨 tick 只结算一次；Observed 永不被投影修改。
  - **Reconciler**：tick 开始时将上一 tick 投影终态与本 tick Observed 对账，差异计数并保留有限样本，不静默吞掉。
  - **Commitment 统一索引**：每 tick 从既有持久权威（`Memory.data.resourceControl.tasks`、`Memory.runtime.resourceReservations`）构建只读承诺视图（reserved/incoming/outgoing/receiver headroom/route merge/owner-aware），不复制第二套持久化任务数据，读侧排除过期与孤儿条目但不删除原始记录（查询零隐藏写入）。
  - **Treasury Gateway/Facade**：所有带上下文的余额查询（observed/projected/committed/spendable/incoming/outgoing/transferable）必须经由 facade；不提供无上下文的 `getAvailable(resource)`；spendable 非负且超卖显式置位。
  - **独立 fresh observation scope**：架构上支持 `market-fresh` 等独立 epoch，不复用共享 snapshot，为市场安全路径未来接入预留。
- Treasury 挂载进 `RuntimeServices`（服务实例内持有全部状态，无新增 global 槽、无新增 Memory 声明字段；性能指标低频快照至 `Memory.runtime.treasuryPerf`，沿用 `inventoryPerf` 的未类型化断言先例）。
- 新增新旧 **Treasury Shadow**（零行为写入）：低频对比 Treasury observation 与旧 empireInventoryIndex core 视图 + 独立直读通道，覆盖每房间 storage/terminal 资源、帝国总量、capacity、缺失位置、stale epoch 与承诺重复计数检查。
- 迁移第一个低风险消费者：`productionMonitor` 的 storage/terminal energy 读取改走 Treasury observation。
- 本阶段**不**切换市场安全写路径（fresh floor、双读隔离、CAS、WAL、permit、claim/deal 顺序、protection read 全部保持原样），**不**删除旧 logistics/production/market 代码，**不**改变现有生产行为输出。

## Round 6 — Fault Recovery & Authority Integrity（第六轮范围补充）

第五轮交付的两阶段 write admission 协议仍存在故障恢复与权威一致性漏洞，第六轮在既有实现上修复（不推翻第五轮成果、不接入真实 Game writer、不部署）：

1. **typed owner 持久 key 碰撞**：reservation store key 仍只编码 `owner.id`——相同 id 不同 kind/namespace 的 owner 互相覆盖。重设计 store key 编码完整 typed identity（kind + namespace + id），并做版本化原子迁移（先完整验证再写入、collision/malformed 终止、失败不部分覆盖不推进版本且授权 fail closed、成功后原子推进版本 + bump revision、幂等）。
2. **executing/faulted transaction 的资源被错误释放**：endTick 审计后统一 `tentativeReleaseAll`，把 Game 结果未知（executing）与 commit 故障（faulted）的预留一并释放。建立跨 tick durable quarantine（Memory.runtime.treasury.quarantine）：这些 transaction 持久占用资源、容量与 transaction identity，计入授权计算，未解决前不得再 prepare/执行；普通未执行 prepared 仍在 tick 边界正常释放。
3. **safe execute 结果语义混淆**：Game callback 成功后 commit fault 仍返回 `prepare_rejected`（暗示未执行，诱导自动重试）。结果集重定义——`executed_unsettled`（Game 已执行、Treasury 未完成提交、禁止自动重试、保留原始 Game 结果与 fault identity）、`executed_abort_failed`（Game 非 OK 且 abort 未确认）等不可混淆状态。
4. **无条件 clear fault**：`clearTreasuryWriteFaultForRepair` 只删 marker，无法证明 Game 动作是否发生。移除该入口，改为显式 fault resolution 协议（resolve-as-committed / resolve-as-not-executed，参数校验 + 幂等 + 锁持续至解决 + 生产 tick 不可自动调用）。
5. **receipt corruption 被解释为 already_settled**：`commitSettledReceipt` 的 `lookupSettled` 把 corrupted 与已结算同归 `already_settled`。corrupted 一律 fatal fail closed（不发布 committed heap projection、prepare 前 callback 零调用、Game OK 后进 durable fault/quarantine）。
6. **prepared handle registry 无界强引用**：`preparedByHandle` Map 终身保留全部 handle（含 canonical payload/observation）。改为 WeakMap 全生命周期记录 + 有界 active strong registry（终态即删、tick 边界 stub 化丢大引用）。
7. **malformed runtime input 中断 tick**：canonicalization 前无形状校验，null input/postings 非数组/decision 缺失等直接 throw。公开 writer 入口前置结构化形状验证（结构化 rejection、零 tentative/零 receipt 槽/零 registry 污染、callback 零调用）。
8. **commitment completeness 静默跳过**：未知 status（"pendng"）被当普通非 pending 跳过、聚合溢出不检查、receiver 房间 completeness 判定因分隔符 bug 恒真。补严：status/blockedReason 枚举、聚合安全整数、无法定位 scope 的损坏全局 incomplete、authorizationSafe fail closed。
9. **authorizationSafe 语义过弱**：只看 commitment completeness。重定义为多条件联合（commitment complete + receipt healthy + 无 write fault + 无 unresolved quarantine + lifecycle open + service/tick 合法 + 持久 migration 完成），数值保留供观察但授权信号 fail closed，diagnostics 指出主要阻断原因。

## Round 7 — Quarantine Closure & Schema Activation（第七轮范围补充）

第六轮交付的 quarantine/fault-resolution/reservation schema 仍存在最后一批权威漏洞，第七轮在既有基础上修复（不重写前六轮基础、不接入任何真实 Game writer、不部署）：

1. **unresolved quarantine 可被绕过**：prepare 只检查同 transactionId 的 quarantine 与 write-fault marker——存在其它 unresolved quarantine 时新 transaction 仍可 prepare。改为全局 write blocker：任意 unresolved quarantine / quarantine store overflow 或 corruption 期间，一切新 prepare 在 Game callback 之前拒绝（已结算幂等查询与同 id 的 transaction_quarantined 精确拒绝保留）；write-fault marker 不再是唯一锁来源。
2. **quarantine 溢出丢失 transaction identity**：条目达到 64 上限后只置 overflowed 不保存 entry。改为 prepare 时的 fault-slot 预留——持久 quarantine 数 + active prepared 数达上限即在 admission 拒绝（第 65 条 fault 在 prepare 前被阻止）；commit/确认 abort 释放 slot；fault 将预留 slot 原子转换为持久 entry；legacy overflowed 标志 fail closed 且只有显式 repair 可清除。
3. **quarantine 无版本与健康契约**：直接信任任意 Memory 形状。升级为版本化持久权威（version/entryCount 元数据、key 编码与 transactionId 一致、phase/locationKind/resource/delta 全枚举与安全整数校验、聚合防溢出、单一 canonical deltas 事实并由其派生容量占用）；global reset 后首次 load 全量验证 + heap health cache；损坏 fail closed（原数据不动、新 prepare 全部阻断、resolution 拒绝、有界诊断）；write-fault marker 同样严格 shape validation。
4. **quarantine 容量方向错误**：正容量 delta（可能已流入）未占用 free capacity、负 delta 被乐观计入。修正为保守口径：正净流入减少 free capacity（receiver headroom 同口径），负流出不增加 free capacity；正资源 delta 不乐观计入 spendable、负流出继续计入 committed。
5. **fault resolution 证据不足**：只凭 transactionId/digest/phase 即可解决，且可与仍存活的 active faulted handle 冲突、receipt retention 从旧 action tick 起算。重做协议：resolution 前 active handle 检查 + 当前 tick > 故障 tick + 故障后 shared observation 已建立；显式 reconciliation evidence（conclusion/observationTick/source，与 digest 匹配）；phase 拆分（action_returned_non_ok_abort_failed / action_threw_execution_unknown / executing_at_end_tick / commit 类）且 not-executed 只允许 execution-unknown 类配合 observed_not_executed 证据；resolve-as-committed 的 receipt 使用 resolution tick（完整 retention 窗口）而原 action tick 保留在 resolution tombstone（有界、幂等 already_resolved、retention 后惰性清理）。
6. **callback 抛错被当作未执行**：当前先尝试普通 abort。改为 execution unknown 默认——不 abort、立即 faulted + write-fault marker（含有界异常诊断）+ durable quarantine + write admission 锁定后 rethrow；同 transaction 再执行 callback 零调用；只有 callback 正常返回明确非 OK 才走普通 abort（其 abort 失败也立即隔离，phase=action_returned_non_ok_abort_failed）。
7. **reservation schema 激活顺序漏洞**：typed mutation 可直接写新 key 而 migration 只在 17 tick memory cleanup 执行——可能形成混合版本 store。建立 schema activation gate：空 store 原子初始化当前版本；legacy store 必须迁移成功后才允许 mutation（失败返回结构化拒绝、原数据不动、授权 fail closed）；gate 挂到 beginTick bootstrap 且每个 mutation 入口自检，memoryCleanup 保留为幂等兜底而非唯一路径；schema 版本升级到 v4（canonical owner token 重编码）。
8. **owner token 仍有字段边界歧义**：`ls:<ns>:<id>` 依赖 namespace 无冒号的隐含约定。重做为真正 canonical 的长度前缀编码（`ow2:<kindCode>:<nsLen>:<namespace><id>`——token 相等当且仅当 tuple 相等，Unicode/冒号/空格/空串无歧义、长度有界、跨 tick 稳定）；identity 字段明确（kind+namespace+id；roomName 由 store key 外层表达、lifecycleRef 只是 metadata，均不参与身份）；kind-specific validation 收紧（logical-service 的 namespace 必填、非 logical-service 禁止 namespace）；migration v1/v2/v3→v4 以验证过的 entry.owner 为权威重建全部 key。
9. **reservation mutation 权威不足**：静默 void 返回、非法输入零报告、list 返回 Memory live 引用、GC 删除损坏 entry 后恢复乐观授权。全部 mutation 改结构化结果（room/resource/amount/ttl/expiresAt 溢出/owner/schema gate/store 健康全验证；非法与 migration 失败零写入；只有实际 mutation 才 bump revision 且不重复 bump）；listProductionReservations 返回冻结深拷贝快照；GC 发现损坏 entry 不删除、置持久 corrupted 标志（显式 repair 才可清除）并使授权 fail closed。
10. **余额完整与写入就绪不分**：authorizationSafe 为 true 时 receipt 可能已满或 quarantine slot 耗尽。新增独立 write admission readiness 视图（writeAdmission.ready/blockers）：context/commitment/migration/receipt health+slot/quarantine health+slot/unresolved quarantine/write fault/lifecycle/tick 全条件；prepare 独立复查不信任调用方读过 readiness。

## Capabilities

### New Capabilities

- `empire-treasury`: 帝国国库的物理观察不可变性、三层余额语义（Observed/Projected/Committed）、带上下文查询、journal 幂等结算、对账不静默、承诺统一索引与零隐藏写入不变量；第六轮起含故障恢复（durable quarantine、显式 fault resolution、fail-closed corruption 处理）与权威完整性（typed owner 持久身份、bounded handle 生命周期、runtime input 验证、多条件 authorizationSafe）；第七轮起含 quarantine 闭环（全局 write blocker、fault-slot 预留、版本化健康契约、保守容量方向）、post-observation fault resolution 证据协议、callback-throw execution-unknown 状态机、reservation schema activation gate 与 canonical owner identity v4、结构化 reservation mutation 与独立 write admission readiness。

### Modified Capabilities

（本阶段无——消费者迁移仅 `productionMonitor` 只读路径，等价替换；后续阶段迁移 hubProgress/hubPlanner/synthesis/factory/market 时再修改对应 capability。）

## Impact

- 新增 `src/runtime/treasury/`（types/observation/projection/commitments/facade/shadow + 测试）；修改 `src/runtime/runtimeServices.ts`（注册 treasury 服务）、`src/runtime/productionMonitor.ts`（energy 读取迁移）、`src/main.ts`（挂载 treasuryShadow phase）。
- 市场安全合同零改动；`Memory.runtime.inventoryPerf`/`empireInventoryShadow` 原样保留；不新增 global 私有槽、不修改冻结的 Memory schema 声明。
- Jest 预算新增 4 个 treasury 测试文件，按既有预算治理流程更新锚点。
- 旧系统删除按阶段进行，见 design.md 迁移地图与删除清单。
