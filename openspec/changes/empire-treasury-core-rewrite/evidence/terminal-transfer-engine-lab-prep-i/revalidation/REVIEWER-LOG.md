# REVIEWER-LOG — 第二干净代码树复验（2026-09-08）

执行者：独立 reviewer subagent（general-purpose；非主执行者上下文）。
前置：被要求并确认完整读取任务书全文（task/task-brief.md，323 行，sha256 `d996ca3109488e7d7497eafd6df6dacce0dfe01c2490754951bfd9f95c2da70a`）后按 §3.2/§7.3 执行。

## 报告全文（原文照录）

## 1. 任务书全文已读确认
**是**。已完整读取 `D:\code\screeps\screeps-bot\openspec\changes\empire-treasury-core-rewrite\evidence\terminal-transfer-engine-lab-prep-i\task\task-brief.md`（323 行全文），并按其 §3.2（独立安装）与 §7.3（第二树与归档）执行，未只抄主报告结论。

## 2. 安装（真正独立 npm ci）
- 第二树：`git worktree add --detach D:/code/screeps/labprep1-tree2 dde2e802007b4153508ddee2715e0e254cfba491`，HEAD 确认为 `dde2e802007b4153508ddee2715e0e254cfba491`（与主树 HEAD 相同）。
- 环境：node v22.19.0 / npm 10.9.3（versions.txt）。
- `npm ci --no-audit --no-fund`：**退出码 0，耗时 12 秒，added 896 packages in 11s**（npm-ci.log 仅含 deprecation warning，无错误）。
- 未使用任何 junction/symlink/目录映射/共享 node_modules；仅依赖 npm 自身下载缓存。

四项独立性核验（逐项原文）：
- a. `node_modules isSymbolicLink=false`
- b. `typescript D:\code\screeps\labprep1-tree2\node_modules\typescript\package.json`、`rollup ...labprep1-tree2\node_modules\rollup\package.json`、`jest ...labprep1-tree2\node_modules\jest\package.json`、`ts-jest ...labprep1-tree2\node_modules\ts-jest\package.json` —— 四个关键依赖全部落在第二树。
- c. `git status --porcelain` 输出 0 字节（安装未修改任何 tracked 文件）。
- d. 两树 lockfile sha256 均为 `490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a`，`match=true`。

## 3. KEY / DEFENSE 复跑结果（解析 JSON，第二树 node_modules + 独立 `.jest-cache`）
| 集合 | suites | tests | passed | failed | pending | runtimeError | exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| KEY 9 件（--runTestsByPath，TREASURY_SEAL_EVIDENCE_DIR=OUT2/trace-key） | 9 | 91 | 91 | 0 | 0 | 0 | 0 |
| DEFENSE 11 件（--runTestsByPath） | 11 | 118 | 118 | 0 | 0 | 0 | 0 |

与期望值 9/91、11/118 完全一致。逐套件均为 passed（明细见 OUT2/jest-key-summary.txt、jest-defense-summary.txt）。

## 4. P01 独立核对（在第二树单独运行 `treasuryTerminalTransferSlice0RemediationII.test.ts`，控制台 p01-verify.log）
我从控制台亲自提取到的三行原文（逐字）：

```
P01-ORDER {"permutation":"100-then-60","order":"txn-0001:100,txn-inj-60:60","spyCalls":2}
P01-ORDER {"permutation":"60-then-100","order":"txn-inj-60:60,txn-0001:100","spyCalls":2}
P01-ACCOUNTS {"sourceH":{"observed":900,"committed":0,"spendable":900},"sourceEnergy":{"observed":9974,"committed":0,"spendable":9974},"targetRiskAdjustedFreeCapacity":99900}
```

该文件 7 个 it 全 passed（O01–O04 共 4 个 + P01 3 个），`Tests: 7 passed, 7 total`。

**独立解读**（基于亲自读取第二树源码 `src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts` 第 225–252、511–589 行）：
- 排列真实性：`wrapTransactionsViewForOrderProbe` 替换宿主 `transactionsView` 上的 `outgoingTransactions`/`incomingTransactions` 方法属性，spy 返回原视图的**独立副本**（reverse 时对整个副本反序），包含宿主真实 100H 记录（txn-0001）与注入 60H 记录（txn-inj-60）——不是仅反转注入数组。reconcile 经 `host.transactionsView` 动态读取，替换即刻生效，注册入口 `service.settleUnknownOutcome({attemptId})` 实际读到两种排列：`txn-0001:100,txn-inj-60:60`（真实在前）与 `txn-inj-60:60,txn-0001:100`（反序），两种排列均断言 `still_uncertain`、active 保留、phase=`outcome_unknown`、outcome=`unknown`、submits 不增加。**两种排列真实覆盖。**
- spy 计数：`spyCalls=2` = outgoing 视图读 1 次 + incoming 视图读 1 次（`expect(spyCalls).toBe(2)` 为硬断言），且 outgoing 与 incoming 的 `orders[0]` 都被断言等于同一顺序串——跨视图组合保持。
- 账目独立验证：P01-ACCOUNTS 来自独立正常场景（唯一 100H committed→closing→cleanup）。q=26 我已从夹具公式独立重算验证：`slice0TerminalEnergyCost(100, 9)=ceil(100×(1−e^(−9/30)))=26`（W1N57→W10N57 range=9），故 sourceEnergy spendable 9974=10000−26；sourceH spendable 900=1000−100；targetRiskAdjustedFreeCapacity 99900=100000−100。三笔账目全部自洽。

## 5. probe.test.ts 在第二树的通过数
KEY JSON 中 `test/lab/terminal-transfer/probe.test.ts`：**status=passed，11/11 tests passed**。其堆栈显示探针自行构建到独立临时目录（`C:/Users/15027/AppData/Local/Temp/labprep1-probe-TPilhm/single-shot/single-shot.js`）并加载真实 bundle 入口（即调用了第二树的 `scripts/build-treasury-terminal-lab.mjs`），11 条明细覆盖构建/加载零副作用/observer 零发送/single-shot 门禁与不重试/受控 reset/读取异常报告等 §4.4 全部最低覆盖项。

## 6. verify-evidence 结果
第二树运行 `node scripts/verify-treasury-evidence.mjs --validation-head dde2e80...491 --run-dir C:/Users/15027/AppData/Local/Temp/labprep1-tree2-out --fixture h18`：**退出码 0，`TREASURY_EVIDENCE_VERIFY=PASS (0 failures)`**。其中 trace-key/H18-J06.json 1180356 字节、54 checkpoints、0 problems；jest-key 9/91/91/0；jest-defense 11/118/118/0。

## 7. 清理确认
`git worktree remove --force D:/code/screeps/labprep1-tree2` 成功；`git worktree list` 仅剩 `D:/code/screeps/screeps-bot dde2e80 [refactor/empire-treasury-rearchitecture]`；目录 D:/code/screeps/labprep1-tree2 已不存在（.jest-cache 随树删除）。主树 tracked 文件零修改（status 仅有主执行者既有的未跟踪 evidence 目录，非本次产生）。

## 8. 异常清单
无。唯一备注：npm ci 输出含常规 deprecation warning（inflight/rimraf/glob/q/eslint@5 等），属 lockfile 固定版本的正常提示，非错误。

## 9. 结论
**P02 通过。** 依据：在 VALIDATION_HEAD `dde2e802007b4153508ddee2715e0e254cfba491` 上建立了全新 detached 第二树，完成真正独立的 `npm ci`（无任何共享安装手段，四项独立性核验全过），用该树自有 node_modules 与独立 Jest cache/output 复跑本轮 KEY（9/91）与既有 Defense（11/118）全部通过，verify-evidence PASS；且我独立核对了 P01 的两种记录排列（100-then-60 / 60-then-100，均经注册 settleUnknownOutcome 入口实际读取、spy 计数 2、still_uncertain 责任保留）与三笔账目（900 / 9974=10000−26 / 99900，q=26 已独立重算）。真实引擎运行状态为 **NOT_RUN**（本轮授权范围内未执行，符合任务书边界）。

全部证据文件保存于 `C:/Users/15027/AppData/Local/Temp/labprep1-tree2-out/`（npm-ci.log、npm-ci-exit-code.txt、independence-a/b/c/d、jest-key.json/log、jest-defense.json/log、p01-verify.log、p01-lines.txt、probe-detail.txt、verify-evidence.log、trace-key/ 等，共 1.3 MB）。
