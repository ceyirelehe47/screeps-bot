# Round 17 — Durable Attempt Lineage & Rearm Capability 本地验证证据

- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`4e032a6e5182e8c537f7a48a1bd691fcc1564a12`
- 最终 HEAD：见本文件提交（evidence 提交前实现全部完成）
- 验证日期：2026-09-01（本地验证——GitHub 无 CI，全部命令在本地真实执行）

## Commit 列表（本轮）

| SHA | 作用 |
| --- | --- |
| b5d029d | docs(openspec): define round 17 durable lineage and rearm capability |
| 12c7f45 | feat(treasury): add durable attempt lineage authority and class-aware identity |
| 7dbf5a3 | fix(treasury): pin not-executed tombstones until lineage replacement completes |
| 30ed938 | feat(treasury): issue opaque service-bound rearm capabilities |
| caaf3a7 | fix(treasury): make marker cleanup and pending-release completion one controlled transition |
| b992b4c | refactor(treasury): split receipt proof classes into identity-bound lowlevel and legacy |
| c6ef751 | refactor(treasury): reserve tr1 namespace and integrate rearm capability handoff |
| 6312905 | test(treasury): adapt existing fixtures to round 17 semantics |
| b20632f | fix(treasury): publish lineage store to memory and break retention lookup cycle |
| ef64b77 | test(treasury): guard derive helper boundary and update memory fingerprint |
| cc18fb5 | test(treasury): cover round 17 lineage and capability invariants |

## Attempt Lineage Store（attemptLineage.ts）

- **store 版本**：`Memory.runtime.treasury.attemptLineage` v1；key `l:<rootTransactionId>`；entryCount/updatedAt；硬容量 **64 条 chain**。
- **record 语义**：lineageId（root ID + root identity 派生 16hex）、root/current attempt ID 与完整 identity（digest/contractDigest/cohortDigest/durableIdentityDigest/lowlevelSource）、actionKind、adapterSemanticIdentity?、ownerIdentity?、generation（root=0，child 接管 +1）、state、resolutionState、nextChildTransactionId?（capability 签发时冻结）、retrySemanticDigest?（non-rearmable 缺失）、authorityClass（identity-bound|lowlevel）、bindingDigest?（rearm child 专属）、rearmable + nonRearmReason、retirement 三段（lineagePublished/authorityReleased/markerCleaned）、recordRevision（每次写入 +1）、createdAtTick/updatedAtTick。
- **状态机（单调）**：`retiring → rearm_ready → capability_issued → child_intent_pending → child_active → chain_committed`；终局 `non_rearmable_retired` / `forensic_isolated`。禁止：chain_committed 回退、同 generation 不同 child、child_active 再签第二个 child、改变 root/语义身份/class、复用旧 generation；recordRevision 严格 +1；同状态仅 exact idempotent。
- **root/current/next 索引**：heap Map（O(1) lookup）；global reset 首次 load 一次有界全表验证 + 索引重建；Memory record 是权威（索引仅定位器；不一致 → indexCorruptions 计数并清理）。
- **容量行为**：新 root 占一个 slot；同 chain 代际推进更新同一 record（entryCount 不变——测试断言）；满载（64）新 root 拒绝且**不驱逐**任何 record（fail closed）；普通 retention 永不删除 lineage record。
- **写入协议**：clone 输入 → 形状/语义校验 → 状态机转换校验 → 容量 → Memory 发布（写入路径权威初始化——published 标志防 heap 幽灵 store）→ read-back 重算验证 → 失败完整回滚。读取返回有界深冻结快照；调用方输入 alias 不污染 Memory（测试断言）。

## Final Not-Executed 的 staged 协议（faultResolution）

顺序：完整 prevalidate → resolution slot + **lineage 容量与 retry semantic 预检**（facts 从释放前的 intent/quarantine entry 计算）→ consume reconciliation capability → 写 final tombstone → 写 lineage candidate + read-back → 释放 intent/quarantine → **class-aware 清 marker（检查清除结果）** → 三段收敛（completeTreasuryNotExecutedRetirement：retiring → rearm_ready / non_rearmable_retired）。

- lineage 容量不足：capability 不消费、tombstone 不写、authority 不释放（零持久副作用）。
- tombstone 已写、lineage 写失败：authority/marker 保留；beginTick 经 pendingRelease 快照重试 publication（tombstone 被驱逐资格门禁 pin）。
- marker 清除失败（conflict/insufficient）：tombstone 与 pending 索引保留、lineage 保持 cleanup-pending、返回 `retirement: "pending_cleanup"`、不进入 rearm-ready。
- **结果不再返回 rearmChildTransactionId 字符串**：`retirement ∈ {complete_rearm_ready, complete_non_rearmable, pending_cleanup, pending_publication}`；child ID 只经 issueTreasuryRearmCapability 交付。
- Round 16 旧 tombstone backfill（beginTick）：pendingRelease 快照中无 lineage record 的 final not-executed → non-rearmable retired（只有 attempt proof、缺 action retry 语义——永久阻断 parent、不签发 capability）；容量不足 → 不写（tombstone 保持 pin）。

## Rearm Capability（rearmCapability.ts）

- **防伪**：冻结对象 + service 闭包私有 WeakSet 对象身份（JSON round-trip 副本/手工伪造/跨 service 一律 invalid——测试覆盖）；绑定 lineageId/lineageRecordRevision/parentTransactionId/parentIdentityDigest/childTransactionId/generation/retrySemanticDigest/actionKind/adapterSemanticIdentity?/authorityClass/ownerIdentity?/lowlevelSource?/bindingDigest + serviceGeneration/tick/nonce。
- **生命周期**：单次消费（consume 后 already_used）；跨 tick（cross_tick）/跨 service（cross_generation）/lineage revision 变化（validate 路径）失效；consume 跳过受控推进的 revision（接管协议自身推进不构成失效——外部 validate 仍受保护）；未使用 tick 结束/global reset → heap 失效、durable capability_issued → beginTick 回退 rearm_ready、新 service 重签发（child ID 确定性不变——测试断言）；接管完成（child_active）后该 generation 永不可再签发；同 tick 重复 issue 拒绝（不产生两个可同时消费的 capability）。
- **消费时点**：executePreparedAction 内、intent read-back 一致之后、Game callback 之前（晚于全部 contract/authorization/readiness 检查，与 child durable 接管原子或可恢复）。

## tr1_ 保留命名空间门禁

单一权威 `isTreasuryRearmAttemptId`（transactionId.ts）。门禁点：prepareTransaction（kernel 内部通道携带 capability——无 capability → `rearm_capability_required`；validate 失败 → `rearm_capability_invalid`；lineage 状态校验）、authorizeTreasuryActionContract（options.rearmCapability 必填 + 匹配 + owner 一致 + retry semantic 重算）、executeTreasuryActionContract 透传、executePreparedAction tr1_ 接管协议、compat 单阶段入口（tr1_ 一律拒绝）、root/current 索引命中的普通 ID → `retired_attempt`（永久门禁——tombstone 驱逐后仍生效）。拒绝路径 bundle 零签发、预算零变化、intent 零创建、callback 零调用。架构扫描：production 源码不得引用 deriveTreasuryRearmChildTransactionId（child 派生权威在 attemptLineage.deriveTreasuryLineageNextChildTransactionId，只经 facade issue 通道）。

## Retry Semantic Identity（retrySemanticIdentity.ts）

- **modern 版包含**：action kind、adapter version/registration/稳定语义身份、canonical postings、structure descriptors+角色、durable payload/version、source、owner identity。
- **排除**：parent/child transaction ID、tick、observation epoch、commitment/projection revision、policy decision digest、authorization bundle ID、canonicalArgsText（durablePayload 已覆盖 args 业务语义且 parent facts 不可重建——防 parent/child digest 恒不等的假阳性）。
- **lowlevel 版**：kind、source、canonical postings、受控 lowlevelSource、durable payload（可选）；durableIdentityDigest **不参与**（transaction ID 绑定的 attempt 身份不是跨 attempt 动作语义）。
- **child contract 匹配**：authorize 与 execute 双重重算（按 capability 的 authorityClass 分派算法），资源/数量/room/target/action kind/adapter 语义/structure/durable payload 任一变化拒绝（capability 不消费——测试断言修正后同 tick 仍可授权）；相同 Game 动作不同 child ID digest 一致；owner 默认一致（不一致拒绝）。

## Capability → Bundle → Intent 接管协议

authorize 验证 capability（授权失败 capability 不消费、lineage 保持 ready）→ bundle record 绑定 rearm capability identity（digest/lineage/child/retry semantic/parent/binding/generation）→ executePreparedAction tr1_ 块：capability 完整验证 → retry semantic 重算比较 → lineage `child_intent_pending` → intent 写入（带 lineageBindingDigest）→ read-back 一致（含 binding 校验）→ consume capability → lineage `child_active`（current 推进、generation+1、bindingDigest 写入）→ Game callback。失败路径：callback 零调用、intent 释放回滚 rearm_ready 或保留为 staged（beginTick 恢复：intent 缺失/一致 not_started → 回滚 + 释放；不一致 → forensic_isolated）。commit 成功 → `chain_committed`（不再签发下一 child——测试断言）。child quarantine/receipt 继承同一 lineageBindingDigest（intent→quarantine 事实转移透传——测试断言）。

## Parent 相反 Proof 与 Child 占用（attemptOccupancy.ts）

- parent：lineage/receipt/quarantine/intent store 健康、retirement record 存在且 rearm-ready 三段完成、not-executed proof 完整（tombstone 驱逐后以 lineage record 为权威）、无 committed receipt（`proof_conflict`——零 capability、不删任何 proof）、无 resolving/committed tombstone、authority 已释放、marker 已清理、无 authorization-fault。
- child：receipt/tombstone/intent/quarantine/auth-fault/marker/其它 lineage root-current-next 索引（排除本 lineage）全部单 key lookup；heap 侧（prepared handle/active bundle）由 facade 注入。任一占用 → `child_identity_occupied` 零签发。

## Tombstone Retention 与 Lineage Replacement

驱逐资格（final not-executed）：lineage record 存在 + retirement 三段全部完成 + state ∈ {rearm_ready, capability_issued, child_intent_pending, child_active, chain_committed, non_rearmable_retired}——经装配注入的 O(1) lookup（模块单向依赖：resolutionStore ← attemptLineage 反向注册，build 无循环依赖）。无 replacement / 任一 pending / forensic → **pin 永不驱逐**（retentionPins 计数；满载 fail closed——测试断言塞满 256 后新写入拒绝且超龄无 lineage 项保留）。驱逐删除 tombstone 与 pendingRelease 索引项，绝不触碰 lineage record；驱逐后 parent root ID 仍被 prepare 永久拒绝（retired_attempt）、capability 仍可从 lineage record 签发、child ID 与驱逐前一致（测试断言）。

## Marker v2（class-aware attempt identity）

marker 新增可选持久字段：markerVersion=2、authorityClass、lowlevelSource、lineageBindingDigest、attemptGeneration（形状校验 + 一致性矩阵：identity-bound 禁 lowlevelSource、lowlevel 必带）。写入点（facade ×2 / recoveryCoordinator / authorizationLedger）经 classAwareMarkerFieldsOfFacts 携带完整 class 身份。清除（clearTreasuryWriteFaultMarkerForResolution）升级为 class-aware relation（markerAttemptIdentity.ts 单一权威）：transactionId+digest+authorityClass 双方可证且一致、lowlevel class 来源双向绑定、marker 携带的 digest/binding/generation proof 必须同样携带且相等——runtime-lowlevel 与 migrated-lowlevel 互不清除、跨 lineage/跨代不清除（测试覆盖）；v1 marker（无 class 字段）保持 transactionId+digest 兼容。immediate not-executed 路径检查清除结果：成功才 pending-release 完成 + rearm-ready；conflict/insufficient → `pending_cleanup`。

## Receipt Proof Class v7

- **identity-bound**：完整 modern 身份（digest+durableIdentityDigest 必填；contract/cohort 可选）；禁携带 lowlevelSource。
- **lowlevel**：digest+durableIdentityDigest+受控 lowlevelSource 必填；禁 modern contract/cohort 字段。
- **legacy**：禁一切身份字段——只作 replay blocker 与历史诊断（不得释放 authority、不得 rearm、不得证明 child attempt）。
- **v6→v7 迁移**：modern 无 source → identity-bound；modern 有合法 source → lowlevel（携带 contract/cohort = 等级矛盾 fail closed 原 store 保留——测试断言）；legacy → legacy；v4/v1-v3 链路更新为 identity-bound/legacy。lookup（v5/v6 读取兼容）、commit、refresh（receiptProofLevelOfIdentity 单一权威定级）、migration、cleanup、Memory 类型声明（runtime schema 指纹更新）全部对齐。
- **committed proof verifier**：跨 class 释放矩阵（identity-bound receipt 不释放 lowlevel authority、反之亦然）；lowlevel provenance 严格绑定（runtime/migrated 不互证——Round 16 测试继续通过）。

## Store 版本与迁移汇总

| Store | 版本变化 | 说明 |
| --- | --- | --- |
| attemptLineage | 新增 v1 | 硬容量 64；无自动驱逐；写入路径 Memory 权威发布 |
| receipts | v6 → v7 | proof level 三级显式；v5/v6 → v7 原子迁移 |
| resolutions | 保持 v6 | 驱逐资格规则变化（lineage replacement 注入查询），entry schema 不变 |
| intents / quarantine | 版本不变 | 新增可选 lineageBindingDigest（向后兼容；验证矩阵更新） |
| write-fault marker | v1 → v2（可选字段） | class-aware 身份；v1 兼容读取 |

## Operation-Count 结果（treasuryRound17OperationCount.test.ts，6/6）

- retired root prepare 门禁（20 次重复）：lineage fullScans 零增量（O(1) 索引）。
- child capability issuance：fullScans 零增量。
- tr1_ 无 capability 门禁（20 次探测）：fullScans 零增量。
- 空闲 beginTick（5 tick 连续）：fullScans 零增量 + idleFastPath 递增。
- chain generation 推进（A→B→孙代 issue）：entryCount 恒 1（不新增 slot）。
- retention 常规路径：lineage fullScans 零增量。

## 本地验证命令与真实结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 errors（build + test 两配置） |
| `npm run build` | dist/main.js 生成成功；无循环依赖警告 |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 46 suites / 867 tests / 867 passed / 0 failed |
| `npx jest --config jest.config.cjs`（全量） | 240 suites / 1573 tests / 1573 passed / 0 failed |
| `node scripts/verify-jest-budget.mjs` | 预算更新后通过（见独立 budget commit） |
| 真实 writer 文件 diff（resourceControl/marketDirectContinuousAutomation/marketSaleProtection/marketSaleProtectionAdapter/factoryControl/synthesisControl/nukerControl/terminalActionEnergyOwnership，4e032a6..HEAD） | **空**（零改动） |

## 边界声明

- **未部署**到 Screeps；**未合并 main**；未 reset/rebase/force push/amend 已推送历史。
- **未接入任何真实 Game writer**（无 terminal.send() / Game.market.deal() / lab / factory / nuker / creep 写 API 调用；resourceControl/market/carrier/lab/factory/nuker/synthesis writer 未迁移）。
- GitHub 当前无 CI——以上全部为**本地验证**真实结果，不声称 CI passed。
- Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once（本轮全部协议为 fail-closed 恢复语义，非 exactly-once）。

## 未勾选项（后续轮次）

terminal.send adapter 实现 / plan shadow / reconciliation shadow / 真实 terminal.send 执行 / ResourceControl writer / market writer / carrier-lab-factory writer / live CPU canary / 完整 Budget Service / ReceiverCapacityLedger 替换 / 旧库存系统删除——全部未开始。

## 进入下一阶段的判断

协议链路（lineage 权威 → capability 签发 → tr1_ 门禁 → 语义绑定 → bundle/intent 接管 → proof 链继承 → retention 联动）已完成且有测试覆盖，**纯协议层面**已具备进入 terminal.send adapter 实现 + 纯 contract plan shadow 的条件；authorization shadow 与 next-tick reconciliation shadow 依赖 adapter 的 durableFacts/reconciler 实际语义落地后再评估。**真实 Game API 调用（真实 terminal.send）不得仅因单元测试通过而批准**——需 adapter 实现 + shadow 阶段在观测层验证后单独决策。
