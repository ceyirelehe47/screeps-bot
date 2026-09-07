# Core Candidate Seal I — 独立 Reviewer 复验日志

- reviewer 身份：独立 subagent（未参与本轮测试补齐实施），只读复验
- 复验时间：2026-09-07（本地时间），recordedAt 轨迹为 2026-09-07T06:11:36.622Z
- 复验 worktree：/tmp/tmp.JGRE8Srj4s/worktree（Windows: C:\Users\15027\AppData\Local\Temp\tmp.JGRE8Srj4s\worktree），独立输出目录：/tmp/tmp.JGRE8Srj4s/reviewer-output/
- 预期 HEAD：62d645743ac986b9f405cdfebb055e6d171c1d9b（detached）
- 冻结基线 FREEZE_BASE：869149dcdd6f2068572354917bf23c52727cf9b6

## 1. 前置核验

| 命令 | 退出码 | 结果 |
|---|---|---|
| git rev-parse HEAD | 0 | 62d645743ac986b9f405cdfebb055e6d171c1d9b（与预期一致） |
| git status --porcelain（前） | 0 | 输出为空（干净）；git rev-parse --abbrev-ref HEAD = HEAD（detached） |
| node --version | 0 | v22.19.0 |
| npm --version | 0 | 10.9.3 |

## 2. 冻结检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| git diff --exit-code FREEZE_BASE HEAD -- src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts' | 0 | 生产零 diff（无输出） |
| git diff --exit-code FREEZE_BASE HEAD -- package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs | 0 | 配置零 diff（无输出） |
| git diff --exit-code FREEZE_BASE HEAD -- （Defense 冻结 7 文件：src/runtime/defenseFocusFire.ts、engagementFallbackRevision.ts、defenderRampartAllocation.ts、homeDefense.ts、towerControl.ts、physicalRampartOwnership.ts、src/roles/homeDefender.ts） | 0 | Defense 7 个生产文件零 diff（无输出） |

### git diff --name-status --no-renames FREEZE_BASE HEAD 全部差异（exit=0，共 7 个文件）

| 状态 | 文件 | 分类 |
|---|---|---|
| M | openspec/changes/empire-treasury-core-rewrite/design.md | 文档 |
| M | openspec/changes/empire-treasury-core-rewrite/tasks.md | 文档 |
| M | openspec/changes/empire-treasury-core-rewrite/test-migration-map.md | 文档 |
| M | scripts/verify-jest-budget.mjs | 脚本 |
| M | src/runtime/treasury/treasuryRemediationIVKernel.test.ts | 测试 |
| A | test/mock/treasurySealEvidence.ts | 测试辅助（新增） |
| M | test/test-suite-budget.json | 测试配置数据 |

分类结论：7 个差异全部为 测试/脚本/文档，无生产代码、无构建核心配置。

## 3. typecheck

- 命令：npx tsc --noEmit -p tsconfig.json
- 退出码：0（无输出）

## 4. 定向测试（jest 均带 --cacheDirectory /tmp/tmp.JGRE8Srj4s/reviewer-output/jest-cache）

### KEY 集合（TREASURY_SEAL_EVIDENCE_DIR=/tmp/tmp.JGRE8Srj4s/reviewer-output/trace-key）

命令：npx jest --config jest.config.cjs --runInBand --runTestsByPath treasuryRemediationIVKernel/VIKernel/IVService/VKernel/VService 五件
- 退出码：0
- Test Suites: 5 passed, 5 total；Tests: 54 passed, 54 total；Snapshots: 0；Time: 18.938 s
- 关键 H18-TRACE 行（treasuryRemediationIVKernel.test.ts:1077）：
  `H18-TRACE completed=true observe=12 bounded=13/40 recovery=1/10 checkpoints=54 portEvents=96 finalClose=25 final={"phases":{"closing":0,"outcome_unknown":20,"retry_ready":0,"pending":0,"other":0},"remaining":0,"active":20,"ring":44,"chars":21879,"utf8Bytes":21879,"budgetUsed":2}`

### Defense 11 件

命令：npx jest --config jest.config.cjs --runInBand --runTestsByPath defenseFocusFire、defenseFocusFireStateful、defenseFallbackReallocation、defenseAllActorReservation、defenseGlobalRampartFootprints、defensePreallocationRampartOwnership、defenseStationaryRampartOwnership、homeDefense、towerControl、src/roles/homeDefender、test/memoryDeclarationBoundaries
- 退出码：0
- Test Suites: 11 passed, 11 total；Tests: 118 passed, 118 total；Snapshots: 0；Time: 37.362 s

## 5. 轨迹机器核验（H18-J06.json，本次运行生成于 trace-key/1788761495170-138588/，1180356 字节）

- format=treasury-seal-trace/v1；completed=true；failure=null —— 全部符合
- suite=treasuryRemediationIVKernel.test.ts；test="H18 J06（Seal I 全轨迹）"；recordedAt=2026-09-07T06:11:36.622Z

### 检查点分布（总数 54，seq 1..54 连续无缺号）

| stage/point | 数量 |
|---|---|
| observe/reload-before | 12 |
| observe/after-advance | 12 |
| bounded/reload-before | 13 |
| bounded/after-advance | 13 |
| recovery/reload-before | 1 |
| recovery/after-advance | 1 |
| final-close/pre-close | 1 |
| final-close/post-close | 1 |

segments 元数据：observe plannedTicks=12/actualTicks=12；bounded limitWindows=40/actualTicks=13（与日志 bounded=13/40 一致）；recovery limitWindows=10/actualTicks=1、failingPortRestoredAtTick=26（与日志 recovery=1/10 一致）。

### portEvents 与 tickEvents 一致性

- portEvents 总数 96（与日志一致），ok=true 90 / ok=false 6，seq 范围 1..96
- 逐点核验 after-advance 与 post-close 共 27 个检查点：每点 tickEvents === portEvents 中 (tick==该点 tick 且 seq<=eventsUpTo) 的数量；不符数 = 0

### 风险覆盖

- initial.unknownRiskBaseline 覆盖 20 ID
- 每检查点（54/54）riskCheckedIds 均为 20 条，且集合与基线 ID 集合一致
- riskDiff===null 的检查点：54/54
- terminal.unknownIds 数 20，与 fixture.unknownIds 集合一致；terminal.riskDiff=[]（空）
- terminal.health=healthy、active=20、ring=44、chars=21879（与 H18-TRACE final 一致）

### 抽样基线记录（id=tk1_h18_30，非 hash，原始结构在档）

- identity：{actionKind:"d.kind", adapterVersion:1, adapterRegistrationId:"reg-d.kind", adapterSemanticIdentity:"d.adapter-d.kind", canonicalDigest:"aaaaaaaaaaaaaaaa"(16), postingsDigest:"bbbbbbbbbbbbbbbb"(16), retryFactsDigest:"cccccccccccccccc"(16), durableFacts:null}
- worstCase：[{roomName:"W1N57",locationKind:"storage",resource:"energy",delta:-50},{roomName:"W2N57",locationKind:"terminal",resource:"energy",delta:50}]
- invocationBoundary：{atTick:1, worldSequence:1}
- 20/20 条 unknown 基线均含 identity/worstCase/invocationBoundary 原始结构

## 6. 收尾

- git status --porcelain（后）：exit=0，输出为空（工作树仍干净）
- 全程未修改任何源码/测试/配置，未 git commit/push，未部署，未触碰真实凭证或玩家 Memory

## 结论

冻结检查（生产/配置/Defense 7 文件零 diff）、typecheck、KEY 5 套件 54 测试、Defense 11 套件 118 测试全部通过；轨迹 H18-J06 机器核验各项指标（检查点分布 12/12/13/13/1/1/1/1 共 54、seq 连续、portEvents 96=90+6、tickEvents 不符数 0、风险覆盖 20/20、riskDiff 全 null 54/54、终态一致）全部符合。
