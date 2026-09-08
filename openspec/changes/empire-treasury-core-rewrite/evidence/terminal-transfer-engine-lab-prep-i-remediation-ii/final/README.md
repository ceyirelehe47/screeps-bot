# Final — Lab Prep I · Remediation II 主验证产物（§7.2）

OUT=treasury-lab-r2-LfYNW6（mkdtemp 随机名；18 个执行步骤全部 exit 0；本目录为该次运行的完整原始产物复制）。

## 内容

- `validation-head.txt` / `expected-start.txt` / `head-after.txt`：9bf6625（=VALIDATION_HEAD=运行 HEAD）；起点 87507f4。
- `node-version.txt` / `npm-version.txt`：运行环境版本。
- `status-before.txt` / `status-after.txt`：均 0 字节（验证前后工作树干净——验证期间未向仓库写入任何文件）。
- 18 步命令留痕：`<step>.command.txt` + `<step>.log` + `<step>.exit-code.txt`：
  production-freeze / config-freeze / defense-freeze / slice-implementation-freeze（四组 `git diff --exit-code` 零差异）、typecheck / typecheck-build、build、lab-observer、lab-single-shot、jest-lab / jest-key / jest-treasury / jest-defense / jest-full、budget、verify-evidence、diff-check。
- `changes-this-round.txt`：起点→VALIDATION_HEAD 的 name-status（本轮全部改动文件清单）。
- `production-bundle-before.txt` / `production-bundle-after.txt`：构建前后 dist/main.js sha256 一致（63e4be29…）。
- `lab-observer/` / `lab-single-shot/`：主验证时点构建的两入口产物 + manifest.json + example.experiment.json（single-shot 27,697 字节 / SHA-256 7730421d…；PREPARED_NOT_RUN；repoSourceCommit=9bf6625）。
- `jest-lab.json` / `jest-key.json` / `jest-treasury.json` / `jest-defense.json` / `jest-full.json`：五组 Jest 原始 JSON（1/22、9/102、35/597、11/118、240/1465，全绿）。
- `trace-key/` / `trace-treasury/` / `trace-defense/` / `trace-full/` / `trace-budget/`：TREASURY_SEAL_EVIDENCE_DIR 槽位的 trace 产物（verify-evidence h18 fixture 消费）。

## 关键数字

| 项 | 值 |
| --- | --- |
| LAB | 1 suite / 22 tests（R02-BOUNDARY、R03-B1、R03-B2 留痕行见 jest-lab.log） |
| KEY（含 Slice 0 与 LAB） | 9 / 102 |
| Treasury 定向 | 35 / 597 |
| Defense | 11 / 118 |
| 全仓 | 240 / 1465 / 1465 passed / 0 failed / 0 pending / 0 todo / 0 runtime error |
| budget | JEST_TEST_BUDGET=PASSED |
| verify-evidence | TREASURY_EVIDENCE_VERIFY=PASS（0 failures） |

集合有重叠，不累加。本目录为一次完整运行的真实输出；未发生中断重跑（无异常记录）。
