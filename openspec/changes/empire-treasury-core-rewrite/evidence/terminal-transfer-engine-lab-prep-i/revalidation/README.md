# revalidation/ — 第二干净代码树复验（P02）

执行者：独立 reviewer subagent（先完整读取任务书全文后执行；报告全文见 REVIEWER-LOG.md）。
复验 HEAD：`dde2e802007b4153508ddee2715e0e254cfba491`（= VALIDATION_HEAD = 主树 HEAD）。

## 结论

- **P02 通过**：全新 detached worktree（D:/code/screeps/labprep1-tree2）真正独立 `npm ci --no-audit --no-fund`（退出码 0、896 包、12 秒；无 junction/symlink/目录映射/共享或复制 node_modules，仅用 npm 下载缓存）；四项独立性核验全过（node_modules 非符号链接、typescript/rollup/jest/ts-jest 解析均落在第二树、安装零 tracked 改动、两树 lockfile sha256 一致 `490ee9c7…`）。
- 第二树自有 node_modules + 独立 `.jest-cache`/output 复跑：KEY 9 suites/91 tests 全 passed（含 probe.test.ts 11/11——该树自行构建探针产物并加载真实入口）；DEFENSE 11/118 全 passed。
- reviewer 独立核对 §3.1：从第二树控制台亲自提取 P01-ORDER 两行（100-then-60 / 60-then-100，order 串与 spyCalls=2）与 P01-ACCOUNTS（900 / 9974=10000−26 / 99900），并独立重算 q=26（ceil(100×(1−e^(−9/30)))，range=9）验证三账目自洽——不是抄主报告。
- verify-evidence（传 run 根）：退出码 0，`TREASURY_EVIDENCE_VERIFY=PASS`。
- 用后即删：worktree remove 成功，`git worktree list` 仅剩主树。
- 真实引擎状态：**NOT_RUN**。

## 文件说明

- `npm-ci.log` / `npm-ci-exit-code.txt` / `npm-ci-duration.txt` / `versions.txt`：安装完整输出、退出码、耗时与 Node/npm 版本。
- `independence-a-symlink.txt` / `independence-b-resolve.txt` / `independence-c-status.txt` / `independence-d-lockfile.txt`（附 `lockfile-sha256-main.txt` / `lockfile-sha256-tree2.txt`）：四项独立性核验原文。
- `worktree-add.log` / `worktree-list-after.txt`：建树与清理后状态。
- `jest-key.json` / `jest-key.log` / `jest-key-summary.txt`、`jest-defense.json` / `jest-defense.log` / `jest-defense-summary.txt`：第二树复跑原始结果。
- `p01-verify.log` / `p01-lines.txt`：P01 独立核对控制台与提取的三行留痕。
- `probe-detail.txt`：probe.test.ts 在第二树的 11 条明细。
- `verify-evidence.log`：核验驱动结果。
- `trace-key/`：该树 jest-key 产生的 H18-J06 轨迹。
- `parse-jest.js`：reviewer 的临时 JSON 解析辅助（非判定驱动；判定依据是 Jest JSON 与 verify-treasury-evidence.mjs）。

## 异常

无（npm ci 的 deprecation warning 属 lockfile 固定版本正常提示；见 REVIEWER-LOG §8）。
