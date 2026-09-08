# 第二干净上下文定向复验指令 — Terminal Transfer Slice 0 · Remediation II

你在独立 worktree（固定提交 fc5edf3）做定向复验。**主树只读**——所有运行在你的 worktree 与你自己的临时目录内完成。逐步执行并记录每步命令、退出码与关键输出。

1. `git -C D:/code/screeps/screeps-bot rev-parse HEAD` 确认主树为 fc5edf3（只读核对，不要在主树运行任何测试或改写）。
2. 创建你的独立 worktree：`git -C D:/code/screeps/screeps-bot worktree add <你的临时目录路径> fc5edf3`；用 `cmd //c mklink //J "<worktree>\node_modules" "D:\code\screeps\screeps-bot\node_modules"` 链接依赖（不重复 npm ci；如你选择 npm ci 须先删除该 junction 并记录 896 包安装日志）。
3. 在 worktree 内运行 `npx tsc --noEmit -p tsconfig.json`，记录退出码。
4. 定向 Jest（O+M+N 三文件 + KEY 五件 + Defense 十一件）：
   ```
   npx jest --config jest.config.cjs --runInBand --runTestsByPath \
     src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
     src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
     src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts \
     src/runtime/treasury/treasuryRemediationIVKernel.test.ts \
     src/runtime/treasury/treasuryRemediationVIKernel.test.ts \
     src/runtime/treasury/treasuryRemediationIVService.test.ts \
     src/runtime/treasury/treasuryRemediationVKernel.test.ts \
     src/runtime/treasury/treasuryRemediationVService.test.ts --json --outputFile=<你的目录>/jest-slice-key.json
   ```
   期望 9 suites / 89 tests（20+69）。注意设置 `TREASURY_SEAL_EVIDENCE_DIR=<你的临时目录>/trace-key`（环境变量）。
5. Defense 十一件（同 README §Defense 列表）`--runTestsByPath` 运行，期望 11 suites / 118 tests。
6. 核验驱动（T1 回归 + 输入布局）：
   - 准备输入根 `<你的目录>/verify-input`：从主验证 OUT 目录复制 `trace-key/`（整目录）与 `jest-key.json` 两项到 `verify-input/`。OUT 目录路径：`C:/Users/15027/AppData/Local/Temp/` 下主验证 mktemp 目录（见 mainval-run.log 末尾"产物目录：…"行）。
   - **警告：run-dir 传 `verify-input` 本身**（其下含 trace-key/ 子目录与 jest-key.json）——不要传子目录。
   - 仓库外含空格 cwd 正例：`mkdir -p "<你的目录>/foreign cwd" && cd "<你的目录>/foreign cwd" && node D:/code/screeps/screeps-bot/scripts/verify-treasury-evidence.mjs --validation-head fc5edf3<完整hash自行 rev-parse> --run-dir "<你的目录>/verify-input" --fixture h18` → 期望 exit 0。
   - 空输入：`--run-dir` 指向空目录 → 期望非零（1）。
   - 缺参（不传 --run-dir）→ 期望非零（2）。
7. 三文件哈希核对：对 `test/mock/treasuryTerminalTransferPrototype.ts`、`test/mock/treasuryTerminalTransferCoordinator.ts`、`scripts/verify-treasury-evidence.mjs` 计算 `git rev-parse fc5edf3:<path>`（blob hash）与你 worktree 工作树文件的 sha256，记录并确认与主验证 final/ 归档（若已就位）一致。
8. 用后清理：`git -C D:/code/screeps/screeps-bot worktree remove --force <你的worktree>`；删除你的临时目录（保留你汇报中引用的日志副本可先复制到指定收集目录 `<你的收集目录>`——主执行者会告知，未告知则全部删除并在报告中粘贴关键输出）。
9. 全程不修改主树、不 push、不运行 npm run push/local、不联网（除本地 git 操作）。
10. 输出：逐步结果（命令/退出码/关键数字），任何异常如实记录。

期望数字汇总：tsc 0；jest 定向 9/89；Defense 11/118；驱动 cwd 正例 0/空 1/缺参 2。
