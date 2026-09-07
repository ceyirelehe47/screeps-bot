# Reviewer 复验指令——Terminal Transfer Slice 0 · Remediation I（第二干净上下文）

目标：在固定提交 `4ea56d0`（VALIDATION_HEAD）的**独立干净 worktree + 独立 npm ci** 复跑
定向集合与 cwd 自测，产物归档回主树
`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-slice-0-remediation-i/revalidation/`。
你未参与实施——只复验，不修改任何被验提交的内容。

## 环境（Windows / Git Bash）

```bash
MAIN_REPO=/d/code/screeps/screeps-bot
WT=/d/code/screeps/slice0-r1-reviewer        # 你的干净 worktree（用后删除）
OUT=<仓库外你的输出目录>/revalidation
mkdir -p "$OUT"
git -C "$MAIN_REPO" worktree add "$WT" 4ea56d0
cd "$WT" && git status --porcelain           # 须为空；记录前后 head/status
npm ci > "$OUT/npm-ci.log" 2>&1; echo "exit=$?" >> "$OUT/npm-ci.log"
node --version > "$OUT/node-version.txt"
git rev-parse HEAD > "$OUT/head-before.txt"
```

## 步骤（每步记录命令、退出码与输出到 $OUT）

1. 冻结三组（exit 0）：
   `git diff --exit-code 869149dcdd6f2068572354917bf23c52727cf9b6 HEAD -- src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'`
   config 五件（package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs）；
   Defense 七件（src/runtime/defenseFocusFire.ts engagementFallbackRevision.ts defenderRampartAllocation.ts homeDefense.ts towerControl.ts physicalRampartOwnership.ts src/roles/homeDefender.ts）。
2. `npx tsc --noEmit -p tsconfig.json`（exit 0）。
3. NM：`TREASURY_SEAL_EVIDENCE_DIR=$OUT/trace-key npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts --json --outputFile=$OUT/jest-nm.json` → 期望 2 suites / 16 tests / 16 passed。
4. KEY（同 env 沿用 trace-key）：加 treasuryRemediationIVKernel/VIKernel/IVService/VKernel/VService 五件 --runTestsByPath --json --outputFile=$OUT/jest-key.json → 期望 7 suites / 73 tests（NM 两件 16 + 五件 57）。
5. Defense 十一件（上轮清单：defenseFocusFire(+Stateful)/FallbackReallocation/AllActorReservation/GlobalRampartFootprints/PreallocationRampartOwnership/StationaryRampartOwnership/homeDefense/towerControl/roles-homeDefender/memoryDeclarationBoundaries）--json --outputFile=$OUT/jest-defense.json → 期望 11 suites / 118 tests。
6. T1/N07 cwd 自测（**关键——本轮修复项**）：从仓库外**含空格**目录以脚本绝对路径运行：
   ```bash
   FOREIGN="$OUT/foreign cwd"; mkdir -p "$FOREIGN" "$OUT/empty-input"
   cd "$FOREIGN"
   node "$WT/scripts/verify-treasury-evidence.mjs" --validation-head 4ea56d0 --run-dir "$OUT" --fixture h18 > "$OUT/verify-outside.log" 2>&1; echo "exit=$?" >> "$OUT/verify-outside.log"
   node "$WT/scripts/verify-treasury-evidence.mjs" --validation-head 4ea56d0 --run-dir "$OUT/empty-input" --fixture h18 > "$OUT/verify-empty.log" 2>&1; echo "exit=$?" >> "$OUT/verify-empty.log"
   ```
   **注意 run-dir 布局**：驱动的 `--run-dir` 须指向这样的目录——根下有 `trace-key/`（含 H18-J06.json 轨迹）与 Jest JSON 文件名（jest-key.json 等）。步骤 3/4 的 TREASURY_SEAL_EVIDENCE_DIR=$OUT/trace-key 会把轨迹写进该子目录、jest JSON 在 $OUT 根——所以 `--run-dir "$OUT"` 正确；**不要**把 trace-key 子目录本身当 run-dir。期望：verify-outside exit=0（正常产物）；verify-empty exit=1（零输入）。若你的 trace-key 下没有 H18-J06.json（步骤 4 未产出），先确认步骤 4 成功。
7. 缺参负例：同 FOREIGN 目录下无参运行 → exit=2（记录）。
8. `sha256sum`（或 git hash-object）核对三个文件与你 worktree 中一致：test/mock/treasuryTerminalTransferPrototype.ts、test/mock/treasuryTerminalTransferCoordinator.ts、scripts/verify-treasury-evidence.mjs（把哈希记入 reviewer-log）。
9. `git status --porcelain`（用后仍须为空）→ `git rev-parse HEAD > $OUT/head-after.txt` → `git -C "$MAIN_REPO" worktree remove "$WT" --force`（或先删 junction/node_modules——**注意**：npm ci 会建真 node_modules，worktree remove --force 可删）。
10. 写 `$OUT/reviewer-log.md`：逐步骤命令、退出码、期望 vs 实际；任何异常如实记录（含你自己的失误与处置——保留 attempt 原件）。

## 产物

$OUT 下全部文件（npm-ci.log、node-version.txt、head-before/after.txt、trace-key/、
jest-*.json、verify-outside/verify-empty/缺参 log、reviewer-log.md）由主会话归档进
revalidation/。不要往主树写任何东西。

期望数字速查：NM 2/16/16；KEY 7/73/73；Defense 11/118/118；typecheck 0；冻结三组 0；
cwd 正例 0 / 空输入 1 / 缺参 2。
