# Core Rewrite III — 本地验证记录（Agent 本地，非 CI）

日期：2026-09-05。性质：Agent 本地验证记录；无独立 CI（报告按"Agent 本地验证"口径，不写成 CI 通过）。

## 1. 起点

- 起始远端 HEAD：`383ffc168d338ad93348f1de671f1095035e57c5`（工作树干净，`git fetch` 后 origin 一致）。
- II 轮声明的最终代码/测试验证 HEAD `ad50c03`；II 轮 `validation-head.txt` 指向中间 `6daf3bc`、`bundle-sha256.txt` 与最终说明 hash 不一致——**保留为历史原始证据，不覆盖**；III 轮以本轮完整最终验证建立新证据链（本文件 + `final/`）。

## 2. 问题 → 实现 → 测试 → 证据

| 编号 | 问题（383ffc1 静态定位） | 实现位置 | 行为测试 | 原始证据 |
| --- | --- | --- | --- | --- |
| R1 | policy 用原始房间余额、逐腿共用政策余量 | authorizationFacts.ts（scope 合计累计口径：观察−占用−承诺−预留−保留 vs 候选 scope 合计流出） | C01×3（pending/unknown/committed 未覆盖三态 + B20/A 取消对照） | baseline/baseline-run-verbose.log（13 红首项） |
| R2 | kernel 容量端口匿名上下文二次裁决 | kernel ports（checkAdmissionCapacity 携带 TreasuryCoreAdmissionContext）+ facade 端口闭包同一判定；facade 预判删除（合并重复检查） | C03×4（own-reservation 贯穿/复验/伪造 owner/policy 真实上下文） | baseline（R2 红灯） |
| R3 | executeAuthorizedDispatch 无当前事实复验 | facade.executeAuthorizedDispatch 执行门禁（共享窗口/统一复验排除本笔/fresh 观察/结构 incarnation；blocked 状态） | C05×4、C06×2 | baseline（R3 红灯） |
| R4 | 发布确认与写入载荷自身比较（Object.is 同引用恒真） | store.ts writeTreasuryCoreMemory（独立预期快照 expected + 条件回滚含丢写缺失情形；initializeTreasuryCoreStore 同契约） | C08、C09×5、C10 | baseline（R4 红灯）+ negative-variants/variant-B（1 红后还原） |
| R5 | committed 效果仅由实例本地 overlay 表达（多实例/reset 责任空窗） | occupancy.ts（closing committed 观察覆盖前占用；世界序 epoch.worldSequence vs invocation.worldSequence 优先、tick 兜底）+ observation.ts 世界序 + adapter 真实写世界 | C12、C13×2、C14×2、C15×4、C23 | baseline（R5 红灯） |
| R6 | 清理端口调用后才计预算（重入各花一份） | kernel.ts（prepayReleaseBudget 持久预扣：预扣失败零调用、份额不退回；applyBudgetedCommand 记账单调 max） | C16×2、C17×2、C11 | baseline（R6 红灯）+ variant-C（3 红后还原） |
| R7 | ring 只在 health 标签 degraded，查询/预算命令仍直接使用 | kernel metrics/applyBudgetedCommand（写前重建）、facade kernelJournal（degraded 空历史视图，不复制坏值）、testHarness | C19×6（null/非数组/数值/对象/坏元素/坏游标+重叠） | baseline（R7 红灯） |
| R8 | 字段名检查 ≠ 值校验（类型/长度/嵌套夹带可穿过） | store.ts validateWorkRecord/validateSafetyCore（完整值校验 + durableFacts 白名单 + 受控字符集 + budgetUsed≤8）+ types.ts 上限收紧 + 逐槽上界推导 | C21×8、C20×2、C22×3 | baseline（R8×3 红灯） |
| R9 | 原始证据 HEAD/hash 未统一、关键组合未覆盖 | 本轮统一证据链（baseline/final 同源；B05/B03/B17/B20 缺口由 C08/C12/C16/C19 补齐） | 治愈复验 17/17 | negative-variants/baseline-healed-* |

## 3. 红灯基线（baseline/）

- 基线 SHA：`383ffc1`（独立 worktree，`git worktree add` + node_modules junction）。
- 脚本：`scripts/baseline-red/treasury3-boundaries.baseline.ts`（17 用例：13 缺陷反例 + 4 合法对照；文件名不含 `.test.` 不进默认收集，`--runTestsByPath` 显式运行）。
- 结果：**13 failed / 4 passed，退出码 1**（13 个缺陷反例全部红灯；4 个合法对照实际通过，如实记录——`baseline-run-verbose.log`）。
- 治愈复验（negative-variants/）：同一反例（fixture schema v3 + R2 用 `synthesis:` 已注册命名空间修正——基线版未注册字符串使排除语义不可达，已在治愈版注明）在修复后代码 **17/17 全绿，退出码 0**。

## 4. 负向变体（negative-variants/）

| 变体 | 修改 | 预期红灯 | 还原后 |
| --- | --- | --- | --- |
| A 去累计 policy 扣减 | authorizationFacts 退回仅观察口径 + 候选取单腿最大 | C01 ×3 红 | 58/58 绿 |
| B 载荷作发布目标 | writeTreasuryCoreMemory expected=draft（独立快照删除） | C08 ×1 红 | 58/58 绿 |
| C 调用后计预算 | prepayReleaseBudget 不持久发布 | C16 ×3 红 | 58/58 绿 |

变体 patch 未保留到生产源码（cp 备份还原 + 全量复跑确认）。

## 5. 最终验证（final/，验证 HEAD = eb4f007）

命令、退出码、日志与 JSON 逐项入库（`*.command.txt` / `*.exit-code.txt` / `*.log` / `jest-*.json`）：

| 项 | 结果 |
| --- | --- |
| typecheck（tsc --noEmit） | rc=0 |
| build（npm run build，本地 bundle，无部署） | rc=0；dist/main.js sha256 `8b7fe1bf0cc91db96bb18b15bb016a0040c92e14ee1ad51161d4a96192b7d2c8` |
| Treasury 定向（src/runtime/treasury/） | 393/393（rc=0） |
| Defense 冻结回归（11 文件）+ memoryDeclarationBoundaries | 118/118（rc=0；生产 Defense 文件零改动） |
| 全仓 | 220 suites / 1228 tests 全通过（rc=0；无 skip/todo/pending） |
| git diff --check | rc=0 |
| 预算校验（scripts/verify-jest-budget.mjs） | `JEST_TEST_BUDGET=PASSED` 220/1228（锚点 `193ec62`；budget 提交 eb4f007 后复跑见 budget.log） |
| 环境 | node v22.19.0 / npm 10.9.3 |

第一轮验证在 `6f51feb` 上通过后，因 runtime.d.ts 类型补充（invocation.worldSequence 声明 + protected 指纹）按任务书 §12 重新固定 HEAD 并完整重跑本轮——全部再次通过。验证 HEAD `eb4f007` 与 `head-after.txt` 一致；此后仅提交非执行证据/文档/budget 元数据。

## 6. 关键实测数字

- 端口预算：两条 closing × 8 消费者 + 端口单次重入 beginTick → 实际释放调用总计 **≤8**（实测恰 8）且记录健康（C16）；同 tick 重复入口/第二 kernel 实例不再调用（C16 第二例）。
- 公平界：前 8 条 closing 永久失败 + 第 9 条可完成 → 第 9 条在 **<12 tick**（实测 2）完成；持续 pending 取消流量下 closing 清理同 tick 即退出（C18）。
- 空间预算：64×单槽完整生命周期上界 + 128×单历史槽上界 + 根元信息 ≤ 360,000（推导函数断言 + 真实接纳满 64 + 手动演化最坏 unknown/closing/含转义 lastError 实测 JSON 字符数 ≤ 预算，UTF-8 bytes 另行计量；C22）。
- 观察接管：A committed 200 → 同 tick 第二实例 800 拒/200 准；fresh 观察（世界序已过效果锚点）800 全额可用（不双扣）；下一 tick 观察重建同样单次表达（C12/C14）。
- 满载收尾余量：满 active + 满 ring 最坏形态下已接纳工作仍有写回余量、新增拒绝（C22 第二例）。

## 7. 未完成 / 明确不支持（与 design §4 一致）

- 真实经济 writer 接入（生产 adapter 注册表为空；external_settlement_receipt 自报通道仍不存在）。
- 真实 Screeps driver 的"效果保留而 Memory 回退"非原子窗口（跨 tick 重发不能排除——部署阻断是结论）。
- 世界序混合模型（同步 bump 与 tick 后生效混用）不支持（design §4.5）。
- 旧 Memory 在线迁移器（不建）。
- 本轮全部验证为 Agent 本地（无独立 CI）；未部署到 Screeps。

## 8. 与 II 轮证据的关系

II 轮 `core-rewrite-ii-local-validation.md` 及 `core-rewrite-ii/` 原始文件全部保留为历史（其中 validation-head 指向中间提交、bundle hash 与最终说明不一致——III 轮未覆盖、未篡改）。III 轮基线即 II 轮远端终态 `383ffc1`。
