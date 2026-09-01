# Round 20 — Semantic Lineage Validation & Exact Terminal Proofs（本地验证证据）

- 日期：2026-09-02
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始 HEAD：`688c32ef436787893d973d8f587884ac49f12205`
- 实际起始 HEAD：`688c32e`（与预期一致；远端在起始时与本地同步）
- 最终 HEAD：见下方 commit 列表最后一项（budget 提交前为 `b692aef`，其后为 evidence/budget 两个独立提交）

## 1. 本轮全部 commit 与作用

| SHA | 主题 | 作用 |
|---|---|---|
| `5d308b6` | docs(openspec): define round 20 semantic lineage and exact proof invariants | proposal/design/spec/tasks 定义第二十轮不变量（design.md §16、spec.md 7 个新 Requirement、tasks.md §26） |
| `254fb4f` | feat(treasury): add semantic lineage validation with exact retirement authority | 三个新模块（semanticLineageValidation / exactAttemptIdentity / generationRetirementAuthority）+ resolver semantic gate + handoff unified authority 重写 + beginTick 顺序 + receipts 幂等 exact 与写入门禁 + verifier semantic verdict + chain committed 结果处理 |
| `805e674` | feat(treasury): require exact retirement proof for historical generation and capability gating | lineageGenerationRetirement verdict 重写（历史代 exact proof、root 五元、当前代持久 parent）+ resolutionStore 驱逐联动 + attemptOccupancy N+1 capability 门禁 |
| `bda5111` | refactor(treasury): verify exact settlement identity before terminal compaction | 压缩前完整 exact settlement identity + 全 store 健康 + 幂等比较扩展 + 孤儿 proof 清理 |
| `3fde3a0` | refactor(treasury): centralize exact attempt identity and converge raw rearm checks | facade 预检 exact / intents finalized 链 / resolutionAuthority / attemptRearm / 散落 tr1_ 收敛 |
| `b692aef` | test(treasury): cover round 20 semantic lineage and receipt invariants | 4 个 round20 测试文件（67 tests）+ GRA byAttempt 索引/当前代保留 + root 五元双口径 + resolver 低层 contract/cohort 补齐 |
| （evidence） | docs(evidence): record round 20 local validation | 本文件 |
| （budget） | chore(test-budget): update verified round 20 budget | 预算锚点更新（独立提交） |

## 2. Semantic lineage validation 流程

```text
tr1_ transaction ID
  ├─ 1. parse v2 child ID（legacy 不可解析 → insufficient legacy isolated）
  ├─ 2. ID 内嵌 (lineageId, generation) === proof 四字段对应项
  ├─ 3. 权威 source 定位（record by lineageId；缺 → summary by lineageId）
  ├─ 4. expected child ID = formatV2(lineageId, generation, root)（checksum 绑定 root）
  ├─ 5. expected parent = gen-1 派生（gen1 parent=root；genN=genN-1 child）
  ├─ 6. binding = computeTreasuryLineageBindingDigest(lineageId, gen,
  │      expectedParent, child) 重算（不信任载体自带字符串）
  ├─ 7. class/provenance 相容（lowlevelSource ↔ authorityClass）
  └─ 8. generation 角色判定：
        > current + 在途 handoff 事实 → pending_handoff match
        = current（record current 三元一致）→ current match
        < current → 查 exact retirement proof（缺失 insufficient；
                    存在则完整比较 → historical match / conflict）
        summary 路径：final 代 terminal_current；历史代同样需 exact proof
```

verdict：`match / conflict / insufficient(legacy isolated) / store_unhealthy / no_authority`；readers 未装配 → store_unhealthy fail closed。authority source 装配：attemptLineage（record）、lineageRetirementSummary（summary）、generationRetirementAuthority（proof）模块加载注册（可重入 re-register 供测试）。

## 3. shape proof 与 semantic proof 矩阵

| 维度 | shape proof（lineageProof.ts） | semantic proof（semanticLineageValidation.ts） |
|---|---|---|
| 四字段形状（16hex/安全整数/合法 parent ID） | ✓ | 输入前置（facts 由调用方经 shape 提取） |
| tr1_ 必带 / initial 禁带（required 矩阵） | ✓ | 冲突时 conflict（防御） |
| 载体间四字段相等 | resolver 双侧 relation | —（在 resolver shape 层完成） |
| child ID 内嵌 lineage/generation | — | ✓ |
| ID v2 派生 + checksum 绑定 root | — | ✓ |
| parent 确定性派生（gen1=root） | — | ✓ |
| binding 权威重算 | — | ✓ |
| class/provenance 相容 | — | ✓ |
| active 状态/current 三元/next(pending facts) | — | ✓ |
| 历史/终代 exact retirement proof | — | ✓ |
| store unhealthy fail closed | — | ✓（含 readers 未装配） |

## 4. Handoff 双 authority 恢复顺序与矩阵

beginTick 固定顺序（facade.performBeginTick）：

```text
cleanupTreasuryReceipts → ensureReservationSchemaActivated
  → ① recoverTreasuryLineageHandoffEvidenceAtTickBoundary（【Round 20 新增，先于一切 intent 删除】
     只处理 child_intent_pending：resolver 完整一致性 + semantic + record facts）
  → ② recoverTreasuryIntentsAtTickBoundary（通用 intent recovery/cleanup）
  → ③ pendingReleaseSnapshot → recoverStagedResolutions
  → ④ recoverTreasuryAttemptLineageAtTickBoundary（child_intent_pending 重入幂等）
  → ⑤ compactTreasuryTerminalLineagesAtTickBoundary
```

| resolver 结果 | 附加条件 | 判定 |
|---|---|---|
| store_unhealthy | — | pending（两侧证据保留，零动作） |
| inconsistent | — | forensic（全部 authority 保留） |
| not_found | — | rollback（零释放） |
| ok | semantic=match + 四字段/class/provenance/actionKind 一致 + intent-only not_started/ready | rollback + 释放 intent |
| ok | 同上 + quarantine 接管（含双存在归一）或 executing/更后 | forward_complete（child identity 从 resolver 构造） |
| ok | semantic ≠ match / pending facts / class / provenance / actionKind 冲突 | forensic |
| ok（双存在） | 低层 contract/cohort 单侧携带 | inconsistent（resolver 低层分支补齐）→ forensic |

execution facts 矛盾（ready intent `not_started` + quarantine `started_unknown`）→ resolver cohesion inconsistent → forensic（第十九轮"并存即 forward"的行为按第二十轮 7.5 收紧为不猜测）。

## 5. Exact attempt identity 字段来源矩阵

| 来源 | transactionId | digest | contract | cohort | durable | lowlevel | proofClass | lineage 四字段 |
|---|---|---|---|---|---|---|---|---|
| prepared/identity 输入 | ✓ | ✓ | o | o | ✓ | o | 推导（事实） | ✓（tr1_） |
| unresolved authority | ✓ | ✓ | o | o | o | o | authorityLevel 推导 | ✓ |
| receipt proof | ✓ | o | o | o | o | o | proof.level | ✓ |
| resolution tombstone | ✓ | ✓ | o | o | o | o | proofLevel | ✓ |
| lineage current | ✓ | ✓ | o | o | o | o（回落 record 顶层） | authorityClass | record 三元 |

relation（对称）：transactionId/digest/proofClass 不同 → conflict；tr1_ 一方缺 lineage → insufficient；非 tr1_ 携带 → conflict；可选维度一方缺失 → insufficient、不等 → conflict。手工字面量构造仅剩 markerAttempt（class-aware 子集，任务书 8.4 允许的诊断性简化——架构扫描按命名豁免）。

## 6. Receipt existing/new/refresh 矩阵

| 场景 | 行为 |
|---|---|
| existing + exact identity 完全一致 | already_settled_match（global reset 后重入幂等——修复第十九轮 lineage 字段丢弃导致的 identity_conflict 误判） |
| existing + lineageId/generation/parent/binding/durable/lowlevel/class/contract 任一不同 | identity_conflict（不覆盖） |
| existing + legacy proof | already_settled_insufficient（replay blocker） |
| absent + tr1_ 完整 proof + semantic match + 角色 current/terminal(chain_committed) | written（完整 proof） |
| absent + tr1_ 缺 proof / 语义不匹配 / binding 错误 / pending_handoff 或历史代角色 / terminal 非 chain_committed | fatal 零写 |
| absent + initial 携带 lineage 字段 | fatal 零写 |
| readers 未装配 | tr1_ 写入 fail closed（fatal） |
| refresh + matching proof | 保留 identity 仅刷 tick |
| refresh + 既有缺 proof（迁移形态） | blocked legacy_proof（不自动补全） |
| refresh + semantic conflict（binding 与权威重算不同） | blocked identity_conflict（不覆盖） |

## 7. Per-generation exact retirement 协议

- 写入顺序：retirement 三段收敛（publication 内置 / authorityReleased=resolver not_found / markerCleaned=marker 证明）→ **exact proof 写入 + Memory read-back** → 才推进 retiring → rearm_ready / non_rearmable_retired；proof 写入失败（满载/冲突/损坏）→ 保持 retiring（fail closed）。
- proof 内容：lineageId/root/rootIdentityDigest/generation/transactionId/parent(gen≥1)/binding(gen≥1)/digest/contract?/cohort?/durable?/lowlevel?/authorityClass/retrySemanticDigest?/resolution=not_executed/三段全 true/completedAtTick。
- 下一代门禁：preflightTreasuryRearmCapability 校验当前 generation 的 exact proof 存在且解析一致（transactionId/binding/parent/digest 与 record）→ 缺失 `generation_retirement_proof_missing` 拒绝。
- 容量：硬容量 384（256 resolution tombstone 依赖上界 + 64 active 当前代 + 余量）；满载 fail closed；lookup (lineageId, generation) O(1) + byAttempt O(1)。
- 回收：(a) not-executed tombstone 驱逐（verdict match）联动释放——**当前代 proof 保留**（chain 活跃时它是 N+1 门禁依据；record 存在且 generation 相同 → 保留）；(b) chain 压缩后孤儿清理（该 lineage 中 tombstone 已不存在的代）；正常 tick 零扫描。
- 旧数据（Round 18/19 无 proof）：verdict insufficient/pin、capability 拒绝——不自动补现代 proof。

## 8. Active lineage 与 terminal summary 关系

- active 存在：历史代由 exact proof 证明（删除状态机推断）；当前代三段 + retirementGeneration + 持久 parent + identity 维度；压缩（chain_committed/non_rearmable）前完整 exact settlement identity 验证 + semantic match + 当前代 proof 在位 + 全 store 健康 → summary 写入 read-back → 删 active → 清孤儿 proof。
- active 缺失：summary 提供定位与 finalGeneration 边界；root tombstone 需五元重算（rootIdentityDigest 双历史口径：rootIdentity 含/不含 provenance）+ proofLevel vs authorityClass + generation 0 exact proof；child 历史代需 exact proof（finalGeneration 只是边界不是 membership proof）。
- 幂等压缩重入：existing summary 比较 lineageId/rootIdentityDigest/terminalState/finalGeneration/finalAttemptId/authorityClass 全部一致才复用。

## 9. Root/child tombstone replacement 矩阵

| 场景 | verdict |
|---|---|
| root ID 命中 summary + 五元一致 + class 一致 + gen0 proof 匹配 | replacement_match |
| root ID 命中但 digest/identity 不同 | replacement_conflict（pin，不删证据） |
| root proof class 与 summary 不一致 | replacement_conflict |
| gen0 proof 缺失（旧数据） | replacement_missing（pin） |
| child（active）历史代 exact proof 完整匹配 | replacement_match |
| child 历史代 proof 缺失（gen < current） | replacement_missing（状态机推进不是证明） |
| child proof digest/parent/identity 篡改 | replacement_conflict |
| 当前代持久 parent 篡改/缺失 | replacement_conflict |
| 当前代三段未全/retirementGeneration 属旧代 | replacement_pending |
| summary 历史代无 exact proof | replacement_missing（finalGeneration 只是边界） |
| 任意相关 store unhealthy | store_unhealthy（pin） |
| v1 不可寻址 tr1_ ID / summary 缺 authorityClass | replacement_missing（不猜测） |

## 10. Store 版本、容量与迁移

| store | 版本 | 容量 | 迁移 |
|---|---|---|---|
| attempt lineage | v2（不变） | 64（不变） | 不变（v1→v2 保留） |
| retirement summary | v2（不变） | 128（不变） | 不变（v1→v2 保留） |
| generation retirement proofs | **v1（新增）** | **384（新增）** | 新 store——首次 load 一次有界全表验证 + byLineage/byAttempt 索引重建；global reset 后读取一致（测试覆盖） |
| receipts / intents / quarantine / resolution | 不变 | 不变 | 不变 |

旧数据策略：不猜测、不自动补 proof、不通过延长 retention 掩盖；原子迁移原则全部保留。

## 11. 关键中断窗口（与恢复）

| 窗口 | 状态 | 恢复 |
|---|---|---|
| exact proof 写入后、retirement 状态推进前中断 | proof 在 + retiring | 下次 converge 幂等（proof idempotent 写）→ 推进 |
| proof 写入失败（满载/冲突） | 保持 retiring | 容量释放（tombstone 驱逐/压缩清理）后重试 |
| receipt 已写 + heap publish 故障 | executed_unsettled + receipt | beginTick commit-pending 补完成 → chain_committed（测试覆盖） |
| receipt 写前 fault → resolve-as-committed | quarantine authority | capability + semantic validation → receipt 从 authority 写入 → verified → chain committed（测试覆盖） |
| quarantine 写成功、intent 删除前 reset（executing 相容） | 双存在 | resolver 归一 → forward_complete |
| ready intent + quarantine（facts 矛盾） | — | forensic（保留两侧——beginTick 顺序保证判定先于删除） |
| chain_committed 推进写失败 | child_active 保留 | beginTick 按 matching receipt 幂等补完成（计数 chainCommitPendingRetries） |
| 压缩 summary 写入 read-back 失败 | active record 保留 | 零删除；下次重试 |

## 12. Operation-count（测试断言值）

- 50 次 semantic validation：lineageStoreEvents.fullScans 不增、generationRetirementEvents.fullScans 不增。
- 50 次 receipt exact lookup：fullScans 不增。
- 50 次 tombstone verdict：lineage/summary/exact-retirement fullScans 均不增。
- 空闲 beginTick：不扫描 exact retirement history。
- 30 代 chain（测试口径）：active lineage entryCount 恒 1；GRA entryCount ≤ 世代数 + 1（有界）；300 代语义由 Round 18/19 既有测试与硬容量共同保证。

## 13. 验证结果（真实命令输出）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 通过（exit 0，无输出） |
| `npm run build` | 成功（dist/main.js created，bundle sha256 621bfad4…） |
| `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound20{SemanticLineage,ExactRetirement,ReceiptIdentity,OperationCount}.test.ts` | 4 suites / 67 tests / 67 passed / 0 failed |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 60 suites / 1058 tests / 1058 passed / 0 failed |
| `npx jest --config jest.config.cjs`（全仓库） | **254 suites / 1764 tests / 1764 passed / 0 failed / 0 pending / 0 todo** |
| `node scripts/verify-jest-budget.mjs` | 见 budget 提交（锚点更新后通过） |

预算对照：起始基线 250 suites / 1697 tests（锚点 7c38c45）→ 本轮 254 / 1764（+4 suites / +67 tests；无删除/跳过/skip）。

## 14. GitHub CI 实际状态

仓库无 `.github/workflows`（`gh run list --repo ceyirelehe47/screeps-bot` 返回空）——**不存在 GitHub Actions / commit status / 其它 CI**。本轮全部验证为本地执行；不声称 CI passed。

## 15. 真实 Game writer diff 检查

- `git diff --stat 688c32e..HEAD -- src/runtime/{resourceControl,marketDirectContinuousAutomation,marketSaleProtection,marketSaleProtectionAdapter,factoryControl,synthesisControl,nukerControl,terminalActionEnergyOwnership}.ts` → **空**（零改动）。
- treasury 源码（非测试）真实调用形态扫描（`.send(`/`Game.market.deal(`/`.runReaction(`/`.boostCreep(`/`.unboostCreep(`/`.produce(`/`.launchNuke(`/`creep.transfer(`/`creep.withdraw(`/`.spawnCreep(`）→ **零命中**（架构测试常驻断言）。
- 说明：`factoryControl.ts` 等既有 production 文件含**历史** writer 调用（非本轮引入，不属于 Treasury 重构范围）；本轮约束是零 diff（上文空输出证明）与 treasury 新代码区域零真实 writer。

## 16. 边界声明

- 未部署到 Screeps；未合并 main；未 force push；未 rebase；未 amend 已推送历史。
- 未实现或调用真实 `terminal.send()` / `Game.market.deal()` / 任何 Game 写 API；测试中的 adapter kind 名称、mock、字符串不是真实 writer 调用。
- 未迁移 ResourceControl / market / carrier / lab / factory / nuker / synthesis writer；未实现完整 Budget Service；未开始线上 shadow execution；未删除旧 inventory/reservation/ReceiverCapacityLedger。
- Screeps hard CPU interruption 与 Memory flush 仍不保证 exactly-once（本轮的全部 fail-closed 设计以持久证据幂等重入弥补，不改变该物理边界）。
- 未声称 CI 通过（无 CI）。

## 17. 下一阶段准入判断

具备进入以下阶段的前提（语义验证链已闭合、全部拒绝路径 callback 零调用、exact proof 协议就位）：

- terminal.send adapter 纯实现；
- contract plan shadow；
- authorization shadow；
- next-tick reconciliation shadow；
- 零 Game API 端到端演练。

但**不得仅因单元测试通过就批准真实 `terminal.send()`**——adapter 纯实现与 shadow 阶段（含零 Game API 演练）仍是真实执行的前置。
