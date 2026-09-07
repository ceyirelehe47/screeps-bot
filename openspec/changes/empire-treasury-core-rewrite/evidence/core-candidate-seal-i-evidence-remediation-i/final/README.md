# final/ —— 主运行原始产物（Evidence Remediation I，VALIDATION_HEAD d9cd60e）

命令序列与逐步说明见 commands.txt；每步 `.command.txt`（完整参数）+ `.log`（原始 stdout/stderr）+ `.exit-code.txt`。环境：node-version.txt / npm-version.txt / workdir.txt。

## 结果总览（全部 exit=0，详见各 exit-code.txt）

| 步骤 | 结果 |
| --- | --- |
| production-freeze / config-freeze / defense-freeze | 三组 `git diff --exit-code` 全零差异（分类见 ../freeze/README.md） |
| typecheck / typecheck-build / build | exit 0；bundle-sha256.txt = 91b561fd…（构建嵌入时间与 Git 身份，与上轮 b2999d8c 不同属预期——仅产物追溯，不判逻辑差异） |
| jest-key（五件 --runTestsByPath） | 5 suites / 57 tests 全过（IVKernel 17 = Seal I 54 基础 +3 敏感性） |
| jest-treasury（src/runtime/treasury/） | 32 suites / 574 tests 全过 |
| jest-defense（十一件 --runTestsByPath） | 11 suites / 118 tests 全过 |
| jest-full（全仓） | 236 suites / 1420 tests 全过（Seal I 基线 1417 + 3） |
| budget（scripts/verify-jest-budget.mjs） | `JEST_TEST_BUDGET=PASSED`（236/1420；脚本自带全仓重跑，其临时 results.json 按原脚本正常清除——完整原始日志 budget.log 与退出码保留，不改校验器功能） |
| diff-check / head-after / status-after | exit 0；HEAD 验证后未移动；工作树前后干净（status-before/after 均空） |
| verify-seal-trace | TRACE_VERIFY=PASS：四份 H18-J06.json（trace-key/treasury/full/budget 各自独立 Jest 进程子目录，互不覆盖）逐份 bytes=1180356、checkpoints=54、completed=true、problems=0；核验实现取自 `git show d9cd60e…:test/mock/treasurySealEvidence.ts`（blob fd930a4…，typescript transpile 后执行）——调用的是**已提交**核验器版本 |
| check-jest-json | JEST_JSON=PASS：四份 Jest JSON 可直接解析，failed/pending/todo/runtimeErrors 全 0 |

## 轨迹导出（trace-* 四目录）

H18-TRACE 摘录（jest-key.log）：completed=true observe=12 bounded=13/40 recovery=1/10 checkpoints=54 portEvents=96 finalClose=25 final={active:20, ring:44, chars:21879}——实际数字从事件与持久状态采集，与 Seal I 期行为数据一致（本轮轨迹化未改变行为；数字非硬编码）。四份轨迹 sha256 各异（recordedAt/时间戳不同），互不覆盖。

## 事件记录（如实）

主验证在 verify-seal-trace 首跑时因 /tmp 下 mjs 无法解析 `typescript` 模块失败（脚本 require 路径问题，**非测试/核验逻辑失败**；其前冻结核验三组、typecheck×2、build、jest×4、budget、diff-check 全部 exit=0）。修复 require 指向仓库 node_modules 后以 set -e 重跑尾段三步（verify-seal-trace / check-jest-json / head-after+status-after）全过——tail-rerun.log 含完整记录；首跑失败现场保留在 mainval-run.log。其余任何步骤未重跑。
