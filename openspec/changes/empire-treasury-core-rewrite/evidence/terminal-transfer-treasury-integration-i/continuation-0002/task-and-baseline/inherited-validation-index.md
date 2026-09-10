# 继承验证索引（相对 9aa1c4815ef01ff42ec0d0f205f6297315dc7811）

## 起点

- 实际起点 HEAD = `9aa1c4815ef01ff42ec0d0f205f6297315dc7811`（= origin/refactor/empire-treasury-rearchitecture，工作树干净，无落后/前移）。
- 任务书预期起点一致；`git fetch origin` 后远端无新提交。

## 差异检查（决定继承范围）

命令：`git diff --name-status 838dcc79b33e6e1b76c698afa7cf88be47859091 9aa1c4815ef01ff42ec0d0f205f6297315dc7811`

结果：225 个新增 + 2 个修改，**全部位于 `openspec/` 证据与状态文档**；非 openspec 文件数 = 0。
即：自 VALIDATION_HEAD（838dcc7）至交付 HEAD（9aa1c48）无任何运行代码、依赖、构建器或测试语义变化。

## 继承的全量验证（历史结果，非本轮声明）

- SHA：`838dcc79b33e6e1b76c698afa7cf88be47859091`
- 原件：`evidence/terminal-transfer-treasury-integration-i/final-validation/jest-full.json`
  （numTotalTestSuites=246、numTotalTests=1515、passed=1515、failed=0、pending=0、todo=0、runtimeErrors=0、success=true）
- budget：`final-validation/budget.stdout.log`（PASSED）；第二树：`final-validation/second-tree/`（3 套 integration 全绿 + bundle 逐字节 IDENTICAL）
- 冻结 diff：`final-validation/frozen-diff.txt`（空）

## 本轮范围声明

按 Continuation 0002 §4.1：由于运行实现/共享代码/依赖/构建器/测试语义**均未改变**，仅实验配置、开关、fixture 配对与证据发生变化，
**不再重复全仓 Jest、Treasury 全目录压力与预算命令**；本轮最终绑定后执行定向验证（tsc×2、三套 integration Jest、LAB 四套 Jest、C02、构建、活动模块回读、第二树比较）。

## 预算锚点

`test/test-suite-budget.json` baseline/target commit = `3db077061a6c63ce559f2c5cf2c92d9b6df08382`，246 suites / 1515 tests —— 本轮不改动（不因换实验配置机械滚动锚点）。
