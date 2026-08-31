# Round 14 — Resolution Proof Closure & Authority-Level Integrity 本地验证证据

## 0. 范围声明

本报告记录 Treasury 第十四轮（staged committed resolution 三方证明闭环、authority 等级完整性与 lowlevel 严格语义）的**本地验证**结果。仓库当前没有 GitHub CI——本文所有命令与数字均为本机真实执行结果，未声称任何 CI 状态。本轮**未部署**、**未合并 main**、**未接入任何真实 Game writer**。

## 1. 版本与提交

- 起始 HEAD：`bb7e512cdaae0bc402f8493cdf947fc3eab549d3`（第十三轮预算锚点）
- 实现终态 HEAD：`e740fb2`（test(treasury): 第十四轮确定性测试与既有 fixture 适配——包含全部实现与测试，位于 evidence 与 budget 提交之前）
- 提交列表（依赖顺序，每个职责单一、可独立审查回滚）：

| SHA | 作用 |
|---|---|
| `1144093` | refactor(treasury): 低层 authority 严格矩阵、等级兼容矩阵与共享发布协议（authorityLevel.ts / authorityCompatibility.ts / durablePublication.ts） |
| `e82ede6` | refactor(treasury): 三个 authority store 升级发布协议与迁移定级（intents v6 / quarantine v5 / authorization-fault v4 + authorizationLedger + Memory schema + types） |
| `634f23c` | fix(treasury): staged committed 三方 proof 闭环与 tombstone 显式 proof level（resolutionStore v4 / recoveryCoordinator / faultResolution / resolutionAuthority） |
| `90ec87e` | refactor(treasury): 双 authority 等级矩阵与 production 定级边界（unresolvedAuthority / facade：成对不变量、readiness 门禁、authorizationSafe 维度、metrics） |
| `e740fb2` | test(treasury): 第十四轮确定性测试（56+3 用例）与既有 fixture 适配 |
| （本提交） | docs(openspec)+docs(evidence): 第十四轮协议与本地验证证据 |
| （下一提交） | chore(test-budget): 第十四轮预算锚点 |

## 2. Staged Committed 三方 proof 闭环

状态图（`recoverStagedResolutions` resolving+committed 分支）：

```text
读取完整 receipt proof（readTreasurySettlementProof，O(1)——tick 充分与否都读）
        │
        ├─ receipt 缺失或 settledAtTick < tombstone.settledAtTick
        │       └→ identity-aware refresh（携带 tombstone 完整 attempt identity）
        │              ├─ blocked（conflict/legacy/insufficient）→ 保留全部、独立计数
        │              └─ 成功 → 重新读取持久 proof → 回到主链（不凭返回值释放）
        │
        ├─ 时间证明：receipt.settledAtTick ≥ tombstone.settledAtTick
        ├─ receipt ↔ tombstone identity relation === match
        ├─ authority 仍存在时：
        │       proofLevel ↔ authorityLevel 释放权限矩阵（identity-bound→modern、
        │       lowlevel→lowlevel、legacy/forensic 不释放 modern/lowlevel）
        │       tombstone ↔ authority relation === match
        │       receipt ↔ authority relation === match
        │
        └─ 全部成立 → 释放 quarantine + intent、清除匹配 marker、finalize（resolving→final）
           （authority 已不存在 = 前一 global 已释放、finalize 前中断——
             receipt ↔ tombstone match + tick 足够即补完成；否则保持 resolving）
```

- **receipt 与 identity 是两个独立条件**：tick 充分不证明 receipt 属于当前 attempt。
- `hasSettledReceipt`（tick 查询）只用于 replay blocker，不作为 modern authority release 证明。
- conflict 与 insufficient 独立计数（`resolutionStoreEvents.identityConflicts` / `identityInsufficientBlockers`；facade metrics 聚合为 `resolutionIdentityConflicts` / `resolutionIdentityInsufficient`）。

## 3. Attempt identity 的完整传播

- `TreasuryAttemptIdentity` = digest + contractDigest? + authorizationCohortDigest? + durableIdentityDigest?；relation 语义：proof 缺 attempt 要求的字段 → insufficient；双方携带但不等 → conflict；全齐且等 → match。
- 本轮修复的调用点：`recoveryCoordinator.checkTreasuryFinalizedProof`（receipt proof 视图）与 `faultResolution` 的 not-found 幂等路径此前只传 `{ digest, durableIdentityDigest }`——现在完整传递全部身份字段（cohort/contract 不同即 conflict、缺失即 insufficient）。
- 全字段直传的既有调用点（tombstone 路径、receipts refresh/commit、staged recovery、resolutionAuthority）保持不变并新增统一 verifier。

## 4. Authority level 兼容矩阵（authorityCompatibility.ts 单一权威）

| quarantine \ intent | modern | lowlevel | legacy | forensic |
|---|---|---|---|---|
| modern | 完整 durable identity 比较¹ | inconsistent | inconsistent | inconsistent |
| lowlevel | inconsistent | 严格低层 identity² | inconsistent | inconsistent |
| legacy | inconsistent | inconsistent | 受控比较³ | inconsistent |
| forensic | inconsistent | inconsistent | inconsistent | 同一隔离记录⁴ |

¹ durableIdentityDigest 与 authorizationCohortDigest 双方完整存在且相等；contractId/contractDigest/adapterSemanticIdentity 一致（一方缺失即 inconsistent——不退回 optional 子集）。
² durableIdentityDigest 双方完整且相等（低层矩阵保证存在）。
³ digest/kind/postings 规范比较。
⁴ digest/kind/postings 相同视为同一隔离记录。

双 authority 比较前先**分别**从持久事实重算 identity（任一失败 → 整体 inconsistent——durable digest 字符串相同也不信任）。不一致时 capability 零签发（`authority_inconsistent`）、resolution 零副作用、两份 authority 原样保留。

## 5. Lowlevel 严格语义

- **来源**：只有当前运行时低层路径（写入缺省等级或显式 lowlevel）+ `lowlevelSource: "runtime-lowlevel@v1"` 来源标记；迁移认定的受支持上一版显式 lowlevel → `"migrated-lowlevel@v1"`。低层 durableIdentityDigest 未携带时由 store 从候选事实确定性派生（与 facade 生产路径同源）。
- **required**：transactionId、canonical digest、action kind（actionKind/kind）、source、canonical postings 非空、durableIdentityDigest（可由事实重算一致）、lowlevelSource。
- **forbidden modern 字段**：contractId、contractDigest、authorizationCohort、authorizationCohortDigest、authorizationDigest、adapterRegistrationId、ownerIdentity、policyIdentity（adapterVersion / adapterSemanticIdentity 允许——低层 reconciler 语义身份）。
- **production 边界**：`executePreparedAction` 的 intentContract 与 redeemedCohort 必须成对（都有 → modern、都无 → lowlevel）；只有其一 = partial-modern → `authority_invariant_violation` 结构化拒绝（callback 零调用、预留释放）。authorizationLedger 的 bundle-redemption fault 在 cohort 缺失时定级 **forensic**（不再 lowlevel）。
- 合法 lowlevel 不被 identity-bound（modern）proof 误释放（proof class ↔ authority 等级释放权限矩阵）。

## 6. 旧版本 migration 定级表（classifyTreasuryAuthorityLevelForMigration）

| 旧 entry 形态 | 定级 |
|---|---|
| forensic 标志 | forensic |
| legacyV1 标志 | legacy |
| modern 矩阵完整且 identity 重算一致 | modern |
| 完全无现代身份事实 | legacy |
| **partial-modern（部分现代事实、矩阵不齐）** | **forensic 隔离（绝不 lowlevel）** |
| 显式 lowlevel（v5/v4/v3）满足严格低层矩阵 | lowlevel + lowlevelSource="migrated-lowlevel@v1" |
| 显式 lowlevel 不满足矩阵 / 显式 modern 矩阵缺失 / 显式 legacy 携带现代字段 | forensic |
| cohort facts 与 digest 不成对 / digest 与事实重算矛盾 | fatal（error 返回，原 store 保留） |

迁移原子性：先构造临时 entries、全量验证后原子替换；任一 entry 定级失败原 store 不变；重复执行幂等。持久语义变化随版本提升（intent v6 / quarantine v5 / fault v4），不在相同 version 下改变解释。

## 7. Resolution tombstone proof level（resolutions v4）

| proof class | required | forbidden | 释放权限 |
|---|---|---|---|
| identity-bound | digest + contractDigest + authorizationCohortDigest + durableIdentityDigest | — | 只释放 modern authority |
| lowlevel | digest + durableIdentityDigest | contractDigest、authorizationCohortDigest | 只释放 lowlevel authority |
| legacy | （基础形状） | 三个身份字段全部 | 只释放 legacy（replay-only 诊断） |
| forensic | digest | —（允许部分字段） | 只服务显式 forensic 协议 |

- 任一 required 缺失 → store unhealthy（绝不降级 legacy）；legacy 携带部分现代身份 → 拒绝。
- 同 id 覆盖（resolving → final）只允许保持同一 proof class 与完整 attempt identity；不同 class 或 identity 漂移的覆盖被拒。
- v3 迁移：全身份 → identity-bound、全缺 → legacy、**部分 → forensic**（不"尽力猜 modern"）；v1/v2 → legacy。
- 写入方按 authority 等级显式声明（faultResolution：modern → identity-bound / lowlevel → lowlevel；resolutionAuthority 的 pre-execution 解除按 fault 等级映射；forensic marker → forensic/legacy）。

## 8. Durable 发布协议（写入前 → Memory → read-back）

```text
候选构造（深拷贝 + shape + 等级矩阵 + cohort/descriptor 校验）
  → 写入前重算：cohort digest 与 durable identity 必须能由候选事实重算一致
     （不一致 → invalid_entry 拒绝；entryCount/revision 不变）
  → Memory 发布（entryCount/revision/updatedAt 推进）
  → read-back：从持久副本再次重算 + 23 项完整身份字段深度比较
     （等级/lowlevelSource/digest 族/cohort/structureFacts/postings/
       outcome/settlement/source——不是 digest 字符串子集）
  → 不一致 → 回滚本次写入并恢复 entryCount/revision/updatedAt
     → 结构化 store fault（调用方不得继续删除源 authority 或执行 callback）
```

- 三个 store（intent/quarantine/authorization-fault）一致使用 `durablePublication.ts` 共享协议；同 id 既有 entry 自身 identity 不可重算 → 不返回 already_present。
- intent → quarantine 转移：验证源 intent → 构造完整 target（等级与 lowlevelSource 随事实转移）→ target 写入（同协议）→ read-back 完整比较通过 → 删除源 intent；任一不一致源 intent 保留为 emergency authority。
- authorization-fault 的 read-back 由 4 字段子集（digest/durable/cohort/transactionId）升级为完整身份比较。

## 9. Authorization-fault health 门禁

- 轻量 probe（O(1)，不扫 entries 全表）：heap fatal、store 存在性、version ∈ {4,3,2,1}、entries 普通对象、entryCount 非负安全整数且 ≤ 64、updatedAt 非负安全整数——明显矛盾直接 unhealthy。
- write readiness 的 `authorizationFaultUnresolved` source 升级为完整 validation 门禁（`ensureTreasuryAuthorizationFaultStoreValidated`：store 不存在零写；存在时触发一次有界全表 load 验证，heap 缓存后 O(1)）。
- `authorizationSafe` 联合判定新增 `authorization_fault_unhealthy` 维度：损坏期间授权拒绝（authorization_context_unsafe）→ callback 零调用。

## 10. Memory store 版本、字段与容量

| store | 版本 | 新增字段 | 容量 | 迁移成本 |
|---|---|---|---|---|
| intents | 5 → **6** | entry.lowlevelSource?（低层来源标记） | 64（不变） | v1-v5 → v6 一次性逐 entry 定级（partial-modern → forensic）；一次有界全表扫描 |
| quarantine | 4 → **5** | entry.lowlevelSource? | 64 + overflowed（不变） | v1-v4 → v5 同上 |
| authorizationFaults | 3 → **4** | entry.lowlevelSource? | 64（不变） | v1-v3 → v4 同上 |
| resolutions | 3 → **4** | entry.proofLevel（必填） | 256（不变） | v1/v2 → legacy、v3 → 按 identity 完整性定级；一次有界全表扫描 |
| receipts | 5（不变） | — | — | —（本轮无 receipt schema 变化） |

Memory schema 指纹锚点更新：`d2df853bc1c92d34cdb85d801d41a6ac327c10ef46c230e8e56287c0577476f2`（test/memoryDeclarationBoundaries.test.ts）。

## 11. Operation-count 结果（treasuryRound14OperationCount.test.ts）

- staged recovery 在 receipt tick 充分时执行**单条** proof identity 读取（O(1) key 读），`receiptFullScans` 计数不增长（附 5 条无关 receipt 干扰项验证不误扫）。
- 同 id 双 authority 反复比较（20 次）不产生新的 quarantine/intent 全表扫描（load 后 `fullScans` 稳定）。
- authorization-fault write readiness 首次触发一次有界全表扫描（`fullScans ≥ 1`），heap 缓存后 20 次查询 `fullScans` 不变（快路径）。

## 12. 实际验证命令与结果（本地）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc build + test 双配置，0 错误） |
| `npm run build` | 通过（dist/main.js 生成，bundle sha256 69f562a821c1099e…） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | **34 suites / 701 tests / 701 passed / 0 failed** |
| `npx jest --config jest.config.cjs`（全量） | **228 suites / 1407 tests / 1407 passed / 0 failed** |
| `node scripts/verify-jest-budget.mjs` | PASSED（budget 提交后执行） |

定向补充（均已包含在上述全量中）：staged committed 三方 proof（treasuryRound14ResolutionProof 56 用例）、full receipt identity propagation、dual authority 等级矩阵、lowlevel required/forbidden、partial-modern migration、tombstone proof-level、immediate recomputation（含故障注入回滚）、intent→quarantine transfer、authorization-fault health、operation-count fixture。

### writer 边界扫描

- production 源码 writer 边界扫描（treasury 生产模块无 `terminal.send` / `Game.market.deal` / lab / factory / nuker / creep transfer/withdraw 等真实 Game 写 API 调用）：通过。
- 真实 writer 文件 diff（`git diff --stat` 对 src/runtime/resourceControl.ts、marketDirectContinuousAutomation.ts、marketSaleProtection.ts、marketSaleProtectionAdapter.ts、factoryControl.ts、synthesisControl.ts、nukerControl.ts、terminalActionEnergyOwnership.ts）：**空**（零改动）。

### git 状态

- `git status`：本轮全部改动位于 src/runtime/treasury/、src/types/memory/runtime.d.ts、test/memoryDeclarationBoundaries.test.ts、openspec/、test/test-suite-budget.json、scripts/verify-jest-budget.mjs。
- 基线 `bb7e512` → 实现 `e740fb2` diff stat：22 个 treasury 文件 + 2 新模块 + 2 新测试文件 + 类型声明（约 +4600 / −800 行，含注释与测试）。
- 分支 `refactor/empire-treasury-rearchitecture`；未 reset / 未 rebase / 未 force push / 未 amend 已推送历史 / 未合并 main。

## 13. 最终 suite / test 数字

- 基线（Round 13）：226 suites / 1348 tests。
- 本轮终态：**228 suites / 1407 tests / 1407 passed / 0 failed**（+2 suites：treasuryRound14ResolutionProof、treasuryRound14OperationCount；+59 tests；旧测试零删除、零 skip/todo）。
- 预算规则执行：先完成实现与全部测试提交（`e740fb2`），全量真实通过后独立更新 budget；`requiredBaselineCommit` 指向 `e740fb2`。

## 14. 未完成与边界声明

- GitHub 无 CI——本报告只记录本地验证，不声称 CI passed。
- **未部署到 Screeps**；**未合并 main**；**未 force push**。
- **未接入任何真实 Game writer**（terminal.send adapter / ResourceControl writer / market / carrier / lab / factory / nuker writer 均未实现接入；真实 writer 文件 diff 为空）。
- 未勾选项：terminal.send adapter、terminal.send plan shadow、terminal.send reconciliation shadow、terminal.send 真实执行、ResourceControl writer、market writer、carrier/lab/factory writer、live CPU canary、完整 Budget Service、ReceiverCapacityLedger 替换、旧库存系统删除。
- Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once（协议幂等恢复承载，非本轮范围）。

## 15. 剩余风险

- 旧 store 数据中 v5/v4/v3 显式 lowlevel entry 若事实残缺（durable 不可重算）会整体 fatal（原数据保留）——生产升级时需人工核对迁移诊断（当前未部署，无实际数据风险）。
- `redeemAuthorization` deprecated hook 现可携带 cohort（测试注入通道）；production 路径继续只认 authorizationBundle，hook 的 cohort 伪造仅存在于测试。
- dual authority 的 forensic+forensic 合并采用 digest/kind/postings 相等判据（同一隔离记录）；若未来 forensic provenance 字段细化，需收紧为显式 provenance 比较。
- 三方 proof verifier 的性能为 O(1) proof 读取 + 单 entry 重算；256 条 resolving 满载时恢复循环仍为一次全表扫描（resolving 条目本身有界，符合第十六节约束）。
