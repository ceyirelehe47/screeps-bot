# Round 16 — Attempt Rearming & Execution-Fact Cohesion 本地验证证据

- 日期：2026-09-01
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`428d5bbdb3cb51ce6b1c7d7705985bd0e24139af`（Round 15 终态，本地 = 远端）
- 最终 HEAD：`<budget 提交后回填>`（见下方 commit 列表）
- GitHub 仓库无 CI —— 本文档只记录**本地实际运行**的验证，不声称 CI passed。

## 1. Commit 列表（本轮全部）

| SHA | 主题 |
| --- | --- |
| `08734f0` | docs(openspec): define round 16 attempt rearming and execution fact cohesion |
| `aab3cb0` | refactor(treasury): make authority resolution store-health aware and enforce execution-fact cohesion |
| `8005e82` | feat(treasury): add deterministic child-attempt rearm protocol |
| `de5e083` | refactor(treasury): bind lowlevel provenance into settlement proof identity |
| `82a61f4` | fix(treasury): validate persisted resolution state and complete marker cleanup after release |
| `d5416ab` | fix(treasury): deep-clone durable authority inputs before publication |
| `9447f78` | test(treasury): cover round 16 rearm and authority invariants |
| `5f89263` | test(treasury): adapt existing fixtures to round 16 semantics |
| (evidence) | docs(evidence): record round 16 local validation |
| (budget) | chore(test-budget): update verified round 16 budget |

`requiredBaselineCommit = 5f89263`（包含全部实现与测试、位于 budget 提交之前）。

## 2. Attempt rearm 状态图（same-ID 不可重试）

```text
business action
   ├─ attempt A（transaction ID A）
   │    ├─ committed → A 终结（receipt + final committed tombstone；同 ID 重放 → already_settled）
   │    └─ not-executed → final not-executed tombstone A（sameIdRetryAllowed=false + rearmChildTransactionId）
   │                        │ authority 释放 + marker 清理完成后
   │                        └─ 显式 rearm（service.rearmResolvedNotExecutedAttempt，零写）
   │                              └─ child B = tr1_<hash16(协议版本 ‖ A ‖ A 的 attempt identity 全成分)>
   └─ attempt B（新 transaction identity；contract/bundle/intents 绑定 B）
        ├─ B 故障 → 独立 capability/resolution/receipt（A 的 proof 不能证明 B）
        └─ B not-executed → 再 rearm → C（A→B→C；每 attempt 最多一个直接 child）

同 ID 直接 prepare：final not-executed tombstone 存在 → rejected(rearm_required) + callback 零调用
```

### parent/child attempt 身份规则

- child ID = `tr1_` + 双 lane FNV-1a hash（canonical tuple：`treasury-attempt-rearm@v1` + parent transactionId + digest + contractDigest? + authorizationCohortDigest? + durableIdentityDigest? + lowlevelSource?）；
- 输出满足现有 transaction ID validator（`/^[A-Za-z0-9:_\-.]{1,128}$/`，长度 20）；
- O(1) 纯函数、无随机数、跨 global reset 恒定、同 parent 幂等、不同 parent / 不同 parent identity 不同 child；不持久化无界 attempt sequence 表；
- rearm 前置：final not-executed tombstone ∈ {identity-bound, lowlevel}（legacy/forensic 拒绝）+ expectedParentIdentity 可选强校验 + resolver not_found（authority 已释放）+ marker 清理完成（7.3）+ 各 store 健康；
- parent tombstone retention 清理不改变已生成的 child ID（ID 已交付调用方，纯派生无状态）。

### Resolution 结果中 same-ID 重试语义的变化

- `reprepareAllowed: boolean` 字段**删除**；resolved 分支改为 `sameIdRetryAllowed: false`（committed 与 not-executed 均恒 false）+ not-executed 时 `rearmChildTransactionId: string`（确定性派生）；
- prepare（两阶段与单阶段 compat）在 final not-executed tombstone 存在时返回 `rearm_required`（`TreasuryRejectionReason` 新枚举）。

## 3. Execution fact 兼容矩阵（executionFactCohesion.ts 唯一权威）

- **outcome 对等**：只有完全相同 outcome 才可归一化。禁止：returned_ok 与任何非 returned_ok、returned_non_ok 与 started_unknown/not_started、started_unknown 与 not_started、aborted_final 与任何运行时事实——全部 inconsistent（两份 authority 全保留，绝不"选择更强事实"）；
- **phase 类别严格对应**：returned_ok ∈ {receipt_publish, heap_publish, journal_publish, overlay_publish, handle_state, commit_unexpected, ok_pending_commit_unresolved}；returned_non_ok = action_returned_non_ok_abort_failed；started_unknown ∈ {executing_at_end_tick, action_threw_execution_unknown}；not_started ∈ {internal_authorization_fault, internal_authorization_fault_forensic}——跨类上探并存禁止；
- **intent settlement 并存集合**：not_started ∈ {quarantined, resolving, faulted}；started_unknown ∈ {executing, quarantined, resolving, faulted}；returned_non_ok ∈ {pending_abort, quarantined, resolving, faulted}；returned_ok ∈ {pending_commit, quarantined, resolving, faulted}（ready/finalized 不得与 unresolved quarantine 并存）；
- **归一化合并规则**：outcome=共同值；settlement=双方向更进展一方（ready<executing<pending_*=2<quarantined|faulted=3<resolving=4<finalized=5）；phase=quarantine（write-fault 权威形态）。

## 4. Marker 补完成流程（7.1/7.2）

```text
final not-executed + resolver not_found
  ├─ marker 不存在 → 释放与清理均完成（移出 pending-release 索引）
  └─ marker 存在 → 全部匹配才清除：
        transactionId + digest 双匹配
        marker.attemptIdentity 完整且 relation(tombstone, markerIdentity) = match（缺失 = insufficient 不清）
        phase 与 not-executed 结论兼容（preExecution 矩阵：preExecution=true 只配 internal_authorization_fault*；
          普通 not-executed 只配 execution-unknown 类）
        tombstone proof level 与 marker identity 兼容（完整现代身份 marker 只配 identity-bound）
      → 清除 marker + completedRelease 计数（幂等）
      → 他属 | conflict | insufficient | phase 不兼容 → 保留 marker + tombstone、
        write readiness 继续阻断、markerCleanupBlocked 独立计数、不伪造 authority
```

marker 读取（readTreasuryWriteFault）返回有界深冻结快照（嵌套 attemptIdentity 一并封闭）；marker 清理未完成前 rearm 拒绝（marker_cleanup_pending）。

## 5. Resolver 四态语义（第八节）

| 状态 | 语义 | 副作用 |
| --- | --- | --- |
| ok | 归一化 authority（identity + cohesion 全部成立；execution facts 经合并规则） | 按 verifier 继续 |
| not_found | 两个 store 均可信且都确实无 entry（store 不存在 = 合法无 entry 来源） | committed → receipt↔tombstone 补完成；not-executed → marker 补完成 |
| inconsistent | identity 或 execution-fact 冲突（双 authority） | 零 release/refresh/marker-clear/stage 变化，两份全保留 |
| store_unhealthy | intent/quarantine store fatal（附各 store 有界诊断） | 零 release/refresh/marker-clear/stage 变化/reconciler/capability 签发 |

接入路径全部处理 store_unhealthy：capability 签发（authority_store_unhealthy + reconciler 零调用）、resolution prevalidate（rejected）、staged recovery 两分支（storeUnhealthy 独立计数）、final not-executed 补完成、committedProofVerifier（authority_store_unhealthy verdict——不归入 authority not_found）、rearm（拒绝）。

## 6. Resolution 持久状态语义矩阵（resolutionStateSemantics.ts）

| 持久状态 | 判定 |
| --- | --- |
| stage 缺失 / 未知 | unhealthy（v1-v4 迁移补终态 stage=final） |
| resolving not-executed | unhealthy（not-executed 只能直接 final） |
| resolving committed 缺 settledAtTick | unhealthy（staged 目标 tick 必填） |
| resolving proofLevel = legacy/forensic | unhealthy（普通自动 resolution 等级只有 identity-bound/lowlevel） |
| resolving 携带 forensicProvenance / preExecution | unhealthy |
| final committed 缺 settledAtTick | unhealthy |
| final committed 携带 preExecution | unhealthy |
| final not-executed 携带 settledAtTick | unhealthy（committed receipt tick 语义） |
| final not-executed preExecution=true 且 source 非受控通道 | unhealthy |
| forensicProvenance 配非 forensic proofLevel | unhealthy |
| final 终态 settledAtTick/observationTick 晚于 resolvedAtTick | unhealthy |
| write 上下文：lowlevel 新写入缺 lowlevelSource | 拒绝（v5 旧数据缺失 = 隔离态，load 放行但不自动释放） |
| write 上下文：identity-bound 携带 lowlevelSource | 拒绝 |

损坏处理：load 发现非法持久状态 → store fatal（原 entry 保留、write readiness=false、recovery 不删除——"防御分支删除"路径废除，删除非法持久状态不是 repair）。migration 遇非法组合：原 store 不变（版本不前移）。合法 v1-v5 迁移继续通过（v2-v4 无 stage 历史 entry 补 final）。

## 7. Durable input clone 与 alias 隔离（第十节）

- 新模块 durableClone.ts：`cloneTreasuryDurableValue` 有界深拷贝（深度 8 / 每层键 256，超出该层退化浅拷贝；普通对象/数组/嵌套 revisions/authorization leg digests/structure descriptors/forensic provenance/attemptIdentity）；
- 接入：intent / quarantine / authorization-fault（整体深拷贝——含 structureFacts/cohort/forensic）、resolution tombstone 写入（forensicProvenance 隔离）、write-fault marker（attemptIdentity 隔离）；
- 发布顺序：clone 输入 → 验证 clone → 重算 clone identity → Memory 写入 clone → read-back 验证；
- 测试：写入成功后修改原输入的嵌套对象（cohort revisions/legs、structureFacts、deltas/postings、forensic provenance、attemptIdentity）Memory 完全不变（treasuryRound16ResolutionStateMatrix 五 store 覆盖）。

## 8. Lowlevel provenance proof 链（第十一节）

- attempt identity：TreasuryAttemptIdentity.lowlevelSource + relation 单向维度（attempt 携带时 proof 必须携带且相等：缺失=insufficient、不等=conflict；marker 等部分身份视图不带时该维度不比较——低层 proof 证明非低层 attempt 由 capability prevalidate 显式等级校验承载）；
- capability：绑定 authority.lowlevelSource（lowlevel authority 双方必须一致携带、非 lowlevel 携带即拒绝）；
- resolution tombstone v6：lowlevelSource（仅 proofLevel=lowlevel；新写入必须携带；v5 旧数据 = 来源不可证明隔离态，不自动释放、不猜测 runtime 来源）；列入状态机 finalize/幂等的安全关键字段；
- receipt v6：lowlevelSource（modern 可携带、legacy 禁带、受控枚举校验；commit 与 refresh 随低层 attempt 写入——facade 两阶段低层路径（无 contract）receipt 携带 runtime 来源）；
- verifier：三方严格比较（tombstone 缺来源=insufficient；tombstone 与 authority 不同=conflict）；runtime-lowlevel 与 migrated-lowlevel 不能互相证明；modern（identity-bound）不释放 lowlevel（自动释放矩阵）。

## 9. Not-executed capability 消费与 tombstone 发布顺序（第十二节）

```text
完整 prevalidate → resolution slot 预检 → consume capability → 写 final not-executed tombstone
  → 释放 quarantine/intent → 清 marker → markTreasuryPendingReleaseCompleted
```

- consume 失败：不写 tombstone、authority 保留、marker 保留（不存在"未成功消费 capability 却已持久化可自动释放 authority 的 final proof"）；
- consume 成功 + tombstone 写失败：authority 保留（本 tick capability 已消费；后续 tick 重新签发重试，不形成错误终态）；
- tombstone 成功 + 释放前中断：final tombstone 为持久 proof，beginTick pending-release 补完成（marker 流程见第 4 节）。

## 10. Resolution recovery 索引与 operation-count（第十三/十五节）

- heap 运行态索引：`resolvingIds: Set<string>` 与 `pendingReleaseIds: Set<string>`——global reset 首次 load 一次有界全表扫描（≤256）重建；写入/删除/retention 驱逐/补完成同步维护；
- beginTick：两索引皆空 → O(1) 直接返回（idleFastPath 计数，不扫描 resolution entries）；有待处理项只遍历索引 ID（不扫描全部历史 final proof）；索引 ID 在 Memory 已不存在或状态已变时直接清理（Memory 权威，索引不作安全 proof）；
- resolving 计数改经索引 size（health probe / write readiness 兼容 O(1)）；
- operation-count 实测：空闲 beginTick 零全表扫描（连续 6 次 idle）；1 条 resolving + 255 条历史 final 只处理 pending ID、零新增 store 全表扫描；store_unhealthy resolver 不回退扫描或选择另一 authority；rearm（含重复）零新增 receipt/tombstone 历史表扫描。

## 11. 新增/升级 Memory store 版本、字段、容量与迁移

| store | 版本 | 变化 | 迁移 |
| --- | --- | --- | --- |
| resolutions | v5 → **v6** | 新增可选 `lowlevelSource`（仅 lowlevel proof；受控枚举） | v5→v6 无损；v2-v4 无 stage 历史 entry 补 stage=final；load/迁移接入持久状态语义矩阵 |
| receipts | v5 → **v6** | 新增可选 `lowlevelSource`（modern 可携带/legacy 禁带；受控枚举） | v5→v6 无损；lookup 版本分派补 v6 |
| intents v6 / quarantine v5 / authorization-fault v4 | 不变 | 写入深拷贝行为（无 schema 变化） | — |
| write-fault marker | 不变 | 写入深拷贝 attemptIdentity、读取深冻结快照 | — |

容量不变：resolutions ≤256（retention 5000）、receipts ≤256（retention 5000）、intents ≤64、quarantine ≤64。Memory schema 指纹（runtime.d.ts）随 v6 声明更新（aeacf0e7…）。

## 12. 验证命令与真实结果（本地运行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（build + test 双 tsconfig，0 error） |
| `npm run build` | 通过（dist/main.js 31.5s，bundle sha256 216407c8b35ef09a…） |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 44 suites / 834 tests / 834 passed / 0 failed |
| `npx jest --config jest.config.cjs` | **238 suites / 1540 tests / 1540 passed / 0 failed** |
| `node scripts/verify-jest-budget.mjs` | **JEST_TEST_BUDGET=PASSED**（suites 238 / tests 1540） |
| `git status` | 干净（除 evidence/budget 提交物） |
| `git log --oneline 428d5bb..HEAD` | 本轮 10 个提交（见第 1 节） |
| `git diff --stat 428d5bb` | 46 files changed（treasury/types/memory/test/openspec；writer 生产文件 0 改动） |

定向测试：attempt rearm（12 用例）、execution fact cohesion（12）、store-unhealthy resolver（7）、marker 补完成（8）、持久状态矩阵 + alias 隔离（13）、lowlevel proof provenance + capability staging（11）、operation-count（6）全部通过。

### writer 边界扫描

`src/runtime/resourceControl.ts`、`marketDirectContinuousAutomation.ts`、`marketSaleProtection.ts`、`marketSaleProtectionAdapter.ts`、`factoryControl.ts`、`synthesisControl.ts`、`nukerControl.ts`、`terminalActionEnergyOwnership.ts` 相对基线 **diff 为空**（`git diff --stat 428d5bb -- <八文件>` 输出为空）；扫描命中的 `lab.runReaction`（synthesisControl）与 `Game.shard?.name` 读取（marketDirectContinuousAutomation）均为本轮之前既有代码（架构边界测试守护范围内），本轮未迁移任何 writer。

## 13. 声明

- **未部署**到 Screeps；**未合并 main**；**未接任何真实 Game writer**（`terminal.send()` / `Game.market.deal()` / lab / factory / nuker / creep transfer/withdraw 零调用）；
- 本轮全部拒绝路径 Game callback 调用数为 0（测试断言覆盖 rearm_required / cohesion conflict / store_unhealthy 等）；
- 仓库无 GitHub CI——以上均为本地验证；
- Screeps hard CPU interruption 与 Memory flush 边界仍不保证 exactly-once（协议目标为持久状态可恢复，非分布式事务）。

## 14. 进入下一阶段的评估

Round 16 完成后协议面已具备进入以下阶段的**前提**（未开始）：

- terminal.send adapter 实现 —— 协议前提已具备（attempt 生命周期、rearm、proof 链完整）；
- 纯 contract plan shadow —— 可开始（不调用 Game API）；
- authorization shadow —— 可开始；
- next-tick reconciliation shadow —— 可开始；
- **真实 terminal.send 调用**：协议前提具备，但按本轮规范要求，不得仅因单元测试通过而批准——仍需在 shadow 阶段积累对照证据后显式决策。

## 15. 剩余风险

- migrated-lowlevel authority 只能由版本化迁移产生（生产写入仅接受 runtime 来源）——现有测试以 verifier 纯函数覆盖反向组合；真实 v5→v6 迁移路径上的 migrated tombstone 隔离语义依赖 load 语义矩阵（无 v5 生产数据时可验证路径有限）；
- rearm 是零写协议——child attempt 的实际 prepare 仍受全局 write blocker（marker/quarantine/resolving）约束；如果帝国长期存在其它 unresolved fault，child 会按全局 fail-closed 语义排队（符合预期但运维上需要显式处理根因）；
- marker 补完成的 phase 矩阵依赖 marker 形状契约（attemptIdentity 为 Round 13 形状，无 provenance 字段）——若未来 marker 增补 provenance，需同步扩展 validatePendingReleaseMarkerCompletion；
- resolution pending 索引是 heap 运行态——global reset 后首个 beginTick 需一次有界全表扫描（≤256 条，实测无性能问题）；
- `lab.runReaction` 等既有 writer 调用仍在本轮范围外（按阶段计划迁移）。
