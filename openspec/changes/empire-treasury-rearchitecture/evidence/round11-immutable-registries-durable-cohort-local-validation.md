# Round 11 — Immutable Registries & Durable Cohort Closure 本地验证证据

日期：2026-08-31 · 分支：refactor/empire-treasury-rearchitecture · 全部为**本地验证**（仓库无 CI，不声称任何远端流水线背书）。

## 1. 基线与终态

- 起始 HEAD：`ee12f7de284d0e8c598a631fdf128cdc6d95961d`（Round 10 终态；`git fetch --all --prune` 后确认与远端一致）
- 最终 HEAD：见第 21 节推送记录
- 基线测试预算：219 suites / 1220 tests

## 2. Commit 列表（线性，均可独立回滚）

| commit | 作用 |
|---|---|
| `d2f069a` | docs(openspec)：第十一轮范围定义（proposal/design 3.13/spec 11 Requirement/tasks 17） |
| `d2f5eef` | refactor：adapter/policy registry 不可变快照注册 + Treasury 计算 policy digest（18 用例） |
| `b8fa20d` | refactor：AC4 完整 structure descriptor 进 contract 与 durable authority（v4/v3 迁移，5 用例） |
| `845d881` | feat：持久化 canonical authorization cohort 与 cohort digest（3 用例） |
| `899af55` | refactor：统一 immutable durable action identity 全 store 比较（identity_conflict，5 用例） |
| `c8798ba` | fix：pre-execution authorization fault 可恢复 durable authority 与恢复协议（5 用例） |
| `471059c` | fix：outcome/settlement/phase 语义矩阵与 cross-store finalized proof（5+4 用例） |
| `116aafe` | fix：隔离 legacy quarantine 不使用当前 reconciler（4 用例） |
| `8fe4609` | refactor：resolution 内部经 symbol kernel 通道彻底封闭（公共面收缩） |
| `2cde8f8` | refactor：facade 职责拆分为四个内部权威模块（行为保持） |
| `98149c2` | chore：删除 fix-ac3.cjs/fix-resolution.cjs + Round 10 evidence 修正 |
| `c4b01a3` | test：第十一轮 operation-count fixture |
| （本提交） | docs(evidence) + chore(test-budget)：证据与预算锚点 |

## 3. Registry 模型

- **adapter registry**（actionContracts.ts）：注册时快照固定全部函数引用并冻结两层 record（内部 record 含 registryGeneration/registeredAtTick；`findTreasuryActionAdapter` 只返回冻结公开视图——读 API 不泄漏内部 record）。同 kind+version：同实现幂等、不同实现拒绝；同 kind 更高 version 合法演进（registrationId 变化 → 旧 contract 因 registration identity 失效）、更低 version 拒绝。`sealTreasuryAdapterRegistryForProduction()`（runtimeServices.ts 生产装配调用；测试 unseal 通道在 clearTreasuryPersistenceForTest）。全部 adapter 函数异常边界：validate/derivePostings/structureBindings/durableFacts 抛错 → `adapter_fault(op)` 结构化拒绝零 callback；execute 抛错走 execution unknown；reconcile 抛错 → `reconciler_fault` capability 拒绝且 authority 隔离。
- **registration identity**：`registrationId = hash(adapter:kind:version:seq)`；contract 绑定 `adapterRegistrationId`（verify/execute 双点校验）；AC4 digest 输入含 `ar:{registrationId}`。registry revision（成功注册计数）暴露 `readTreasuryAdapterRegistryRevision()`。
- **policy registry**（policyAuthority.ts）：policyVersion 正安全整数强校验；同 policyId+version 不同 evaluate 引用拒绝；可 seal。decision 接口**删除自报 digest**——resolver 只返回 `{withhold, strategicReserve, emergencyOverride, auditReason?}`；`computeTreasuryPolicyDecisionDigest(registration, canonicalContext, decision)` 由 Treasury 计算（context 绑定 contractId/contractDigest/actionKind/resource/sorted rooms/ownerIdentity/tick/registrationId）。evaluate 抛错 → `policy_fault` fail closed；非法 decision 字段结构化拒绝。bundle redemption 验证 exact registration identity（registrationId 比对；字符串前缀比较已删除）。

## 4. Authorization cohort

`TreasuryAuthorizationCohortFacts`（authorization.ts）：ownerIdentity、policyId/policyVersion/policyRegistrationId/policyDecisionDigest（排序拼接）、emergencyOverride、epochSeq、五元 revisions（commitment/projection/quarantine/intent/reservationStore）、adapterRegistrationId、contractId/contractDigest、transactionId、authorizationLegDigests（≤8，`canonicalTreasuryAuthorizationLegDigest`：resource/sorted rooms/sorted locations/amount——不持久化 heap token）、receiverCapacityDigest（capacityRequirement canonical 或 "none"）、issuedTick、authorizationDigest。`computeTreasuryAuthorizationCohortDigest` 覆盖全部字段——owner/policy decision/emergency override/revision/legs/receiver capacity/contract 任一变化 → digest 变化。持久化位置：intent v4 / quarantine v3 entry（`authorizationCohort` + `authorizationCohortDigest`，完整形状校验 + 深拷贝封闭）；unresolved authority facts、reconciliation capability（`authorizationCohortDigest` 绑定）、faultResolution prevalidation（强匹配 `reconciler_mismatch`）。

## 5. Full durable identity

`durableIdentity.ts`：`computeTreasuryDurableIdentityDigest`（transactionId/canonical digest/contractId/contractDigest/adapterRegistrationId/actionKind/canonical postings/完整 structure descriptors/durable payload+version/authorizationCohortDigest/ownerIdentity/policyIdentity/source——outcome/settlement 是可变 workflow 事实**不进** identity）+ `treasuryDurableIdentitiesMatch`（空对空匹配、空对非空 conflict）。统一比较点：intent 首写同 ID 幂等（不同 → `identity_conflict`，store 原数据不动）、read-back（facade 统一 identity 验证，reason 从 intent_conflict 升级为 identity_conflict）、intent→quarantine 转移读回、quarantine 写入幂等、双权威一致性（都携带时必须一致 → inconsistent fail closed）、capability 签发绑定（`durableIdentityDigest`）与 resolution prevalidation 强匹配。legacy entry（迁移无法补全）identity 为空——空对空才匹配。

## 6. Pre-execution fault

`authorizationFaults.ts`：`Memory.runtime.treasury.authorizationFaults`（version 1、key `"af:"+txId`、上限 64、load 全量验证 fail closed）。redemption 注入故障回滚后、写 marker 前写入 `{transactionId, digest, contractId/contractDigest, actionKind, authorizationDigest, authorizationCohortDigest, postings ≤32, faultTick, outcome:"not_started", rollbackConfirmed:true, source, detail}`。恢复协议（`resolveUnresolvedTransaction` 路由 → resolutionAuthority.resolvePreExecutionAuthorizationFault）：authority 命中时要求显式 `acknowledgeRolledBack: true`（无任何无条件解除入口）+ digest 完整验证 → 写 not-executed final tombstone（`preExecution:true`）→ 清 marker → 删 authority；幂等（final tombstone 存在即 already_resolved 并补齐清理）；global reset 后仍可完成；其他 commit/execution fault 走 capability 路径不受影响。write readiness 新增 `authorization_fault` blocker（与 marker 同生命周期）。

## 7. Semantic matrix 与 cross-store proof

`semanticMatrix.ts`（零依赖）：`TREASURY_INTENT_SEMANTIC_MATRIX`（not_started ∈ {ready, finalized}；started_unknown/returned_non_ok/returned_ok ∈ {executing|pending_abort|pending_commit, faulted, quarantined, resolving, finalized}；aborted_final 仅 {finalized}）+ quarantine phase→outcome 单调推导校验（允许 returned_ok/returned_non_ok 事实保留不降级）。接入：progressTreasuryIntent 目标组合校验、intent/quarantine entry 形状校验（load 全量验证 + 写入重验）——非法组合 store fatal → readiness=false、authority 签发/resolution 拒绝。cross-store finalized proof（recoveryCoordinator.checkTreasuryFinalizedProof，beginTick 恢复注入）：finalized+returned_ok 须 settled receipt 或 final committed tombstone；finalized+其余须 final not-executed/rolled-back tombstone（preExecution 计入）；proof 缺失 → semantic store fault（entry 保留不释放）——"看到 finalized 就直接释放"的第九轮行为已移除。

## 8. Legacy authority

quarantine v3 保留 `legacyV1` 标记。capability 签发遇 legacyV1 → `legacy_authority_isolated` 拒绝（不用当前 adapter reconciler 解释）；faultResolution prevalidate 防御拒绝（即使经其它通道到达）；只读诊断 `treasuryLegacyQuarantineDiagnostics()`（冻结快照，零写入）；新 adapter version 不解释 legacy action 的 version mismatch 防线保持；迁移不伪造 contract/cohort identity。

## 9. Resolution 公开/私有边界

公共 TreasuryService 仅保留 `issueTreasuryReconciliationCapability` + `resolveUnresolvedTransaction`（+ 生命周期/read/query/metrics）。`consumeReconciliationCapability`/`treasuryServiceGeneration`/`treasuryResolutionGuard` 从公共接口与公共白名单删除（generation 计数器内部化改名且源码全文零残留）。注：`consumeReconciliationCapability` 之名仍以两处**闭包内部**形态保留——internalService 对 resolutionAuthority 的委托方法与 TREASURY_RESOLUTION_KERNEL symbol 通道定义（即封闭通道本体）——公共类型与运行时枚举均不可达，架构测试守护（treasuryServiceGeneration/treasuryResolutionGuard 全文断言为零）。resolution kernel 经 `resolutionKernelChannel.ts` 的 unique symbol（non-enumerable）挂载 service 运行时对象；faultResolution 的模块级 WeakSet 注册机制删除（`registerTreasuryResolutionKernelForService` 不复存在）——resolve 函数从持有对象读取 symbol kernel，伪造对象无该属性一律拒绝。架构测试：resolutionKernelChannel/TREASURY_RESOLUTION_KERNEL 引用白名单仅 facade/faultResolution/testHarness/resolutionAuthority + facade 源码不得出现被移除方法名。testHarness 视图展开 validate/consume（测试专用）+ symbol 重挂。capability 消费仍只在 staged resolution 写入成功后。

## 10. Structure descriptor（AC4）

`TreasuryActionStructureBinding` 升级：bindingKind（缺省按 objectId 推导）/role（source/target/fee_source/production_structure/auxiliary 受控枚举，缺省 auxiliary）/required（缺省 true；optional 缺失跳过不进 descriptor）。posting 自动 binding role 由 delta 符号派生（负腿 source、正腿 target）；descriptor 唯一性 key = (identity, role)——同结构不同 role 保留两条不静默合并；默认 label 带 role 后缀；同 (identity, role) 重复声明拒绝。AC4 digest 输入：完整 descriptor canonical 文本（全字段长度前缀 + incarnation）+ adapter registrationId。`TreasuryActionContract.structureDescriptors`（排序冻结）→ intentContract.structureFacts（完整形状持久化）→ intent v4/quarantine v3（v3 三元组迁移补全 governed_location/auxiliary/required/v1，不伪造缺失字段）→ durable identity 输入 → reconciler facts（`TreasuryActionReconcilerFacts.structureDescriptors`）。

## 11. Facade 拆分

| 模块 | 职责 | 大小 |
|---|---|---|
| authorizationLedger.ts | token registry + 预算簿记 + bundle registry/签发 + 批量原子 redemption（staged 发布/前缀回滚/pre-execution fault 写入）+ 只读解析 + legs 预验证 | ~27KB |
| resolutionAuthority.ts | capability registry + validate/consume + resolution kernel 组装 + pre-execution 恢复 | ~8KB |
| recoveryCoordinator.ts | fault marker + intent→quarantine 转移协调 + finalized cross-store proof | ~6KB |
| readinessCollector.ts | write readiness 状态收集器（sources 一次装配；query/authorize 共用，query 局部缓存经 overrides 复用） | ~4KB |

facade.ts 163KB（原 172KB）：保留生命周期编排、prepared handle registry、executePreparedAction 执行顺序、公开 read/query facade 与模块组装；原闭包函数为模块委托壳——**不再直接持有 bundle Maps/capability WeakSets/预算表**。依赖方向单向（actionContracts 对 facade 是 type-only import）；无新循环依赖。行为保持：既有断言不改即通过（全量 223 suites 全绿）。

## 12. 删除的临时文件与 evidence 修正

- 删除 `src/runtime/treasury/fix-ac3.cjs` 与 `src/runtime/treasury/fix-resolution.cjs`（Round 10 开发期一次性文本替换脚本，写死本地 Windows 绝对路径；`.cjs` 不在架构测试 `.ts` 扫描范围即其残留原因）。Round 10 evidence 第 20 节如实修正：fix-ac3.cjs 当时未被 amend 移除并误入远端 commit 7858477，于本轮删除；历史提交事实不篡改。
- 本轮开发期临时 patch 脚本（patch-*.cjs）全部用后即删（工作树与 commit 中均无）。
- 绝对路径扫描：src/ 与 scripts/ 无写死本地路径文件；`monitor-data/set-canary3-config.cjs` 为既有 canary 运维配置工具（读 .env token 设置线上 Memory，无 token 明文、非源码修补脚本，属运维证据链——保留）。

## 13. Store 版本与容量

| store | version | 上限 | 说明 |
|---|---|---|---|
| intents | 4（v3→v4 原子迁移） | 64 | structureFacts 完整 descriptor + authorizationCohort/Digest + durableIdentityDigest |
| quarantine | 3（v2→v3 原子迁移） | 64 | 同上字段集 + legacyV1 标记保留 |
| authorizationFaults | 1（新） | 64 | pre-execution not-started authority |
| resolutions | 2（+preExecution 字段） | 256 | pre-execution tombstone 标志 |
| receipts | 3（未变） | 4096 | — |

清理规则：fault authority 随 acknowledge resolution 删除；intent 随正常关闭/release 或 proof 验证后释放；quarantine 随显式 resolution；authorizationFaults entry 与 marker 同生命周期。memory 声明边界指纹更新为 `5e589b252ad2cb1fb3782626a4e7c9ce205aa17797e42c93266b12ae10b08027`。

## 14. Operation counts

- registry lookup/revision：32 次 `findTreasuryActionAdapter` + revision 读取——零 store 扫描、revision 不变（O(1)）。
- 正常写路径（build→authorize→execute × 6 + query 视图）：intent/quarantine `fullScans` 增量为 0（cohort facts 构造与 durable identity 计算只读 bounded facts，与 leg/posting 数线性）。
- 既有 fixture 保持：write-admission/blocker/fault-slot O(1)、bundle 预验证与 token/posting 数线性、授权/prepare 不全表扫描。

## 15. 验证命令与结果（真实输出）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（build + test 两配置零错误） |
| `npm run build` | 通过（dist/main.js 31.3s，bundle sha256 52f3afef…） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 29 suites / 562 tests 全通过 |
| `npx jest --config jest.config.cjs` | 223 suites / 1268 tests / 1268 passed / 0 failed |
| `node scripts/verify-jest-budget.mjs` | JEST_TEST_BUDGET=PASSED（见第 16 节） |

- 真实 writer 零接入：八个生产 writer 文件（resourceControl/marketDirectContinuousAutomation/marketSaleProtection/marketSaleProtectionAdapter/factoryControl/synthesisControl/nukerControl/terminalActionEnergyOwnership）自基线 ee12f7d 起 `git diff --numstat` 为 0 行。
- `git status` 干净（全部改动已成 commit）；`git log` 线性无 merge。

## 16. 测试预算

- 基线：219 suites / 1220 tests（requiredBaselineCommit=3401ea7 时代）。
- 本轮实现+测试全部提交后（evidence 前一 commit）：223 suites / 1268 tests / 0 failed（净增 4 suites / 48 tests；无删除/.skip/.only/发现范围收缩）。
- 预算更新：`monitor-data/apply-budget-treasury-round11.mjs`（27 个 treasury 高风险文件硬校验 223/1268）→ `scripts/verify-jest-budget.mjs` requiredBaselineCommit 指向含全部实现与测试的前置 commit、requiredTarget 223/1268 → `JEST_TEST_BUDGET=PASSED` → 独立预算提交。

## 17. 新增/升级测试覆盖（十六节对应）

- internal fault recovery 8 项：注入回滚/callback 零调用（既有矩阵保持）/durable authority 建立/global reset 持久/acknowledge 解除（marker+authority 双清+tombstone preExecution+writer 恢复）/digest 不匹配拒绝且 authority 保留/其他 fault 不可用该通道/重复 resolution 幂等。
- adapter registry 12 项：原对象 execute/reconcile 修改不影响 registry、同 kind+version 拒绝、同实现幂等、更低 version 拒绝、更高 version 旧 contract 失效、test-only replace 新 registrationId 失效、seal/unseal、读 API 冻结不泄漏、validate/derive 抛错结构化拒绝、reconcile 抛错隔离、同 record identity。
- policy registry 10 项：原对象修改不影响、同 ID+version 拒绝、version 非法、evaluate 抛错 fail closed、decision 字段非法拒绝、registration 变化 bundle 失效、决策变化 digest 变化、emergency 进 identity、seal。
- cohort 6 项：unsettled 路径进 quarantine + capability 绑定同 digest、fault 路径全事实 + global reset 可读、policy 决策/receiver capacity/leg 事实变化 digest 变化。
- full identity 8 项：intent/quarantine 同 ID 冲突与幂等、legacy 空对空、双权威不一致、contract 路径 identity 持久化与 capability 绑定、identity 输入敏感性（owner/policy/cohort/payload/source/descriptor）与 workflow 事实不进。
- semantic matrix 5+4 项：progress 组合拒绝、三类非法组合 store unhealthy + readiness、quarantine phase/outcome 矩阵、finalized proof 两态与幂等（durableIntent 终态残留用例升级四态）。
- legacy 4 项：capability 隔离拒绝、version mismatch 防线、只读诊断零写入不伪造、resolution 防御。
- resolution privacy 1 项综合：生产 service 运行时枚举无内部方法、symbol non-enumerable、普通对象无 kernel 拒绝（+架构规则）。
- descriptor 5 项：role/objectId/expectedType/expectedRoom digest 敏感性、同结构双 role 不合并、optional 跳过/required 拒绝、durable 保留与 global reset、reconciler 收到完整 descriptor、v3 迁移。
- facade decomposition：行为保持（既有断言不改全绿）+ 架构白名单阻止绕过。
- cleanup 3 项：fix-ac3/fix-resolution 不存在、evidence 一致、无源码修补脚本残留（人工 + 扫描确认）。
- operation-count：r11 fixture（见第 14 节）。

## 18. 未部署声明

- 未向 Screeps（ptr/live）推送任何代码；未修改线上配置；未接任何真实 Game writer。
- 未合并 main；未 reset/rebase/force push/amend 已推送历史。
- GitHub 无 CI：以上全部为本地验证。

## 19. Screeps 边界

hard CPU interruption / Memory flush 边界下跨 tick execution facts 仍不保证 exactly-once（协议保证 durable 事实单调 + fail-closed 恢复，不是 exactly-once 执行）。

## 20. 残余风险

1. pre-execution fault authority 的容量上限（64）满载时写入 rejected——marker 仍写（fail closed），但恢复协议需先释放既有 entry（人工审计序列）；未实现自动驱逐。
2. 语义矩阵使历史损坏数据的 store fatal 更严格——线上若存在 Round 10 前的非法组合残留数据，首次 load 将 fail closed（需显式 repair；这是设计要求的行为，但运维上需知晓）。
3. `authorizationFaults` store 与 write-fault marker 双持久化在 hard interruption 窗口内可能单侧缺失（marker 无 authority 或反之）——恢复协议对无 authority 的 marker 仍锁死（保守），对无 marker 的 authority 由 blocker 拦截。
4. facade 拆分后 authorizeResourceUse 的授权计算主体仍在 facade（预算簿记已入 ledger）——"authorization ledger 不再由 facade 直接持有"的验收以 Maps/registry 所有权为准。
5. AC4 digest 与 Round 10 的 AC3 向量不兼容（编码前缀升级）——跨轮持久化的旧 contract 只在同 tick 有效，实际影响为零，但向量基线已重置。

## 21. 推送

`git push origin refactor/empire-treasury-rearchitecture`（线性提交，见第 2 节；远端 HEAD 见推送输出）。

## 22. 阶段判断

第十一轮完成后，Treasury 协议栈已具备进入**第一个低风险 writer 的纯 contract generation shadow** 的条件：immutable registry/seal、AC4 descriptor、durable cohort 与统一 identity、语义矩阵与 cross-store proof、封闭的 resolution/kernel 通道、pre-execution fault 可恢复性均已落地并被确定性测试覆盖。建议顺序：terminal.send 纯 contract plan shadow（不执行）→ authorization shadow（bundle 签发与 redemption 演习）→ reconciliation dry-run（真实 reconciler 的 post-observation 差异判定设计）。**真实 Game API shadow execution 尚不批准**：需要 shadow 期采样证据（contract/receipt/quarantine 的实际分布）与 real reconciler 的差异判定验证，不能仅凭单元测试通过批准。
