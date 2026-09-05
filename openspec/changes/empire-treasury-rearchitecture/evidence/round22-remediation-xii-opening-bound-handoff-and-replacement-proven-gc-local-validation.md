# Round 22 Remediation XII — 本地验证 evidence

## 基本事实

- 日期：2026-09-05（本地）
- Repository：ceyirelehe47/screeps-bot
- Branch：refactor/empire-treasury-rearchitecture
- 预期起始 HEAD：2dde34b39df4b80140c7af2569e6fc8cdb13ef48（与实际一致——远端无前移）
- 最终代码/测试验证 HEAD：0476884ab7cf290e413bee77546fa6583c699fb1
- 最终分支 HEAD：见最终报告（docs/budget commits 在验证 HEAD 之后）
- 无独立 CI：本文件全部数字为 Agent 本地实测（Windows / Git Bash / Jest --runInBand）。

## commit 列表与职责

| commit | 职责 |
| --- | --- |
| 23c1e4a fix(treasury): make authority lookups fully query-pure | 工作流 D：intent/quarantine/fault/receipt(trusted) 零写校验视图、certificate lookup 零写、summary/lineage/GRA loader forWrite 门禁、journal/issuer 读取零写、authority store migration owner（coordinator 前置） |
| 0a3a270 fix(treasury): bind positive ownership to exact opening identity | 工作流 A+B：positiveOwnershipVerifier（全 source 聚合）、expected identity 绑定、ticket binding 双维度、facade 时序反转（consume 先于 executing）、beginTick 恢复 consume + GC 收敛 sweep、新 reason 五项 |
| 2f85ce9 fix(treasury): require durable replacement for gra retirement | 工作流 C：replacement class 验证矩阵（summary/certificate/advanced-lineage/range）、exact consumer 扩展（intent/quarantine/marker/fault）、lineage health/read 同源、XI G 组 fixture 迁移真实压缩链 |
| 2bd1a91 fix(treasury): physically isolate issuer range capacities | 工作流 E：retired range v3 物理分区（current 48 / legacy 16 + legacyOverflow 至 64，总上限 112）、v1/v2→v3 迁移（namespace 分流 + 区间数守恒）、分区直读查询、lifecycle contract 更新 |
| 5293717 fix(treasury): prove issuance before certificate publication | 工作流 F：watermark frontier、matching terminal summary（probe 委托 + record 侧 terminal authority 匹配）、active ticket 拒绝、全部拒绝路径零写、VII/VIII/IX fixture 迁移 |
| 0476884 test(treasury): cover remediation xii counterexamples | O/P/I 24 + Q/G/N/长跑 13 + XII1-XII8 架构守护 + migrate 入口 heap 失效修复（测试暴露的生产缺陷） |

## generic GC blocker 与 opening-bound positive owner 的区别

XI 及之前：`resolveTreasuryAttemptLifecycleOwnership` 只按 transactionId 判定 exact_owner——同 ID 不同 contract/durable/cohort 的 owner 会被误判"已接管"（O1/O2 的缺陷本体）；且 12 级 first-match 使前方 matching Intent 遮蔽后方 unhealthy/conflict（O3/O4）。

XII：通用 resolver 保留给 orphan GC / TTL sweep / sequence abandon / "不得删除"判断（4.1）；ticket handoff 的正向判定迁移到 `positiveOwnershipVerifier`：

- expected identity 由当前执行状态机内部构造（facade 的 contract/lowlevel 通道——4.2），不得从 owner entry 反推；
- 全部 source（Intent/Quarantine/cleanup journal/Authorization Fault/write-fault marker/Resolution tombstone/attempt lineage/live completion/historical completion/settled receipt/GRA proof/retirement summary/certificate/retired range——14 类）先收集后统一裁决；
- 裁决优先级：store_unhealthy > identity_conflict > outcome_conflict > insufficient > retired_only/protocol_only > matching 三态聚合；
- matching_not_started / matching_execution / matching_terminal_owner 严格区分（4.4）。

## expected opening identity 维度（4.2）

transactionId、canonical payload digest、contract digest、authorization cohort digest、durable identity digest、proofClass（identity-bound/lowlevel）、tr1_ lineage 四字段、lowlevelSource。某维度对通道不适用时省略；owner 携带而 expected 省略的维度按 relation insufficient（不静默跳过）。

## positive verifier 收集的全部 source 与统一裁决规则

见上列 14 类 source。规则（3.3）：任一 source unhealthy → store_unhealthy；任一 exact conflict → identity_conflict；两个有结论的 terminal source 相反 → outcome_conflict；任一 exact source 只能 insufficient/legacy → insufficient；protocol/retired-only 只阻断不构成 owner（与 exact match 并存时同样阻断）；not_started + committed terminal → outcome_conflict；not_started + not-executed terminal → matching_terminal_owner（窗口 C 目标终态）。

## callback_not_started 状态与 ticket transfer 状态机（3.4 / 5.1）

复用 Intent (outcome=not_started, settlement=ready)。facade 时序（XII 反转）：全部 callback 前检查 → durable (not_started, ready) 写入 + read-back 完整 identity 验证 → positive verify（expected 绑定当前 opening）→ consume + consume read-back → **才** progress (started_unknown, executing) → Game callback。

consume/read-back 失败（P1）：callback=0、Intent 保持 (not_started, ready)、不进 executing、不转 execution-unknown、不进 quarantine、ticket 由 consume 原语完整回滚 active、tentative/receipt reservation 释放（tr1_ 另回滚 lineage）。

global reset 窗口：A（owner 写入前：ticket active 正常重试）/ B（owner 后 consume 前：beginTick 安全释放 not-started owner，同 exact opening 可重试——P2/P3）/ C（consume 后 executing 前：beginTick 明确 not-executed 释放、不进 quarantine、同 ID 不可再执行——P4）/ D（executing 后 callback 前：保留 execution-unknown fail-closed——P5）/ E（callback 返回：既有状态机）。execution-owner intent 转 quarantine 前由 beginTick hook 幂等 consume；"transfer 成功而 consume 失败"窗口由 GC coordinator 的 ticket handoff 收敛 sweep（quarantine owner 在位的 active ticket 幂等补 consume）承载。

## GRA replacement class 与 delete site 审计

replacement 验证矩阵（6.2）：summary_superseded/compaction_orphan → exact Summary full relation（后者亦接受 terminal certificate 覆盖）；orphan_advance → active-lineage advanced（record 在位 + 同 lineage + generation 严格更大 + root 一致——record 缺席不再是删除依据）；tombstone_retired → advanced active lineage / terminal certificate / retired range 按序验证。exact consumer 关闭（6.3）：cleanup journal / resolution tombstone / unresolved intent / quarantine / write-fault marker / authorization fault。lineage health 判定与 record 读取统一到 semantic lineage record source（6.4）。delete site 审计：`delete runtime.store.entries[key]` 全文件仍恰 4 处（persist 回滚 ×2 + primitive + ForTest helper——XI4/X8 守护不变）；read-back 失败完整恢复 entries/entryCount/byAttempt/byLineage（G9 既有）。caller（sweep/tombstone hook/compaction/capacity）消费结构化 blocked。

## query-pure authority API 清单（工作流 D）

intent（peekTreasuryIntentStoreValidation + readTreasuryIntentEntryForQuery）、quarantine（peekTreasuryQuarantineStoreValidation + ForQuery）、authorization fault（peek validation）、receipt trusted（peekTreasuryReceiptStoreTrustedValidation + 零写 lookup）、certificate（lookup 三 API——absent 不初始化）、retired range 三 query、summary/lineage/GRA health（legacy 版本 fail closed 不迁移）、cleanup journal（absent 零写）、issuer checkTreasuryServiceIssuedAttemptId、positiveOwnershipVerifier 全部读取。Q1-Q8 断言第一次调用前后 Memory JSON.stringify 字节一致。

## migration owner 清单

| store | 唯一 owner | 语义 |
| --- | --- | --- |
| retired range v1/v2 → v3 分区 | GC coordinator 的 runTreasuryRetiredRangeMigrationAtTickBoundary | 发行域证明 / namespace 分流 + 区间数守恒 + read-back + 失败还原 + 幂等 |
| attempt issuer v1 → v2 | runTreasuryAuthorityStoreMigrationsAtTickBoundary（facade beginTick 最前置；mint 写路径 load 仍可迁移） | watermark 保留 legacy 记录 + read-back |
| attempt lineage v1/v2 → v3 | 同上 | 确定性 identityProfile 迁移 |
| retirement summary v1/v2 → v3 + archive 拆分 | 同上 | 原子 + read-back |
| GRA v1 → v2 | 同上 | identityProfile 推导 |

query/写路径遇 legacy 一律 fail closed（migration_required/unhealthy）；migrate 入口带 heap 失效（防缓存视图遮蔽 Memory 直改 store——XII 测试暴露并修复的缺陷）。

## namespace 物理容量布局（工作流 E）

retired range v3：current 分区（独立数组，硬上限 48）/ legacy 分区（配额 16，迁移存量显式 legacyOverflow 至 64）——总 Memory 上限 112。legacy 占满旧协议最大 64 条时 current 仍完整 48 条（N1 实测）；某分区 overflow 只阻断该分区（legacyOverflow 下 legacy 新增一律 fail closed、current 不受影响）；不删除旧事实腾槽、不跨域合并；跨域同 sequence 独立（N5/N7）。

## certificate issuance / lifecycle 验证（工作流 F）

current root：watermark frontier（sequence > watermark 拒、watermark 不可读 fail closed）；matching terminal retirement summary（经 probe：health + root lookup + terminal authority 五字段匹配 + ti_ root 发行域一致；arbitrary root 按隔离协议）；root 的 issued ticket active → 拒；全部拒绝零写。legacy root（ti1_/arbitrary）不做 current checksum 重算。

## 固定反例 → 测试映射

- O1-O8 → treasuryRound22RemediationXII.test.ts（O describe；O1 断言 callback=0 + verifier identity_conflict + Intent B 原样在位；O2 cohort 维度 conflict；O3 store_unhealthy 不遮蔽；O4 outcome_conflict；O5 legacy receipt insufficient；O6 matching_terminal(not-executed) 相容聚合；O7 retired_only；O8 absent 放行）
- P1-P8 → 同文件（P describe；全部显式断言 callbackCount）
- G1-G5/G7/G9-G11 → treasuryRound22RemediationXILifecycle.test.ts G 组（XII 语义迁移）+ 既有 X8/XI4 守护；G6/G8 → treasuryRound22RemediationXIIQueryAndGc.test.ts
- Q1-Q8 → treasuryRound22RemediationXIIQueryAndGc.test.ts Q describe（无 warm-up 字节快照）
- N1/N5 → 同文件 N describe；N2-N4/N7 已由 XI Q 组 v3 分区断言覆盖（XILifecycle Q1-Q4 + P2）；N6 = M 组 v1/v2 migration_required；N8 = P2/contract 硬上限
- I1-I7 → treasuryRound22RemediationXII.test.ts I describe（I3b 覆盖 active ticket 分支；I7 reset 幂等）
- 架构守护 XII1-XII8 → treasuryMemoryLifecycleContract.test.ts

## 长跑与容量数字（实测）

- 1000 ticket open/abandon/expire/retire 循环（XII-LOAD，含每 50 轮 GC + Memory 采样）：ticket store 峰值 entries=1（abandon 即删 + 周期 GC；X 轮 B 组的满载场景峰值 128 = 硬容量）、watermark=1000（单调不回退）、GC 后 active=0、Treasury Memory 序列化峰值 430 字节 / 终态 431 字节（干净场景）；X 轮 B 组满载场景与 XI P2 各 store 满载断言继续通过（483 上下文见 X/XI evidence）。
- 300-generation chain（VI T9 真实执行链）：GRA 中间代 proof 经 advanced-lineage replacement 释放、终局经 certificate 覆盖释放、historical 压缩至 0、certificate 1 条——全部断言通过。
- 600 chain / 高吞吐 / reset 交错（X 轮 B 组既有）：继续通过（本轮回归）。
- query purity：Q1-Q6/Q8 断言 before/after JSON.stringify 字节一致（实际等于——Jest 通过）。
- positive owner verification 单次最大访问条目数：O(各 store entry 总数 ≤ 各自硬容量；verifier 无全表扫描——单键/索引读取 + validation 全表校验经 heap 缓存只做一次)。
- beginTick migration 单次最大访问条目数：迁移源 store 全表（≤ 该 store 硬容量：GRA 384 / summary / lineage / issuer / range 112）——每 tick 至多一个 store 迁移、幂等 idle 零访问。

## 验证命令与精确结果（全部本地实测）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | npx tsc --noEmit -p tsconfig.json | exit 0 |
| build | npm run build | exit 0 |
| XII 定向 | npx jest …XII.test.ts …XIIQueryAndGc.test.ts --runInBand | 2 suites / 37 tests / 37 passed / 0 failed / 0 pending / 0 todo（4.46s） |
| 高风险回归（12 文件） | npx jest …（XI/X/XNamespace/IX/contract/writeArchitecture/actionContract/core/R18/R20/R21）--runInBand | 12 suites / 306 tests / 306 passed / 0 failed（46.2s） |
| Treasury 全目录 | npx jest src/runtime/treasury/ --runInBand | 81 suites / 1624 tests / 1624 passed / 0 failed / 0 pending / 0 todo（80.7s） |
| Defense 冻结（11 文件） | npx jest …（footprints/preallocation/stationary/allActor/fallback/focusFire×2/homeDefense/towerControl/homeDefender/memoryDeclaration）--runInBand | 11 suites / 118 tests / 118 passed / 0 failed（23.9s） |
| 全仓 | npx jest --runInBand | 283 suites / 2462 tests / 2462 passed / 0 failed / 0 pending / 0 todo（303.0s） |
| budget | node scripts/verify-jest-budget.mjs | JEST_TEST_BUDGET=PASSED（suites 283 / tests 2462；manifest=test/test-suite-budget.json；锚点 0476884） |
| build hash | sha256sum dist/main.js | a68462155216d81821a2e78067ba73d19d1c5742a527ce65fcd8b64d8f8c342b |
| git diff --check | （验证 HEAD） | 干净（无 whitespace error） |
| git status --short | （验证 HEAD） | 干净 |

## push 与声明

- push：见最终报告（docs/budget 提交后 push，ls-remote 核验）。
- GitHub 无独立 CI——上述全部为 Agent 本地验证，不得表述为 CI passed。
- 未部署到 Screeps；未合并 main；未调用真实 terminal.send() / Game.market / lab / factory / nuker / carrier；未使用生产凭证；未修改 Defense 生产逻辑（XII8 守护 + Defense 冻结回归 118/118）。

## 仍存在的限制

1. execution-unknown 的不可消除窗口（executing 后 callback 前）保留 fail-closed（任务书 5.3.D 允许）；Screeps hard CPU interruption 下不声称 exactly-once。
2. early ownership gate 的 digest-only verify 对 not-started owner 判 insufficient 放行——精确裁决在 intent 写入后的 full verify（O5/O7 类阻断发生在 callback 前但可能晚于 redemption；bundle 一次性消费的窗口由 authorization fault 路径承载）。
3. ticket binding 的 contractDigest 含 adapter.version——生产 registry 每 tick 稳定故幂等；测试环境的反复 register 会使 version 递增（XII 测试经 registry 保持 fixture 规避；生产无此场景）。
4. v3 分区迁移的 legacy 存量 >16 时 legacy 新增区间一律 fail closed（显式 forensic 状态）——需要人工/后续协议收敛 legacy 分区。
5. GRA tombstone_retired 对"chain 推进中"的中间代依赖 advanced active lineage——lineage record 意外缺失时 blocked（保留 proof，下一 tick 由 compaction_orphan/summary 或 certificate 通道收敛）。
6. 远端无 CI；forensic 场景（summary legacy archive 的 root 冲突等）依赖人工 repair。
