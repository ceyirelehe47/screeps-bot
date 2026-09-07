# Reviewer 复验日志——Terminal Transfer Slice 0 · Remediation I（第二干净上下文）

- 复验人：独立 reviewer（未参与实施），第二干净上下文定向复验
- 日期：2026-09-08（本机时钟；指令日期 2026-09-06）
- 固定提交（VALIDATION_HEAD）：`4ea56d0fa2033f3a1bde2e12f236c913970d1daf`
- 冻结基线（FREEZE_BASE）：`869149dcdd6f2068572354917bf23c52727cf9b6`
- 主仓库：`D:\code\screeps\screeps-bot`（全程只读，除临时目录外未写入主树）
- Worktree：`D:\code\screeps\slice0-r1-reviewer`（用后已删）
- 输出目录（$OUT）：`C:\Users\15027\AppData\Local\Temp\slice0-r1-review\revalidation`
- 环境：Windows / Git Bash；node v22.19.0；npm 10.9.3

## 结论速览

| 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|
| 0 环境（worktree+npm ci） | 干净树，ci exit 0 | porcelain 空；896 packages，exit=0 | PASS |
| 1 冻结三组 diff | 三组 exit 0 | 0 / 0 / 0 | PASS |
| 2 typecheck | exit 0 | exit=0，无输出 | PASS |
| 3 NM 两件 | 2/16/16 | suites=2 tests=16 passed=16 failed=0，exit=0 | PASS |
| 4 KEY 七件 | 7/73/73 | suites=7 tests=73 passed=73 failed=0，exit=0；H18-J06.json 产出 | PASS |
| 5 Defense 十一件 | 11/118/118 | suites=11 tests=118 passed=118 failed=0，exit=0 | PASS |
| 6 cwd 正例（含空格外目录） | exit 0 | exit=0，TREASURY_EVIDENCE_VERIFY=PASS (0 failures) | PASS |
| 6 cwd 空输入 | exit 1 | exit=1（两条零输入 FAIL） | PASS |
| 7 cwd 缺参 | exit 2 | exit=2（usage 提示） | PASS |
| 8 三文件哈希 | 一致 | worktree=HEAD blob=主树（三件全 match）；driver 自报 sha256 与本地一致 | PASS |
| 9 worktree 清理 | 删除成功、主树无本 reviewer 改动 | remove exit=0，目录已删；主树无 tracked 改动 | PASS（见异常 4） |

全部步骤 PASS。无期望外失败。

## 逐步骤记录

### 0. 环境准备

命令与结果：

```
mkdir -p "$OUT"
git -C /d/code/screeps/screeps-bot worktree add /d/code/screeps/slice0-r1-reviewer 4ea56d0fa2033f3a1bde2e12f236c913970d1daf
cd /d/code/screeps/slice0-r1-reviewer && git status --porcelain   # 空
npm ci > $OUT/npm-ci.log 2>&1   # added 896 packages, audited 897 in 13s；exit=0
node --version                  # v22.19.0
git rev-parse HEAD              # 4ea56d0fa2033f3a1bde2e12f236c913970d1daf → head-before.txt
```

- worktree head-before：`4ea56d0fa2033f3a1bde2e12f236c913970d1daf`（= VALIDATION_HEAD）
- npm ci：`added 896 packages, and audited 897 packages in 13s`，exit=0（npm-ci.log）
- node-version.txt：v22.19.0

### 1. 冻结三组 diff（FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6）

命令（在 worktree 内执行，输出 freeze-diff.log）：

```
git diff --exit-code 869149dcdd6f2068572354917bf23c52727cf9b6 HEAD -- src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'
  → exit=0（无差异）
git diff --exit-code <BASE> HEAD -- package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs
  → exit=0（无差异）
git diff --exit-code <BASE> HEAD -- src/runtime/defenseFocusFire.ts src/runtime/engagementFallbackRevision.ts src/runtime/defenderRampartAllocation.ts src/runtime/homeDefense.ts src/runtime/towerControl.ts src/runtime/physicalRampartOwnership.ts src/roles/homeDefender.ts
  → exit=0（无差异）
```

期望 vs 实际：三组均期望 exit 0，实际 0/0/0。PASS。

### 2. typecheck

```
npx tsc --noEmit -p tsconfig.json   # typecheck.log：仅 "exit=0"，无诊断输出
```

期望 exit 0，实际 exit=0。PASS。

### 3. NM 两件

```
TREASURY_SEAL_EVIDENCE_DIR=$OUT/trace-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  --json --outputFile=$OUT/jest-nm.json    # exit=0
```

期望 2 suites / 16 tests / 16 passed；实际 suites=2 tests=16 passed=16 failed=0 pending=0 todo=0。PASS。
（说明：NM 两件不产生 seal 轨迹——跑完此步 `$OUT/trace-key/` 尚不存在，符合预期，轨迹由步骤 4 的 KEY 五件之一写出。）

### 4. KEY 七件（NM 两件 + IVKernel/VIKernel/IVService/VKernel/VService）

```
TREASURY_SEAL_EVIDENCE_DIR=$OUT/trace-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  <NM 两件> src/runtime/treasury/treasuryRemediationIVKernel.test.ts \
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts \
  src/runtime/treasury/treasuryRemediationIVService.test.ts \
  src/runtime/treasury/treasuryRemediationVKernel.test.ts \
  src/runtime/treasury/treasuryRemediationVService.test.ts \
  --json --outputFile=$OUT/jest-key.json    # exit=0
```

期望 7 suites / 73 tests（16+57）；实际 suites=7 tests=73 passed=73 failed=0 pending=0 todo=0。PASS。
轨迹产出：`$OUT/trace-key/1788797975829-48992/H18-J06.json`（1,180,356 字节）。

### 5. Defense 十一件

清单第 11 件的定位：worktree `src/` 下无 memoryDeclarationBoundaries 文件；经主树上轮
`final/jest-defense.json` 的 testResults 确认第 11 件为 `test/memoryDeclarationBoundaries.test.ts`。

```
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/defenseFocusFire.test.ts src/runtime/defenseFocusFireStateful.test.ts \
  src/runtime/defenseFallbackReallocation.test.ts src/runtime/defenseAllActorReservation.test.ts \
  src/runtime/defenseGlobalRampartFootprints.test.ts src/runtime/defensePreallocationRampartOwnership.test.ts \
  src/runtime/defenseStationaryRampartOwnership.test.ts src/runtime/homeDefense.test.ts \
  src/runtime/towerControl.test.ts src/roles/homeDefender.test.ts \
  test/memoryDeclarationBoundaries.test.ts \
  --json --outputFile=$OUT/jest-defense.json    # exit=0
```

期望 11 suites / 118 tests；实际 suites=11 tests=118 passed=118 failed=0 pending=0 todo=0。PASS。

### 6. T1/N07 cwd 自测（关键修复项）

FOREIGN 目录：`$OUT/foreign cwd`（路径含空格，仓库之外），以脚本绝对路径运行：

正例（run-dir=$OUT 本身——根下有 trace-key/ 子目录与 jest-key/jest-defense JSON；未传 trace-key 子目录）：

```
node <WT>/scripts/verify-treasury-evidence.mjs --validation-head 4ea56d0 --run-dir "$OUT" --fixture h18
  → exit=0（verify-outside.log）
```

要点（日志实测）：`repo-root=D:\code\screeps\slice0-r1-reviewer`（由脚本路径向上定位，未依赖 cwd）；
`run-dir-resolved` 按调用者 cwd 解析；trace-roots=trace-key；H18-J06.json 核验
`bytes=1180356 completed=true checkpoints=54 problems=0`；jest-key.json 7/73/73、jest-defense.json
11/118/118 runtimeErrors=0；`TREASURY_EVIDENCE_VERIFY=PASS (0 failures)`。期望 exit=0，实际 0。PASS。

空输入（run-dir=$OUT/empty-input，已 mkdir 的空目录）：

```
node <WT>/scripts/verify-treasury-evidence.mjs --validation-head 4ea56d0 --run-dir "$OUT/empty-input" --fixture h18
  → exit=1（verify-empty.log；两条零输入 FAIL：无 trace 目录 / 无 Jest JSON）
```

期望 exit=1，实际 1。PASS。

### 7. 缺参负例（同 FOREIGN 目录）

```
node <WT>/scripts/verify-treasury-evidence.mjs
  → exit=2（verify-noargs.log；“缺少必填参数（--validation-head/--run-dir/--fixture 全部必填）”+usage）
```

期望 exit=2，实际 2。PASS。

### 8. 三文件哈希核对（hash-check.log）

| 文件 | sha256（worktree = 主树同路径） | git hash-object（worktree 文件 vs HEAD blob） |
|---|---|---|
| test/mock/treasuryTerminalTransferPrototype.ts | `4388121c0de0b0dd91d6b1a96f5e5f82853e7ace490ce3852e32c01edc57b014` | `05a6a0e4…` = `05a6a0e4…` match=YES |
| test/mock/treasuryTerminalTransferCoordinator.ts | `ecc232aca35c1a0e274671af3e8ecb815e5b4c05512579164c15858c6c90e934` | `8b7e085e…` = `8b7e085e…` match=YES |
| scripts/verify-treasury-evidence.mjs | `3b5e9464d83ec04f3ad3b86849c005f2b5c0e9e571335db95c8c79cbe5db4de7` | `8b81ebc2…` = `8b81ebc2…` match=YES |

driver 自报哈希（verify-outside.log 中 `driver=… sha256=3b5e9464…`）与本地 sha256sum 一致。
主树同路径三文件 sha256 与 worktree 完全一致。PASS。

### 9. 清理与终态

```
cd <WT> && git status --porcelain   # 空（用后仍干净）
git rev-parse HEAD                  # 4ea56d0fa2033f3a1bde2e12f236c913970d1daf → head-after.txt（= head-before）
git -C <MAIN> worktree remove <WT> --force   # exit=0；目录已不存在
git -C <MAIN> worktree list          # 主树 + slice0-remediation-baseline（预先存在，非本 reviewer 创建）
git -C <MAIN> status --porcelain     # 仅 untracked（见异常 4），无 tracked 改动
```

## 异常与处置清单（如实记录）

1. **本 reviewer 自身失误（已回退）**：`worktree add` 首次命令把完整 sha 尾部误打为 `…1faf`，
   git 报 `fatal: invalid reference`；同命令 fallback 分支以正确 sha `4ea56d0fa2033f3a1bde2e12f236c913970d1daf`
   成功创建。对结果无影响（head-before 已核对为正确 sha）。
2. **指令文件措辞与列表不一致（非失败）**：步骤 1 写“config 五件”但列出 6 个文件名
   （package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs）。
   按实际列表执行全部 6 个，exit=0。
3. **Defense 第 11 件文件定位**：指令清单中 “memoryDeclarationBoundaries” 未给路径，worktree `src/`
   下搜索无果（`find src -iname "*memory*"` 等均未命中）；经主树上轮 `final/jest-defense.json`
   testResults 确认为 `test/memoryDeclarationBoundaries.test.ts`（6 tests）。据此跑齐 11 件，数字与上轮一致。
4. **主树 untracked 变动（非本 reviewer 写入）**：复验开始时主树已有 untracked
   `…/terminal-transfer-slice-0-remediation-i/final/`；结束时 status 另现 `task/` 与
   `terminal-transfer-slice-0-remediation-i-local-validation.md`。本 reviewer 对主树仅执行读操作
   （worktree add/remove 不写主树工作区），判断为主会话并行归档所致。主树无任何 tracked 文件改动。
5. **预先存在的他人 worktree**：`D:/code/screeps/slice0-remediation-baseline`（93a6152，detached）。
   非本 reviewer 创建，未动、未删。本 reviewer 的 worktree 已删除。
6. **node -e 转义失误（过程性，已重试）**：读取主树 jest-defense.json 清单时首版 `node -e` 内
   `\\` 被 bash 吞掉导致 SyntaxError；改写转义后成功。不影响任何产物。
7. **末次组合命令 exit code 2**：来自清理步骤最后的 `ls -d <WT>`（目录已删除，ls 报 No such file，
   属预期确认行为），非 git 操作失败。

## 产物清单（$OUT）

npm-ci.log、node-version.txt、head-before.txt、head-after.txt、freeze-diff.log、typecheck.log、
jest-nm.json、jest-nm-stdout.log、jest-key.json、jest-key-stdout.log、jest-defense.json、
jest-defense-stdout.log、trace-key/1788797975829-48992/H18-J06.json、
verify-outside.log、verify-empty.log、verify-noargs.log、hash-check.log、reviewer-log.md、
foreign cwd/、empty-input/（自测脚手架目录）。
