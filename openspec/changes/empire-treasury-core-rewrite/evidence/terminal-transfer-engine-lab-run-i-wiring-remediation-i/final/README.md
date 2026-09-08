# final——主验证（§7.2 模板）产物归档

- 运行脚本：`run-mainval.sh`（任务书 §7.2 模板逐字执行；副本归档，原件在临时目录执行）。
- 外层包装日志：`wrapper.log`（`mainval-exit=0`；末行 `OFFLINE_VALIDATION_COMPLETE` 可核验）。
- `validation-head.txt`＝`324f21a53ea128661e0555de662db7891b9b3808`（VALIDATION_HEAD；含 task/baseline 证据提交，使验证期间工作树干净）。
- `expected-start.txt`＝`457b052e1c7300a91a8b85c6337cfbf244968ce0`（任务书预期起点，核对一致）。
- `changes-this-round.txt`：恰为本轮允许修改集——`runIMain.ts`、`runI.test.ts`、`terminal-transfer-engine-lab-run-i.md`、`tasks.md`、`test-suite-budget.json`、`verify-jest-budget.mjs`、evidence task/baseline 四新增；无其他文件。

## 19 步退出码（全部 0）

production-freeze、config-freeze、existing-implementation-freeze（2 mock＋9 个 lab 既有文件＋构建器，对照起点 457b052 零差异）、typecheck、typecheck-build、build、lab-observer、lab-single-shot、lab-main、jest-lab、jest-slice、jest-key、jest-treasury、jest-defense、jest-full、budget、verify-evidence、diff-check（`*.exit-code.txt` 逐条可核）；另含 `status-before.txt`/`status-after.txt` 均 0 字节（验证期间零仓库写入）与 `head-after.txt`＝VALIDATION_HEAD 断言通过。

## 关键计数

- jest-lab 2/34（probe 22＋runI 12）、jest-slice 3/23、jest-key 10/114、jest-treasury 35/597、jest-defense 11/118、jest-full 241/1477（failed/pending/todo 全 0）。
- budget：`{"status":"JEST_TEST_BUDGET=PASSED","suites":241,"tests":1477}`。
- 产物身份：observer 9160B/SHA-256 `96721926…`、single-shot 27697B/`7730421d…`（与 Remediation II 归档逐字节一致，构建器零改动证明）；**新 main 7721B/`0a71f720f1d6f85339b21dbf8e7288cfa2e65f5949b223f5418684b673aad3ad`**（manifest `PREPARED_NOT_RUN`；按本轮实际构建身份核验，不再等于旧 7430B/`44f624cc…`——任务书 §5 明确）。
- 生产 bundle：`production-after-build.txt` 与 `production-after-lab-builds.txt` cmp 一致（三次实验构建未触碰本次生产构建产物；跨构建 hash 非确定性为既有 rollup buildTime 事实，冻结以源码 git 对比为准，见 Run I 主验证 README）。

## trace-* 目录

`TREASURY_SEAL_EVIDENCE_DIR` 各组留痕（key/treasury/defense/full/budget），随 Jest 运行产生，一并归档。
