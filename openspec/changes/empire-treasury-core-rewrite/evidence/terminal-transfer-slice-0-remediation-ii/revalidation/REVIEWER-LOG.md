# Terminal Transfer Slice 0 · Remediation II — 第二干净上下文定向复验报告

复验对象：仓库 `D:\code\screeps\screeps-bot`，固定提交 `fc5edf3bfa057cba254a0d6b4be4109b445f2d37`。全程离线、未修改主树、未 push。

## 逐步结果

| 步骤 | 命令摘要 | 退出码 | 关键数字/输出 | 结论 |
|---|---|---|---|---|
| 1a | `git rev-parse HEAD` | 0 | `fc5edf3bfa057cba254a0d6b4be4109b445f2d37` | PASS |
| 1b | `git status --porcelain` | 0 | 2 项 untracked（`evidence/.../baseline/README.md`、`evidence/.../final/`），均为 evidence 归档路径 | PASS（预期内） |
| 2 | `worktree add .../slice0-r2-review/wt fc5edf3` + `mklink /J` node_modules | 0 / 0 | worktree detached 于 fc5edf3；junction 下 tsc/jest 均可见 | PASS |
| 3 | worktree 内 `npx tsc --noEmit -p tsconfig.json` | 0 | 无任何诊断输出 | PASS |
| 4 | 定向 Jest `--runInBand --runTestsByPath`（8 文件，`TREASURY_SEAL_EVIDENCE_DIR=.../trace-key`） | 0 | **8 suites / 77 tests / 77 passed / 0 failed**；其中 slice0 三件子集 3 文件 / 20 tests（8+8+4），逐文件全 PASS | PASS（见异常说明 ①） |
| 5 | Defense 十一件 `--runTestsByPath`（`trace-defense`） | 0 | **11 suites / 118 tests / 118 passed / 0 failed** | PASS |
| 6a | 仓库外含空格 cwd（`foreign cwd`）正例：`node .../verify-treasury-evidence.mjs --validation-head fc5edf3 --run-dir .../verify-input --fixture h18` | 0 | `TREASURY_EVIDENCE_VERIFY=PASS (0 failures)`；trace `H18-J06.json` bytes=1180356、sha256=`99c70f8d…`、checkpoints=54、problems=0；jest-key 8/77；driver sha256=`3b5e9464…` | PASS |
| 6b | 空输入（`--run-dir` 指向空目录） | 1 | `TREASURY_EVIDENCE_VERIFY=FAIL (2 failures)`，两条"零输入"检出信息 | PASS |
| 6c | 缺参（不传 `--run-dir`） | 2 | "缺少必填参数（--validation-head/--run-dir/--fixture 全部必填）" | PASS |
| 7 | 三文件 `git rev-parse fc5edf3:<path>` + `sha256sum`（worktree 与主树双向） | 0 | blob：prototype `1a1e1a03…`、coordinator `0fb9272a…`、verify-driver `8b81ebc2…`；sha256 主树=worktree 完全一致：prototype `21a79fb2…`、coordinator `94068c19…`、driver `3b5e9464…`（与 6a 驱动自报值及主验证 `verify-evidence.log` 第 4 行同值互证）；`final/jest-slice0.json` = 3 suites/20 tests 与复验一致 | PASS |
| 8 | `worktree remove --force` + 删 trace-key/trace-defense/verify-input/empty-input/"foreign cwd" + `worktree list` | 0 / 0 | 复验 worktree 已移除；临时目录仅留存 jest-slice-key.json、jest-defense-r2.json、verify-positive/empty/noargs.log 及主执行者的 REVIEWER-INSTRUCTIONS.md | PASS（见异常说明 ②） |

## 异常与差异说明（如实记录，均不构成失败）

① **指示数字与实际不符（指示笔误，非仓库问题）**：步骤 4 指示命令列出的第二个路径 `src/runtime/treasury/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts` 带双重 `treasury/`（该子目录不存在），已修正为 `src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts` 运行；命令实际含 8 个路径而非"9 文件"。复验得 8/77，与主验证归档三方互证完全一致：`final/jest-key.json`（8 suites/77 tests）、`final/README.md`（"jest-key | 8 suites / 77 tests（slice0 三件 + KEY 五件）"）、核验驱动 6a 输出（`suites=8 tests=77 passed=77`）。指示中"期望 9 suites / 89 tests"判定为笔误。

② **worktree list 非仅主树**：清理后仍存在 `D:/code/screeps/slice0-r2-baseline`（b938a15，detached）。经查其 `.git` 时间戳为 2026-09-08 09:30:58，早于本次复验开始（约 10:28），系主执行者 baseline 流程既有产物，非本次复验创建，故未擅自删除。复验创建的 `Temp/slice0-r2-review/wt` 已确认移除。

③ **主树 status 期间变化**：复验期间主树 untracked 由 2 项增至 4 项（新增 `evidence/.../task/` 与 `...-local-validation.md`），系主执行者归档进行中产生，符合"evidence 归档进行中"预期。

## 总体结论

**PASS**。全部核验点通过：tsc exit 0；定向 Jest 8/77（slice0 子集 3/20，与主验证一致）；Defense 11/118；核验驱动三场景退出码 0/1/2 且正例输出 `TREASURY_EVIDENCE_VERIFY=PASS`；三文件 blob hash 与 sha256 在固定提交、主树工作树、worktree 工作树、主验证归档日志之间完全一致。唯一差异为指示文本自身的两处笔误（双重 `treasury/` 路径与 "9/89" 期望数字），不影响验证结论。
