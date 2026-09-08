# final/ — Remediation II 主验证产物（VALIDATION_HEAD fc5edf3，2026-09-08）

固定提交 `fc5edf3bfa057cba254a0d6b4be4109b445f2d37`（实施 2099e56 + 预算
fc5edf3），干净工作树、离线运行。模板为任务书 §7.1 原文（run-mainval.sh，
sha256 260e1da2…；mainval-run.log 含哨兵 MAIN_VALIDATION_DONE，wrapper
exit 0）。

## 退出码与关键数字（全部 0 除非注明）

| 检查 | 结果 |
| --- | --- |
| production-freeze / config-freeze / defense-freeze | 0 / 0 / 0（相对冻结基线 869149d 零差异） |
| typecheck / typecheck-build / build | 0 / 0 / 0；bundle sha256=b251d0f7f1fbf7d7428afccac9cdfa3bfd41958ea16d68449c9dee1aa0252d1c（产物追溯用） |
| jest-slice0 | 3 suites / 20 tests（O 4 + M 8 + N 8） |
| jest-key | 8 suites / 77 tests（slice0 三件 + KEY 五件） |
| jest-treasury | 35 suites / 594 tests |
| jest-defense | 11 suites / 118 tests |
| jest-full | 239 suites / 1440 tests（failed/pending/todo 全 0） |
| budget | JEST_TEST_BUDGET=PASSED（239/1440，manifest 锚点 2099e56） |
| verify-evidence | TREASURY_EVIDENCE_VERIFY=PASS (0 failures) |
| verify-outside（仓库外含空格 cwd 正例） | 0 |
| diff-check / status-after / head-after | 0 / 空 / =fc5edf3 |
| verify-empty / verify-noargs / verify-tampered（补负例） | 1 / 2 / 1（篡改点 doc.fixture.unknownIds[0]，检出信息"fixture.unknownIds 与固定夹具约束不符"） |

负例说明：verify-empty/verify-noargs/verify-tampered 是 §7.1 模板之外的
补充记录（与上轮口径一致）；empty-input 与 tampered-input 目录为对应输入
副本，foreign cwd 为外部工作目录。

## 目录内容

- 每项检查的 `.command.txt` / `.exit-code.txt` / `.log`（`run()` 三元组）。
- 五组 Jest JSON（jest-*.json）与四组 trace（trace-key/trace-treasury/
  trace-full/trace-budget——驱动核验输入为 run 根下 `trace-key/` 加
  `jest-key.json`）。
- changes-this-round.txt（b938a15..fc5edf3 的 name-status）。
- expected-start / validation-head / head-after / status-before /
  status-after / node-version / npm-version。
