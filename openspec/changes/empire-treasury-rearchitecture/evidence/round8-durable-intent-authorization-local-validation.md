# Round 8 — Durable Intent & Authorization Binding 本地验证证据

> 本文件记录第八轮（Treasury Round 8 — Durable Intent & Authorization Binding）的本地确定性验证证据。该仓库在 GitHub 上**没有 CI**——以下全部为本地验证结果，不声称任何 CI passed。

## 1. 埈始与终止状态

- 起始 HEAD（本轮基线，= 上次审查远端 HEAD）：`dedd4a5ddc61fa94d96e44aeff346354e48724da`
- 最终实现 commit（含全部实现与测试，budget 锚点之前）：见第 3 节 commit 列表（实现终点 `868088e`）
- 分支：`refactor/empire-treasury-rearchitecture`（无 reset/rebase/force push；线性新增提交）

## 2. 本轮 commit 列表

| commit | 主题 |
|---|---|
| `a4a5ff8` | docs(openspec): 第八轮状态机、授权边界与迁移任务定义 |
| `7e788d3` | feat(treasury): durable intent/WAL 版本化持久权威与统一 recovery slot |
| `43be378` | feat(treasury): 资源授权 token（opaque 单次 capability + revision 绑定 + 防超卖预算） |
| `7ed30c6` | refactor(treasury): canonical action contract 与注册 adapter registry |
| `94c0104` | fix(treasury): quarantine 按 transaction 保守聚合 + 快照封闭 |
| `6794a43` | refactor(treasury): staged atomic resolution、capability 签发与既有 receipt 刷新 |
| `e258734` | fix(reservations): owner identity 统一 canonical token 与 store 完整健康契约 |
| `45bad75` | refactor(treasury): strict projected 与 risk-adjusted capacity 口径分立 |
| `04bffb3` | chore: 移除误提交的临时脚本 |
| `0e38eb9` | test(treasury): 性能 fixture 与架构边界扩展 |
| `868088e` | refactor(treasury): 打破 receipts↔resolutionStore 循环依赖 |

## 3. 核心状态机与协议

### 3.1 Durable intent / WAL（`Memory.runtime.treasury.intents`，schema v1）

- **phase 状态机**（ready 与 executing 绝不混同）：`ready`（durable 已写入并验证——协议保证 execution-started 标记先于 callback，持久化的 ready 即"Game API 从未被调用"）→ `executing`（已标记 execution-started）→ `returned_non_ok` / `ok_pending_commit`（关闭中）→ 删除（settled/确认 aborted）；`execution_unknown` / `quarantined`（转换中）→ quarantine 完整写入后释放；`resolution_pending`。heap-only 的 `authorized` 为状态机语义完整性（不落盘）。
- **唯一安全顺序**：authorize → prepare tentative → 持久化 intent(ready) → 读回验证 → 标记 executing → 注册 adapter 恰好一次 → 非 OK 关闭+abort / OK → staged commit → finalize 删除。intent 写失败：callback 零调用、tentative 与槽位释放、结构化拒绝（intent_store_unavailable）。
- **统一 recovery slot**：`recoverySlots = quarantine entryCount + intent entryCount + 无 intent 的 active handle`——一笔 transaction 恒占一个 slot（fault 转换 quarantine +1/intent −1 守恒；commit/abort 回收）；指标 intentSlotsRemaining 证明。
- **global reset 恢复**（beginTick 显式分支，先于一切 planner/writer）：ready → 确认未执行关闭；其余 phase → 保守转 execution-unknown quarantine（postings 完整）；quarantine 写失败 → intent 保留（emergency intent authority：postings/占用/slot 不丢）。
- **健康契约**：version 1 / entryCount / key="i:"+id / 容量 64 / entry 全形状 + canonical postings 逐腿校验 / 安全整数与聚合溢出 / global reset 首次 load 全量验证 / heap health cache / 损坏与未知版本 fail closed / 显式 repair 并入 faultResolution。

### 3.2 资源授权 token（authorization.ts + facade）

- 硬策略默认：allowIncoming=false（pending incoming 不可花费）、必扣 outgoing、必扣 reservations、commitment complete——违反结构化拒绝（无 incoming 依赖通道）。
- 授权计算 = exact observation + committed overlay − pending outgoing − production reservations（owner-aware）− quarantine/intent 风险流出 − policy withhold − 其它未消费授权预算；同时验证 completeness/reservation store health/write readiness/容量（risk-adjusted）/安全整数。
- opaque token：heap-only 冻结 + 服务私有 WeakSet 对象身份；单次使用；tick/generation 有界；绑定 exact epoch + commitment/projection/quarantine/intent/reservation-store revision + policy fingerprint + owner canonical token + action kind + resource/room/location/amount scope + contract digest——任一 revision 变化即失效。授权成功立即占用 authorization budget（多房间 scope 逐 key 全额保守占用）——A 授权 60k 后 B 再授权 60k（物理 100k）被拒，不等 prepare。

### 3.3 Action contract 与注册 adapter（actionContracts.ts）

- contract：canonical args 冻结深拷贝 + postings 由 `adapter.derivePostings(args)` 确定性派生（与 Game API 参数同源）+ 结构 incarnation 快照 + digest/epoch 绑定；私有 WeakSet 防伪；跨 tick 失效。
- 执行入口 `executeTreasuryActionContract`：adapter 存在且 kind 匹配 → contract 防伪 → 授权 token 消费（多资源 action 每种负 posting 资源分别授权 + 联合覆盖校验）→ 结构 incarnation 校验（fresh 观察重扫，变化 structure_replaced）→ 经 executePreparedAction 走 intent 状态机 → adapter.execute 恰好一次。
- 注册边界：registerTreasuryActionAdapter 仅 actionContracts.ts 与测试（重复 kind 拒绝）；内置测试 adapter `test.transfer`（多 posting fixture + 副作用计数 + 可编排 reconciler 结论）。本轮未注册任何真实生产 writer。

### 3.4 Staged atomic resolution（resolutionStore.ts v2 + faultResolution.ts + reconciliation.ts）

- resolution store v2：version/entryCount/key 一致/entry 完整 shape（resolution/stage 枚举、digest、安全整数）/容量 256（满时在任何原状态变化之前拒绝）/未知版本与损坏 fail closed（malformed 旧 tombstone 不当垃圾删除）/v1 无损升级（补 entryCount + stage=final）。
- committed 流程：capability 校验 → slot 预检 → resolving tombstone → **receipt 刷新**（既有 receipt 真正更新到 resolution tick，nextExpiryTick 重算；无则写入）→ 释放 quarantine/intent → 清匹配 marker → finalize（stage=final）。receipt 失败回滚 tombstone（零原状态变化）；finalize 失败保持 resolving（恢复幂等完成）。
- not-executed 流程：先写 final tombstone（可写性保证）再释放——绝无"函数返回失败但可重新 prepare"的中间态。
- 恢复（beginTick `recoverStagedResolutions`）：resolving+receipt 已写 → finalize；无进展 → 回滚；final not-executed 未释放 → 补完成。全部幂等。
- reconciliation capability：`service.issueTreasuryReconciliationCapability`（quarantine/intent 双权威、注册 reconciler 边界、active handle/post-fault observation 签发侧校验、结论只能来自 reconciler）；resolve 只接受 capability（旧 evidence/guard 自由对象入口移除）；WeakSet 防伪 + 单次使用 + generation/tick 校验。

## 4. 覆盖与不能覆盖的 failure model（exactly-once 边界）

**Treasury 机制覆盖**（本地确定性测试验证）：
- tick 内任意时点的 global reset（heap 丢失、Memory 完整）：intent/quarantine/receipt/resolution 四权威恢复；
- prepare→intent→executing→commit 全链各阶段中断（intent 写失败/execution-started 标记失败/callback 抛错/非 OK abort 失败/commit 各 publish 段故障）；
- staged resolution 各阶段中断（slot 满/resolving 写失败/receipt 失败/finalize 失败/global reset）幂等恢复；
- store 损坏（intent/quarantine/reservation/receipt/resolution 五处）fail closed。

**不能保证**：
- Screeps 运行时**硬 CPU 中断**（tick 中途进程终止导致 Memory 未 flush）——该 tick 的全部 Memory 写入（含 intent）一并丢失，与 Game 副作用可能同时消失；恢复按"无持久记录"处理，风险由统一 recovery slot 预留与保守恢复兜底，不声称 exactly-once；
- Memory 序列化介质故障。

## 5. 新增 Memory 字段与上限

| 字段 | 版本 | 上限 | 清理规则 |
|---|---|---|---|
| `Memory.runtime.treasury.intents` | v1 | 64 entries（与 quarantine 同上限，统一 recovery slot） | settled/确认 aborted/quarantine 完整写入/resolution finalized 即删；beginTick 恢复处置 |
| `Memory.runtime.treasury.resolutions` | v2（v1 无损升级） | 256 entries | 写入时惰性清理 resolvedAtTick 超 5000 tick 项；满载且无可清理在任何原状态变化之前拒绝 |
| `Memory.runtime.treasury.quarantine` | v1（沿用，聚合口径升级 per-transaction） | 64 entries | 显式 resolution 释放 |
| authorization heap ledger（不持久化） | — | TREASURY_AUTHORIZATION_ACTIVE_LIMIT=64 | 消费释放/revision 失效懒释放 |
| receipt | v3（沿用，新增 refresh 能力） | 4096 | retention 5000 / resolve-as-committed 刷新到 resolution tick |

runtime 指纹：`b6807812592d7fe578c2ad32635af3e04419a80bea1d2c57dda283c543b2a871`（test/memoryDeclarationBoundaries.test.ts 锚定）。

## 6. 验证命令与结果（本地）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run build` | 成功（dist/main.js 4,856,762 bytes；rollup 无循环依赖告警） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 23 suites / 424 tests 全过 |
| `npx jest --config jest.config.cjs`（全量） | **217 suites / 1130 tests / 1130 passed / 0 failed** |
| `node scripts/verify-jest-budget.mjs` | 见第 8 节（预算锚点提交后 PASSED） |

定向新增套件：treasuryDurableIntent（21）/ treasuryAuthorization（19）/ treasuryActionContract（12）/ treasuryCapacityViews（4）；treasuryFaultResolution 重写（25）/ treasuryWriteArchitecture（+4=15）/ treasuryWriteAdmissionPerformance（+3=12）/ treasuryTypedOwnerMigration（+8=41）。

## 7. operation-count 结果（确定性计数断言）

- intent admission O(1)：64 笔 prepare/execute 全程 `intentEvents.fullScans === 0`；
- authorize/consume 不全扫：revision 未变时 16 次授权/消费 `commitmentRebuilds` 恒定、quarantine/intent fullScans 恒定；
- token 消费 O(1)+postings 线性：32 腿 postings 消费零全扫；
- quarantine/intent 聚合 revision 缓存：store 变更才重算（既有用例延续）。

## 8. Jest 预算

- 基线（第七轮终点）：213 suites / 1045 tests。
- 本轮终点：**217 suites / 1130 tests**（+4 suites / +85 tests；无删陋试试）。
- 预算治理：`monitor-data/apply-budget-treasury-round8.mjs`（21 个 treasury 文件 budget=实际数；校验 217/1130）→ `test/test-suite-budget.json` → `scripts/verify-jest-budget.mjs`（requiredBaselineCommit 指向含全部实现与测试的 `a231e69`，requiredTarget 217/1130）。锚点提交独立于实现提交（正式流程）。

## 9. 未部署声明

- **未部署**到 Screeps（无 grunter/screeps upload、无分支 default 操作）；未合并 main；未 force push。
- **未接入任何真实 Game writer**：ResourceControl/terminal/carrier/lab/factory/market 生产写路径零改动；本轮只交付协议、测试 adapter、状态机、持久权威与确定性验证（架构测试守护：生产 writer 候选禁用任意 callback 入口/直接 prepare/授权原语/contract 构建）。
- 旧库存系统（empireInventoryIndex/empireInventoryShadow/ReceiverCapacityLedger 等）零删除。

## 10. 残余风险

1. 本地确定性测试 ≠ 线上验证：Screeps 真实运行时的 Memory flush 边界与硬 CPU 中断行为无法在 Jest 中复现（见第 4 节边界声明）。
2. 统一 recovery slot 的两个 64 上限（quarantine 与 intent 共享语义）与 receipt pending 64 上限的运营语义耦合——真实 writer 接入前需容量模型复核（design 3.10.12 容量模型已记录）。
3. intent/quarantine/reservation/resolution 的轻量 health 探测对 entry 级损坏不可见（需触发 load；与 receipt 契约一致的既有权衡，本轮未改变）。
4. `executeTreasuryActionContract` 的结构 incarnation 校验优先用 fresh 观察重扫（额度耗尽时退回 shared 同 tick 比较——同 tick 结构替换在该退化路径下不可见，跨 tick 由 contract 失效兜底）。
5. reconciliation capability 的真实业务对账器（terminal/factory/market 的 post-fault 判定逻辑）尚未实现——本轮只有测试 reconciler 与协议边界。
