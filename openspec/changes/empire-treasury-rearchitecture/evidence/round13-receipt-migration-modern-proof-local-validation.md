# 第十三轮 Receipt Migration Safety & Modern Proof Strictness 本地验证证据

- 日期：2026-08-31（本地验证；仓库无 GitHub CI——全部为本地命令的真实输出）
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD（本轮基线）：`b901003087fde0755e0e553e31917f2e868d33b7`（第十二轮 evidence 提交）
- 预算基线核对：起始 `test/test-suite-budget.json` 声明 224 suites / 1299 tests / commit `7ebd7d7`——与提示词预期一致，未覆盖。

## 1. 最终 HEAD 与 commit 列表

最终 HEAD（实现与全部测试，预算提交之前）：`5aa098b`（其后为本 evidence 提交与预算锚点提交）。

| commit | 作用 |
| --- | --- |
| `ea47571` | docs(openspec)：第十三轮规范（proposal Round 13 / tasks 19 / spec 6 Requirement+12 Scenario / design 3.15） |
| `597c83b` | fix(treasury)：统一 receipt normalized lookup + receipt v5 显式 proof 等级（admission already-settled 命中修复、v1-v4 迁移定级、Memory schema v5） |
| `46ba8da` | fix(treasury)：already_settled 零发布终态 + identity-aware commit 细化（compat/staged 路径、post-callback 防御段 proof 比较） |
| `251c4ec` | fix(treasury)：receipt refresh 身份感知 + staged recovery 只接受 identity match（conflict/insufficient 独立计数） |
| `e85e8bd` | refactor(treasury)：集中异常安全 cohort validator（cohortValidation.ts，三 store 共用，重算 Result 化） |
| `2f57304` | refactor(treasury)：集中持久 structure descriptor 校验（structureDescriptorValidation.ts，discriminated union） |
| `b6024d4` | refactor(treasury)：显式 modern/legacy/forensic/lowlevel authorityLevel + modern required 字段矩阵（intent v5 / quarantine v4 / authorization-fault v3） |
| `f9d1461` | fix(treasury)：forensic marker 与 resolution tombstone 绑定完整 attempt identity |
| `5aa098b` | test(treasury)：第十三轮 49 个确定性测试（两个新测试文件） |

## 2. Receipt 语义

### 2.1 版本迁移表

| 版本 | value 形态 | 识别（零写 lookup） | 迁移定级（一次性 → v5） |
| --- | --- | --- | --- |
| v1（裸键） | number | 合法数字 → legacy committed（raw key 探测 O(1)） | 数字 → `{level:"legacy", settledAtTick}` |
| v2（前缀键+entryCount） | number | 同 v3 | 同上 |
| v3（+nextExpiryTick） | number | 合法数字 → legacy committed；损坏 → corrupted | 同上 |
| v4（第十二轮 proof） | 对象（digest?/durableIdentityDigest?，无 level） | 合法形状按 durableIdentityDigest 存在性只读推断（查询展示；定级权威在迁移） | digest+durable 成对 → modern（保留身份）；全部缺省 → legacy；部分身份 → **fail closed**（原 store 保留）；数字 → fail closed |
| v5（当前） | `{level, settledAtTick, digest?, contractDigest?, authorizationCohortDigest?, durableIdentityDigest?}` | modern（level=modern：digest+durable 必填）/ legacy（禁携带身份字段）；违反 → corrupted | —（当前版本） |
| 未知版本 | 任意 | 按前缀键探测：合法数字/合法 v5/v4 proof → committed（已可靠解释的合法 ID 不遗忘）；无法解释 → incompatible；admission 整体 fail closed | fail closed（原数据保留） |

迁移不变量：临时结构全量校验（key/transactionId/value/entryCount/nextExpiryTick/编码碰撞）后一次性原子替换；任一失败原 store 不变；重复运行幂等（`migrationsExecuted` 恒 1）。

### 2.2 normalized lookup 状态机

`TreasuryReceiptLookupResult = absent | incompatible | corrupted | legacy_committed | modern_committed`——`hasSettledReceipt` / `readTreasurySettlementProof` / `admitTreasuryReceipt` / `reserveTreasuryReceiptAdmission` / `commitSettledReceipt` / `refreshSettledReceiptForResolution` / cleanup/migration / `projection.isSettled` / prepare / finalized proof 全部路径复用；`admitTreasuryReceipt` 原 `typeof existing === "number"` 恒不命中的缺陷已修复（迁移后对象 proof 正确返回 already_settled）。

### 2.3 already_settled 零发布与 identity-aware commit

- compat 单阶段（`writeAcceptedTransaction`）：非 written 结果零 journal/overlay/capacity delta/heap settled cache/onRecorded/projectionRevision/tentative，返回 `already_settled`（`transactionsRecorded` 不变）。
- prepared 路径：Game callback 之前（`projection.isSettled` → receipt admission）直接 already_settled——bundle 不签发/不 redeem、intent 不创建、adapter.execute 零调用。
- post-callback 防御段（`commitPreparedTransaction`）：读取完整 settlement proof 按 attempt identity 区分——match → 幂等（不重复 heap 发布、释放 intent）；legacy/insufficient → `settlement_proof_insufficient`；conflict → `settlement_identity_conflict`——后两者不发布 heap committed state，上层 executed_unsettled 分支 quarantine 接管 authority、`retryForbidden` 阻断自动重试。
- `commitSettledReceipt` 五态结果：`written` / `already_settled_match` / `already_settled_insufficient(relation=legacy|insufficient)` / `identity_conflict` / `fatal`（部分 identity 提供 → fatal，store 不变）。

### 2.4 identity-aware refresh

absent → 写 modern proof（identity 完整）/ legacy proof（低层 resolve）；existing modern + match → 仅刷新 settledAtTick（身份保留）；conflict → blocked（保持 resolving authority）；legacy proof → blocked（不覆盖不升级）；proof 身份不足（insufficient_proof）/请求无 digest（identity_unavailable）→ blocked；corrupted → fatal。staged resolve-as-committed 携带完整身份，blocked 回滚 tombstone 并返回 `settlement_identity_conflict` / `settlement_proof_insufficient`。

## 3. Proof / Authority 等级

### 3.1 等级矩阵

| 等级 | 来源 | 权限 |
| --- | --- | --- |
| modern | production contract + bundle redemption（cohort facts 与 digest 成对，矩阵全齐才写入） | 完整 authority（capability / resolution / 释放，均须 identity match） |
| legacy | 版化迁移显式标记（无现代身份事实的旧 entry / legacyV1 / v1-v3 数字 receipt） | replay blocker 保留；不签发普通 capability、不证明/释放 modern authority、不走现代 reconciler |
| forensic | recovery 防御性直写（intent_missing_fallback）、authority 写入失败兜底 | 阻断 writer、不签发普通 capability、不走普通 resolution，仅显式 forensic 通道 |
| lowlevel | 低层（非 contract）路径（含 test-only 两阶段），durable identity 绑定 | 保留既有低层语义（identity relation 可 match 释放），非现代 contract authority |

### 3.2 modern required 字段矩阵（intent/quarantine；authorization-fault 免 durablePayload/structureFacts——pre-execution authority，结构事实由 contract digest 绑定）

contractId、contractDigest、actionKind、adapterVersion、adapterRegistrationId、stable adapterSemanticIdentity、durablePayload(+version)、structureFacts（非空，逐项过共享 descriptor validator）、authorizationCohort 与 authorizationCohortDigest **成对**、durableIdentityDigest、policyIdentity、canonical postings。任一缺失 → store unhealthy（`proofLevelRejections` 计数），绝不降级 legacy；authorityLevel 缺失/未知枚举 → unhealthy；cohort facts 与 digest XOR → 损坏（任何等级）。

### 3.3 capability 签发

显式等级第一道判定：legacy / forensic / 等级缺失 → `legacy_authority_isolated` 拒绝；modern/lowlevel 继续走 semantic identity / reconciler 注册 / 版本完整检查链（既有检查全部保留）。

## 4. Staged recovery 释放规则

唯一释放许可 = identity relation **match**：

| relation | 行为 |
| --- | --- |
| match | finalize / 补完成释放（quarantine+intent+marker） |
| conflict | 保留全部 authority；`identityConflicts` 计数 + 报告字段 |
| insufficient（legacy proof 对 modern attempt / tombstone 身份不足） | 保留全部 authority；`identityInsufficientBlockers` 计数 + 报告字段 |

覆盖分支：resolving committed 的 refresh 续做与 authority 释放、final not-executed 补释放（quarantine 或 intent）、global reset 后恢复。`!== "conflict"` 释放许可已全部移除。

## 5. Cohort validation 与 structure descriptor

- `cohortValidation.ts` 唯一 `validateTreasuryAuthorizationCohortFacts`（owner/policy 四元组/decision digest/emergency override/epoch/五元 revisions/adapter registration+semantic identity/contract ID+digest/transactionId 交叉/leg digests 1..8/receiver capacity digest/issued tick/authorization digest/上限/安全整数/nested）；全部属性访问在 try/catch 内——throwing Proxy 返回结构化错误（`cohortValidationFailures` 计数）；intent/quarantine/authorization-fault 三 store 共用（各自私有副本移除）。
- `recomputeTreasuryCohortDigest` / `recomputeTreasuryDurableIdentityDigest` 全 try/catch Result 化（canonical 解引用异常 → null = 身份不可证明）；durable 重算前置共享 descriptor 校验。
- `structureDescriptorValidation.ts` 唯一 descriptor validator（governed_location 禁 objectId/expectedType/expectedRoom；game_object 必填 objectId + expectedType/expectedRoom 规则 + structureId === objectId 语义一致；单一 bindingKind 分支权威）；intent/quarantine/authorization-fault 持久校验共用；矛盾 descriptor 在持久层即拒绝（store unhealthy）。
- quarantine 篡改检测路径：写入方 digest 的最终一致性由 load 全量校验承载（写入不重算——与第十二轮既有语义一致，测试断言 load 检出 "重算不一致" fail closed、repair 不覆盖 digest）。

## 6. Forensic identity

- write-fault marker 扩展 `attemptIdentity`（contractDigest/authorizationCohortDigest/durableIdentityDigest——redemption 故障前已计算；fault store 满载兜底场景实测携带完整身份）。
- forensic resolution tombstone 写入绑定 marker 的同一 identity；`already_resolved` 幂等比较完整 attempt identity：同 ID、同普通 digest、不同 durable → 拒绝（不共享/不覆盖 tombstone）；marker 无 identity（legacy forensic proof）遇携带现代身份的 tombstone → 证明不足拒绝；legacy marker 与 legacy tombstone digest 匹配 → 幂等。
- `acknowledgeRolledBack: true` 必填（缺失 → invalid_input）；无新增无条件 clear marker 接口。

## 7. 新增 / 升级 Memory store 版本、字段与容量

| store | 版本 | 新增字段 | 容量 |
| --- | --- | --- | --- |
| receipts | v4 → **v5** | proof `level`（modern/legacy）+ 可选 `contractDigest` / `authorizationCohortDigest` | 4096 条（不变）；迁移一次 O(n) |
| intents | v4 → **v5** | entry `authorityLevel` | 64 条（不变） |
| quarantine | v3 → **v4** | entry `authorityLevel`（含 forensic） | 64 条（不变） |
| authorizationFaults | v2 → **v3** | entry `authorityLevel` | 64 条（不变） |
| writeFault marker | — | 可选 `attemptIdentity`（3 个 16hex 字段） | 单条（不变） |
| resolution tombstone | v3（不变） | identity 字段已有（Round 12） | 256 条（不变） |

Memory schema 指纹锚点更新（`test/memoryDeclarationBoundaries.test.ts`）：`b202ed36196074fd73e732787b3383e77b566de32bc7bc4782e4711af8d855c0`。

## 8. Operation-count 结果

新增计数器（heap，global reset 归零）：

| counter | 模块 | 触发 |
| --- | --- | --- |
| `receiptLegacyLookups` | receipts | 只读路径识别 legacy committed receipt |
| `receiptIdentityMatches` / `receiptIdentityConflicts` / `receiptIdentityInsufficient` | receipts | commit/refresh 的 relation 判定 |
| `receiptProofLevelRejections` | receipts | 迁移/校验的等级语义拒绝（部分身份、v4 数字、v5 等级损坏） |
| `cohortValidationFailures` | cohortValidation | cohort 校验失败（含异常逃逸防御） |
| `proofLevelRejections` | authorityLevel | authorityLevel 缺失/未知/矩阵缺失/XOR |
| `identityConflicts` / `identityInsufficientBlockers` | resolutionStore | staged recovery 的 conflict/insufficient 保留 |

性能语义（测试覆盖）：query 零写识别 O(1)（不触发迁移/全表扫描，`peekTreasuryReceiptStore().version` 保持 3）；迁移每 heap 生命周期至多一次；正常 admission O(1) 快路径；staged recovery 对单条 insufficient 仅计数跳过（不重扫 receipt 全表）。

## 9. 实际验证命令与结果（本地）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASSED（typecheck:build + typecheck:test，0 错误） |
| `npm run build` | PASSED（dist/main.js，bundle sha256 `10b21e5aa72a6d62…`） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | **32 suites / 642 tests / 642 passed / 0 failed** |
| `npx jest --config jest.config.cjs` | **226 suites / 1348 tests / 1348 passed / 0 failed** |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（226/1348，manifest 与 `5aa098b` 一致） |
| 定向：receipt v3→v5 migration（treasuryRound13ReceiptMigration.test.ts） | 24 passed |
| 定向：proof strictness / cohort / descriptor / forensic（treasuryRound13ProofStrictness.test.ts） | 25 passed |
| 定向：historical receipt callback-zero / compat 零 heap / identity insufficient staged recovery / proof-level requiredness / cohort malformed+Proxy / persisted structure union / forensic attempt identity / operation-count | 包含于上述两文件（对应 describe 块全绿） |
| 生产源码 writer 边界扫描 | treasuryWriteArchitecture.test.ts 全绿（kernel 封闭/单阶段入口退役/架构白名单） |
| 真实 writer 文件 diff（b901003..5aa098b：resourceControl / marketDirectContinuousAutomation / marketSaleProtection(+Adapter) / factoryControl / synthesisControl / nukerControl / terminalActionEnergyOwnership） | **零改动（diff 为空）** |
| `git status` | 工作区干净（每 commit 后验证） |
| 基线→HEAD diff stat | 9 commits；treasury 模块 + 新增 3 个生产模块（cohortValidation / structureDescriptorValidation / authorityLevel）+ 2 个测试文件 |

## 10. 边界与声明

- **未部署**（未调用任何 Screeps 部署通道）；**未合并 main**；**未 force push / rebase / amend 已推送历史**（本轮全部为新增提交）。
- **未接入任何真实 Game writer**：不调用 terminal.send / Game.market.deal / lab / factory / creep transfer/withdraw；production action execution 仍只接受 opaque bundle；裸 token 仅 test-only harness。
- 未实现（明确不在本轮）：terminal.send adapter、terminal.send plan shadow、terminal.send reconciliation shadow、真实 terminal.send 调用、ResourceControl/market/carrier/lab/factory/nuker/synthesis writer 迁移、live CPU canary、完整 Budget Service、ReceiverCapacityLedger 全量替换、旧库存系统删除。
- GitHub 仓库无 CI——以上全部为**本地验证**真实输出。
- Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once（本轮的 staging/proof 协议在该边界下保持 fail closed 与幂等恢复，但不做 exactly-once 声明）。

## 11. 剩余风险

- v4 store 内"删除字段的 modern 记录"（部分身份）在一次性迁移窗口无法与"从未存在"区分——按 fail closed 处理（拒绝迁移、原数据保留、人工处理），不会静默降级，但需要人工介入。
- 未知版本 store 的"已可靠解释 ID"识别按 v2+ 前缀键形态探测：v1 裸键形态的未知版本 store 无法识别（整体 fail closed，不遗忘已迁移数据）。
- forensic marker 的 `attemptIdentity` 依赖 redemption 故障前已计算的事实：bundle 上下文缺失 contract/cohort 字段时 marker 退化为部分身份（legacy 语义处理，不伪造）。
- lowlevel 等级保留既有低层路径的全部行为（含 test-only 两阶段）——它是显式标签而非新限制；生产 contract 路径恒为 modern（矩阵校验不过即拒绝、callback 零调用）。
