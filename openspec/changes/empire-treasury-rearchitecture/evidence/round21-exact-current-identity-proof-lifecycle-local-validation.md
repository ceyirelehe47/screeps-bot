# Round 21 — Exact Current Identity & Proof-Lifecycle Closure（本地验证证据）

- 日期：2026-09-02
- 分支：refactor/empire-treasury-rearchitecture
- 预期起始 HEAD：68387a4054a17bd4bed688e1a89f59365a236444
- 实际起始 HEAD：68387a4054a17bd4bed688e1a89f59365a236444（一致——`git fetch --all --prune` 后远端未前移，工作树干净）
- 实现与测试完成提交（budget 锚点）：054691d
- 最终 HEAD：见下文提交清单末尾（budget 提交）

## 1. 本轮提交清单（作用）

| SHA | 作用 |
|---|---|
| 3140a85 | docs(openspec): define round 21 exact current identity and proof lifecycle（design §17 / spec 7 个 Requirement / tasks §27 / proposal Round 21 节） |
| 4509231 | refactor(treasury): add exact current, terminal and retirement relation modules（currentLineageSettlementVerifier / terminalExactIdentity / generationRetirementRelation 三新模块，741 行） |
| 9002c2e | fix(treasury): compare full active current identity in semantic lineage validation（current 分支 verifier 化 + terminal finalExact/provenance 修复） |
| 20bd218 | feat(treasury): persist exact terminal identities in retirement summaries（summary v3 + 四方 compaction + legacy replay-only 隔离） |
| 2292e46 | fix(treasury): replace child-active binding shortcut with exact committed proof（补完成 verifier 化 + close→释放 Intent 顺序 + facade reader 完整视图） |
| 7eb89da | fix(treasury): require exact retirement proof for current tombstone replacement（当前代含 gen0 三方 relation + root verdict v3 + historical 持久 parent） |
| 788e054 | refactor(treasury): enforce generation retirement class and index integrity（class 矩阵 + root 绑定 + 全局唯一 + byAttempt O(1)） |
| 6407449 | fix(treasury): make receipt refresh proof-class aware（exact relation + 只改 tick） |
| 054691d | test(treasury): cover round 21 identity, recovery, compaction and lifecycle（4 新文件 74 tests + 既有 fixture 升级；**budget 锚点**——含全部实现与测试） |
| （evidence 提交） | docs(evidence): record round 21 local validation |
| （budget 提交） | chore(test-budget): update verified round 21 budget |

起始→实现完成 diff stat：`24 files changed, 3965 insertions(+), 271 deletions(-)`。

## 2. Active current exact identity（矩阵实测）

单一权威 `currentLineageSettlementVerifier.expectedTreasuryCurrentLineageExactIdentity`：
从 record.currentTransactionId/currentIdentity（digest/contract/cohort/
durable/lowlevelSource 回落 record.lowlevelSource）/authorityClass/generation
（≥1 时 currentParentTransactionId+bindingDigest）构造；requiredness：
- identity-bound：digest+durable 必备、禁 provenance、modern contract 来源
  （current/root identity 携带 contract 维度）必须成对保留 contract/cohort；
- lowlevel：digest+durable+受控 provenance 必备、禁 modern contract/cohort。

实测矩阵（treasuryRound21CurrentIdentity，真实状态机链 fixture，durable 全部
`recomputeTreasuryDurableIdentityDigest` 真实重算）：

| 场景 | 结果 |
|---|---|
| 完整一致（lowlevel / modern contract 链） | match（active/current） |
| digest 相同、contract 不同（modern 链） | conflict |
| digest/contract 相同、cohort 不同 | conflict |
| durable 不同 | conflict |
| 输入缺 durable（identity 视图不完整） | insufficient |
| modern contract current 输入缺 contract / 缺 cohort | insufficient |
| identity-bound 输入携带 lowlevelSource | conflict（class 推导不一致） |
| lowlevel 输入缺 lowlevelSource | 不可证明（非 match） |
| lowlevelSource 不同（migrated） | conflict |
| proof class 不同（lowlevel 输入 vs modern record） | conflict |
| identity 未提供 | insufficient |
| lineage 四字段正确但 digest 错误 | conflict（detail 含 digest） |

## 3. Terminal summary：旧版与新版语义

- **v3（`TREASURY_RETIREMENT_SUMMARY_VERSION = 3`）**：entry 持久化
  `rootExact`（digest/contract/cohort/durable/lowlevelSource/proofClass/
  identityAlgorithm="root-identity@v1"）与 `finalExact`（同前 +
  gen≥1 的 parentTransactionId/lineageBindingDigest + 可选 retrySemanticDigest
  + exactIdentitySchema=1）；shape 强制 authorityClass === finalExact.proofClass、
  rootIdentityDigest === computeTreasuryGenerationRootIdentityDigest(rootExact
  五元)（canonical 单一口径——双口径任一匹配语义已删除）、finalExact 必带
  durable；store version 与 entry schemaVersion 一致（混合版本 fail closed）。
- **v1/v2（replay-only）**：load 只读解释（v1 原子迁移 v2）；不得证明
  terminal current（insufficient）、不得授权新 Receipt 写入（tr1_ gate 拒
  绝）、不得驱逐 historical child（verdict missing）、不得被 v3 写入混合
  （compaction 对 legacy store 拒绝写入并保留 active record）；不自动补造
  exact identity（v1/v2 summary 存在意味着 active record 已删除——无法从
  active lineage 重建，语义上不存在合法自动迁移路径）。
- **迁移**：v1→v2 迁移保留（零字段变换）；无 v2→v3 迁移（原因如上）。

## 4. Terminal current semantic validation 流程

`validateTreasurySemanticLineage` 的 terminal 分支：v3 定位 → finalExact 形状
校验 → provenance 权威取 `finalExact.lowlevelSource`（修复"调用方 source 与
自身比较"）→ finalGeneration 分支：caller 侧 exact identity（identity 与
proof 四字段合并构造）vs summary 持久 finalExact 的 proof-class-aware
relation——完整 match 才 `terminal_current`；terminal historical 仍由 exact
retirement proof 证明（provenance 与 proof.lowlevelSource 绑定比较）。

实测：压缩后 terminal current 继续 match；同 finalAttemptId 但 digest/durable/
provenance/parent/binding 不同 → conflict（外壳不构成证明）。

## 5. Child-active commit recovery 流程

- **Receipt 读取**：facade 装配的 reader 返回完整 settlement proof 视图
  （level/digest/contract/cohort/durable/lowlevel/lineage 四字段）；
- **exact verifier**：`verifyTreasuryChildActiveCommitRecovery`——legacy/
  "modern" 旧 level 不关闭；proof class 与 record.authorityClass 不一致
  conflict；Receipt exact identity vs record current exact identity 完整
  relation；requiredness 失败 insufficient（保留全部证据不自动升级）；
- **状态变化顺序**：verified → close chain_committed → 成功后释放残留
  Intent（close 失败时 Intent 与 child_active 保留、Receipt 作为持久 commit
  proof、下 tick 幂等重试）；
- **故障恢复实测**：close 被外部 forensic 干扰失败 → Intent 保留；receipt
  digest/durable/class/provenance 不同、legacy、absent、store unhealthy →
  零状态变化（child_active 保持）。

## 6. Current/historical tombstone replacement 矩阵

当前代（含 gen0 root）：三段布尔 + retirementGeneration + 状态检查后，必须
命中 matching exact proof 并通过 `verifyTreasuryGenerationRetirementRelation`
（expectedCurrent 来自 record current exact + root 绑定 canonical 口径）。

| 场景 | 结果 |
|---|---|
| 三段全 true + exact proof 完整 match | replacement_match |
| 三段全 true 但 proof 缺失 | replacement_missing（detail 含 exact retirement proof） |
| record 已 rearm_ready 但 proof 被篡改（digest） | replacement_conflict/pin |
| proof lowlevelSource 篡改（migrated） | replacement_conflict |
| proof store unhealthy | store_unhealthy（pin） |
| root exact identity 完整 match（v3 rootExact） | replacement_match |
| 同 root ID 但 root digest 不同 / provenance 不同 | replacement_conflict |
| root gen0 exact proof 缺失 | replacement_missing/pin |
| historical child 持久 parent 篡改 / binding 篡改 | replacement_conflict |
| historical child exact proof 完整 match | replacement_match |
| summary finalGeneration 存在但历史代 proof 缺失 | replacement_missing/pin |
| 旧 v2 summary（replay-only） | replacement_missing（不得驱逐 historical child） |
| future generation | replacement_conflict |

## 7. Exact retirement proof class required/forbidden 矩阵

| proof 形态 | 结果 |
|---|---|
| identity-bound modern（digest+durable+contract+cohort 成对） | 写入 ✓ |
| identity-bound 缺 durable | 拒绝 |
| modern 来源缺 contract / 缺 cohort | 拒绝 |
| identity-bound 携带 lowlevelSource | 拒绝 |
| lowlevel（digest+durable+受控 source） | 写入 ✓ |
| lowlevel 缺 durable / 缺 source | 拒绝 |
| lowlevel 携带 contract/cohort | 拒绝（class 矛盾） |
| lineageId 与 (root, rootIdentityDigest) 派生不一致 | 拒绝（root 绑定） |
| duplicate transactionId（不同 lineage / 不同 generation） | 写入拒绝（全局唯一） |
| global reset load 遇重复 transactionId | 整 store unhealthy |
| byAttempt 查询 ×50 | 索引直接命中，load 后零 fullScans（O(1)） |

## 8. Generation proof 创建、依赖、驱逐和清理生命周期

创建：retirement 三段收敛完成 → exact proof 写入（shape+语义+root 绑定）→
read-back（shape/JSON/transactionId 未占用复核）→ 索引同步 → lineage 推进。
依赖：当前代 proof 是下一代 capability 门禁依据（tombstone 驱逐联动释放时
检查 active record 存在且 generation 相同则保留）；历史代 proof 的 tombstone
驱逐（replacement_match）后经 byAttempt 联动释放；compaction 后按 tombstone
存在性清理孤儿。300 代实测：历史 proof 随依赖消失收敛（entryCount 远小于
代数），当前代 proof 在位。

## 9. Terminal compaction 四方 proof

- chain_committed：receipt（`treasuryExactAttemptIdentityOfReceiptProof` +
  relation）↔ record current exact ↔ semantic lineage（active current 完整
  match）↔ summary candidate finalExact（candidateFinalExactRelationError
  防御构造漂移）；
- non_rearmable：tombstone（exact relation）↔ record ↔ exact retirement
  proof（三方 relation）↔ semantic ↔ candidate；
- 发布顺序：外部终态 proof 验证 → candidate 构造 → summary 写入 →
  read-back（shape + JSON 全等）→ 索引同步 → 删除 active → 孤儿清理；
- 实测：proof 只是存在但 digest/durable/provenance 不同 → 不压缩；缺失/
  store unhealthy → 不压缩；同 root 幂等压缩要求全部 exact 字段一致
  （不同 identity 拒绝且 active 保留）。

## 10. 300 代测试设计（15.1/15.2）

- **长期 retention 推进**：`driveLifecycle(root, 300)` 每代执行 retire →
  converge（exact proof 写入）→ final tombstone（Game.time 每代 +100 →
  retention 5000 即约 50 代后过期）→ 下一代接管；Resolution store 满载写入
  自动触发惰性驱逐（verdict match → tombstone 删除 → proof 联动释放）。
- **容量窗口 fail closed**：256 条未过期 final tombstone 手塞满载 → 第 257
  条明确 rejected（不提前驱逐未过期 proof、不覆盖）。
- **entryCount 变化实测**：active lineage 恒 1；Resolution ≤256（容量内）；
  GRA 历史 proof 收敛（<120，远小于 300）；root 重放门禁有效（同 root 再建
  链 rejected）。

## 11. Store 版本、容量、迁移

| store | 版本 | 容量 | 迁移 |
|---|---|---|---|
| retirement summary | 3（v1/v2 legacy replay-only） | 128 | v1→v2 原子迁移；无 v2→v3（无法重建 exact identity） |
| generation retirement | 1（无变化） | 384 | 无 |
| attempt lineage | 2（无变化） | 64 | 无 |
| resolution tombstone | 无变化 | 256 | 无 |
| receipts | 8（无变化） | 4096 | 无 |

## 12. Operation-count 结果

- 300 代推进：lineage fullScans 增量 <60（与代数无线性关系，heap 缓存
  load 为主）；active entryCount 恒 1；
- 50 次 semantic validation + 50 次 byAttempt 查询：load 后零 fullScans；
- 空闲 beginTick 恢复：零 fullScans、零状态变化；
- 架构扫描：attemptLineage 无 binding+generation 快捷放行（verifier 调用
  在位）；compaction 含三方 relation（存在性单独放行形态已删除）；receipts
  无旧 class-unaware relation 调用；新模块无手工 TreasuryExactAttemptIdentity
  字面量；raw `startsWith("tr1_")` 仅 transactionId.ts/lineageProof.ts 白名单。

## 13. 验证命令真实结果

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0（无输出） |
| `npm run build` | 成功，bundle sha256 4e12458b… |
| `npx jest --config jest.config.cjs src/runtime/treasury/treasuryRound21*.test.ts` | 4 suites / 74 tests 全通过 |
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 64 suites / 1132 tests 全通过 |
| `npx jest --config jest.config.cjs`（全仓库） | 258 suites / 1838 tests 全通过 |
| `node scripts/verify-jest-budget.mjs` | 见 budget 提交（更新后 PASSED） |

## 14. GitHub CI 实际状态

仓库无 `.github/workflows`（GitHub Actions 不存在）——**没有独立 CI 证据，
以上全部为本地验证结果，不声称 CI passed**。

## 15. 真实 Game writer diff 与源码扫描

- `git diff --stat 68387a4..HEAD -- <8 个 production writer 文件>` 为空
  （resourceControl / marketDirectContinuousAutomation / marketSaleProtection
  / marketSaleProtectionAdapter / factoryControl / synthesisControl /
  nukerControl / terminalActionEnergyOwnership 均无改动）；
- treasury 源码真实 writer 调用形态扫描
  （`terminal.send` / `Game.market.deal` / `runReaction` / `boostCreep` /
  `unboostCreep` / `factory.produce` / `launchNuke` / `creep.transfer` /
  `creep.withdraw` / `creep.drop` / `creep.pickup` / `spawnCreep` 的真实
  调用形态）零命中。测试中的 adapter kind 名称/字符串/mock 不等于真实
  writer 调用，已明确区分。

## 16. 明确边界

- 未部署到 Screeps；
- 未合并 main、未 force push、未 rebase、未 amend 已推送提交；
- 未调用任何真实 Game API（无 terminal.send / market.deal / lab / factory /
  nuker / creep / spawn 写调用）；
- 未声称 CI 通过（无 CI 存在）；
- Screeps hard CPU interruption 与 Memory flush 语义下仍不保证 exactly-once
  ——本轮交付的是持久 proof 与 fail-closed 恢复协议，不是 exactly-once 幂等。

## 17. 不得勾选项确认

terminal.send adapter 实现 / plan shadow / reconciliation shadow / 真实执行、
ResourceControl writer、market writer、carrier/lab/factory writer、live CPU
canary、完整 Budget Service、ReceiverCapacityLedger 替换、旧库存系统删除
——以上全部未开始（属下一阶段）。
