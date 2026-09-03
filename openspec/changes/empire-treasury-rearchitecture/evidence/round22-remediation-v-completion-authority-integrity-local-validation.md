# Round 22 Remediation V — Completion Authority Integrity & Root-Lineage Exactness（本地验证 evidence）

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 实际起始 HEAD：`97e23e9ba67e0f6a31bd8e51ac42211f0c71e4b2`（与预期一致；`91a11f5` 之后只有 OpenSpec/evidence/budget 提交）
- 最终代码/测试验证 HEAD：`f8cf544...`（fix(defense) 之后、test(defense) 提交 `f8cf544` —— 完整验证在此 HEAD 执行；其后的 OpenSpec/evidence/budget 提交不含生产代码、测试代码或类型代码）
- 验证环境：本地 Windows（无独立 CI——全部为本地执行结果）

## 提交清单（本轮 Treasury）

| commit | 职责 |
| --- | --- |
| `fix(treasury): authorization fault v5 lineage and root lineage exactness` | fault v5（lineage 四字段 + v4→v5 迁移 fail closed）、tri-state 读取、gate/discharge/路由不折叠 undefined、ledger 透传、root exact relation（channel 注入）、semantic pending_handoff 扩展 |
| `fix(treasury): completion authority exactness, replacement lifecycle and admission ownership` | no_cleanup_authority/completion_conflict 独立状态 + statusOf 映射修复 + 全部消费分支、completion exact relation、replacement/supersession/reclaim、readiness admission、open 恒 reservation + 删除旧激活入口、tr1_ fault 路径 lineage 透传与回滚 |
| `test(treasury): cover remediation v failure matrices` | treasuryRound22RemediationV.test.ts（35 tests）+ 既有 9 个测试文件对齐 |

## 完成状态（no_cleanup_authority）公共 API 验证

- `advanceTreasuryResolutionCleanupPhases`（journal absent + completion absent + 无 replacement）→ `status="no_cleanup_authority"`、`pendingStage="none"`、五个阶段全部 false（`phases.markerDischarged===false` 等）；
- `treasuryCleanupStatusOfAdvance("not-executed", advance).stage === "no_cleanup_authority"`（绝不 `fully_complete`）——该映射器是 facade（executed-aborted）、faultResolution（committed/not-executed）、resolutionAuthority（fault/reopen）全部公共 cleanup 报告的唯一出口（`treasuryWriteArchitecture` 守护 advance 调用点）；
- 生产消费分支补齐：facade executed-aborted 的 `abortedAdvance.status` 检查扩展 `no_cleanup_authority`/`completion_conflict`（此前 completion conflict 会穿透全部 pendingStage 分支返回 `complete_rearm_ready`）；faultResolution committed 路径与 resolutionAuthority 两路径同样扩展；
- completion 冲突（expected 对照）→ `completion_conflict` / stage `cleanup_conflict`；store 损坏 → `store_unhealthy` / stage `cleanup_store_unhealthy`。

## completion exact relation 比较维度

transactionId / resolution / digest（16hex）/ identityProfile（枚举 + ↔proofClass 唯一映射）/ required-forbidden 矩阵（modern-contract: digest+contract+cohort+durable 必带、lowlevelSource 禁带；lowlevel: digest+durable+lowlevelSource 必带、contract/cohort 禁带）/ contractDigest / authorizationCohortDigest / durableIdentityDigest / lowlevelSource / lineage 四字段（all-or-none；tr1_ 必带、initial 禁带）/ lineageDisposition / 五阶段完成事实 / key↔transactionId 一致 / schemaVersion / completedAtTick 形状。record 的 read-back 比较上述全部不可变维度；lookup 的 expected 经 `treasuryExactAttemptIdentityRelation` 完整 relation。

## corruption 测试矩阵（全部 → store_unhealthy / conflict，不 match）

identityProfile 缺失；identityProfile 与 proofClass 冲突；digest 非 16hex；lowlevel proof 缺 lowlevelSource；identity-bound 错带 lowlevelSource；tr1_ completion 缺任一 lineage 字段；initial completion 错带 lineage 字段；五阶段事实缺失；lineageDisposition 非法；key 与内部 transactionId 不同；read-back 后篡改 durable（expected 对照 → conflict；格式损坏 → store_unhealthy）。

## Authorization Fault tri-state 与 tr1_ fault lineage 四字段路径

- tri-state：`readTreasuryAuthorizationFaultEntryStructured` → present / absent / store_unhealthy；fault store metadata 损坏时 pre-release gate 返回 `authority_store_unhealthy`（不折叠为 absent——cleanup 不完成、marker 不清）；
- tr1_ redemption fault 完整链（固定反例 B）：rearmable root chain → capability_issued → child_intent_pending → fault v5 写入（lineage 四字段 + durable 重算）→ final not-executed tombstone（lineage 透传）→ cleanup open（reservation）→ activation → advance：semantic（pending_handoff）放行 → marker discharge → fault 释放（read-back absent）→ outcome 阶段回滚在途 chain（`rearm_ready`）→ lineage 阶段幂等确认 → completion 写入 → `advance.status="completed"`；
- tr1_ 缺任一 lineage 字段 → 写入前 rejected（无 partial authority）；initial fault 携带 lineage 字段 → rejected；
- binding 冲突（fault 与权威重算不一致）→ gate semantic 权威重算拦截（fault entry 与 marker 均保留）；
- 普通 initial non-lineage fault：既有测试（Round12/13 系列）全部保持通过；
- v4 store 迁移：非 tr1_ entry 原样迁移 v5；v4 tr1_ entry → 原数据保留 fail closed（`treasuryRound12Integrity` v5 版本断言更新）。

## root active/terminal exact relation（固定反例）

- 跨 store 冲突（journal/tombstone/Authority 身份 D2 vs active root lineage 身份 D1，两 store 各自健康）：pre-release gate `semantic_lineage_blocked`（detail 含 conflict）→ marker discharge 前阻断；marker 不清、authority 不释放、journal 保留、不推进 D1 的 retirement（record 保持 retiring）、不写 completion；
- root lineage 缺失（现代 profile）→ `lineage_missing` 阻断（不得 not_applicable）；
- root 已被 child 接管（current ≠ root）→ conflict；
- terminal summary finalExact 的 durable 与 entry 不同 → `summary_conflict`（不得 already_final）；root committed 与隔离 profile 保持 not_applicable/隔离语义（既有测试通过）。

## completion capacity 与 replacement authority 生命周期

- 129th transaction 固定反例（A）：128 个合法 completion 填满硬容量 → `evaluateTreasuryWriteReadiness`（authorize purpose）输出 blocker `completion_headroom_exhausted`（ready=false——真实 Game callback 之前 admission fail closed）；facade readinessSources 已接线 `completionStoreUnhealthy`/`completionHeadroomExhausted`；
- 满载写入的 bounded 回收：`recordTreasuryCleanupCompletion` 满载 rejected → `reclaimTreasuryCleanupCompletionHeadroom(1)`（只回收有 GRA/summary/tombstone replacement 的 completion）→ 重试；
- 300-generation chain（12 代可构造链承载同语义）：每代 converge 写入 GRA proof → activate 回收 parent completion（gate：其代 GRA 在位）→ **每个历史代的查询经 supersession 返回 completed**（不退化为 no_cleanup_authority）；
- replacement store unhealthy（GRA store version 非法）→ supersession `store_unhealthy`、reclaim 0、completion 保留（fail closed）；
- terminal summary compaction 成功后回收 final/root completion（supersession 成立才删——`lineageRetirementSummary` 接线）。

## open/activation 唯一写入口

- 省略一切 proof 参数的新 entry → `settlementProofDurable=false`（open 不再有 proofMode 参数——旧参数编译期消失）；journal 阶段 mark 在 reservation 期间被偏序拒绝；
- 旧入口 `activateTreasuryResolutionCleanupProof`（绕过 matching proof 验证）已删除（零 production 调用方）；架构扫描：`settlementProofDurable = true` 直写只存在于 `settlementProofActivation.ts`；
- activation 失败（proof absent）→ 不激活、零阶段推进；global reset 后从 reservation 恢复 → activation 权威幂等补激活 → 全链完成。

## operation-count

- normal 查询路径保持单 key O(1)（completion lookup / GRA byAttempt / summary byRoot / tombstone 单键）；readiness 探测零扫描（`peekTreasuryCleanupCompletionEntryCount` 只读——不隐式创建 store，query 零写保持）；
- bounded 扫描只发生在：满载 headroom 回收（≤128 × O(1) supersession 验证）、load 时全表验证（既有语义）、测试；
- coordinator/gate 无新增全表扫描。

## 验证命令与精确结果（最终代码/测试 HEAD `f8cf544`）

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | 通过（无 whitespace 错误） |
| `npx tsc --noEmit -p tsconfig.json` | 通过（0 错误） |
| `npm run build` | 通过（无新增循环依赖警告） |
| Treasury 定向（MarkerDischarge + Remediation I-V） | 6 suites / 177 tests / 177 passed / 0 failed |
| Treasury 全量 `npx jest src/runtime/treasury/` | 70 suites / 1313 tests / 1313 passed / 0 failed / 0 pending / 0 todo / 0 skipped |
| 全仓 `npx jest` | 268 suites / 2115 tests / 2115 passed / 0 failed / 0 pending / 0 todo / 0 skipped |
| `node scripts/verify-jest-budget.mjs`（budget 更新后） | 见 budget 提交（baseline = `f8cf544`） |
| `sha256sum dist/main.js` | `5f97c76d95f72cba39d6ed84b72b71a459bfc5b52bdb97e1e95e6da88c417576` |

新增测试：Treasury `treasuryRound22RemediationV.test.ts` 35 tests（预算 35，high-risk）；预算总量 266→268 suites / 2067→2115 tests。

## CI / 部署边界

- 无独立 CI（本仓库当前没有可靠 GitHub Actions run——以上全部为本地执行结果）；
- 未部署到 Screeps；未调用真实 `terminal.send()`；未调用 `Game.market`/lab/factory/nuker 或其它真实经济 writer；测试全部使用现有 mock/fixture；
- 未合并 main；未 amend/rebase/force push 已推送历史。

## 剩余风险

- completion store 硬容量 128 不变（按任务书不得单纯调大）；极端场景（128 个 completion 均无 replacement——理论不可达，每个完成 attempt 必有 GRA/summary/tombstone 之一）仍 fail closed；
- v4 authorizationFaults store 含 tr1_ entry 的旧部署需人工 forensic 处理（迁移 fail closed 原数据保留）；
- `pending_handoff` role 在 not_executed_retirement purpose 的扩展只覆盖 tr1_ redemption fault 的回滚语义（child 从未激活）；已激活 child 的 fault 走既有 intent/quarantine 轨道；
- replacement 的 GRA 路径信任 GRA store 的写入权威（release-trusted converge 单一写入）——手工篡改 GRA store 由其 load 全表验证拦截；
- Screeps 线上 CPU interruption / Memory flush 边界的行为未被线上验证（协议已按中断窗口幂等设计）。
