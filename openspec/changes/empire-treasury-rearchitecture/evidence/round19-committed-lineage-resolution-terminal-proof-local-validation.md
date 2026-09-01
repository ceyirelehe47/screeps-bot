# Round 19 — Committed Lineage Resolution & Terminal Proof Compaction 本地验证证据

## 1. 日期、分支、起始与最终 HEAD

- 日期：2026-09-01
- 分支：`refactor/empire-treasury-rearchitecture`
- 起始 HEAD：`2a435ff880ecf2975bf3195e9a74014d390f41d1`（与任务书预期一致；工作树干净）
- 最终 HEAD：见第 13 节（推送后以 `git ls-remote` 为准）

## 2. 本轮 commit 列表

| commit | 主题 |
|---|---|
| d4a3840 | docs(openspec): define round 19 committed lineage resolution tasks |
| b118b18 | refactor(treasury): expose and verify lineage proof in unified authority（新增 lineageProof.ts 单一权威 + resolver 双侧/单侧 proof 矩阵） |
| ae2913e | fix(treasury): propagate lineage proof through committed resolution chain（capability 绑定 / tombstone / refresh / verifier / marker / chain_committed 全链） |
| eb0a5cd | fix(treasury): recover child handoff from both intent and quarantine |
| 42f2f57 | fix(treasury): prove each retirement stage from durable facts（markStage + converge 单一权威） |
| 80df5d3 | fix(treasury): detect duplicate lineageId in cross-index integrity（sameRecord 改 entry identity） |
| 54a6f33 | fix(treasury): prove historical generations from terminal summary（summary v2 + verdict 重演验证） |
| 6df9b53 | fix(treasury): accept migratable store versions in health probes（receipt v6/v7、resolution v6） |
| 9d2d9b7 | test(treasury): assert v6 migration-pending health with load fail closed（Round 17 测试语义随版本认可更新） |
| 7c38c45 | test(treasury): cover round 19 resolution, recovery and compaction invariants（7 文件 64 项） |
| 2c37446 | docs(openspec): close round 19 task list and spec requirements |

## 3. Committed resolution 完整 proof 流向图

```text
intent / quarantine（各自携带完整 lineage proof——store 矩阵）
  → resolveTreasuryUnresolvedAuthority
      ├─ 双存在：lineage proof 双侧形状验证（tr1_ 必完整/initial 禁带）
      │   + 单侧缺失 inconsistent + 四字段不一致 inconsistent
      └─ 单侧：同样形状验证 → authority 暴露 4 字段
  → reconciliation capability 签发（facade 透传 4 字段）
  → prevalidate（capability ↔ authority lineage 强比较：
      携带性必须一致 + 四字段完全相等）
  → resolving tombstone（携带完整 proof）
  → consume capability
  → refreshSettledReceiptForResolution（lineage-aware：
      tr1_ 必带 proof identity；match 保留既有 proof；
      absent 从 authority 写入；legacy/conflict blocked）
  → verifyTreasuryCommittedResolutionProof（三方：
      receipt↔tombstone、tombstone↔authority、receipt↔authority
      ——每组经 treasuryAttemptIdentityRelation 的 lineage 双向 fail closed）
  → verified → 释放 intent/quarantine → class-aware marker 清除
      （携带 lineageBindingDigest + attemptGeneration）
  → final tombstone（携带完整 proof）
  → chain_committed（receipt proof 的 lineageId/generation/parent/binding
      与 lineage record 完全一致才推进）
断点恢复：任一环节 fail closed 时 resolving tombstone + authority + marker
  保留，beginTick recoverStagedResolutions 以同一 verifier 语义幂等补完成
  （refresh identity 与 marker 清除同样携带 tombstone 的 lineage proof）。
```

两个关键故障窗口实测（treasuryRound19CommittedLineageResolution.test.ts）：
- **场景 A（receipt 写入前 fault）**：`receipt_publish` 注入 → executed_unsettled + quarantine、receipt 缺失、lineage 保持 child_active；显式 resolve-as-committed 后 receipt 从 authority 写入完整 proof、final tombstone 同源、chain_committed、generation 一致。
- **场景 B（receipt 写入后 fault）**：`heap_publish` 注入 → receipt 已带完整 proof；resolve-as-committed 的 refresh 原样保留 proof（level 不降级 legacy）、三方 match、chain_committed。

## 4. Intent/Quarantine 双 authority handoff 恢复矩阵

| intent | quarantine | 判定 | 实测 |
|---|---|---|---|
| proof 冲突 | 任意 | forensic（保留 authority） | ✓ |
| 任意 | proof 冲突（binding/generation） | forensic | ✓（intent 存在时同样验证） |
| not_started/ready | 不存在 | rollback + 释放 intent | ✓ |
| not_started/ready | 匹配存在（转移中断窗口） | forward_complete 绝不回滚 | ✓ |
| executing | 匹配存在 | forward_complete | ✓ |
| executing | 冲突 | forensic | ✓ |
| 缺失 | 匹配存在 | forward_complete | ✓ |
| 缺失 | 缺失 | rollback（零释放） | ✓（Round 18 回归） |

说明：ready intent 可能被通用 intent recovery（Round 16 语义：无 finalized proof 的 not_started intent 回收）在 lineage 恢复之前释放——authority 由 quarantine 权威形态保留，lineage 判定不受影响（测试注释已记录）。forward 的 child identity 从 quarantine（proof 匹配侧）派生——实测 currentIdentity 与 quarantine facts 一致。

## 5. Retirement 三阶段的事实来源

| 阶段 | 唯一证明来源 | 推进机制 |
|---|---|---|
| lineagePublished | retire 转换（child_active→retiring）的 candidate 持久化 + read-back | 转换内置（published=true 起点） |
| authorityReleased | 统一 resolver 返回 not_found | converge 内验证 → markStage（单调） |
| markerCleaned | marker 不存在 / transactionId 不指向本 attempt / 匹配 marker 成功清除 | converge 内验证 → markStage |

- `completeTreasuryLineageRetirement` 只推进 state 并**校验三段全 true**（未证明 throw）；阶段置位只经 `markTreasuryLineageRetirementStageVerified`（false→true 单调，幂等重入零写入）。
- `convergeTreasuryLineageRetirementFromFacts` 是运行时路径（facade executed_aborted / faultResolution not-executed / resolutionAuthority immediate）与 beginTick 恢复（retiring 分支、child_active 防御路径）共用的单一收敛函数。
- 实测：marker 匹配未清 / digest 冲突 / v1 无 class / store 损坏 → converge pending（保持 retiring）+ verdict replacement_pending（无 eviction 资格）；marker 不指向本 attempt / 无 marker → 完成 rearm_ready。
- pending-release 索引移除与 retirement 完成共享阶段事实（converge completed 才 markTreasuryPendingReleaseCompleted）。

## 6. Lineage 索引完整性矩阵

same-record 判定从 lineageId 相等改为 **store entry identity（rootTransactionId）**。实测 fail closed 场景（load 全表校验与写入候选预检同语义）：

| 场景 | 结果 |
|---|---|
| duplicate current（两条 record current 相同、lineageId 各自合法） | store unhealthy、原数据保留 |
| record current = 另一 record root | unhealthy |
| next-child 篡改（B 携带 A 派生 next-child） | unhealthy（duplicate/派生校验） |
| duplicate lineageId（篡改 B 为 A 的） | unhealthy、原数据保留 |
| 写入候选 current 与既有冲突 | 拒绝、原 store 与索引不变、healthy 保持 |

## 7. Active lineage 与 terminal summary 的 generation 证明关系

- summary v2 字段：`lineageId / rootTransactionId / rootIdentityDigest / terminalState / finalGeneration / finalAttemptId / finalizedAtTick / authorityClass(新)`。
- 压缩资格（在无 intent/quarantine/auth-fault/marker 残留之上新增）：chain_committed 需 matching committed receipt（digest + 完整 lineage proof 与 record 一致）；non_rearmable_retired 需 matching final not-executed tombstone + 三段完整。实测删除 committed receipt → 不压缩（active 保留）。
- 压缩后历史代重演验证（verdict record 缺失分支）：tombstone 自身完整 proof → 按 lineageId 定位 summary → generation ≤ finalGeneration → v2 ID 派生 + checksum（绑定 root）重算一致 → binding 按 (lineageId, gen, parent 派生 ID, child) 重算一致 → proof class == summary.authorityClass → final 代 not-executed 只与 non_rearmable_retired 相容。
- 实测（A→B→C 端到端）：C committed → 压缩（entryCount 0）→ B（gen1 not-executed）tombstone 凭 summary verdict replacement_match 回收、A（root）同样回收、root/旧 ID 仍永久阻断、resolution store 不满载；future generation / 错误 binding / 错误 class / 错误 lineageId → conflict；无 proof 旧 tombstone → missing pin；v1 迁移 summary（无 authorityClass）→ missing pin（root 门禁不受影响）。
- 300 代链实测：active entryCount 恒 1（generation 不增长 entry）；最终 commit 压缩后 entryCount 收敛 0；resolution store 容量预检每代通过（超龄历史代 verdict match 回收）。

## 8. Store 版本与迁移

| store | 版本 | 迁移 |
|---|---|---|
| retirement summary | v1 → **v2** | load 时原子迁移（entry schemaVersion 一并提升；失败保留原数据 fail closed）；v2 新增可选 authorityClass |
| receipt | v8（不变） | v6/v7 的轻量 health 从 unknown fatal 改为 migration pending（版本认可集合与 loader 迁移能力对齐）；load 迁移逻辑不变（临时结构验证 → 一次替换 → 失败保留） |
| resolution | v7（不变） | peek 版本集合补 v6（第十八轮新增迁移分支时遗漏） |
| intent/quarantine/lineage/marker | 不变 | — |

tr1_ 旧 receipt 缺 proof 迁移后仍为 legacy_committed replay blocker（实测）。

## 9. 关键中断窗口及恢复结果

| 窗口 | 持久后果 | 恢复 |
|---|---|---|
| receipt 写成功、final tombstone 失败 | resolving tombstone + authority | beginTick staged recovery（refresh 携带 tombstone proof 续做）幂等补完成 |
| resolving tombstone 已写、receipt 未写 | resolving + authority | 同上（absent refresh 从 tombstone 携带的 authority facts 写入） |
| authority 已释放、finalize 前中断 | resolving + receipt | verifier not_found 补完成分支 |
| chain_committed 写入失败 | child_active + receipt | beginTick receipt reader（binding/generation 匹配）补完成；不匹配不推进（同样语义进入 faultResolution 的 chain_committed 推进校验） |
| quarantine 写成功、intent 删除前中断 | 双存在 | forward_complete（绝不回滚）——本轮新增明确测试窗口 |
| capability_issued 跨 reset | rearm_ready（child ID 稳定） | Round 18 语义回归 |
| marker 未清时 retirement 尝试完成 | retiring 保持 | converge cleanup pending（本轮修复——原 complete 无条件置 true） |

## 10. Operation-count 结果（treasuryRound19OperationCount.test.ts）

- 50 轮 root/lineageId record lookup：lineage fullScans 零增加（O(1) 索引）。
- 50 轮 summary verdict（record 缺失 + summary 命中）：lineage 与 summary store fullScans 均零增加（O(1) 索引 + 零全表扫描）。
- 空闲 beginTick：idleFastPath 计数推进（O(1) 快路径）。
- 300 代 chain：active entryCount 恒 1；最终 commit → 压缩 → entryCount 0；resolution store 容量预检每代通过（不因历史 child tombstone 满载）。

## 11. 验证命令与真实结果

| 验证 | 命令 | 结果 |
|---|---|---|
| typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| build | `npm run build` | 成功（bundle sha256 9f0b3905b5469960…，35.3s） |
| Round 19 定向 | `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound19*.test.ts` | 7 suites / 64 tests / 64 passed / 0 failed |
| treasury 全量 | `npx jest --config jest.config.cjs src/runtime/treasury/` | 56 suites / 991 tests / 991 passed / 0 failed |
| 仓库全量 | `npx jest --config jest.config.cjs` | 250 suites / 1697 tests / 1697 passed / 0 failed（pending 0 / todo 0） |
| budget | `node scripts/verify-jest-budget.mjs` | 见 budget 提交（PASSED） |

基线对照：起始 243 suites / 1633 tests → 最终 250 / 1697（+7 suites / +64 tests，全部为本轮新增；无删除/跳过/弱化——唯一修改的既有测试是 Round 17 的 v6 矛盾组合断言，从"peek 版本误报 unhealthy"更新为"peek migration pending + load 迁移 fail closed"（语义增强：fail closed 判定从版本误报转移到真正的迁移自检））。

## 12. 真实 Game writer diff 检查

`git diff 2a435ff..HEAD -- src/runtime/resourceControl.ts src/runtime/marketDirectContinuousAutomation.ts src/runtime/marketSaleProtection.ts src/runtime/marketSaleProtectionAdapter.ts src/runtime/factoryControl.ts src/runtime/synthesisControl.ts src/runtime/nukerControl.ts src/runtime/terminalActionEnergyOwnership.ts` → **空**。

本轮全部变更文件：openspec 3 个 + treasury 模块 16 个 + treasury 测试 8 个。diff 中出现的 `terminal.send` 字符串全部位于测试 fixture 的 kind 标识符（业务动作标签，非 Game API 调用）；无 `Game.market.deal` / `lab.runReaction` / `factory.produce` / `nuker.launchNuke` / `creep.transfer` / `spawnCreep` / controller 写操作等新增调用。

## 13. 边界声明

- 未部署到 Screeps。
- 未合并 main。
- 未调用任何真实 Game API（含 terminal.send 等 8 个 writer 文件零改动）。
- 仓库当前无 GitHub CI；上述全部为本轮真实本地执行结果，不声称 CI passed。
- Screeps hard CPU interruption 与 Memory flush 仍不构成 exactly-once 保证——本轮的全部协议改进以持久 proof 与 fail closed 承载中断，不依赖运行时原子性。

## 14. 剩余风险与下一阶段判断

- v1/v6/v7 store 迁移路径只有 fixture 级覆盖（真实部署环境的旧数据形态可能更杂）；summary v1 迁移的 authorityClass 缺失会使历史代 tombstone 保守 pin（安全方向，但需要现场观察 pin 是否长期存在）。
- marker 为全局单槽结构：指向其它 attempt 的 marker 不阻塞当前代收敛（本轮语义），但多 attempt 并发故障时 marker 覆盖的首个未清除问题仍依赖 forensic 观察。
- 下一阶段工程条件：terminal.send adapter 纯实现、contract plan shadow、authorization shadow、next-tick reconciliation shadow、零 Game API 端到端演练。真实 Game API 调用必须继续由后续独立门禁批准——本轮通过不构成批准。
