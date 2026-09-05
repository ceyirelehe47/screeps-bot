# Authority Retirement Map — Core Rewrite I

旧权威 → 新职责 → 退役位置 → 最终 runtime 引用。基线 `cf2ee7b`（Remediation XII）→ 本轮 HEAD。

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
