# Round 22 Remediation II — Enforced Cleanup Journal & Exact Settlement Relation（本地验证证据）

- 变更分支：`refactor/empire-treasury-rearchitecture`
- 实现提交：`ee8fee9`（fix(treasury): enforce cleanup journal admission, read-back gates and exact GRA relation）
- 预算锚定提交：`a9f4eb2`（fix(defense)，包含 protected-full 声明边界测试新内容）
- 验证环境：本地（Windows / Git Bash / Node + jest 全部 mock），**未部署到 Screeps**
- 验证时工作树与最终代码提交内容一致（budget 在 manifest 更新后的同一树运行并 PASSED）

## 一、缺陷根因与修复对照（任务书三节 A–E）

### A. Cleanup journal 必须成为不可绕过的持久恢复所有权门禁

**根因**：`faultResolution` 的 immediate committed / not-executed 两路径在
`openTreasuryResolutionCleanup()` 后**忽略返回值**——journal 满载、store
unhealthy、同 transactionId 相反 resolution、exact identity 冲突四种状态下
仍继续消费 capability、discharge marker、释放 authority、推进终态。
not-executed 路径顺序为「consume capability → 写 final tombstone → open
journal」，存在「capability 已消费、final proof 已写、journal 拒绝」的
不可恢复窗口。

**修复**：
1. committed 路径：open 结果 `rejected/conflict` → 回滚本次 resolving
   tombstone 并返回 `cleanup_journal_blocked`（capability 未消费、marker
   未清、authority 未释放、无错误 final）。
2. not-executed 路径重排：lineage publication → **reservation open**
   （`proofMode: "reservation"`，`settlementProofDurable=false`——不谎称
   proof durable）→ consume capability → 写 final tombstone →
   `activateTreasuryResolutionCleanupProof`（proof 落盘激活）→ discharge →
   release。admission 被拒 → capability 未消费、tombstone 未写。
3. 回滚路径（consume 失败 / receipt fatal / receipt blocked）经
   `revokeTreasuryResolutionCleanup` 只撤销「本次创建（open=opened）、
   exact identity 一致、四阶段零推进、settlementProofDurable 事实一致」
   的 entry；already-open 既有 entry 不误删；not-executed proof 写失败时
   保留未激活 reservation 供重试幂等复用。
4. journal 恢复跳过 `settlementProofDurable=false` 的 reservation
   （`pendingReservations` 计数，不折叠为已完成）；恢复路径对既有
   reservation 的 proof_durable open 幂等激活。

### B. Authority release read-back 必须是 finalize 硬门禁

**根因**：committed immediate 路径在 release 后 resolver 为
ok/inconsistent/store_unhealthy 时**继续写 final tombstone 并返回
resolved**（`if (resolver === not_found) mark` 的 else 分支静默落空）；
`recoverStagedResolutions` 的阶段 `mark` 返回值被忽略、finalize 用裸写
`runtime.store.entries[key] = finalEntry` 绕过状态机。

**修复**：两处 immediate 路径与 recoverStagedResolutions 三条恢复分支全部
改为「release → 统一 resolver read-back 必须 `not_found` → journal
authority-release 阶段写入成功 → 才 finalize」；任一失败保留 recoverable
pending（新 reason `authority_release_blocked` / retirement
`authority_release_pending`）。finalize 改经
`writeTreasuryResolutionTombstone`（resolvedAtTick 单调推进至
settledAtTick）——顺带修复旧裸写可产出「final committed settledAtTick >
resolvedAtTick」违反持久状态语义矩阵、下次 global reset load 即 store
fatal 的隐性缺陷（Round14 场景固化）。

### C. Not-executed 返回值必须反映真实 retirement 状态

**根因**：converge 未完成时路径仍按 `retrySemanticDigest` 返回
`complete_rearm_ready / complete_non_rearmable`（converge 结果只影响
journal mark，不影响返回值）；函数尾部存在不可达的死代码 return。

**修复**：converge `completed` 才返回 complete_*（此时 marker 阶段完成、
resolver not_found read-back、exact proof 由 converge 写入、pending-release
收敛、journal outcome+lineage 完成）；否则按 `pendingStages` 映射
`exact_proof_pending` / `lineage_finalization_pending` /
`authority_release_pending` / `pending_cleanup`；删除死代码。

### D. Cleanup journal 持久状态必须完整验证

**根因**：load validator 只验证基础字段与 boolean 形状——损坏的阶段布尔、
非法 identity profile、越级阶段组合均被信任；恢复编排 `if (!entry.X)` 直
接信任持久 boolean 为安全证明。

**修复**：
1. **D.1 entry identity 完整形状**：profile 合法枚举 + profile↔proofClass
   唯一组合 + `validateTreasuryIdentityProfileFacts` required/forbidden
   矩阵 + lineage 四字段整体性 + generation/时间字段形状。
2. **D.2 store 不变量**：entryCount 精确、硬容量 256、键 `c:` 前缀且与
   transactionId 一致、entries/entry 原型为普通对象（防 `__proto__` 注入）、
   损坏结构化 unhealthy（`peekTreasuryResolutionCleanupHealth` 不折叠为
   pending 为空）。
3. **D.3 阶段偏序**：authority→marker、outcome→authority、lineage→outcome；
   reservation（proof 未 durable）阶段必须全 false。
4. **D.4 恢复不信任 boolean**：恢复编排对每个 entry 无条件重跑四阶段幂等
   外部事实验证——marker 阶段重新读取并 discharge（matching marker 重现时
   安全补清除；unrelated 区分 attempt 完成与全局锁保留）；authority 阶段
   resolver 重确认 not_found、需要时经 handler 重释放 + read-back；outcome
   阶段（committed）重验 trusted Receipt + exact tombstone + 统一三方
   verifier `verifyTreasuryCommittedResolutionProof` 后才 finalize/already_
   final；lineage 阶段重验 record 的 lineageId/current attempt/generation/
   parent/binding 与 entry 完全一致（facade journal handler 强化承载）。

### E. Cross-store coordinator 必须使用完整 GRA exact relation

**根因**：`verifyTreasuryCurrentSettlement` 第 5 步与
`verifyTreasuryOppositeProofAbsence` 的 GRA 检查只比较
transactionId/digest（后者仅 transactionId+digest；前者 digest+lineageId）。

**修复**：新增 `graExactRelationToAttempt`（复用
`generationRetirementRelation.compareTreasuryGenerationProofWithTombstone`
统一 matcher，不复制身份比较逻辑）：lineageId/generation 显式一致（matcher
未覆盖的两维）+ gen0 禁 parent/binding、gen≥1 完整 lineage 维度 +
transaction/digest/proofClass/contract/cohort/durable/lowlevel 全维三方比
较。任一维度冲突 → `conflict`（不推进清理、不删除 proof、不授权 rearm）；
opposite-proof 检查中不 matching 的同 attempt id proof 同样 retained。

## 二、回归测试矩阵（treasuryRound22RemediationII.test.ts，37 tests）

| 任务书场景 | 用例 | 关键断言 |
|---|---|---|
| 1 容量满 | 满载 → `cleanup_journal_blocked` | capability 未消费（同 capability 释放容量后重试 resolved）、marker 未清、authority 未释放、无错误 final |
| 2 identity conflict | 同 ID 不同 digest 预开 | 既有 entry 逐字段零变化、新 attempt 不借用、authority/marker 保持 |
| 3 相反 resolution | 预开 not-executed 后 resolve committed | fail closed、两种结论不共存 |
| 4 回滚撤销 | receipt-blocked 驱动 staged 回滚 | opened→revoked（entry 删除）；already-open（exact 一致预开）不误删 |
| 5 admission 成功但 proof 写失败 | 签发后预塞冲突 tombstone | reservation 保留且 `settlementProofDurable=false`、阶段标记被拒、authority/marker 保持、重试安全 |
| 6 release 后三态 | jest.spyOn 伪造 read-back ok/inconsistent/store_unhealthy | committed：`authority_release_blocked`、tombstone 停留 resolving、journal 阶段不推进；not-executed：`authority_release_pending` |
| 7 converge 非 completed | 同 key 预塞它属 GRA proof | `exact_proof_pending`，绝不返回 complete_* |
| 8 形状负向矩阵 | 10 组 entry 级 + 3 组 store 级 | 结构化 unhealthy、open rejected |
| 9 boolean 撒谎 | marker/authority/outcome/lineage 四窗口 | matching marker 补清除后完成；authority 重释放 read-back；proof 缺失/record 不匹配阻断且 entry 保留 |
| 11 reservation 生命周期 | mark 拒绝/恢复跳过计数/激活/revoke refused | `pendingReservations=1`、proof_durable open 激活后可推进 |
| 10 GRA exact mismatch | 8 维表驱动（digest/lineageId 相同前提下篡改 generation/parent/binding/contract/cohort/durable/class/digest） | verdict ∉ {not_executed_verified}、opposite absence retained；基线完整一致 → verified |

既有回归保持：`treasuryRound22Remediation.test.ts`（32）窗口 6 改用真实
tr1_ child ID + 可重验 final tombstone（D.4 恢复重验语义下的正确
fixture）；journal pending 用例补全 lowlevel required 事实；purpose 调用
面计数 7→8（facade outcome handler 新增一处显式 purpose 调用）。

## 三、最终验证命令与结果

在包含全部 Treasury/Defense/budget 变更的同一工作树运行：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0（0 错误） |
| `npm run build` | 成功（bundle sha256 见报告；未部署） |
| `npx jest src/runtime/treasury/treasuryRound22Remediation.test.ts` | 32/32 |
| `npx jest src/runtime/treasury/treasuryRound22RemediationII.test.ts` | 37/37 |
| `npx jest src/runtime/treasury/` | 67 suites / 1219 tests 全过 |
| `npx jest`（全仓） | 262 suites / 1956 tests 全过（0 failed/0 pending/0 todo/0 skipped） |
| `node scripts/verify-jest-budget.mjs` | `JEST_TEST_BUDGET=PASSED`（262/1956，锚点 a9f4eb2） |

## 四、诚实声明

- **未部署**到 Screeps（build 仅产出本地 bundle；无 deploy target）。
- 测试全部使用 mock（installRooms / 测试 reconciler / jest.spyOn /
  手工 Memory fixture）；**未调用真实 Game 写 API**、**未调用真实
  terminal.send**、未触碰 market/lab/factory/经济 writer。
- 未合并 main、未 force push、未归档 change。
- `FOCUS_FIRE_*` 常量与 Treasury 容量常量均未经线上调参（本轮只保证
  确定性与 fail-closed 语义）。
- 剩余遗留：capacity-full 场景下 256 条 reservation 可能长期占用 journal
  槽位（fail closed 可接受，需管理通道清理）；GRA store 满载（384）时
  converge 持续 `exact_proof_pending`（同上，无自动驱逐——设计使然）。
