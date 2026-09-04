# Round 22 Remediation XI — Positive Ticket Handoff Proof, Canonical Ticket Identity, Unified GRA Release & Query-Pure Lifecycle Migration 本地验证记录

- 日期：2026-09-05
- Repository：ceyirelehe47/screeps-bot
- Branch：refactor/empire-treasury-rearchitecture
- 实际起始 HEAD：aff491c8d743a1a19ae2850537ed253de454efc0（与任务书预期一致；工作树干净）
- 最终代码/测试验证 HEAD：e99fd15（test commit——其后仅 docs/evidence 与 budget 提交）
- 最终分支 HEAD：见下方 commit 列表末尾（push 后 ls-remote 核验）

## Commit 列表及职责

| Commit | 职责 |
| --- | --- |
| 7a6c125 | fix(treasury): require positive proof for issued ticket handoff——resolver verdict 结构化（exact_owner/blocked/absent）、gate 只消费 exact_owner、ticket canonical identity（T1-T4/T6）、facade 执行点 handoff 结果控制 callback、X 轮 fixture durableIdentityDigest 重算修正 |
| a4414de | fix(treasury): canonicalize certificate roots and unify gra release——certificate current root canonical 校验（C1-C2）、GRA 统一 destructive release primitive（四路径收敛、结构化 blocked、read-back 完整恢复）、resolutionStore/compaction 消费 blocked（pending 诊断） |
| e8d3353 | fix(treasury): make retired range migration query-pure——migration 唯一 owner（GC coordinator 前置阶段）、range 三 query 零写 + migration_required 第五态、resolver Intent 维度零写校验、completion/supersession store-absent 零读、namespace quota（current 48 / legacy 16） |
| e99fd15 | test(treasury): cover remediation xi lifecycle counterexamples——XI1-XI7 架构守护、P1/P2 压力回归 |
| （后续） | docs(openspec) + chore(test) budget |

## 一、Positive owner 与 GC blocker 的语义区别

resolver 的 `owned` 双语义结构化拆分为 `verdict` 字段：

- `exact_owner`：该维度 entry 真实在位（durable intent / quarantine / journal / fault / marker / resolving resolution / active lineage / matching completion / historical / settled receipt / GRA proof / final tombstone / terminal lineage / summary）——唯一可授权 ticket handoff consume 的 verdict；
- `blocked`：保守阻断（18 处 store unhealthy / probe 未装配 fail-closed + live completion identity conflict——后者 storeUnhealthy=false，不得用 `!storeUnhealthy` 区分，必须读 verdict）——只阻断执行与 GC，绝不构成"新 owner 已接管"；
- `absent`：全部维度健康且明确为空。

伪修复排除：未采用 `owned && !storeUnhealthy` 表面修复（conflict 是 storeUnhealthy=false 的 blocked——H5 三层验证：API conflict 可表达、身份矛盾形态 → resolver blocked → gate owner_unverifiable）；未把 blocker 改名 owner 保持原语义。

## 二、handoff 状态顺序（3.2）

```
active Ticket
→ durable owner 写入（intent/tombstone/…）+ Memory read-back
→ 正向 owner relation 验证（verdict === "exact_owner"）
→ Ticket consume（active → consumed 写入）
→ consume read-back（失败 → 完整回滚 + 结构化 rejected）
→ callback（成功 handoff 判定之后、恰好一次）
```

facade 执行点（execution-started 持久化后）：`completeTreasuryIssuedTicketHandoff` 结果控制 callback——非 consumed → callback=0、保守关闭 handle（reason issued_ticket_handoff_failed / issued_ticket_store_unhealthy；intent 保留 executing——durable owner 在位，下次 gate 幂等补完成，B6 不回 active）。

## 三、unhealthy / conflict / insufficient 时 Ticket 为何保持 active

consume 的授权依据是**正向证明**而非"防止重放"：store 损坏 / probe 未装配 / identity conflict 时 durable owner 是否已接管不可判定——此时 consume 会制造"ticket 已 terminal 但 owner 不可证明"的不可逆状态（修复后无法区分恢复场景与协议异常）。gate 返回 `issued_ticket_owner_unverifiable`、ticket 保持 active（不 consume / 不 expire / 不删除）；修复相关 store 后同 exact opening 可正常执行一次（H1/H2：最终 callback 总数恰为 1）或幂等完成 handoff（H6：handoff_recovered + callback=0）。

## 四、gate 如何处理 consume 失败（H7）

gate 的 exact_owner 分支消费 completeHandoff 结果：consumed → handoff_recovered；absent → issued_ticket_missing（不报告 recovered）；rejected(store_unhealthy / state_conflict) → 对应结构化 reason + detail 含真实失败（read-back 失败已由 consume 原语完整回滚）。生产面零 `void completeTreasuryIssuedTicketHandoff`（XI2 源码守护）。

## 五、Ticket canonical identity 完整维度

`verifyTreasuryCurrentIssuedIdCanonical`（纯函数、零 Memory 读写，attemptIssuer 导出——ticket 与 certificate 共用）：ti2_ 形态（regex）+ namespace=current（ti1_ 是独立 legacy 域）+ checksum 按 ISSUER_PROTOCOL_TAG v3 确定性重算全等 + entry.sequence 与 ID 内 sequence 完全相等。validateTicketEntryShape 逐条调用（validateTicketStoreShape 整店共用）——任一条损坏 → 整店 unhealthy（production callback 不可达，不自动修复、不删除损坏 entry——T1-T4）。发行事实独立判定：gate 验证 ticket.sequence ≤ issuer watermark（canonical ID 不构成发行事实——T6 issued_ticket_unissued，watermark 不推进；production contract 路径更早被 build 层 forged_future 防线拦截 transaction_id_not_issued）。

## 六、certificate current root 完整维度

validateCertificateCanonicalRelations 对 current（ti2_）root：canonical 校验（同上四维度，rootSequence 与 ID 内 sequence 相等）+ 既有 finalAttemptId 派生一致性。legacy ti1_ root 保持隔离（不用当前协议重算 legacy checksum、不解释为 current、不因 current 活性删除 legacy 安全事实）。record 的满载驱逐分支对候选做防御性 canonical 复验（不吸收该 rootSequence、不删除该 certificate——load 后篡改拦截）。

## 七、GRA delete site 审计（前 → 后）

修复前（审计结论）生产删除点：
1. releaseTreasuryGenerationRetirementProofOfAttempt（GRA:656）——无 read-back、无恢复；守卫仅 active record 同代检查，信任调用方；
2. releaseOrphanTreasuryGenerationRetirementProofs（GRA:690）——同上，且放行条件是调用方注入的 `tombstoneExists` 谓词（"tombstone 不存在 → 释放"是独立充分条件）；
3. evictGenerationProofsSupersededBySummary（GRA:895）——有 verifier + 依赖检查 + read-back 恢复（X 轮成果）；
4. persistTreasuryGenerationRetirementProof 回滚 ×2（非 release 语义——写入失败回滚）。

修复后：1/2/3 全部经统一 `releaseGenerationProofDestructive(key, mode)`（四个 mode：tombstone_retired / orphan_advance / compaction_orphan / summary_superseded）。primitive 内部自验：entry 在位 + byAttempt/byLineage 索引一致；lineage probe 装配+健康+record 非当前代；journal 健康+entry 不在；tombstone 健康+entry 不在（**tombstone 缺席不再是充分条件**——G1）；summary_superseded 模式重验 verifyTreasuryGenerationSummaryReplacement 全维度（legacy replay-only 不授权——G2/G3）。删除同步维护 entries/entryCount/updatedAt/双索引 + Memory read-back，失败完整恢复（G6/G11）。caller 消费结构化结果：resolutionStore hook blocked → `peekTreasuryGenerationProofReleaseBlockedDetail` 诊断（不再 void）；compaction → `peekTreasuryCompactionOrphanReleasePending`（pending 不谎称已释放——G3）；advance sweep blocked → retained。源码守护 XI4：GRA 内 `delete runtime.store.entries[key]` 恰 4 处（persist 回滚 ×2 + primitive + ForTest helper），三个入口函数体内零直接 delete。

## 八、每类 GRA replacement mode 的安全理由

- summary_superseded（满载驱逐）：root 代（gen=0）proof 的 retirement 语义由 matching v3 summary rootExact 按全维度 relation 接管（verifyTreasuryGenerationSummaryReplacement：schema v3 / root ID / lineage / gen=0 / terminalState 相容 / class / digest / canonical root identity / durable / contract-cohort-lowlevel 矩阵 / profile / issuer domain）+ exact consumer 关闭；
- tombstone_retired（驱逐联动）：tombstone 已按 retentionReplacementVerdict replacement_match 驱逐（唯一长期依赖消失）+ primitive 重验 lineage/journal/索引；
- orphan_advance（代推进清理）：active record 已推进到更高 generation（下一代接管）+ 全部依赖关闭；
- compaction_orphan（压缩清理）：summary 已写入 + active record 已删 + primitive 重验；
- 共同原则：anti-reuse 事实（retired range/watermark）从不伪装成 exact identity replacement；replacement identity 不足时保留 GRA（G2/G3——legacy v2 summary 与 relation 不一致均零删除）。

## 九、query API 零写证明

- peekTreasuryRetiredRangeHealth / lookupTreasuryRetiredRangeStructured（v1 → migration_required 第五态）/ checkTreasuryAttemptRetiredRange（absent → 健康空不初始化；v1 → 保守 retired）：全部 Memory 直读（M1：v1 store 下三轮查询前后 JSON.stringify(Memory.runtime.treasury) 完全一致；M2：store absent 时 retiredAttemptRanges 恒不存在）；
- lifecycle owner resolver：Intent 维度 peekTreasuryIntentStoreValidation（absent → null 零创建；在位 → 复用 load 全量校验）；cleanupCompletion / supersession load 改 forWrite 模式（absent 读取 → heap-only 空视图；写路径 ensurePublished 保障首次真实写入落 Memory）；
- sequenceHasLifecycleAuthority：纯构建 ID（buildTreasuryCurrentIssuedIdUnchecked——不经 issuer load）+ certificate 直读；
- XI5 守护：三个 query 函数体内零 loadRangeRuntime/零 migrate 调用。

## 十、migration 唯一 owner 及 reset 恢复

v1→v2 迁移唯一 owner = `runTreasuryRetiredRangeMigrationAtTickBoundary`（runTreasuryLifecycleGcCoordinator 的前置阶段）：v1 源完整形状校验（validateLegacyRetiredRangeStoreShape——source 与 target 双侧）→ 发行域严格证明（proveLegacyRetiredRangeStore：issuer v1 → legacy；issuer v2 无 legacy record → current；v1 updatedAt < migratedAtTick → legacy；不可证明 → blocked 原数据保留）→ 单对象替换 + Memory read-back（失败还原 v1）。幂等：v2/absent → idle 零写；reset 后重读 v2 即完成，不产生第二 frontier（M6）。blocked/unhealthy 不折叠为 absent（query 报 migration_required / unhealthy；absorb fail closed——M5）。coordinator report 携带结构化 rangeMigration（blocked 不阻断 ticket GC——M7）。XI5 守护：migrateLegacyRetiredRangeStore 生产调用方全仓仅 coordinator。

## 十一、legacy/current 容量隔离方式

per-namespace quota（不拆 store、不改持久 schema）：current 48 + legacy 16 = 物理 64 总量不变。吸收入口（coalesce 触发判定）与 core（coalesced 精确终检）双层强制；判定只针对"新增区间"（相邻合并扩展既有区间不增加计数——Q3 超额 legacy 存量的合并式吸收允许）；超额存量保留不裁剪（只阻断新增）、两域互不驱逐、不跨域合并（Q1/Q2：legacy 满 16 → current 吸收照常；current 满 48 → legacy 吸收照常）；Q4：store 恒 ≤64、同 sequence 两域独立事实。lifecycle contract 登记（capacityNote/cleanupOwner XI6 守护三方一致）。

## 十二、固定反例 → 测试映射

| 反例 | 测试 |
| --- | --- |
| H1 | treasuryRound22RemediationXI.test.ts「H1：无 owner + unrelated Intent store 损坏…」 |
| H2 | 同文件「H2：… Quarantine store 损坏…」 |
| H3 | 同文件「H3：settled Receipt store 他键损坏…」 |
| H4 | 同文件「H4：fresh module registry…」 |
| H5 | 同文件「H5：live completion 的 exact identity conflict…」 |
| H6 | 同文件「H6：global reset 正向恢复…」 |
| H7 | 同文件「H7：… consume Memory read-back 失败…」 |
| H8 | 同文件「H8：瞬态 reservation 不是 durable handoff proof…」 |
| T1-T6 | 同文件 T1-T6（canonical identity 六项） |
| C1-C4 | treasuryRound22RemediationXILifecycle.test.ts C1-C4（certificate canonical root） |
| G1-G5/G7 | 同文件 G 组（统一 release：tombstone 非充分条件 / legacy summary 不授权 / compaction pending / 成功+幂等 / read-back 恢复 / reset 幂等；G8 源码守护=XI4） |
| M1-M7 | 同文件 M 组（query 零写 / absent 零写 / legacy 迁移 / current 迁移 / 不可证明 / reset 幂等 / coordinator 阶段） |
| Q1-Q4 | 同文件 Q 组（保留容量 / 互不驱逐 / 超额存量 / 有界） |
| 架构守护 | treasuryMemoryLifecycleContract.test.ts XI1-XI7 |
| 压力 | XILifecycle P1（≥1000 循环）/ P2（容量记录）+ X 轮 X1-X4 重跑（600 chain / 高吞吐 / namespace 并存 / reset 五窗口） |

## 十三、容量与 Memory 数字（实测）

- Ticket store 最大 entryCount：P1 千循环峰值 ≤128（active 满载 64 由 X 轮 B 系覆盖；X2 高吞吐峰值 12/128——X 轮 evidence 口径，本轮重跑全绿）；
- GRA 最大 entryCount：255（600 chain 稳态震荡——满载 384 上界内）；
- Summary 最大 entryCount：128（硬容量一致）；
- Certificate 最大 entryCount：256（硬容量一致）；
- current range entryCount：1（600 chain 收敛）；legacy range：0；
- 300 chain 阶段 Treasury Memory 序列化：292,379 - 420,865 字节；
- 600 chain 阶段：361,707 - 423,623 字节（不随历史总数线性增长——两阶段带内重叠）；
- query purity：M1 before/after 字节完全一致（JSON.stringify 全量比较）；
- migration 每次最多访问 entry 数：≤64（validateLegacyRetiredRangeStoreShape 单遍 + migrate 单对象替换）；
- namespace 满载压力最大 store 尺寸：64 区间（Q4 实测）。

## 十四、验证命令与精确数字

| 命令 | 结果 |
| --- | --- |
| npx tsc --noEmit -p tsconfig.json | exit 0（无输出） |
| npm run build | exit 0；31.1s；产物 dist/main.js |
| npx jest … treasuryRound22RemediationXI.test.ts treasuryRound22RemediationXILifecycle.test.ts | 2 suites / 37 tests / 37 passed / 0 failed / 0 pending / 0 todo；7.895s |
| npx jest …（回归定向 10 文件：X / XNamespace / IX / MemoryLifecycleContract / ActionContract / Core / WriteArchitecture / Round18 / Round20 / Round21） | 10 suites / 261 tests / 261 passed；24.015s |
| npx jest … src/runtime/treasury/ | 79 suites / 1579 tests / 1579 passed；34.513s |
| npx jest …（Defense 冻结 11 文件 + memoryDeclarationBoundaries） | 11 suites / 118 tests / 118 passed；32.973s |
| npx jest（全仓） | 281 suites / 2417 tests / 2417 passed / 0 failed / 0 pending / 0 todo；111.664s |
| node scripts/verify-jest-budget.mjs | PASSED（budget 提交后核验） |

## 十五、产物与仓库卫生

- build 产物：dist/main.js
- bundle SHA-256：e251d0e7cf237b5cf9c834b7b8f1348df3c776a9f30b3de1f4437b37c36180ad
- git diff --check：干净（无 whitespace 错误）
- 最终 git status --short：干净（budget/docs 提交后）
- push：见最终报告（ls-remote 核验一致）

## 十六、声明

- 以上为**本地验证**（Agent 本机执行 jest/tsc/npm run build），不是 GitHub Actions 或独立 CI；
- 全部 Game 写动作测试均使用 mock / spy；未调用真实 terminal.send()；未接入任何真实经济 writer；
- 未部署到 Screeps；未修改真实 Memory；未使用生产凭证；未合并 main；未修改 Defense 生产逻辑（Defense 仅跑冻结回归 118 tests 全绿）；
- 未把预计值写成实测值；未把本地全绿描述成独立 CI。
