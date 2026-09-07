# Terminal Transfer Slice 0 — 第二上下文定向复验说明（reviewer 用）

## 任务身份

- 仓库：`ceyirelehe47/screeps-bot`，分支 `refactor/empire-treasury-rearchitecture`
- 复验提交（VALIDATION_HEAD）：`0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`（= 当前 origin/refactor HEAD 待 push 状态；如远端已前移，以本 SHA 的 worktree 为准）
- 任务书：`C:\Users\15027\Downloads\treasury-terminal-transfer-slice-0-implementation.md`（SHA-256 `1d1d835376fb95b5c897511070024085f971b578ab7d05efd96daf15ad6f55f5`；仓库内逐字副本 `openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0/task/task-brief.md`）
- 生产冻结基线：`869149dcdd6f2068572354917bf23c52727cf9b6`

## 你是谁、要做什么

你是**未参与本轮实施的独立 reviewer**。在 `0ce9d97` 的**独立干净 worktree**（不得在主工作树）复跑定向集合并保存原始产物。全部命令真实执行，产物写仓库外目录。**禁止**：修改主工作树/生产文件/提交任何东西到分支/运行 `npm run push`/`npm run local`/调用真实游戏 API/读取部署凭证。

## 步骤

1. **环境**：
   - `git worktree add <REVIEW_PARENT>/worktree --detach 0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`
   - 在 worktree 内 `npm ci`（按 lockfile；不得升级依赖/改 lockfile）
   - 输出根 `<REVIEW_PARENT>/output`，Jest cache 独立：`--cacheDirectory <REVIEW_PARENT>/output/jest-cache`
   - 记录 `node --version`、`npm --version`、worktree HEAD（前后各一次）、`git status --porcelain`（前后各一次，均须干净）
2. **任务书核对**：对仓库内逐字副本复算 SHA-256，须等于 `1d1d8353…5f5`。
3. **typecheck**：`npx tsc --noEmit -p tsconfig.json`（exit 0）。
4. **冻结抽查**：`git diff --exit-code 869149dcdd6f2068572354917bf23c52727cf9b6 HEAD -- src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'`（exit 0）；config 同查（package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs）。
5. **M 集合**：`npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts --json --outputFile=<OUT>/jest-slice0.json`（8/8 通过）。
6. **KEY 集合**（六件）：
   `src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts`、`treasuryRemediationIVKernel.test.ts`、`treasuryRemediationVIKernel.test.ts`、`treasuryRemediationIVService.test.ts`、`treasuryRemediationVKernel.test.ts`、`treasuryRemediationVService.test.ts`（--runTestsByPath，--json 落盘）。
7. **Defense 十一件**：`src/runtime/defenseFocusFire.test.ts`、`defenseFocusFireStateful.test.ts`、`defenseFallbackReallocation.test.ts`、`defenseAllActorReservation.test.ts`、`defenseGlobalRampartFootprints.test.ts`、`defensePreallocationRampartOwnership.test.ts`、`defenseStationaryRampartOwnership.test.ts`、`homeDefense.test.ts`、`towerControl.test.ts`、`src/roles/homeDefender.test.ts`、`test/memoryDeclarationBoundaries.test.ts`（--runTestsByPath，--json 落盘）。
8. **核验驱动**（KEY 运行时导出 TREASURY_SEAL_EVIDENCE_DIR=<OUT>/trace-key 以落盘 J06 轨迹）：
   - 正例：`node scripts/verify-treasury-evidence.mjs --validation-head 0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe --run-dir <OUT>/trace-key --fixture h18`——注意 trace-key 须同时含 jest-key.json：把步骤 6 的 --outputFile 放到 <OUT>/trace-key/jest-key.json 再跑（或复制）。exit 0。
   - 负例（零输入）：`--run-dir` 指向空目录 → 非零。
   - 负例（缺参数）：不传 `--fixture` → 非零。
9. **产物**：每步保存 `.command.txt`（完整参数）、`.log`（原始 stdout/stderr）、`.exit-code.txt`；Jest JSON 原件保留。写一份 `reviewer-log.md`（时序 + 每步结论 + 异常如实记录）。
10. **清理**：核验 worktree 前后干净后 `git worktree remove`（junction/依赖目录处理见下）。

## Windows 注意

- worktree 内 `npm ci` 生成自己的 node_modules（不要 mklink 主树）。
- `git worktree remove` 前确认无未提交变更。
- 路径含空格时引号包裹；bash 下 Windows 路径用正斜杠。

## 产出

完成后返回：每步命令+退出码汇总、M/KEY/Defense 的 suites/tests/passed 数字（从 Jest JSON 读取）、驱动正负例退出码、任务书 hash 比对结果、前后 status 是否干净、异常与处置如实列出。不改任何仓库文件。
