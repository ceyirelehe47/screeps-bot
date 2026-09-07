# Reviewer Log — Core Candidate Seal I · Evidence Remediation I 独立复验（V3/第二执行上下文）

日期：2026-09-07（本地）。本文件由本轮独立 reviewer 撰写。

## 身份声明

- 本 reviewer 为独立复验 subagent（第二执行上下文），**未参与本轮任何实施工作**（未编写/修改本轮任何补修代码、测试、证据归档）。
- 全程只读主仓库 `D:\code\screeps\screeps-bot`；所有写操作仅发生在独立 worktree 与 `seal-ev1-review/output` 输出目录。
- 未 push、未 commit、未执行 `npm run push`/`npm run local`、未修改主仓库工作树（唯一对主仓库的 git 管理性操作为按任务书执行 `git worktree add` 与结束时的 `git worktree remove --force`）。

## 任务书读取记录

- 读取位置：`C:\Users\15027\AppData\Local\Temp\seal-ev1-stage\task\task-brief.md`（已读取全文，413 行）。
- SHA-256：`6e3ff9a480e8b924eb142038f207ee5c963098aee1755444d8bb7a88c522e4a0`（certutil 计算并存于 `task-brief-sha256.txt`）。
- 逐字副本保存于 `task-brief-copy.md`。

## 环境

| 项 | 值 |
| --- | --- |
| 执行 worktree | `C:\Users\15027\AppData\Local\Temp\seal-ev1-review\worktree`（detached） |
| 固定提交 | `d9cd60e07f4c4e7559aec14383ee805aea0e2051`（= 主仓库分支 `refactor/empire-treasury-rearchitecture` 当前 HEAD；commit 主题 "docs(openspec): Evidence Remediation I——L01–L08 任务/映射与证据工具勘误"） |
| node | v22.19.0 |
| npm | 10.9.3 |
| 依赖安装 | `npm ci --no-audit --no-fund`，退出码 0，896 packages，16s（按原 lockfile 真实安装，未用 junction） |
| Jest cache | 独立目录 `../jest-cache`（所有 Jest 运行均带 `--cacheDirectory`） |
| worktree 运行前状态 | `git status --porcelain` 为空（`status-before.txt`，0 字节） |
| worktree 运行后状态 | `git status --porcelain` 为空（`status-after.txt`，0 字节）；`git rev-parse HEAD` 仍为 `d9cd60e07f4c4e7559aec14383ee805aea0e2051`（`worktree-head-after.txt`） |

## 步骤与退出码一览

每步均保存 `<name>.command.txt` / `<name>.log` / `<name>.exit-code.txt` 于本目录。

| # | 步骤 | 产物名 | 退出码 | 关键结果 |
| --- | --- | --- | --- | --- |
| 1 | 生产冻结 `git diff --exit-code 869149dcdd6f2068572354917bf23c52727cf9b6 HEAD -- src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'` | production-freeze | 0 | 零差异（log 0 字节） |
| 2 | 配置冻结 `git diff --exit-code 869149d… HEAD -- package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs` | config-freeze | 0 | 零差异（log 0 字节） |
| 3 | Defense 冻结 `git diff --exit-code 869149d… HEAD -- <7 个 Defense 生产文件>` | defense-freeze | 0 | 零差异（log 0 字节） |
| 4 | typecheck `npx tsc --noEmit -p tsconfig.json` | typecheck | 0 | 无输出（log 0 字节） |
| 5 | IVKernel 套件（TREASURY_SEAL_EVIDENCE_DIR=output/trace-ivkernel）`npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryRemediationIVKernel.test.ts --json --outputFile=…/jest-ivkernel.json --cacheDirectory=…/jest-cache` | jest-ivkernel | 0 | 1 suite / **17 tests / 17 passed / 0 failed / 0 pending / 0 todo**，success=true |
| 6 | KEY 五件（TREASURY_SEAL_EVIDENCE_DIR=output/trace-key，--runTestsByPath 5 个完整路径） | jest-key | 0 | 5 suites / **57 tests / 57 passed / 0 failed / 0 pending / 0 todo**，success=true |
| 7 | Defense 十一件（TREASURY_SEAL_EVIDENCE_DIR=output/trace-defense，--runTestsByPath 11 个完整路径） | jest-defense | 0 | 11 suites / **118 tests / 118 passed / 0 failed / 0 pending / 0 todo**，success=true |
| 8 | 落盘轨迹核验 `node output/verify-seal-trace.mjs` | verify-seal-trace | 0 | 见下节 |

KEY 五件完整路径（--runTestsByPath 实参）：`src/runtime/treasury/treasuryRemediationIVKernel.test.ts`、`src/runtime/treasury/treasuryRemediationVIKernel.test.ts`、`src/runtime/treasury/treasuryRemediationIVService.test.ts`、`src/runtime/treasury/treasuryRemediationVKernel.test.ts`、`src/runtime/treasury/treasuryRemediationVService.test.ts`。

Defense 十一件完整路径（--runTestsByPath 实参）：`src/runtime/defenseFocusFire.test.ts`、`src/runtime/defenseFocusFireStateful.test.ts`、`src/runtime/defenseFallbackReallocation.test.ts`、`src/runtime/defenseAllActorReservation.test.ts`、`src/runtime/defenseGlobalRampartFootprints.test.ts`、`src/runtime/defensePreallocationRampartOwnership.test.ts`、`src/runtime/defenseStationaryRampartOwnership.test.ts`、`src/runtime/homeDefense.test.ts`、`src/runtime/towerControl.test.ts`、`src/roles/homeDefender.test.ts`、`test/memoryDeclarationBoundaries.test.ts`。

### 说明

- 步骤 5–7 为三次独立 Jest 运行，TREASURY_SEAL_EVIDENCE_DIR 分别指向 `trace-ivkernel` / `trace-key` / `trace-defense` 三个不同子目录，未相互覆盖。
- Defense 运行未产生 trace-defense 目录（Defense 套件不消费该证据导出变量），属预期，非失败。
- trace-ivkernel 运行导出 `trace-ivkernel/1788780811839-137248/H18-J06.json`；trace-key 运行导出 `trace-key/1788780869682-101808/H18-J06.json`（后者为第 8 步核验对象）。
- Jest JSON 均由真实 `--outputFile` 生成，可与各自 `.log` 原始输出对照。

## 第 8 步：对自有导出 H18 轨迹的落盘核验（verify-seal-trace.mjs）

脚本位置：`output/verify-seal-trace.mjs`（本 reviewer 编写）。流程：`git show d9cd60e…:test/mock/treasurySealEvidence.ts` 取**已提交**核验实现源码 → 用 worktree `node_modules/typescript` 的 `transpileModule`（CommonJS）编译至临时 .cjs → require → 对 `output/trace-key/1788780869682-101808/H18-J06.json` 先读盘、再 JSON.parse，调 `sealVerifyTraceCompleteness(doc, { unknownIds: doc.fixture.unknownIds, plannedObserveTicks: doc.segments.observe.actualTicks })`。

运行输出（`verify-seal-trace.log`，退出码 0）：

- 核验对象：`trace-key/1788780869682-101808/H18-J06.json`
- 文件字节数：1,180,356
- 文件 SHA-256：`8c3bcdc77820e9fa9116be13c5ece2e40319e89d65f2c94ced3554a85addcfff`
- `completed`：true
- checkpoints 数：54（实际采集值）
- expected unknownIds：20；plannedObserveTicks：12（= `doc.segments.observe.actualTicks`）
- verifierOk：**true**；problems 数：**0**（空数组）
- verifier 源 blob hash（git blob @ d9cd60e）：`fd930a44c47c7a612fc942e8f1d07c30a95d844d`
- verifier 源内容 SHA-256：`e54dc612602b9ea5cf1f4348dde1cfc801dfa086e21a1e59f778392e2fcfab7c`
- 退出码 0（problems 为空、文件存在）。

结论：本 reviewer 在第二执行上下文导出的 H18 完整轨迹经落盘读取后由 d9cd60e 已提交核验器判定完整，无任何 problem。

## 未完成项

无。全部计划步骤均实际执行并保存原始产物；无环境失败，无以摘要替代原始输出的步骤。

## 产物清单（output/）

环境与任务书：`worktree-head.txt`、`worktree-head-after.txt`、`status-before.txt`、`status-after.txt`、`node-version.txt`、`npm-version.txt`、`workdir.txt`、`task-brief-sha256.txt`、`task-brief-copy.md`。
各步骤：`npm-ci.*`、`production-freeze.*`、`config-freeze.*`、`defense-freeze.*`、`typecheck.*`、`jest-ivkernel.*`、`jest-key.*`、`jest-defense.*`、`verify-seal-trace.*`（每项含 .command.txt/.log/.exit-code.txt；Jest 另有 `jest-ivkernel.json`、`jest-key.json`、`jest-defense.json`）。
轨迹：`trace-ivkernel/1788780811839-137248/H18-J06.json`、`trace-key/1788780869682-101808/H18-J06.json`。
本日志：`reviewer-log.md`。
