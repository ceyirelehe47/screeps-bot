# Round 10 — Durable Authority Cohesion & Bundle Atomicity 本地验证证据

- 日期：2026-08-30（本地时间）
- 分支：refactor/empire-treasury-rearchitecture
- 起始 HEAD：1ce0bad87f5b36f03f49f03afcc6252779b4b143（Round 9 预算锚点）
- 最终实现 commit：f331017（test: operation-count fixture）；证据与预算提交随后（见 commit 列表）

## 1. Commit 列表（1ce0bad..HEAD，线性、无 amend/rebase/force push）

| # | SHA | 主题 |
|---|-----|------|
| 1 | 23d52f7 | docs(openspec): 第十轮 durable authority cohesion 与 bundle atomicity 设计定义 |
| 2 | 01c723d | refactor(treasury): 拆分 execution outcome 与 settlement workflow（intent v3） |
| 3 | 9ff3343 | refactor(treasury): quarantine v2 完整合同事实与读回验证的事实转移协议 |
| 4 | 7858477 | refactor(treasury): opaque bundle、批量原子 redemption 与 writer kernel 封闭 |
| 5 | 61e80a1 | fix(treasury): contract digest AC3 绑定 durable reconciliation facts |
| 6 | 72a9829 | fix(treasury): intent 完整 identity 与幂等冲突检查 |
| 7 | a2b621f | test(treasury): 低层旧 intent 不被 production 接管的第一道防线用例 |
| 8 | 40f6f34 | refactor(treasury): resolution 移入 service 闭包权威与 capability 消费时点后移 |
| 9 | 04e51c7 | feat(treasury): Treasury-owned policy evaluation（注册制 policy resolver） |
| 10 | fb180f9 | refactor(treasury): 统一 write readiness 单一评估器 |
| 11 | 5708ac1 | fix(treasury): canonicalization 反射异常边界（Proxy trap 结构化拒绝） |
| 12 | f5c7f67 | fix(treasury): structure binding canonical authority 与 build 顶层异常边界 |
| 13 | f331017 | test(treasury): 第十轮 operation-count fixture——原子 redemption 线性与 readiness O(1) |

注：commit 4 为三项耦合实现（kernel symbol 通道是 bundle redemption 的载体），message 中分点说明。

## 2. 旧/新状态机对照

### intent：单一 phase（v2） → (outcome, settlement) 正交二元组（v3）

| 旧 phase（v1/v2） | 新 (outcome, settlement) |
|---|---|
| ready | (not_started, ready) |
| executing | (started_unknown, executing) |
| returned_non_ok | (returned_non_ok, pending_abort) |
| ok_pending_commit | (returned_ok, pending_commit) |
| committed | (returned_ok, finalized) |
| aborted | (aborted_final, finalized)（无歧义迁移终态，不冒充事实） |
| execution_unknown | (started_unknown, faulted) |
| quarantined | (started_unknown, quarantined) |
| resolution_pending | (started_unknown, resolving) |

- `progressTreasuryIntent` 一次原子写两轴；outcome 单调表内建（not_started→started_unknown→{returned_ok\|returned_non_ok}；其余边 `outcome_regression` 拒绝）；settlement 前序由调用方声明。
- **断链 2 修复**：OK 后 commit 故障/ok_pending_commit 写失败 → 升级写 `(returned_ok, faulted)`——不再降级 execution_unknown（facade ok-escalate 分支）；quarantine 写失败时 intent 保留 outcome=returned_ok（跨多次 recovery 单调，新增用例验证）。
- 未知旧 phase → store fatal（v1→v3 迁移 fail closed，用例验证全表映射与 mystery_phase 拒绝）。

### quarantine：v1 最小事实 → v2 完整合同事实

v2 entry 新增：outcome/settlement/contractId/contractDigest/actionKind/adapterVersion/durablePayload(+Version)/authorizationDigest/ownerIdentity/policyIdentity/structureFacts（≤16 数组）/legacyV1 标记。迁移：phase 单调推导 outcome、并存 intent 合同字段合并（digest 不一致 fatal）、无并存标记 legacyV1（不参与 contract-backed resolution）。

## 3. Durable authority 迁移

- **事实转移协议** `transferTreasuryIntentToQuarantine`：intent 全部事实原子写入 quarantine v2 → **读回验证一致**（digest/postings/outcome/contractDigest/adapterVersion/durablePayloadVersion）→ 才释放 intent；写入被拒/读回不一致 → intent 保留（emergency）。facade 两处转换入口与 beginTick 恢复统一走此协议。
- recovery slot：`|intentIds ∪ quarantineIds|` 去重（快速路径 O(1)——单一 store 非空时零扫描；双存在罕见路径才求交集）。
- 双权威一致性：digest/kind/postings + **contractDigest/adapterVersion**（双方都在时）不一致 → fail closed（用例验证）。
- adapter version 演进：capability 签发检查 authority.adapterVersion vs registry 当前 version → `adapter_version_mismatch` 拒绝（用例验证）。
- global reset 重建：quarantine v2 自带全部 reconciler 输入（contract 路径用例验证 reset 后 facts 完整）。

## 4. Bundle capability 模型

- opaque 句柄（`{__brand}` only）——生产调用者不可读 legs/cohort；service 闭包 `bundleRecords: WeakMap<object, BundleRecord>` 对象身份验证；JSON round-trip/手工构造/裸 token/token 数组在 `resolveAuthorizationBundle`/`redeemAuthorizationBundleAtomic` 一律拒绝（用例验证）。
- cohort 字段：tokens/contractId/contractDigest/transactionId/actionKind/adapterVersion/ownerIdentity/policyIdentity/revisions（五元）/serviceGeneration/tick/authorizationDigest（hash 签发序号唯一化）。签发路径结构性保证同源 + 逐字段防御校验（修订记录：初版按对象引用比较 revisions 误判，已改逐字段比较——commit 7858477 内）。
- 生命周期：active → redeemed（单次）；跨 tick/generation/revision cohort/policy 变化失效（各有用例）。

## 5. 批量 redemption 原子性

`redeemAuthorizationBundleAtomic`（facade 闭包）：只读预验证（registry 身份/cohort/contract 匹配/全部 legs 联合覆盖）→ staged 发布（逐 leg 预算减少与消费；guard 注入点 first_leg/middle_leg/last_leg/before_budget_publish/before_tentative_handoff/before_bundle_state）→ 成功 `record.state="redeemed"`；任一注入/异常 → **前缀完整回滚**（预算/容量/消费标记恢复、bundle 保持 active、tentative 不残留）+ `internal_authorization_fault` marker 阻断后续 writer（审计要求显式确认）。注入矩阵用例（六 stage × 断言回滚+阻断）与正常路径恰好一次（budget→tentative 单次、legs 全消费）用例验证。不再循环调用单 token consume。

## 6. Writer kernel 边界

- 公共 `TreasuryService` 类型移除 7 个低层方法（authorizeResourceUse/validateTreasuryAuthorizationForRedeem/consumeTreasuryAuthorization/prepareTransaction/executePreparedAction/commitPreparedTransaction/abortPreparedTransaction）。
- kernel 经 `kernelChannel.ts` 的 unique symbol `TREASURY_WRITER_KERNEL` 以 non-enumerable 属性挂载（运行时枚举零暴露）；actionContracts 经 kernel 调用；`testHarness.ts` 提供测试视图（`treasuryTestService`，kernel symbol 同步挂载支持嵌套）。
- 架构测试新增规则：非 treasury 生产模块不得引用 kernelChannel/testHarness/TREASURY_WRITER_KERNEL；测试只允许经 testHarness（直接引用 kernelChannel 即违规）。生产实际调用面（runtimeServices/main/shadow）零改动验证。

## 7. Contract identity（AC3）与 test vectors

- digest 格式：`AC3:ce:{encodingVersion}:k:…:av:…:t:…:a:…:p:…:s:…{durableText}`；durableText = `:dfv:{version}:dfh:{payloadHash}:rcv:{version}` 或 `:df:none`。
- durable payload/version 变化 → digest 变化；相同 facts → 确定性 digest（vector 用例）；提供 reconciler 的 adapter 缺 durableFacts → contract 构建拒绝。
- contractId = `ac:${digest}`（派生保证一一对应）。

## 8. Intent identity 与幂等冲突

- read-back 完整元组：digest/outcome/settlement/postings/contractId/contractDigest/adapterVersion/authorizationDigest/durablePayload(+Version)——任一不同 → `intent_conflict`（新 rejection reason；区别于 store 不可信）。
- contract 路径 authorizationDigest 实际写入（actionContracts → execution.intentContract → writeTreasuryIntentEntry）。
- 低层 test path 同 ID 旧 intent：第一道防线 unresolved blockers 阻断（intent_write_blocked，用例验证 + 原样保留）。

## 9. Resolution：service-private 与 capability 消费时点

- 对外入口 `TreasuryService.resolveUnresolvedTransaction`（capability 结论自动路由 committed/not-executed）；faultResolution kernel 经 WeakSet 注册（`registerTreasuryResolutionKernelForService`——结构兼容伪 service 无效，用例验证）。
- 顺序：只读身份/tick/generation/未用验证（`validateReconciliationCapability` 零消费）→ stores 健康 → authority 解析 → **contract-backed 强匹配**（contractId/contractDigest/adapterVersion/durablePayloadVersion 双方必存在且一致——弱 optional 检查删除）→ 时序/evidence → slot → staged resolution 写入 → **此时消费** → 状态转换。前置失败不烧 capability（intent store fatal 后同 capability 重试成功用例）。
- staged 写入后跨 reset 仅凭 durable staged state 恢复（第九轮 staged 机制保留）。

## 10. Policy 模型

- `policyAuthority.ts`：注册制 resolver（policyId/policyVersion/evaluate→{withhold, strategicReserve, emergencyOverride, digest}）；内置测试 policy：no-reserve/fixed-reserve/emergency-override；test/setup.ts 全局 beforeEach 注册默认。
- production 授权：options.withhold 删除且携带即拒；无 resolver → `policy_not_ready`；bundle policyIdentity=`{policyId}@v{version}:{决策摘要排序拼接}`；redemption 校验当前 authority 前缀一致（policy 变化 → `policy_invalidated`）。

## 11. Write readiness 单一权威

- `writeReadiness.ts`：`evaluateTreasuryWriteReadiness` 纯函数（20 项输入、20 个 blocker 枚举按优先级）。
- 使用方：query 的 writeAdmission 视图 + contract authorization 前置（`authorizeReadiness`）；prepare 保留独立复查（TOCTOU）。receipt 满载时三处同一 blocker、恢复后一致放行（用例验证）。

## 12. Structure binding 与 canonical 边界

- identity 判别：governed_location（room:loc）/ game_object（objectId+expectedType+expectedRoom，构建与执行前双验——mock 增加 Game.objects/getObjectById）；label 仅诊断。
- 重合：同 identity 合并（posting 权威）；同 label 不同 identity 拒绝（用例）；required structure 构建时必须存在（undefined 拒绝）；null-prototype 快照容器（`__proto__` 为自有键用例）；structure facts 变化 → digest 变化（用例）。
- canonicalization：全部反射操作统一异常边界（revoked/throwing trap → `reflection_fault` 结构化拒绝；ancestors 异常路径对称弹出；getter 零调用保持）；build 顶层 `canonicalization_fault`（registry/授权零变化）；7 个 Proxy 用例。

## 13. 新增/升级 Memory 字段、版本、上限与清理规则

| store | version | 变化 | 上限/清理 |
|---|---|---|---|
| intents | 2→3 | phase → outcome+settlement；新增 structureFacts?（≤16）/ownerIdentity?/policyIdentity?（≤128）；v1/v2 → v3 保守单调迁移（未知 phase fatal） | 上限 64 不变；恢复按 (outcome, settlement) 分级释放/转移 |
| quarantine | 1→2 | 新增 outcome/settlement/合同字段 10 项 + legacyV1?；v1 原子迁移（并存 intent 合并/legacy 标记） | 上限 64 不变；retention 语义不变（仅显式 resolution 释放） |
| write-fault phase 枚举 | — | 新增 internal_authorization_fault（redemption 中断——状态已回滚、marker 阻断直至显式确认） | detail ≤192 不变 |
| write-fault markers | — | 新增 policy_not_ready（授权 reason）/ intent_conflict（prepare reason）/ internal_authorization_fault（prepare reason + fault phase）/ adapter_version_mismatch（capability 签发 reason） | — |

不持久化：bundle registry/legs（heap WeakMap）、policy registry（heap）、redemption 注入器、resolution kernel 注册（WeakSet）。memoryDeclarationBoundaries 指纹更新（bb7ceec1→d2b6af81→79ddc16e，随 store schema 变更两次）。

## 14. 性能 operation counts（确定性计数器）

- 批量原子 redemption（多资源 U+fee 执行 ×3）：quarantine/intent/receipt fullScans 增量 **0**（零全表扫描；staged 发布不引入扫描）。
- 统一 readiness（query ×5 + authorize ×5 循环）：fullScans 增量 **0**（O(1) 基于缓存 health/counters；authorize 全部成功——无误报 blocker）。
- 既有第九轮 fixture（bundle 预验证线性、512 receipt 零扫描）保留通过。

## 15. 实际验证命令与结果（本地）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc -p tsconfig.json --noEmit 零错误） |
| `npm run build` | 通过（dist/main.js created；bundle sha256 见构建输出） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 25 suites / 514 tests 全通过 |
| `npx jest --config jest.config.cjs` | 219 suites / 1220 tests / 1220 passed / 0 failed |
| `node scripts/verify-jest-budget.mjs` | 见第 17 节（预算提交后 PASSED） |

定向补充（本轮新增覆盖）：durable authority cohesion（quarantine v2 facts/转移读回/v1 迁移/slot 去重/双权威/版本演进 6 用例）、outcome 单调（OK+quarantine 写失败保留 returned_ok/回归拒绝/全集映射 5 用例）、opaque bundle（伪造/JSON 副本/单次/跨 tick/generation/注入矩阵 14 用例）、AC3 vectors（2）、intent identity（3）、resolution 闭包（2）、policy（5）、readiness（2）、structure binding（5）、Proxy（7）。

## 16. 基线到 HEAD 的 diff stat 与真实 writer 检查

- 1ce0bad..HEAD：13 个实现 commit（见第 1 节）。
- **八个真实 writer 文件零改动**（git diff 为空验证）：
  src/runtime/resourceControl.ts、marketDirectContinuousAutomation.ts、marketSaleProtection.ts、marketSaleProtectionAdapter.ts、factoryControl.ts、synthesisControl.ts、nukerControl.ts、terminalActionEnergyOwnership.ts
- git status 干净（除本证据与预算提交外）。

## 17. 测试预算

- 本轮前基线：219 suites / 1181 tests（Round 9 锚点 1ce0bad）。
- 本轮后：**219 suites / 1220 tests**（净增 39 tests，全部为新增覆盖——无删除、无 .skip/.only/.todo、无断言语义削弱；既有断言随语义升级同步修改并注明【第十轮】标记）。
- 预算流程：实现+测试全部提交（f331017）→ 全量验证通过 → 独立预算提交更新 requiredBaselineCommit/requiredTarget。

## 18. 边界与声明

- **未部署**：未向 Screeps（ptr/live）推送任何代码；未修改线上配置。
- **未合并 main**：分支 refactor/empire-treasury-rearchitecture 保持线性，未 reset/rebase/force push/amend 已推送历史（commit 7858477 的一次 amend 发生在推送前，用于移除误入的临时脚本文件——该 commit 从未出现在远端）。
- **未接任何真实 Game writer**：八个生产 writer 文件零改动；本轮全部验证基于 test adapter（test.transfer/test.three 等 fixture）。
- **无 CI**：仓库无 CI 配置——以上全部为**本地验证**结果，不声称任何远端流水线背书。
- **Screeps hard CPU interruption / Memory flush 边界**：硬中断下跨 tick 的 execution facts 仍不保证 exactly-once（协议保证的是 durable 事实单调与 fail-closed 恢复，不是 exactly-once 执行）。

## 19. 残余风险

1. bundle redemption 的 staged 发布在同步实现内逐 leg 发布后回滚——"理论不可达"的中间态依赖同步窗口无并发源（与第九轮相同前提）；注入测试覆盖回滚正确性，但真实运行时不存在此类中断源验证。
2. policy resolver 注册边界当前由 test setup 装配；生产 policy 装配路径（Budget Service 延期）尚未设计——生产部署前必须补生产 policy 注册审计。
3. object-ID binding 经 `Game.getObjectById` 验证（mock 注入对象表）——真实 Game 对象的 structureType/room 归属与 mock 形状的一致性在接入第一个真实 writer 时才能端到端验证。
4. readiness 的"prepare 独立复查"仍沿用既有 prepare 检查链（未替换为评估器调用）——三处 blocker 枚举已统一，但 prepare 分支的 reason 字符串与评估器 blocker 名的完全对齐留待后续轮（当前测试覆盖 query/authorize 一致性）。
5. emergency override policy 仅建立 identity/审计通道——其语义学（何时允许 override 谁）未定义，接真实 writer 前需要 policy 设计阶段。

## 20. 阶段判断

第十轮十二项断链全部关闭（验收条件 1-25 逐项满足：见 tasks.md 第 16 节与上文的用例映射）。**已具备进入"第一个低风险 writer 的 adapter 与 shadow 设计阶段"的条件**——建议 terminal.send（postings/fee/durable facts 语义已在 test.transfer fixture 中完整演练；前置条件：真实 reconciler 的 post-observation 差异判定与 shadow 期采样设计）。以本轮 HEAD 为基线。

## 20. 第十一轮修正（2026-08-31）

上一节"commit 7858477 的一次 amend 发生在推送前，用于移除误入的临时脚本文件"的陈述**不准确**：该次 amend 只移除了 newsrc-exec-redeem.txt 与 patch-bundle-*.cjs；一次性文本替换脚本 `src/runtime/treasury/fix-ac3.cjs`（写死本地 Windows 路径）当时**未被移除**并随 commit 7858477 进入远端，同类脚本 `src/runtime/treasury/fix-resolution.cjs` 亦在仓库中。两个文件已于第十一轮删除（见 round11 evidence 的清理记录）；历史提交事实不做任何篡改。
