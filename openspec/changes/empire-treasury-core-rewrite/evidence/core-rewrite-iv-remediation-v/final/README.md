# Remediation V 最终验证（固定验证 HEAD 7e977660d9dd1ab74a6c8799307a7b4cc9a01a8b）

本目录全部产物对应**同一次**验证运行（validation-head == head-after，前后
工作树干净；逐命令 command/exit-code/log 齐全）：

| 命令 | 结果（exit=0） |
| --- | --- |
| typecheck（tsc --noEmit） | 通过 |
| build（rollup 本地构建） | dist/main.js sha256 `fcc5382db4e91eb90c04cb8c524d44bbae641a27315771ca53a765d4660f9832`（构建插件中间 hash 不同于最终文件 hash——以后者为准） |
| jest-treasury（src/runtime/treasury/） | 31 suites / 558 tests 全过（另 test/baseline 2 suites/11 tests 计入全仓） |
| jest-defense（冻结集合 11 文件） | 11 suites / 118 tests 全过 |
| jest-full（默认全仓收集） | **235 suites / 1404 tests 全过**；failed/pending/todo = 0 |
| budget（scripts/verify-jest-budget.mjs） | `JEST_TEST_BUDGET=PASSED`（235/1404；其自带全仓重跑结果另存 budget-own-run-results.json） |
| diff-check / status-before / status-after | 干净（无空白错误、无未提交变更） |

I13 成本实测（jest-treasury.log 内 `I13-COST` 行，真实运行输出）：

| fixture | 实测 |
| --- | --- |
| 空 endTick | 7 读 / 1 次写（仅关窗；事实一致无尾写）/ closurePersisted=true |
| 恢复 1 条 A + 清理 8 项 C | tick1：41 读 / 7 写 / 份额 7 / 释放 2；完成再 2 tick（77 读 / 14 写，逐 tick 释放 [4,2]≤4）；终态 retry_ready |
| 关窗发布失败 | 2 次写尝试 / 0 放行（关窗写 + 1 次尾写，均有界）/ closurePersisted=false（不谎报） |
| 64 活跃混合推进 | beginTick 恢复 2/清理 6 + endTick 关窗确认；53 读 / 10 写 / 份额 8 |

旧压力用例口径（§4.1 修正后的本轮事实）：`treasuryKernelStress.test.ts`
两项均在最终全仓 JSON 中**实际重跑并 passed**——"10,000 项完成工作"（107s）
与"1,000 次合法 retry 单链"（11s）；上轮报告中"未在本轮重跑"的表述与
其 final/jest-full.json 不符（该文件实含 passed 记录），特此纠正为本口径。
