# final/ — 主验证原始产物（Terminal Transfer Engine Lab Prep I）

执行 HEAD（VALIDATION_HEAD）：`dde2e802007b4153508ddee2715e0e254cfba491`（预算/验证锚点；实施提交 `6ac563b514119c8107a7a328f4794ac9c9ca9ad8`）。
执行时间：2026-09-08；运行目录 `C:/Users/15027/AppData/Local/Temp/labprep1-mainval`（Windows 原生路径——模板 OUT=mktemp 的适配，见 run-mainval.sh 头注）。

## 结果汇总（16 步全部 exit 0）

| 步骤 | 结果 |
| --- | --- |
| production-freeze / config-freeze / defense-freeze | 三组 git diff --exit-code 全 0（相对 869149d；src 非测试/根配置/lockfile/Defense 零差异） |
| typecheck / typecheck-build | 0 错误（含 test/lab 探针源码与 probe.test.ts） |
| build | 生产构建 0；dist/main.js sha256 `089817cb91c0c46468c47758c76873fede5a8b1ef4a3da4215fe69424cd8833e`，前后一致（探针不进生产 bundle） |
| lab-observer / lab-single-shot / lab-build-outside | 三次探针构建 0（含从 `foreign cwd/`（仓库外含空格路径）以绝对路径执行）；三份 manifest 均 PREPARED_NOT_RUN |
| jest-key | 9 suites / 91 tests / 91 passed / 0 failed（SLICE 3 件 8+8+7 + probe 11 + Remediation 5 件 17+9+12+11+8） |
| jest-treasury | 35 suites / 597 tests 全 passed |
| jest-defense | 11 suites / 118 tests 全 passed |
| jest-full | 240 suites / 1454 tests 全 passed（failed/pending/todo/runtime error 全 0） |
| budget | `JEST_TEST_BUDGET=PASSED`（240/1454，锚点 6ac563b） |
| verify-evidence | `TREASURY_EVIDENCE_VERIFY=PASS`（H18 固定夹具、trace-key/treasury/full/budget 四目录） |
| diff-check / status-after / head-after | git diff --check 0；验证前后工作树干净；HEAD 未移动 |

## P01 小型日志（jest-key.log 内的留痕行）

```
P01-ORDER {"permutation":"100-then-60","order":"txn-0001:100,txn-inj-60:60","spyCalls":2}
P01-ORDER {"permutation":"60-then-100","order":"txn-inj-60:60,txn-0001:100","spyCalls":2}
P01-ACCOUNTS {"sourceH":{"observed":900,"committed":0,"spendable":900},"sourceEnergy":{"observed":9974,"committed":0,"spendable":9974},"targetRiskAdjustedFreeCapacity":99900}
```

（P01-ACCOUNTS 的 sourceEnergy.spendable=9974 即 10000−q、q=26；targetRiskAdjustedFreeCapacity=99900 即 F0−100。）

## 目录内容

- `*.command.txt` / `*.log` / `*.exit-code.txt`：每步命令实录、完整输出与退出码。
- `changes-this-round.txt`：START_HEAD(a03cac5)→VALIDATION_HEAD 的改动清单。
- `lab-observer/`、`lab-single-shot/`、`lab-observer-outside/`：三次构建的产物（bundle + manifest.json + example.experiment.json）。
- `trace-key/`、`trace-treasury/`、`trace-full/`、`trace-budget/`：H18-J06 轨迹（TREASURY_SEAL_EVIDENCE_DIR 四目录）。
- `jest-*.json`：四组 Jest 原始 JSON。
- `run-mainval.sh`：执行脚本副本（见下）。

## 异常记录（如实）

1. **脚本自删**：run-mainval.sh 原件与 mainval-run.log 写在 OUT 目录内、被脚本首行 `rm -rf "$OUT"` 删除（外层重定向 fd 写入已删除文件，哨兵 `MAIN_VALIDATION_DONE` 因此未落到盘上）。本目录的 `run-mainval.sh` 为执行前落盘的同一内容副本；逐步骤完整性由 16 个 `*.exit-code.txt`（全 0）+ `set -euo pipefail` 的 wrapper 退出码 0 替代哨兵证明。后续轮次应把脚本与日志放在 OUT 之外。
2. `foreign cwd/` 为空占位目录（git 不收录空目录，未归档；其内构建的产物在 `lab-observer-outside/`）。
