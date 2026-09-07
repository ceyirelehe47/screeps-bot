# Empire Treasury — Core Candidate Seal I 本地验证报告

任务：`treasury-core-candidate-seal-I-execution.md`（内核候选版封板复验与
证据闭合，验收索引 K01–K08）。编制：2026-09-07。本文为实施者交付报告，
独立验收见文末与 tasks.md。

## 0. 结论分级（任务书 §8——不用一个 ACCEPT 代替全部层级）

| 层级 | 结论 |
| --- | --- |
| 既有两项功能修复（VI 的 R1/V1） | 沿用 VI 限定通过；本轮复验未推翻（J01/J02/J04、H18 全轨迹、全仓零回归） |
| 本轮证据补齐（K02/K03/K04） | **完整**——全程轨迹 54 检查点不截断、unknown 逐字段基线比较全 null diff、40/10 勘误为回归测试限值；逐项见 §2–§4 |
| 候选固定提交复验（K05/K07） | **通过**——固定 VALIDATION_HEAD 62d6457 实跑全量模板全绿（§5.1）；第二干净 worktree 由独立 reviewer subagent 实跑复验全过（§5.2） |
| 独立审查属性（K05） | reviewer 为**未参与实施的 subagent**、独立 worktree、独立输出目录（Agent 侧审查，不冒称外部人工审计或 CI） |
| 敏感性（K06） | 测试侧检查与生产负向变体均红、还原绿（§6） |
| 部署许可 | **本轮不授予**；真实引擎适配与第一种动作的隔离验证是后续独立任务 |

## 1. 任务身份与提交链

- 起点：远端 HEAD = 869149d（fetch 后确认未前移），工作树干净，与任务书
  冻结基线一致。
- 提交链（线性，全部未推送前先本地验证）：
  - `046e4c0` test(treasury)：Seal 证据 helper（test/mock/treasurySealEvidence.ts，521 行）+ H18 全程轨迹化与敏感性 2 用例（IVKernel 12→14）
  - `09dec15` chore(budget)：锚点滚动 236/1417（requiredBaselineCommit=046e4c0）
  - `62d6457` docs(openspec)：tasks/map/design 的 Seal I 段与 40/10 勘误
- **VALIDATION_HEAD = 62d645743ac986b9f405cdfebb055e6d171c1d9b**（全部可执行
  改动在此之前）；验证后提交仅为原始日志/数据/说明（本报告与 evidence 归档）。

## 2. 冻结与差异分类（K01）

- 全部差异（`git diff --name-status 869149d..62d6457`，7 文件）：
  `src/runtime/treasury/treasuryRemediationIVKernel.test.ts`（测试，被
  production-freeze 的 glob 豁免）、`test/mock/treasurySealEvidence.ts`
  （测试辅助，非 Jest 收集不进 build）、`scripts/verify-jest-budget.mjs`
  与 `test/test-suite-budget.json`（budget 元数据，仅常量滚动）、
  openspec 三文档（design/tasks/test-migration-map）。
- production-freeze（src 排除 test）、config-freeze（package/lock/rollup/
  tsconfig×2/jest.config）、Defense 冻结 7 生产文件：**三组全部 exit=0
  零 diff**（主树与 reviewer worktree 各跑一次，结果一致；freeze/ 目录）。
- 没有已获准的生产修复例外——本轮未发现可复现生产反例，未动生产代码。

## 3. 工作流 A：H18 全程轨迹（K02）

实现在 `test/mock/treasurySealEvidence.ts`（纯测试辅助，@mock 别名，不触
碰 tsconfig/jest 配置）与重写后的 H18 J06。**实测轨迹**（H18-TRACE 与
trace-key/H18-J06.json，1,180,356 字节机器可读）：

- **段落**：observe 12 窗（计划=实际，固定 12）、bounded **13** 窗
  （limitWindows=40，退出条件达成：remaining=1/closing=1——只剩 C0 失败
  义务）、recovery **1** 窗（limitWindows=10，宿主 restoreFailingPort 于
  tick 26，C0 经真实清理退出）、final-close（pre/post 各一，25 次
  closeWork abandoned 逐一记录）。
- **检查点 54 个**不截断：每段每窗口 reload-before + after-advance 成对，
  记录 health/四阶段数量/active/ring/remaining/份额（持久记账）/chars/
  utf8Bytes/事件计数；seq 1..54 连续。
- **原始端口事件 96 条**（tick/key/成败），成功 90、失败尝试 6（全部
  failingKey 且 tick 先于恢复时点）；每窗口检查点 tickEvents 与
  "tick 匹配且 seq≤eventsUpTo 的实际事件数"逐点相等（完整性核验
  不符=0，reviewer 独立复核一致）。计数一律实际事件求和，不从
  stats.cleaned 或 outcome 推算；closeWork 显式命令在 finalClose 数组
  单独分类，不与端口事件混淆。
- **导出**：TREASURY_SEAL_EVIDENCE_DIR 未设置时全部断言照常（本轮全仓
  默认收集即此形态）；设置时每 Jest 进程独立子目录（final/ 下四份
  trace-key/treasury/full/budget 互不覆盖）。失败路径验证过：修复前一次
  失败运行定格 completed=false + failure 原文的 incomplete 轨迹（catch 内
  fail→导出→rethrow，不在 finally 补成功终态）。

## 4. 工作流 A：unknown 风险事实基线（K03）+ 工作流 B：限值表述（K04）

- 推进前对 20 条 unknown 生成**脱离 Memory 引用的深快照**（JSON 往返，
  不存活引用、不每 tick 重建期望）。白名单 13 字段：attemptId/workKey/
  generation/parentAttemptId/phase/完整 identity（含三摘要与 durable
  facts）/完整 worstCase 逐腿/invocationBoundary/invocation/external/
  outcome/outcomeEvidence/cleanup.consumerKeys；可变诊断字段
  （admittedAtTick/updatedAtTick/lastError/cleanup.cursor/cleanup.failures/
  retryDeadlineTick）明确排除并写入 doc.comparisonScope。
- **每段每次重载后、推进后、最终 close 后**字段级比较：54 检查点全部
  riskDiff=null（与基线一致）；终态不止 active=20/ID+phase——
  terminal.riskDiff=[]（每条 unknown 的全部风险字段与基线逐字段相等，
  含每腿金额与调用边界原始事实）。全程另断言：成功 key（89 个）每个
  恰好一次不再进入端口；失败尝试全部先于宿主恢复。
- 工作流 B：40/10 写明为**固定 H18 fixture 的回归测试限值**（第 40/10
  窗口出现即失败），由 89 义务×2 份额+30 退出份额在 ≤8 份额/tick 的静态
  推算加余量导出；8 份额/tick 是上限而非最低服务量——由此勘误 VI 期
  "40 tick 上界"的一般化表述（VI 段与 test-migration-map §13 同步勘误；
  旧日志/evidence 不改写）。收尾段退出条件显式断言（remaining=1/
  closing=1），到达限值未满足即失败；失败阶段健康项不饿死（新成功 key
  严格增长）、失败项不提前消失。

## 5. 固定候选版复验（K05/K07）

### 5.1 主工作树全量模板（final/，逐步 command/exit-code/log 在档）

| 项 | 结果 |
| --- | --- |
| production-freeze / config-freeze | exit=0 / exit=0 |
| typecheck / typecheck-build | exit=0 / exit=0 |
| build（npm run build，未设 DEST） | exit=0，dist/main.js 29.3s |
| bundle sha256 | `b2999d8c2bc5ac898b1b7bcc305e4a5573a10b18424f646bbf4e7361c7017566`（与上轮 2cee7a92 不同系构建器嵌入 buildTime/Git 身份，§7.4 口径：hash 只作产物追溯，逻辑冻结以 git diff 为准） |
| jest-key（J05/J06/J01/J02/J04/H15/H16/I01–I10 所在五件） | 5 suites **54/54** |
| jest-treasury | 32 suites **571/571** |
| jest-defense（冻结 11 件） | 11 suites **118/118** |
| jest-full（默认收集） | **236 suites/1417 tests 全过**（failed/pending/todo=0） |
| budget | **PASSED 236/1417**（锚点 046e4c0；自带全仓重跑 647s 另存 budget.log，与 jest-full.json 为两次独立运行；其内部临时 results.json 已被脚本清理，摘录即 PASSED 行） |
| diff-check / head-after | exit=0 / HEAD 未移动 |

尾段事件如实记录：首次 `status-after` 检查失败——实施者在验证运行期间
向工作树归档 evidence 未跟踪文件所致（非任何测试/构建失败）；evidence
移出后尾段复检三步全过（tail-rerun.log：diff-check 0/HEAD 一致/status
为空），evidence 移回继续归档；首次 status-after.txt 原样保留。

### 5.2 第二执行上下文（revalidation/）

独立 reviewer subagent（**未参与本轮实施**）在独立干净 worktree
（detached @62d6457，原 lockfile npm ci exit=0）实跑：冻结三组零 diff、
typecheck 0、KEY 54/54（独立 jest cache 与轨迹目录）、Defense 118/118、
H18-TRACE 与主运行逐字段一致；轨迹机器核验：54 检查点分布正确、27 个
窗口检查点事件计数**不符=0**、风险覆盖 20/20 全 null diff、终态集合
一致、基线原始内容在档（非 hash）。工作树前后干净。**Agent 侧审查，
不构成外部人工审计或 CI**（任务书 §4.3 如实标注）。

## 6. 敏感性（K06，negative-controls/）

- **测试侧**（正常通过的 expect 用例，IVKernel +2）：合成完整轨迹六种
  破坏（缺中间窗口/缺终态/缺 post-close/事件缺失/风险覆盖缺 ID/
  finalClose 空）核验全红并定位；真实形状风险漂移五种（worstCase 单腿
  金额/边界 tick/identity 摘要/null→缺失/记录缺失，ID/phase/腿数不变）
  比较全红并定位 attemptId+字段路径；J06 内嵌真实轨迹删窗口与真实基线
  漂移双自检。
- **生产负向变体**（一次性 worktree @62d6457，原 patch `git apply
  --check` 干净可应用，用后即删）：
  - heap-only-gate：**3 failed/6 passed**（J01/J02 主用例+J03 坏 ring
    持久判定行为红）→ 还原 **9/9 绿**；
  - zero-advance：**9 failed/5 passed**（J06 全轨迹版+H01–H07 推进系列红；
    J05/零推进对照/敏感性仍绿，判别准确）→ 还原 **14/14 绿**。
  - 红来自行为断言，非编译失败/缺模块/零收集/expected 全拒。
- 两类在 negative-controls/README.md 分开分类。

## 7. 预算与收集（K07）

- budget：manifest 与脚本常量同步滚动至 **236/1417**（IVKernel 12→14），
  锚点 046e4c0；budget 脚本全仓重跑 PASSED。默认收集不缩水（jest-full
  236 suites 即默认收集结果）；无 skip/todo/only。
- 三处 SHA 对应：冻结基线 869149d（起点 fetch 核验远端一致）→ 验证
  HEAD 62d6457（jest-*.json/log 全在其上产生）→ 预算锚点 046e4c0（测试
  文件集所在提交，merge-base 祖先关系成立）。bundle hash 见 §5.1（另加
  final/sha256.txt 产物清单 54 条）。

## 8. 尚未证明事项与停止条件（K08）

- 支持模型不变：受控同步效果测试世界、选定持久状态保留后的运行时重建。
  真实 driver 非原子窗口、任意旧备份回滚、整份 Memory 丢失、实际 Screeps
  CPU 保证均不由本轮证明；不声称数据库式 exactly-once。
- 40/10 是回归测试限值；13/1 是本次运行实测窗口数，不是任何负载的完成
  保证。Node 时间只是测试运行信息。
- 沿 VI 待办（低危）：VKernel I02 冗余写法清理、evidence 树 .ts.txt 归档
  策略统一。
- **部署仍禁止**：未部署、未执行 npm run push/local、未合并 main、未调用
  任何真实经济 writer、未接触玩家 Memory/凭证；Defense 生产行为冻结
  （7 文件零 diff）。内核候选版不因本轮封板复验获得部署许可；真实引擎
  适配与第一种动作的隔离验证是后续独立任务。
