# Terminal Transfer Engine Lab Prep I — 本地验证主报告（P01–P06）

任务身份：Terminal Transfer Engine Lab Prep I（任务书 2026-09-08；任务书全文转存 `task/task-brief.md`，sha256 `d996ca3109488e7d7497eafd6df6dacce0dfe01c2490754951bfd9f95c2da70a`）。本报告只覆盖离线开发、测试、构建、提交与推送授权范围内的结论。

## 0. 提交链

| 提交 | 内容 |
| --- | --- |
| `a03cac5`（起点） | 上一轮交付 HEAD，本地=远端核对一致 |
| `6ac563b514119c8107a7a328f4794ac9c9ca9ad8` | 实施：P01 用例（RemediationII +3 it）、探针源码 7 文件+示例配置、构建器、probe.test.ts（11 it）、交接说明与三处索引 |
| `dde2e802007b4153508ddee2715e0e254cfba491` | 预算锚点滚动（240/1454，基线 6ac563b）＝ **VALIDATION_HEAD** |
| 归档提交（本报告与 evidence） | 仅非执行性证据，见 §6 |

## 1. P01–P06 交付表

| 索引 | 结论 | 依据 |
| --- | --- | --- |
| P01 | **通过** | 注册 `service.settleUnknownOutcome` 实际读取 `[100,60]` 与 `[60,100]` 两种排列（spy/包装器返回独立副本/反序副本，只改排序不改集合/身份/数量/时点），均 still_uncertain+phase=outcome_unknown+outcome=unknown+active 保留+submit 不增；两排列 order 串与 spyCalls=2 经主验证与第二树 reviewer 双向提取留痕；独立正常场景唯一 100H 闭环 closing 三账目 900/10000−q(=26)/F0−100；跨视图组合与同 ID 冲突/无关 60/仅部分量对照由既有 O01/O02 承担（原断言未动） |
| P02 | **通过** | 新 VALIDATION_HEAD 上全新 detached 第二树**真正独立** `npm ci`（无 junction/symlink/共享/复制安装；四项独立性核验全过）；该树 node_modules+独立 cache/output 复跑 KEY 9/91（含 probe 11/11）、DEFENSE 11/118 全 passed；安装输出/退出码/版本/lockfile hash/解析路径齐全（revalidation/） |
| P03 | **通过** | observer/single-shot 可构建源码（真实 API 薄包装、原始采样、默认无写、observer 模块链零 terminal.send）；不复制国库协议/对账器/matcher（采样无 observed_* 结论） |
| P04 | **通过** | probe.test.ts 11 it 全部加载**真实构建产物**执行：门禁矩阵零调用、合法 tick 恰一次参数+this 绑定、同 tick/后续 tick 不再调用、非 OK/throw 不重试、JSON 重载+模块重建不重发、读异常显式报告、OK 不自造效果+后续 tick fixture 差异如实报告 |
| P05 | **通过** | 构建器（仓库外含空格 cwd 可用、非空目录拒写、无网络无上传）+三份 manifest PREPARED_NOT_RUN（repo/bundle/lockfile/engine/driver 身份）；交接说明含版本前置、操作顺序、待测矩阵五行、停止清理与环境隔离边界 |
| P06 | **通过** | 三组冻结 diff 零差异；生产 bundle 前后一致（探针不进 dist/main.js）；固定 SHA 主验证 16 步 exit 0；执行代码先提交后验证；push 纪律保持（无 reset/rebase/force push/amend 已推送提交） |

## 2. 三项工作摘要

- **工作 A（P01）**：`wrapTransactionsViewForOrderProbe` 在用例内 spy/包装宿主只读交易视图（任务书 §3.1 最小做法）——未改 mock matcher 语义、未建通用乱序平台。注册路径沿协调器→contract→真许可→fake 延迟处理完成真实 100H 后注入同描述/路线/双方/资源/时窗、不同交易 ID 的 60H；两种排列都保持 unknown 与责任。实测通过，未发现顺序缺陷（未触发"最小修复"分支）。
- **工作 B（P03/P04/P05）**：`test/lab/terminal-transfer/` 七个源文件 + `scripts/build-treasury-terminal-lab.mjs` + `probe.test.ts`。single-shot 门禁 17 类前置拒绝原因逐项可测；控制记录独立键 `Memory.__labTerminalTransferProbe`（≤4KiB、缺失/损坏不自动初始化、调用前标记已尝试、完成即 stopped、无 TTL 重获）；构建器 TypeScript transpile + rollup 内联配置（不加载根配置/部署插件）。probe.test.ts 的"send 调用 1 次"全部是 stub spy。
- **工作 C（P05）**：`terminal-transfer-engine-lab-prep-i.md`（版本前置、六步操作顺序、待测矩阵、32 tick 观测窗与停止清理、环境隔离由外部流程保证）；`terminal-transfer-slice-0.md` 加索引链接并声明旧接线细节以 Remediation I/II 为准；tasks.md 与 test-migration-map §19 定位。

## 3. 主验证（§7.2 模板，VALIDATION_HEAD=dde2e80）

16 步全部 exit 0（产物见 final/）：三组冻结 diff 0（869149d 基线：src 非测试/根配置+lockfile/Defense）；typecheck×2 0；build 0 且 dist/main.js sha256 `089817cb…` 前后一致；三次探针构建（observer/single-shot/仓库外含空格 cwd）全 0 且 manifest PREPARED_NOT_RUN；五组 Jest——SLICE+LAB+KEY 9 suites/91 tests、Treasury 35/597、Defense 11/118、full 240/1454（failed/pending/todo/runtimeError 全 0，LAB 单列于 KEY 内不与 Treasury 累加）；budget `JEST_TEST_BUDGET=PASSED`（240/1454）；verify-evidence `PASS`；diff-check 0；前后状态干净、HEAD 未移动。

P01 小型日志（jest-key.log 留痕）：

```
P01-ORDER {"permutation":"100-then-60","order":"txn-0001:100,txn-inj-60:60","spyCalls":2}
P01-ORDER {"permutation":"60-then-100","order":"txn-inj-60:60,txn-0001:100","spyCalls":2}
P01-ACCOUNTS {"sourceH":{"observed":900,"committed":0,"spendable":900},"sourceEnergy":{"observed":9974,"committed":0,"spendable":9974},"targetRiskAdjustedFreeCapacity":99900}
```

适配说明：OUT 采用 Windows 原生临时路径（模板 OUT=mktemp 的等价替换——git bash /tmp 与 node Windows 路径不一致的已知坑）。异常一条：主验证脚本原件与 mainval-run.log 被脚本首行 `rm -rf $OUT` 自删（final/run-mainval.sh 为执行前落盘的同内容副本；完整性由 16 个 exit-code 全 0 + `set -euo pipefail` wrapper 退出码 0 替代哨兵证明，见 final/README.md 异常①）。

## 4. 第二干净上下文（§3.2/§7.3）

独立 reviewer subagent（先完整读取任务书全文）在 `dde2e80` 上建 detached worktree，**真正独立** `npm ci`（exit 0、896 包、12 秒；node_modules 非符号链接、typescript/rollup/jest/ts-jest 解析均落第二树、安装零 tracked 改动、lockfile sha256 两树一致 `490ee9c7…`），以该树 node_modules+独立 Jest cache/output 复跑 KEY 9/91（含 probe.test.ts 11/11，自行构建探针产物加载真实入口）与 DEFENSE 11/118 全 passed；verify-evidence（传 run 根）PASS；用后即删（worktree list 仅剩主树）。reviewer 并独立提取 P01 两行 ORDER 与 ACCOUNTS、独立重算 q=26 验证三账目——非抄主报告。结论 **P02 通过**；原文见 revalidation/REVIEWER-LOG.md。

## 5. 未证明边界（如实）

- **真实引擎 NOT_RUN**：两个产物均未上传、未在任何游戏世界运行；未启动服务器/容器；未调用真实 terminal.send/市场交易；未做 CPU 超限或 driver 故障注入。交接说明中的待测矩阵五行全部为"计划/离线覆盖"，不是实机结果。没有 engine-success 之类的伪实机文件。
- probe.test.ts 的全部"发送"都是 stub spy；它证明包装与采样正确，不证明引擎真的这样运行。
- 实验控制记录的 Memory read-back 只覆盖普通运行与保留 reset 下的防重入，不是 driver 持久化承诺、不是 exactly-once。
- 沿留待办（低危）：真实引擎实验待单独授权；M06 部分量 fee 缩量显式断言（沿前两轮）；P01 宿主记录在视图物理拼接中固定在前的形态如需原生覆盖需扩展 mock 视图配置（本轮 [60,100] 由 spy 反序副本覆盖）。

## 6. Git 与 CI

- 提交链：a03cac5 → 6ac563b（实施）→ dde2e80（预算/VALIDATION_HEAD）→ 归档提交（仅非执行性证据：task/final/revalidation + 本报告）。`git diff --check` 0；验证前后工作树干净；无 reset/rebase/force push/amend 已推送提交；未合并 main。
- push：`git push origin refactor/empire-treasury-rearchitecture` 后以 `git ls-remote` 核验远端 HEAD 与交付 HEAD 一致（见下方回填）。
- CI：仓库无 .github/workflows、无 check-runs/statuses——**无 CI 证据**（如实）。

## 7. 验收结论

- Slice 0 交接（P01/P02）：**完成**——两种排列经注册 settle 入口实读、责任保留；第二树真正独立依赖安装复跑通过。
- 探针构建与离线自测（P03/P04/P05）：**通过**——可构建双入口、假端口行为测试全绿、构建器与清单 PREPARED_NOT_RUN。
- 独立依赖复验（P02 后半）：**完成**（独立 reviewer + 独立 npm ci）。
- 真实引擎：**NOT_RUN**。
- 按任务书 §7.3 最终停止：不自动启动真实实验、不上传任一产物、不发起真实调拨。
