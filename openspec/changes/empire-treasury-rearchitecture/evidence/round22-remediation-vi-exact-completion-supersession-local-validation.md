# Round 22 Remediation VI — Exact Completion Supersession & Durable Historical Authority（本地验证 evidence）

- 日期：2026-09-04
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`de0656d73959ab7f18f76468d127774731b79219`；实际起始 HEAD：`de0656d73959ab7f18f76468d127774731b79219`（一致；`f8cf544` 之后只有 OpenSpec/evidence/budget 提交）
- 最终代码/测试验证 HEAD：`ad0002e96887a40aae0cda6ad484332f46cfabbb`（test(defense) 提交——完整验证在此 HEAD 执行；其后的 OpenSpec/evidence/budget 提交不含生产代码、测试代码或类型代码）
- 验证环境：本地 Windows（无独立 CI——全部为本地执行结果）

## 提交清单（本轮 Treasury）

| commit | 职责 |
| --- | --- |
| `fix(treasury): make completion supersession exact and durable`（`f185df1`） | cleanupSupersessionAuthority 新模块（exact replacement 验证 + durable historical authority + 统一 archive 入口 + headroom preflight）、coordinator/acknowledgement journal-absent 判定改造、attemptLineage/summary compaction 统一入口迁移、record 结构化 reason、facade 三处 preflight、types 两个 rejection reason、read-back 同引用修复 |
| `test(treasury): cover durable supersession and 300 generation history`（`adb04ad`） | treasuryRound22RemediationVI.test.ts（22 tests，T1–T13）+ Remediation V 测试新语义对齐 + treasuryWriteArchitecture 架构守卫（T14，3 tests） |

## supersession authority 语义

completion 的删除只经 `archiveTreasuryCleanupCompletionViaAuthority`（所有 destructive release 的唯一生产入口；底层 `releaseTreasuryCleanupCompletionOfAttempt` 仅在该模块内部使用——`treasuryWriteArchitecture` 全仓扫描守护）。固定顺序：验证 completion（健康 + shape 完整）→ 验证 replacement（via 指定时 exact）→ durable historical authority 写入 + Memory read-back 全维度比较（独立 clone）→ 删除 completion → 删除 read-back absent → 结构化结果（archived / already_archived / absent / interrupted / blocked+reason）。幂等：completion 已不在而 historical 在位 → already_archived（不重复写冲突）；写入后删除前中断 → 两者并存、重入继续；删除 read-back 复活 → blocked pending、后续幂等恢复。

## outcome 绑定方式

advance 携带 `settlementOutcome`（completed 时必有——completion proof / historical authority / journal entry 的持久权威派生）；`lookupTreasuryCleanupCompletion` / `lookupTreasuryHistoricalCompletion` 支持 `expectedOutcome`（与权威 resolution 不一致 → conflict）；`treasuryCleanupStatusOfAdvance` 验证调用方 settlement 标签与权威一致——不一致 → `cleanup_conflict`（绝不输出 not-executed + fully_complete）。

## exact identity 比较维度

transactionId / settlement outcome（必要条件）/ digest / identityProfile（枚举 + ↔proofClass 唯一映射）/ proofClass / contractDigest / authorizationCohortDigest / durableIdentityDigest / lowlevelSource / lineageId / generation / parentTransactionId / lineageBindingDigest。GRA 额外验证：rootTransactionId + rootIdentityDigest 绑定字段（经 GRA store load 的 semantics canonical 重算 + lineageId 相等传递 root 一致性）、authorityClass（经 relation 的 proofClass 维度比较）、resolution=not_executed、retirement 三阶段全 true、generation/parent/binding 与 completion 同代。GRA exact 构造按 generation 分支：gen0（root）不含 lineage 维度、gen≥1（tr1_）携带完整四字段（构造器矩阵单一权威）。

## completion 删除固定顺序（global reset 恢复行为）

historical authority store（`Memory.runtime.treasury.cleanupSupersessions`，schemaVersion 1、硬容量 384、key `sa:<transactionId>`）经 reset hook 重建 heap；global reset / heap 清空后 `lookupTreasuryHistoricalCompletion` 从 Memory 权威恢复并完整 shape 验证（T7-C/T8 验证 reset 后 historical 独立可查、advance completed）。

## store 硬容量与满载行为

- completion live store：128（未提高——300 代链任意时刻 live ≤ 2）；
- historical authority store：384（300 代链实际观察到 301 条——root + 300 children，`peekTreasuryCleanupSupersessionEntryCount()` 断言 `≥301 且 ≤384`）；
- historical 满载 + completion 满载且无安全可回收项 → `ensureTreasuryCleanupCompletionHeadroom` 返回 `headroom_exhausted`，prepare/execute 拒绝（callback 零调用）、completion 均保留（T11）；
- completion 或 historical store unhealthy → 零 archive、零删除、零 callback、明确 store unhealthy（不折叠为无可回收项——T12）；
- record 失败结构化 reason：capacity_exhausted / existing_conflict / invalid_candidate / store_unhealthy / read_back_failure；只有 capacity_exhausted 触发 bounded reclaim；identity conflict 后其它 completion/historical 完全不变（T13）。

## T1–T13 固定反例对应测试名（treasuryRound22RemediationVI.test.ts）

| 反例 | 测试 |
| --- | --- |
| T1 | "T1：not_executed GRA 不得删除 committed completion（blocked、completion 保留、零其它 GC）" |
| T2 | "T2：final committed tombstone 不得替代 not-executed completion" |
| T3 | "T3：durableIdentityDigest 冲突 / proofClass/profile 冲突 / lowlevelSource 冲突 → replacement conflict、completion 保留"（3 例）+ "T3b：contractDigest 冲突（completion vs 已存在 historical authority）" + "T3c：authorizationCohortDigest 冲突" |
| T4 | "T4：tr1_ child completion 的 generation/parent/binding 冲突均不得 supersede" |
| T5 | "T5：journal absent + completion absent + historical absent + final committed tombstone present → no_cleanup_authority" |
| T6 | "T6：committed completion 用 not-executed 视角查询 → conflict；public status 不输出 not-executed + fully_complete" + "T6b：not-executed historical authority 用 committed 视角查询 → conflict" |
| T7 A–E | "A：historical authority 写入前中断"、"B：authority 写入成功、completion 删除前中断 → 两者并存；reset 后幂等继续、不重复写冲突"、"C：completion 删除后、返回前中断 → historical 可独立查询；global reset 后仍 completed"、"D：authority read-back 失败 → completion 保留、authority 回滚（无残留）"、"E：completion 删除 read-back 仍存在 → blocked pending；后续幂等恢复" |
| T8 | "archive → 正式 retention 驱逐 tombstone + 联动释放 GRA → reset 后 historical 查询 exact completed" |
| T9 | "300 代链：正式 helper、每代 completion+archive、周期 retention/GC/reset、终态 compaction；全部历史可查" |
| T10 | "T10：满载但存在可安全回收项 → prepare preflight 回收一条、authorization/prepare 成功、callback 恰一次、proof 可查" |
| T11 | "T11：满载且无安全可回收项（historical 亦满）→ prepare/execute 拒绝、callback 零调用、completion 均保留" |
| T12 | "T12：completion store unhealthy → 零 archive、零删除、零 callback、明确 store unhealthy（不折叠为无可回收项）" |
| T13 | "同 ID 不同 identity 的 completion 写入 rejected(existing_conflict) → 其它 completion/historical 完全不变、零回收" |
| T14 | treasuryWriteArchitecture "Treasury completion supersession 架构守卫（Remediation VI）"（3 tests：底层 release 单一权威入口 / 不得回归 transactionId-only 与 tombstone-alone-completed / preflight 三处接线） |

## 300-generation 测试真实循环上限

`for (let generation = 1; generation <= 300; generation++)`（源码字面 300——root generation 0 + 300 个 child generation，实际执行；无 12 上限）。链过程：每代正式 journal open（tr1_ 带 lineage 四字段）+ 手工 activation 激活 + marker ack + `advanceTreasuryResolutionCleanupPhases` 五阶段完成（completion record）→ `convergeTreasuryLineageRetirementFromFacts`（GRA）→ capability/intent staging + `recomputeTreasuryDurableIdentityDigest` → `activateTreasuryLineageChild`（统一 archive 入口回收 parent completion）→ `retireTreasuryLineageCurrentAttempt`（末代 rearmable:false 进 terminal）。周期性维护：每 25 代 `Game.time += 5001` + 写入 dummy tombstone 触发满载惰性驱逐（正式 retention/GRA 生命周期通道）+ 双 store heap 清空（global reset 模拟，共 12 次）。末代：settle + tombstone-exact 归档 + `compactTreasuryTerminalLineage` 正式 terminal compaction。

## root + 300 child 的历史查询结果

root 与 generation 1..300 全部 attempt：`verifyTreasuryHistoricalCompletionStatus(attemptId).verdict === "match"` 且 `settlement === "not-executed"`；错误维度不 match：generation 150 用 committed 视角查询 → conflict；generation 300 用伪造 durable/parent/binding 的 expected identity → conflict。`advanceTreasuryResolutionCleanupPhases` 对 root 与 gen300 幂等查询均 completed（无 no_cleanup_authority 退化）。

## tombstone/GRA GC 后历史查询结果（T8）

root 的 final not-executed tombstone 经满载惰性驱逐（verdict replacement_match——GRA 在位 exact）正式删除并联动释放 GRA gen0 proof（active record 已被 terminal compaction 替代——释放条件成立）；此后双 store heap 清空（global reset 模拟）→ historical authority 仍 exact match（settlement=not-executed）、advance completed、错误 expected identity/outcome 均 conflict——完成事实不依赖已消失的 GRA/tombstone。

## 验证结果（全部本地执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `npx tsc --noEmit -p tsconfig.json` | 通过（零输出） |
| build | `npm run build` | 通过（`created dist/main.js in 39.6s`；无循环依赖警告） |
| Treasury 定向（V+VI+架构） | `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound22RemediationV.test.ts src/runtime/treasury/treasuryRound22RemediationVI.test.ts src/runtime/treasury/treasuryWriteArchitecture.test.ts` | 3 suites / 83 tests / 83 passed / 0 failed |
| Treasury 全目录 | `npx jest --config jest.config.cjs src/runtime/treasury/` | 71 suites / 1338 tests / 1338 passed / 0 failed |
| 全仓 Jest | `npx jest --config jest.config.cjs` | 270 suites / 2151 tests / 2151 passed / 0 failed / 0 pending / 0 todo |
| budget | `node scripts/verify-jest-budget.mjs` | `{"status":"JEST_TEST_BUDGET=PASSED","suites":270,"tests":2151}`（baseline `ad0002e`） |
| bundle SHA-256 | `sha256sum dist/main.js` | `45108530802db57ec0255fc5358bb97055618964af18c5bc1a212a43bc54ec93` |

## 未部署声明

本轮未部署到 Screeps、未合并 main、未调用真实 `terminal.send()`、未调用真实 market/lab/factory/nuker/carrier 等 Game 写 API；全部 Game 交互均为测试 mock。未宣称任何线上验证。
