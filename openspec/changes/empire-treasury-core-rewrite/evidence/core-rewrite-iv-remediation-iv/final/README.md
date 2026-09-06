# Remediation IV 最终验证（固定 HEAD 8d77d7d8de8feb8d2558cbb2161ed2678742de2c）

一次固定验证 HEAD 的完整记录（validation-head.txt == head-after.txt；status-before/after 均空——工作树干净）：

| 项 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| typecheck | npx tsc --noEmit -p tsconfig.json | 0 | 无错误 |
| build | npm run build | 0 | dist/main.js sha256 `f1543c228eaa4e70aa78195b44b9458e3a0276f9d517691909377d683cb4d516` |
| jest-treasury | npx jest src/runtime/treasury/ --runInBand --json | 0 | 29 suites / 539 tests 全过 |
| jest-defense | npx jest --runTestsByPath（11 个冻结文件）--json | 0 | 11 suites / 118 tests 全过 |
| jest-full | npx jest --runInBand --json | 0 | 233 suites / 1385 tests 全过（含 test/baseline/ 2 suites/11 tests） |
| budget | node scripts/verify-jest-budget.mjs | 0 | `JEST_TEST_BUDGET=PASSED`（233/1385；锚点 0f955cf） |
| diff-check | git diff --check | 0 | 干净 |

- 环境：node v22.19.0（node-version.txt / npm-version.txt）。
- `budget.log` 是脚本**自行重跑全仓**的追加验证（区别于 jest-full 的独立
  全量运行）——两者各自完整、结论一致。
- 三份 jest JSON（jest-treasury/jest-defense/jest-full）为原始输出；
  `*.command.txt`/`*.exit-code.txt` 逐项存档。
- 基线与负向变体的预期非零退出码单独保存在 `../baseline/` 与
  `../negative-variants/`（本目录只含最终验证——全部成功）。
