# offline/mainval/——离线主验证产物（Lab Run I 接线）

在 VALIDATION_HEAD `15b027bc3f002b97219001a8766fd6d6e0e78736`
（起点 `9158c496d77f51072f0899ffa01f60487a031c58`）上按任务书 §7.1 执行的
主验证全部产物。执行脚本 `run-mainval.sh`（副本同目录），wrapper 输出
`wrapper.log`；每步含 `*.command.txt` / `*.log` / `*.exit-code.txt`。

## 结果汇总（19 步全部 exit 0）

| 组 | 结果 |
| --- | --- |
| 四组冻结对比（production/config/defense vs 869149d；slice-implementation + probe-protection vs 起点 9158c49） | 零差异 |
| typecheck（tsconfig.json / tsconfig.build.json） | 0 |
| npm run build | 0 |
| 三 lab 构建 | observer 9160B/96721926…、single-shot 27697B/7730421d…、run-i-main main.js 7430B/44f624cc…（全部 PREPARED_NOT_RUN，repoSourceCommit=15b027b） |
| jest-lab（probe+runI） | 2 suites/29 tests 全绿 |
| jest-key | 10 suites/109 tests 全绿 |
| jest-treasury | 35 suites/597 tests 全绿 |
| jest-defense | 11 suites/118 tests 全绿 |
| jest-full | 241 suites/1472 tests 全绿 |
| verify-jest-budget | PASSED 241/1472 |
| verify-evidence（--fixture h18） | 0 |
| git diff --check / status 前后 / head-after | 0 / 0 字节 / =15b027b |

## 新增断言说明

- `probe-protection-freeze`：既有 lab 包全部源文件（probe.test.ts/
  controlRecord/singleShot/sendGate/observer/labConfig/worldRead/sample）
  相对起点零差异——本轮接线只新增 runIMain.ts，不触碰既有探针。
- `production-bundle-after-build.txt` 与 `production-bundle-after-lab-builds.txt`
  相等（cmp 通过）：三次实验构建未触碰 dist/main.js（§7.1 分开存放要求）。
  **注意**：生产 bundle 跨构建不可复现——`rollup.config.js:43` 注入
  `buildTime`（`new Date().toISOString()`），连续两次 `npm run build` 产物
  sha256 必然不同（本轮实测 e4708d09→3a496af c…）。因此本轮不以"bundle
  前后一致"作冻结证据，冻结以源码 git 对比为准；该非确定性为既有事实，
  非本轮引入（本轮未改 rollup.config.js，config-freeze 零差异可证）。

## 关键文件

- `validation-head.txt` / `expected-start.txt` / `head-after.txt`
- `changes-this-round.txt`：起点→VALIDATION_HEAD 的变更文件清单
- `lab-observer/` / `lab-single-shot/` / `lab-run-i-main/`：三产物与 manifest
- `jest-*.json/.log`：五组 Jest 原始输出
- `trace-budget/` 等 trace 目录：Seal 证据目录（由 TREASURY_SEAL_EVIDENCE_DIR 生成）
