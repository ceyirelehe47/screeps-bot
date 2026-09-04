# Round 22 Remediation IX — Versioned Issuance Migration, Lifecycle Inventory & Checked Handoff 本地验证证据

- 日期：2026-09-03
- 分支：`refactor/empire-treasury-rearchitecture`
- 预期起始远端 HEAD：`826aebbd35240441f7c53efbce92462b5daa4f79`
- 实际起始 HEAD：`826aebbd35240441f7c53efbce92462b5daa4f79`（与预期一致）
- 最终代码/测试验证 HEAD：`e28df92e76985a6f12a505af5da9525796f24311`
- 最终分支 HEAD（docs/budget 提交后）：见最终报告（本 evidence 属 docs commit）

## 1. 提交清单（本轮 9 个代码/测试 commit）

| commit | 职责 |
|---|---|
| b6abb26 | fix(treasury): migrate issued attempt identities to versioned ti2 namespace（工作流 A） |
| 4f2a817 | fix(treasury): add store lifecycle contracts and bounded gc coordinator（工作流 B + GRA 有界驱逐） |
| 70879c4 | fix(treasury): unify orphan ownership across full lifecycle authority（工作流 E 8.3） |
| 0858b24 | fix(treasury): verify replacement authority before terminal detail eviction（工作流 C） |
| f1094db | fix(treasury): propagate completion handoff and reservation failures（工作流 D + E 8.1 容量公式） |
| 1c7d5dc | fix(treasury): treat insufficient settlement identity as blocking（工作流 F） |
| 93563a0 | test(treasury): cover remediation ix lifecycle counterexamples（IX 40 + lifecycle 12 + 既有迁移） |
| 12e827c | fix(defense): enforce global rampart footprints across targets（工作流 10） |
| e28df92 | test(defense): cover cross-target physical occupancy（D16-D23） |

## 2. issuer 版本边界（新旧隔离方式）

- 新 store `version=2`（`TREASURY_ATTEMPT_ISSUER_VERSION = 2`）+ 新命名空间前缀 `ti2_`（协议 tag `treasury-attempt-issuer@v3`——hash 仍只依赖 sequence）。
- 旧 `version=1` store 经 `migrateLegacyIssuerStore` 单对象替换 + Memory read-back 迁移：旧 watermark 保留为 `legacy: { version: 1, highWatermark, retiredAtTick }`（**不清空旧 issuer Memory**）；新命名空间 watermark 独立从 0 推进——旧 watermark=100 不能证明任何 ti2_ ID 已发行（ghost ID 消除）。
- 迁移幂等：v1 store 在位 → 首次 load 触发迁移；global reset 后重读 version=2 即完成（不二次迁移、无双 frontier）；迁移 read-back 失败还原 v1 对象并 fail closed。
- 未知版本（version=99）/shape 损坏 → build/check/open/mint 全链 fail closed。

## 3. 旧 ti1_ 的 replay blocker 保留

- `checkTreasuryServiceIssuedAttemptId` 对 ti1_ 一律 `legacy_unverified`（namespace="legacy"——不再属当前发行协议）；production contract writer（sealed registry）拒绝其作为新 initial attempt（`transaction_id_not_issued`——detail 明示"旧 ti1_ issued namespace"）。
- 旧 ti1_ 在 historical/Receipt 等持久权威中继续阻断同 ID 重放（A5 实测：historical committed → facade prepare `already_settled`；弱身份 legacy-replay 数据在 insufficient 语义下同样 fail closed 阻断）。

## 4. production issuance/opening 的裸洞消除

- `openTreasuryIssuedInitialAttempt(owner)`：watermark 推进（mint）与持久 issued ticket 写入是同一操作——ticket 写入 read-back 失败时 watermark 回滚（不存在"ID 已返回但 Treasury 无 lifecycle owner"的窗口，A8）。
- ticket lifecycle：active（TTL 500 tick）→ expired（**显式协议转换**——正面生命周期事实，非删除、非"猜测调用方放弃"）；consumed（opening 接管，prepare/admission 路径幂等）；expired ticket 无任何 owner → lifecycle GC 按有界预算（≤8/批）在 watermark frontier 验证后淘汰（O6）。
- active 容量 64 满载 fail closed（阻断新 issuance，不按年龄删除 active ticket）。
- 架构守护：`mintTreasuryInitialAttemptId` 只存在于 attemptIssuer/attemptIssuanceTicket 模块（production 调用方零直接 mint）。

## 5. Memory lifecycle inventory 摘要

`treasuryLifecycleContract.ts` 登记 18 个 treasury 分支 store（+分支外 treasuryPerf）：

| store | classification | 硬容量 | cleanup owner |
|---|---|---|---|
| receipts | recent-exact-detail | 4096 | facade prepare/commit 的 admission 生命周期 |
| intents | active-unresolved | 64 | intents 状态机（commit/abort/faultResolution） |
| quarantine | active-unresolved | 64 | faultResolution + resolutionCleanupCoordinator |
| resolutions（tombstone） | active-unresolved | 256 | resolutionStore 终结 + faultResolution |
| authorizationFaults | active-unresolved | 64 | authorizationFaults + faultResolution |
| writeFault | active-unresolved | 单 marker | writeFault + faultResolution |
| attemptLineage | active-unresolved | 64 | attemptLineage 终结 + summary 压缩 |
| generationRetirementProofs | recent-exact-detail | 384 | GRA + summary 压缩 / **IX：summary 接管驱逐** |
| resolutionCleanup journal | active-unresolved | 256 | cleanupStageAcknowledgement（唯一 ack） |
| cleanupCompletions | recent-exact-detail | 128 | cleanupCompletionReplacement（bounded exact archive） |
| completionHeadroomReservations | active-unresolved | 受 128 联合约束（TTL 1000） | cleanupCompletionHandoff（单一 owner） |
| cleanupSupersessions | recent-exact-detail | 384 | chain certificate 压缩 |
| lineageRetirementSummaries | recent-exact-detail | 128 | summary 满载驱逐（IX replacement 验证） |
| chainRetirementCertificates | recent-exact-detail | 256 | certificate 满载驱逐（range + 无 summary 依赖） |
| retiredAttemptRanges | permanent-anti-reuse | 64 区间 | absorb/coalesce（单调合并） |
| attemptIssuer | permanent-anti-reuse | 单标量+legacy | 不适用（v1→v2 迁移幂等） |
| issuedAttemptTickets | active-unresolved | 64（TTL 500） | treasuryLifecycleGcCoordinator |
| lifecycle（标量） | telemetry-audit | 2 标量 | 覆盖写 |
| （分支外）treasuryPerf | telemetry-audit | 固定键覆盖写 | 覆盖写 |

架构守护（treasuryMemoryLifecycleContract.test.ts，12 tests）：源码扫描 store 键 ⊆ registry（新 store 未登记 → 失败）；temporal store 必须有退出路径；authority 不得标 telemetry；active-unresolved 不允许年龄淘汰/覆盖最旧；容量声明完备；recent-exact-detail 必须声明 replacement；GC coordinator 由 facade beginTick 唯一接线（query 零写）。

## 6. recent queue 淘汰语义（summary/certificate/GRA）

- **驱逐 eligibility 由生命周期状态决定（非年龄）**：summary 满载 → 有界 eligible 扫描（≤128 全量升序——队首不可清理不停止）：certificate 路径须通过 `verifyTreasurySummaryCertificateReplacement` 全维度（root ID/lineageId/terminalState/finalGeneration/finalAttemptId/rootSequence）验证；range 路径为 anti-reuse-only——须 exact 依赖关闭（cleanup journal 与 GRA 对 root/final ID 的引用全空）。certificate 满载 → range 结构化 present + 无 matching summary 在位 + probe 装配且健康。GRA 满载 → summary（同 lineage）接管驱逐 root 代 proof。
- **store unhealthy 绝不授权驱逐**：retired range 用 `lookupTreasuryRetiredRangeStructured` 四态查询（present/absent/store_unhealthy/malformed）——boolean 折叠 API（`checkTreasuryAttemptRetiredRange` 的 unhealthy→retired=true）保留给最外层 replay blocker，架构守护禁止进入 eviction 决策（Q1）。
- **固定驱逐顺序**：replacement 前置验证（读取并完整验证待淘汰 entry / 验证 terminal / 验证无 active owner / 验证 replacement store 健康 / 验证 matching replacement identity-relation）→ 删除 → Memory read-back → 结构化结果；任一步失败旧事实保留、不写成已清理。

## 7. summary/certificate/range replacement relation

summary ← certificate：六维度全等（verifyTreasurySummaryCertificateReplacement——"同 root 有 certificate"不授权删除）。certificate ← retired range：root 序号吸收在位（chain 终结压缩时 `absorbTreasuryRetiredSequence`——monotonic frontier）且无 matching summary（summary 以该 certificate 为 replacement 时不撤走）。GRA ← summary：root 代 proof 的 exact terminal facts 已由 summary 承接。range-only 不冒充 exact summary（Q5：GRA/journal 依赖仍在 → 不驱逐）。

## 8. completion handoff 固定顺序与失败状态迁移

admission（matching reservation + identity 绑定）→ completion 写入 + read-back → consume（结构化）→ consume read-back → journal 删除 → journal read-back → completed。第 6/7 步失败：completion 可保留、reservation 可保留、**journal 必须保留**、返回 cleanup_pending/store_unhealthy（不报 completed；beginTick recovery 继续）。release 失败（callback 前拒绝路径）：结构化失败并入返回 detail（不谎报"预留已释放"）+ reservationReleaseFailures 诊断计数（H3 实测：abort 后 diagnostics.releaseFailures ≥ 1 且 reservation 保留）。

## 9. 单一容量公式

`occupancyAfterAcquire = effective + (matching pair ? 0 : 1)`，其中 `effective = live + reserved − pairs`（唯一实现于 cleanupCompletionHandoff.occupancyAfterTreasuryCompletionAcquire；底层 acquire 只做边界比较、不再叠加 entryCount）。O7 实测：live=0 时第 128 个独立 reservation 成功、第 129 个 rejected（capacity_exhausted）——VIII 的双重计数（第 65 个提前失败）已消除。O8 实测：live=64/reserved=64 达 128；live=127/reserved=1 满载；pair 恢复型 acquire 不新增槽（effective 保持 128）。

## 10. orphan owner truth graph 覆盖的事实源

`treasuryLifecycleOwnerResolver`（16 类）：active——issued ticket（active）/ receipt admission reservation（heap）/ headroom reservation / intent / quarantine / cleanup journal / resolving resolution / authorization fault / write-fault marker / 活跃 lineage / matching completion；terminal-authority——final tombstone / settled receipt / historical / GRA proof / retirement summary / terminal lineage。任一相关 store unhealthy 或 probe 未装配 → owned（fail closed）。certificate/range 维度由 chainRetirementCertificate 侧补充。reservation sweep 排除自身维度（否则自引用永不 orphan）；terminal-authority 阻断 sequence abandon 但不阻止 reservation 释放。

## 11. insufficient 语义

resolver 显式 insufficient 状态：两个 exact 声明仅 relation=match 共同证明 exact；expected（含自身缺关键维度）对每个 exact 声明必须 match；cleanup completion 维度不足不确证 completed。消费方全部 fail closed：replay gate（proof_insufficient / 零 callback / 不 release Authority）、reconciliation capability（零 mutation）、rearm preflight（零 capability）、child occupancy（占用阻断）、settlement verifier（conflicts）、opposite proof matrix 与 opposite-absence（retained——无法证明无相反权威）。

## 12. 固定反例 → 测试名映射

| 反例 | 测试（treasuryRound22RemediationIX.test.ts，40 tests） |
|---|---|
| A1-A9 | `Remediation IX A：versioned issuance migration`（9 tests） |
| Q1-Q12 | `Remediation IX Q：summary/certificate/range 的 replacement 验证驱逐`（10 tests，Q2/Q3/Q4 与 Q10/Q11 各合并） |
| H1-H9 | `Remediation IX H：checked completion handoff`（9 tests；H9 源码扫描在 lifecycle contract 测试） |
| O1-O8 | `Remediation IX O：reservation 单一容量公式与完整 orphan owner resolver`（8 tests） |
| S11-S15 | `Remediation IX S：resolver insufficient 真正 fail closed`（5 tests） |
| 架构守护 | treasuryMemoryLifecycleContract.test.ts（12 tests） |

## 13. >600 terminal chain 实际结果

Q10/Q11（正式 converge→compact 全链路 + 真实 tick 前进与周期 beginTick）：600 条现代 terminal chain 后 `executePreparedAction` 第 601 条仍 `executed_committed`；全部已退休 root 的 resolver 查询恒非 absent（protocol/retired——不可重放）。

## 14. queue wrap 次数与各 store 最大 entry count

- summary queue wraparound：Q7（200 条 chain）与 Q10（600 条）中 summary 在 128 上限处多次滚动驱逐（每次满载压缩驱逐 1 条最旧 eligible——wrap ≥ 72 次 @600 chain）。
- 各 store 最大 entry count（600 chain 实测探针）：summary=128（上限）、certificate=256（上限）、retired range=**1**（区间单调合并收敛）、cleanupSupersessions=0（archived 后全部回收）、cleanupCompletions=0（正常路径即时消费/回收）。

## 15. Treasury Memory 最大序列化字节数与 300→600 增长对比

`JSON.stringify(Memory.runtime.treasury).length` 实测（Q11 探针，验证 HEAD 上的临时探针运行后还原——未产生提交）：

- 300 chain：426,645 字节
- 600 chain：581,523 字节（增长 +36.3%——chain 数翻倍而 Memory 非线性翻倍；每 chain 边际被 summary/certificate 驱逐与 range 合并压缩在 ~516 字节）

## 16. global reset 中断窗口

- 迁移中断（写新 store 后 reset）：A6 实测重读幂等（watermark 单调、legacy 保留）。
- replacement 写入后/旧 entry 删除前 reset：Q12 实测 heap 全清后 certificate/range 稳定可读、resolver 稳定 protocol、重复压缩幂等（无双权威、不丢 anti-reuse）。
- completion 写入后/consume 前 reset：H4 实测 pair reconcile 完成 consume 后 journal 推进 completed。

## 17. 验证数字（验证 HEAD e28df92）

| 项目 | 结果 |
|---|---|
| `git diff --check` | 通过（无冲突标记/空白错误） |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| `npm run build` | 成功 |
| 定向 Treasury（VIII+IX+lifecycle+architecture 4 文件） | 124 passed / 124 |
| Treasury 全目录 | 1478 passed / 1478 |
| 定向 Defense（11 文件） | 11 suites / 118 passed |
| 全仓 Jest | 277 suites / 2316 passed / 0 failed / 0 pending / 0 todo |
| `node scripts/verify-jest-budget.mjs` | PASSED（见 budget commit） |
| bundle SHA-256 | `c08a03b8458ab2d2f35e5ecadd364844d38cf3ddc6516218ca78b2f446768f6c` |

## 18. 声明与限制

- GitHub 无可依赖的 Actions workflow / commit status——以上全部为本轮本地实际执行结果，未把旧 evidence 当作独立 CI。
- 未部署到 Screeps、未合并 main、未调用真实 terminal.send()/Game.market/lab/factory/nuker/carrier、未使用真实玩家 Memory、未在线调参 Defense 常量。
- 未声称数据库式 exactly-once（Screeps hard CPU interruption 语义下为 fail-closed + 幂等恢复）。
- 剩余限制：legacy ti1_ 数据在 issuer 层统一 legacy_unverified（不区分"旧 v1 合法发行"与"篡改"——二者在当前协议下同权重阻断新执行，replay blocker 由持久权威承载）；GRA 驱逐依赖 summary probe 装配（未装配时 fail closed——生产装配链路由 lineageRetirementSummary 模块加载保证）；ticket TTL 窗口内 mint 的 sequence 在调用方放弃后需等待显式 expired + GC（有界收敛，非即时）。
