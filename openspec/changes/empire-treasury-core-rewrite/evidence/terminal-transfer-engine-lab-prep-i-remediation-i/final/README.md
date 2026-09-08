# final/——主验证原始产物（任务书 §8.2）

VALIDATION_HEAD：`c8a6d53271b269c25c2b83c3f05cecea41433dab`（budget 提交）
START_HEAD：`749d44c94bf35a12abcbdeda9e5842e9b27a9c6b`
产物目录：`C:\Users\15027\AppData\Local\Temp\treasury-lab-r1-ousvrqhr`（一次性临时目录，完整复制归档于此）
驱动脚本：`run-mainval.sh`（与 wrapper2.log 同目录副本；脚本与日志放 OUT 之外，OUT 新建后未整目录删除——落实任务书 §8.2 提示）

## 步骤与退出码（18 步全部 0）

| 步骤 | exit | 说明 |
| --- | --- | --- |
| production-freeze | 0 | FREEZE_BASE 869149dc… → VALIDATION_HEAD 对 src（排除测试）零差异 |
| config-freeze | 0 | 根 package/lockfile/rollup/tsconfig×2/jest.config 零差异 |
| defense-freeze | 0 | Defense 七文件零差异 |
| slice-implementation-freeze | 0 | test/mock 的 prototype/coordinator 对 START_HEAD 零差异（本轮不触碰 Slice 0 实现） |
| typecheck / typecheck-build | 0 / 0 | 双配置无错 |
| build | 0 | 生产构建成功 |
| lab-observer / lab-single-shot / lab-build-outside | 0 / 0 / 0 | 三次探针构建（含"foreign cwd"含空格仓库外路径）；manifest 均 PREPARED_NOT_RUN、repoSourceCommit=c8a6d53… |
| jest-lab | 0 | LAB 1 suite / 17 tests（含 Q01 基线复现与修复对照） |
| jest-key | 0 | KEY 9 suites / 97 tests（LAB+SLICE×3+Remediation V 组；97 = 91 + 本轮 6） |
| jest-treasury | 0 | 35 suites / 597 tests |
| jest-defense | 0 | 11 suites / 118 tests |
| jest-full | 0 | 240 suites / 1460 tests（failed/pending/todo/runtime error 全 0） |
| budget | 0 | verify-jest-budget PASSED（240/1460） |
| verify-evidence | 0 | TREASURY_EVIDENCE_VERIFY=PASS（0 failures；四 trace 根 H18-J06 各 54 checkpoints/problems=0） |
| diff-check | 0 | `git diff --check` 干净 |

生产 bundle 前后一致：`6287d8984a4603a8fa3c2f8311450b6ddd279910bf1abcafc1d364cc8b5dce23`（探针不进 dist/main.js）。
status-before/status-after 均 0 字节；head-after == validation-head == c8a6d53…。

新 single-shot 产物身份：24,496 字节；SHA-256 `49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca`；manifest PREPARED_NOT_RUN。

## Q01 留痕行

`p01-focus-lines.txt`：jest-lab.log 中的 `Q01-BASELINE` / `Q01-FIXED` 两行原文（七场景三时点累计 send 数）。
摘要——旧产物：S5/S6/S7 = **1/2/2**（同 tick 双发缺陷），对照 S1=0/0/0、S2/S3/S4=1/1/1；新产物：S5/S6/S7 = **0/0/0**（S5 `mark_write/assign_failed`、S6 `mark_readback/readback_not_attempted`、S7 读取阶段 `control_record_corrupt`——超限 note 记录读取即拒，如实口径），对照组行为保持。

## 本轮变更（changes-this-round.txt）

M：tasks.md、terminal-transfer-engine-lab-prep-i.md、test-migration-map.md、scripts/build-treasury-terminal-lab.mjs（banner 说明）、scripts/verify-jest-budget.mjs（锚点）、test/lab/terminal-transfer/{controlRecord,labConfig,probe.test,singleShot}、test/test-suite-budget.json。

## 异常与处理（如实记录）

**异常①（重跑原因）**：主验证第一次完整运行（OUT=treasury-lab-r1-gjjk5g8w）期间，执行者将 evidence 归档文件提前复制进仓库（task/baseline 目录），导致末尾 `test ! -s status-after.txt` 失败（status-after.txt 含未跟踪 evidence 目录一行）、wrapper exit 1。该次 16 个执行步骤本身全部 exit 0（含 verify-evidence PASS 与 full 240/1460），无任何测试或冻结失败；失败仅由流程时序污染引起。处理：归档文件移出仓库恢复干净后，完整重跑 §8.2 全部步骤（本目录即第二次运行原始产物），通过。第一次运行目录保留于临时区未入库。教训（沿 §8.2 精神）：验证期间不得向仓库写入任何文件。
