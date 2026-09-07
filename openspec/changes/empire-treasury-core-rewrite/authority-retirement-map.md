# Authority Retirement Map — Core Rewrite I（III 增补确认）

旧权威 → 新职责 → 退役位置 → 最终 runtime 引用。基线 `cf2ee7b`（Remediation XII）→ 本轮 HEAD。

## -1. Core Rewrite IV 增补确认（2026-09-06）

IV 轮新增的持久信息与门禁**不是**新证明权威：

| 检查项 | 结论 |
| --- | --- |
| `Memory.runtime.treasuryWorldSequence`（IV 新增独立键） | 单一安全整数计数器，受控世界真实更新时 +1（单字段直写、不走发布确认——丢一次 bump 只落保守方向）。它只是观察覆盖判定的**时间锚点**，不证明任何交易执行/清理完成；比较域 = Memory 持久域（跨 heap reset 连续）。替代 III 的 global 槽 `__treasuryWorldSequence`（已退役并从 PRIVATE_GLOBAL_SLOTS 移除）——不构成第二套世界事实账本 |
| 观察接管证明（advance_cleanup.observationProof） | 数据化证明（worldSequence/atTick/coveredLocations），由 kernel 编排层从 ports.observeForCleanup（facade 装配）取得——调用者不可自报；它只是退出条件的**必要输入**，未覆盖效果的资源责任仍由原聚合承担（occupancy 投影不变） |
| 观察视图时效（ensureTickState 重建） | 失效边界而非权威：拒绝陈旧视图（epoch.worldSequence < 持久世界序 → 重建），不证明交易执行；不建立逐 facade 确认列表、永久观察凭证或第二套 applied 账本 |
| 成对预算（prepayReleaseUnitBudget/applyPrepaidCleanupCommand） | 调度许可而非完成证据：份额是"可进入端口+确认"的许可，完成只由端口确认 + advance_cleanup 真实 remaining 表达；validator 防止第 9 份（R4 死锁根除） |
| 构造器上界（buildTreasuryCoreWorst*） | 空间推导工具：上界 = 真实 JSON.stringify 一次，不是持久数据；validator 真实收紧（腿数 12/generation·adapterVersion ≤9999）与上界一致 |
| 旧 proof 体系 | 未复活：无 Ticket/Intent/GRA/Summary/certificate/retired range 或其改名版本；无逐 attempt/逐 generation/逐消费者 proof store；ring 仍非权威（D20 坏 ring 对照） |

## 0. Core Rewrite III 增补确认（2026-09-05）

- 旧 proof 体系（Ticket/Intent/GRA/Summary/certificate/retired range/receipt/token/quarantine）**未复活**：本轮全部修复落在现有 kernel/facade/authorizationFacts/store 内，未新增任何持久证明 store、未新增逐交易/逐代 proof。
- **实例本地 applied overlay 的派生地位（R5/§6.1）**：授权判定不再消费 overlay（已确认未入观察的效果由 occupancy 从 active 记录派生——观察覆盖世界序判定）；overlay 仅作 query projected 展示缓存，可丢失可重建，不是任何效果的安全载体。
- **原聚合的观察责任**：closing(committed) 在效果被当前观察接管前由原活跃聚合继续承担占用（世界序/tick 双锚点判定）；不存在第二执行权威、不存在独立的"已完成效果登记处"。
- **世界序（__treasuryWorldSequence）是调度/判定元信息**：单调计数器，非权威账本——丢失只会使判定保守（多占用），不会漏算或授予执行权。
- **发布确认不新增持久回执**：独立预期快照是写协议内部的临时深拷贝，不落盘、不形成第二份权威。
- **执行门禁在 facade 层**：blocked 前置状态不推进 kernel 状态机——许可权威（WeakSet + 冻结快照）与门禁事实（窗口/复验/incarnation）分离，后者失败不消费前者。

## 1. 旧权威 → 新职责

| 旧权威/机制（基线 cf2ee7b） | 新归属 | 退役方式 |
| --- | --- | --- |
| Ticket（attemptIssuanceTicket/attemptIssuanceHandoff）：可执行许可跨 store 转移 | kernel dispatch permit（heap-only，聚合内签发消费） | 文件删除；许可不再持久化、不再跨 store 转移 owner |
| Intent WAL（intents.ts v7）：执行阶段持久状态机 | kernel 聚合 phase（dispatching/outcome_unknown 即"可能已进入"） | 文件删除；dispatch 发布 + 保守恢复取代 executing/started_unknown 细分 |
| Quarantine（quarantine.ts v6 + 全局 write blocker） | kernel outcome_unknown 阶段（占用保持，无全局锁） | 文件删除；不再阻断无关工作，风险按聚合隔离 |
| writeFault marker（writeFault.ts）+ 全局 write admission 锁 | 写后读回失败 → 保守方向处理 + unhealthy 阻断 | 文件删除；无全局单槽 marker |
| Resolution tombstone（resolutionStore.ts v7）+ resolutionStateMachine | kernel settle（受控证据）+ closing/retry_ready 阶段 | 文件删除；结论不可逆由阶段单调性保证 |
| cleanup journal/coordinator/stage handlers/supersession/completion authority | kernel cleanup.consumerKeys + beginTick 公平推进（预算 8/tick） | 文件删除；清理是聚合内义务，非跨 store 状态机 |
| GRA（generationRetirementAuthority/proofLifecycle/relation） | 不再需要——retry 以 exact not-executed + 清理完成为前提，无逐代 proof | 文件删除；A07 结构矛盾校验保留"相反结论阻断"语义 |
| chain retirement certificate / retired ranges / lineage retirement summary | 不再需要——frontier 单调 + 环覆盖，无退休区间 | 文件删除 |
| attemptLineage（v3）+ lineage*（8 文件） | kernel 聚合 parentAttemptId + generation（单parent 链） | 文件删除 |
| receipts（v8，4096 槽） | ring（128，不参与授权）+ 活跃聚合内的占用 | 文件删除；幂等由"聚合 + permit 恰一次"保证 |
| attemptIssuer（ti1_/ti2_ 双命名空间） | kernel identity（tk1_ 单命名空间 + frontier/burned） | 文件删除 |
| rearmCapability / attemptRearm / attemptOccupancy preflight | kernel issueRearmPermit + executeRearm（同 tick、retryFactsDigest 绑定） | 文件删除 |
| authorization（token/bundle/ledger/faults/cohort）+ policyGate 链 | policy withhold 在接纳路径 fail closed（checkPolicyForAdmission）；无 token 层 | authorization*.ts/cohortValidation.ts 删除 |
| positiveOwnershipVerifier（14 类 source 聚合）+ exactAttemptIdentity/entryExactIdentity/identityProof/identityProfile | kernel 身份事实全集比对（单聚合内，无跨 store source 聚合） | 文件删除；A04/A06 语义由结构矛盾校验 + 许可身份匹配保留 |
| projection.ts（journal/tentative ledger/receipt 预留/reconcile） | facade 本 tick heap overlay（tentative + 已发生）+ kernel 持久占用 | 文件删除 |
| kernelChannel（TREASURY_WRITER_KERNEL symbol 通道）+ testService 低层原语展开 | 公共 API 即测试通道（authorize/executeDispatch/settle/rearm）+ 纯观察 harness | 文件删除；测试不再有绕开 gate 的低层入口 |
| compat.ts（单阶段 compatRecordAcceptedTransaction） | 退役（无等价——统一走 admit+dispatch） | 文件删除 |
| writeReadiness/readinessCollector/unresolvedAuthority/faultResolution/recoveryCoordinator/reconciliation | kernel beginTick/endTick 恢复推进（保守化 + 清理 + 期限） | 文件删除 |
| markerDischarge/markerAttemptIdentity/markerExactIdentity/exactAuthorityDischarge | cleanup.consumerKeys 释放确认 | 文件删除 |
| committedProofVerifier/oppositeProofMatrix/forensicProvenance | outcomeEvidence（kind/conclusion/source 绑定聚合） | 文件删除 |
| currentSettlementCoordinator/preReleaseSettlementGate/historicalSettlementAuthority | settle 单一路径 | 文件删除 |
| completionHeadroomReservation | 接纳时容量检查（一次接纳承担完整生命周期，无第二个 proof 槽） | 文件删除 |
| durableIdentity/durableSnapshot(部分)/durablePublication | canonicalDigest + 写后读回（writeTreasuryCoreMemory） | durableIdentity 删除；durableClone/durableSnapshot 保留为通用工具 |
| executionFactCohesion/holderResolution 变体/authority 等级 | identity facts 全集比对 | executionFactCohesion 等删除；holderResolution 保留（查询 owner 验证） |

## 2. 保留模块与理由

| 模块 | 理由 |
| --- | --- |
| observation.ts | 物理事实冻结快照（productionMonitor 只读消费） |
| commitments.ts + commitmentRevision.ts | 任务/预留承诺索引（resourceReservation/resourceControl/logistics 生产依赖） |
| canonicalEncoding.ts / canonicalTransaction.ts / transactionId.ts | canonical 派生与 hash 核心（contract digest 与 attemptId 铸造共用） |
| ownerIdentity.ts / holderResolution.ts | typed owner 身份（resourceReservation/nukerControl 生产依赖） |
| policyAuthority.ts | policy 注册表（registry 概念独立于旧授权协议；runtimeServices seal） |
| adapterRetrySemantics.ts | retry facts canonical 化 |
| durableClone.ts / durableSnapshot.ts | 有界深拷贝/冻结工具 |
| shadow.ts | 只读影子对账（main 挂载，零行为写入） |
| actionContracts.ts | adapter 注册表 + contract 构建（精简：执行入口 1109-1373 行删除） |
| facade.ts | 重写为薄装配层（查询侧签名保持） |

## 3. 最终 runtime 依赖图证明

- 架构守护测试（treasuryKernelArchitecture.test.ts）机器检查：
  1. 66 个旧协议文件名不存在于 `src/runtime/treasury/`；
  2. 生产 treasury 代码零 import 旧协议路径；
  3. `applyTreasuryCoreStateCommand` 的 runtime importer 唯一 = kernel.ts；
  4. 生产模块零 import testHarness；
  5. `treasuryCore` 持久键只被 treasury 目录内模块 + 类型声明引用；
  6. actionContracts 无 Game 市场写调用；runtimeServices 只 seal 不注册；
  7. kernel 命令集封闭（union 无 default 兜底）。
- Treasury 外部生产 import（全仓扫描）：main.ts（shadow/runtimeServices）、runtimeServices.ts（facade/actionContracts/policyAuthority）、resourceReservation.ts（commitmentRevision/ownerIdentity）、resourceControl.ts + logistics/resourceTransferTasks.ts（commitmentRevision）、nukerControl.ts（ownerIdentity type）、productionMonitor.ts（runtimeServices）。全部落在保留模块。
- `src/main.ts` 与 Defense 冻结清单生产文件零改动（git diff 为空，budget protected 校验通过）。

## 4. 兼容性策略

- 不迁移旧数据：发现旧 `Memory.runtime.treasury.*` 业务 store → legacy_store_present，写入阻断、数据保留（A24）。
- `Memory.runtime.treasuryPerf` 保留（shadow 诊断）。
- `runtime.d.ts` treasury 段（约 520 行声明）替换为 treasuryCore v1（约 60 行）；boundaries schema 指纹更新（必要兼容修复——旧声明 import 已删除模块，类型层不可保留）。

## Core Rewrite II 增补（2026-09-05）

II 轮确认旧证明链未复活，并补充 II 轮新增写权威的封闭性：

| 检查项 | 结论 |
| --- | --- |
| 旧多 store proof 链（GRA/certificate/summary/retirement/lineage/receipt） | 未复活：treasuryKernelArchitecture 守护（旧模块不存在 + 无 import + 命令集封闭含 cancel_pending）全部通过 |
| external_settlement_receipt（外部自报结算） | **已删除**（I 轮保留的显式通道在 II 轮关闭）：类型/validator/运行时均不存在；结算唯一入口 = kernel.settle → 受控 reconcileOutcome 端口（facade 装配注册 reconciler），无 kernel.settle(rawConclusion) 旁路 |
| tentative ledger（I 轮 heap tentative 预留） | **已删除**：admit 后 active 记录即同 tick 扣减权威——不存在第二份同责任表达（B09 双扣对照守护） |
| pending sweep / 清理游标 / 预算记账（recovery 区） | 调度元信息而非权威：失效可安全重建，不构成完成 proof，不授予执行权；treasuryCore 键权威仍只在 kernel/store.ts（架构守护通过） |
| 测试夹具能力是否泄漏为生产通道 | 否：mint/内部 command 仅 kernel 内部可达（architecture：applyTreasuryCoreStateCommand 唯一 runtime importer = kernel.ts）；reset harness 位于 test/mock（生产模块不 import，架构守护） |
| 新写入口清单（II 轮终态） | facade.authorizeTreasuryActionContract / executeAuthorizedDispatch / executeRearm / settleUnknownOutcome / cancelPendingWork / closeWork + kernel.beginTick/endTick 恢复——全部收敛到 kernel.runCommand 单一写路径 + commands.ts 封闭命令集（admit/dispatch_start/dispatch_result/settle/advance_cleanup/rearm/close/recover_dispatching/cancel_pending） |

## Core Rewrite IV · Remediation I：原聚合内恢复/调度信息的责任与退出

- `invocationBoundary`（每活跃聚合内，随 phase=pending→dispatching 同次写入）：唯一职责是 committed 退出判定的保守下界锚点与"可能已进入"的恢复事实。退出时随聚合移除进 ring（ring 不含该字段——明细只留终态摘要）；不构成新证明链、不按 attempt/generation 另存。旧 proof 未复活；没有第二执行权威。
- `cleanup.cursor`（每活跃聚合 cleanup 内，随成对预算确认命令推进）：唯一职责是记录内消费者轮转位置（调度元信息）。义务完成事实仍 solely 由集合成员资格表达；聚合退出/retry_ready 清零。无逐消费者完成记录存储。
- `recovery.cleanupCursor`（恢复调度区，跨记录轮转）：与记录内 cursor 分层——前者选记录，后者在记录内选成员；两者都不是完成 proof。
- kernel preflight（只读许可预检）：不是执行凭证——真正调用边界终验仍在 executeDispatch（WeakSet 身份 + 阶段 + 完整身份重验）。未新增许可品牌表或第二签发权威。


## Core Rewrite IV · Remediation II：覆盖判定/游标发布/预检门禁的责任归属

- kernel/coverage.ts（新增共享纯能力）：效果覆盖锚点链（invocation→external→invocationBoundary）与时间序比较的唯一实现——occupancy 投影、commands 观察接管转移、beginTick committed 清理门三处消费同一份判定。它是既有聚合字段（invocation/external/invocationBoundary）的纯派生，不是新权威、不落盘、不产生第二证明链。
- 覆盖成立的效果不重复扣减：占用投影（occupancy）与记录保留（active 成员资格）分离——同一效果只扣一次；其他业务承诺/消费者义务按原规则计算；无新余额账本。
- cleanup.cursor 发布时点（ Remediation II/§7.2 修订）：随成对预扣同次发布（端口调用前持久）；advance_cleanup 确认命令的 rotationCursor 字段删除——确认只做结果记账，不得回写游标。义务完成事实仍 solely 由集合成员资格表达；无逐消费者完成记录存储、无调度票据。
- preflight 健康门禁：非健康核心（absent/incompatible/unhealthy）明确拒绝——未新增 health authority、未新增可复用"预检通过证书"；预检仍是只读且不是执行凭证（调用边界终验在 executeDispatch）。
- 测试模型（harness/exact oracle/存储拦截器，全部位于 test/mock）：captureTreasuryHostBreakpoint 是断点事实的原子捆绑器（Memory+世界+事件同一时刻），不是生产回滚能力；treasuryExactOracle 的结论从宿主事件/分支世界序推导——不是第二对账权威（生产对账仍只有注册 reconciler 端口）；存储拦截器只模拟故障注入，卸载保留 liveValue 是工具契约而非生产语义。


## Core Rewrite IV · Remediation III：单步清理/严格成功/断点事件的责任归属

- 复用原聚合内核与义务事实：本轮未新增任何持久权威——义务完成仍 solely 由
  cleanup.consumerKeys 集合成员资格表达；budgetUsed/cursor 仍由 Memory
  recovery 区承担。逐项确认（releasedDuties 单成员）复用 advance_cleanup
  命令，无新命令类型、无逐消费者日志、无调度票据。
- 生命周期推进 guard（kernel 模块级 lifecycleAdvanceInFlight）是有界运行时
  协调，不是持久完成权威：完整 reset（jest.resetModules 重建模块）后丢失；
  记录事实、预算、游标、remaining 均不依赖它。多实例共享同模块即同调度域；
  不按 treasuryCore 对象引用分锁（安全写会替换该对象）。
- cursor 重定位（nextServiceCursor）是 advance_cleanup 内基于记录现值的
  派生计算（下一待服务成员），不是新的游标权威；与本命令无对应关系时保守
  保留现值取模回绕——调度元信息失效可安全重建，不证明任何义务完成。
- 测试分支模型（journal.captureBranch/reopen）不是生产 proof 体系：事件
  副本只在测试内存中，不进生产 Memory；恢复分支对账结论由受控宿主事件
  推导（exact oracle 仍是测试工具，生产对账仍只有注册 reconciler 端口）。
  runWithInvocation 调用作用域是测试侧的同步调用包装，不是第二套生产许可
  机制——许可有效性仍完全由生产 preflight/复验/执行门禁决定。

## Core Rewrite IV · Remediation IV（2026-09-06）

- 双入口推进所有权是 beginTick/endTick 共用的同一模块级运行时 guard：
  独立 endTick 取锁后回调重入零推进、嵌套 endTick 只写关窗事实。没有第
  二个锁、没有持久调度票据；guard 经完整 reset 丢失属预期（运行时协调不
  是持久权威），持久事实（预算/游标/关窗/记录）均在 Memory 安全写协议下。
- endTick 尾部预算 max 写回与游标现读写回是"当前推进写回"原则的实现，
  不是新的预算权威；预算单调性的权威仍是 applyBudgetedCommand/
  applyPrepaidCleanupCommand 的命令写与 Memory 现读。
- 测试宿主绑定（executeTreasuryAdmittedDispatch 的聚合/许可核对、
  marker.source 与 adapter.journal 的来源关联核实）是验收工具的输入完整
  性检查，不产生新生产权威：生产许可有效性仍完全由 preflight/复验/执行
  门禁决定；事件来源关联失败在对账前拒绝，不修改 Memory/世界/事件。
- TreasuryOracleHostPlan（results/afterWorldEffect）只在测试宿主内编排
  执行结果与捕获时机，不进生产、不向 reconciler 提供结论；调用与效果
  仍在真实边界记录（dispatch_start/adapter.execute/dispatch_result）。

## Core Rewrite IV · Remediation V（2026-09-07）

- endTick 关窗否决标记（endTickAdmissionVetoTick）是**运行时否决条件**，
  不是第二许可权威：它只能拒绝新增业务（admit/executeDispatch/
  executeRearm 与 facade 授权窗口共享消费），不授予任何执行权、不证明
  持久关闭、不写新永久 store；按 tick 失效（无永久闩锁），完整 reset
  后丢失——跨运行时的关窗权威仍是持久 lifecycle.lastEndTick 的安全写
  协议。guard（推进互斥）与否决标记（业务拒绝）职责分离，不能一起清除。
- endTick 返回的 closurePersisted 是对持久事实的**如实报告**，不是执行
  权限或关窗证书；发布失败返回 false 不影响否决标记本 tick 生效。
- performTreasuryFullReset 的来源必备校验是验收工具的输入完整性门禁：
  拒绝发生在任何状态修改之前、零修改；生产许可有效性仍完全由
  preflight/复验/执行门禁决定。测试事件分支（captureBranch/reopen）
  不是生产证书；kernel 面裸 Memory 安装明确不宣称 exact 对账。
- 关窗不停止旧工作收尾：beginTick/清理/对账/取消/关闭入口不消费否决
  标记（不加"closed 即全入口返回"总开关）——新增业务拒绝与既有义务
  兑现是两个口径。

## Core Rewrite IV · Remediation VI（2026-09-07）

- 只复用既有两个关闭事实：持久 lifecycle.lastEndTick（安全写协议发布，
  跨运行时权威）与模块级 heap 否决标记（按 tick 失效）。kernel 新增的
  admissionGateStatus 是二者之上的**只读组合判定**（持久先查、heap 兜底，
  原因区分来源不冒充），不是第三权威、不授予执行权、不写任何新持久
  字段；facade admissionWindowOpen 改为消费同一判定——两侧不再各自维护
  双口径实现。admissionVetoActive 保持 heap-only 语义（运行时否决事实
  查询）。
- 门禁不扩大拒绝面：closed 不进 requireWritableHealth；恢复 unknown、
  可信对账、取消、清理与安全 close 不受关闭限制；非健康核心退化为
  heap 单口径且原有 unhealthy/incompatible 拒绝不退化。测试工具
  resetTreasuryCoreLifecycleFactsForTest 仅清 heap 事实（J02 门禁隔离），
  不新增绕过生产签发的接口。
