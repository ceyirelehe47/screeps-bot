# Core Rewrite II — 本地验证记录

日期：2026-09-05。起始远端 HEAD `35ed7f892d56f557674c5855c5629a31e996d9b7`（Core Rewrite I 终态）；代码/测试验证 HEAD 与最终分支 HEAD 见 §7（evidence 锚定代码验证 HEAD，避免引用自身最终 commit 的循环）。所有命令在本地 Windows/Git Bash 执行，未部署、未接触真实经济 writer 或玩家数据。

## 1. 审查问题 → 改动 → 测试 → 结果

| 问题 | 改动（文件） | 测试 | 基线 → 修复后 |
| --- | --- | --- | --- |
| R01 真许可可变 | kernel/identity.ts：签发快照深冻结（canonicalArgs/postings 独立冻结副本 + WeakSet + isFrozen 双校验）；kernel/kernel.ts：执行前 treasuryCorePermitRecordConflicts 完整身份重验；permit.postings 承载 overlay 结算（不再从公开字段派生） | B01/B02/B03（Rewrite2Acceptance + Lifecycle） | 26 红 → 42+17 绿 |
| R02 健康读回冒充成功 | kernel/store.ts：writeTreasuryCoreMemory 重写为发布确认（基线漂移检查 + 读回与草稿 treasuryCoreStateEquals 深度精确比较 + 安全校验；失败回滚） | B04/B05/B06 | 红 → 绿 |
| R03 授权账目分裂 | authorizationFacts.ts（新）：统一判定（观察+applied+任务承诺+生产预留+policy+占用流出/流入）；facade：删 tentative、rearm 同严格、authorize options.owner exact 排除；occupancy.ts：closing 不占（execution_semantics）/reconcile 来源保守占用 + inflow 投影；worstCase 双向腿 | B07–B11、A16 扩展、Stress 接收竞争 | 红 → 绿 |
| R04 pending 无出口 | kernel/commands.ts：cancel_pending 命令（正面确认未开始；pending_cancellation 证据；无 rearm 权利）；kernel：beginTick sweep（admittedAtTick < nowTick 轮转取消）；facade.cancelPendingWork | B12/B13（Lifecycle）；基线证明 scripts/baseline-red | 基线脚本 PASS（=缺陷）→ 修复后翻转 FAIL（=治愈） |
| R05 缺端口默认成功 | kernel：admit 拒绝非空义务（release_port_unavailable）；清理端口缺失→保留；抛错→保留不崩；确认写失败→同 (key, attemptId) 幂等重试 | B14/B15 | 红 → 绿 |
| R06 查询泄漏权威 | facade.kernelJournal：health → TreasuryCorePublicHealth（无 memory）；ring 逐条深快照；kernel.metrics counters clone | B22、A21 扩展 | 红 → 绿 |
| R07 未受控结算 | types/store/commands/kernel/facade：external_settlement_receipt 删除；settle 收口 reconcileOutcome 端口（跨 reset 匹配 = kind+version+stable semanticIdentity） | B23/B24、B25 reconciler 断点 | 红 → 绿 |
| R08 清理不公平 | kernel beginTick：cleanupCursor/sweepCursor 持久游标轮转 + per-tick 预算（recovery.budgetTick/budgetUsed 持久记账，同 tick 多入口共享）；端口调用计预算 | B16/B17、Stress sweep 流 | 红 → 绿 |
| R09 无完整体积上限 | types：CONSUMER_KEYS_MAX=8、TOTAL_CHAR_BUDGET=360,000、计数器饱和；store：未知字段拒绝（顶层/嵌套）；kernel.admit 预算预检 | B18/B19、A20 | 红 → 绿 |
| R10 历史环阻断核心 | store：validateSafetyCore 与 validateRingLayer 分离（ringDegraded 诊断）；runCommand 写入前重建 ring 层；A06 语义按 §6.5 修正 | B20/B21、A06/A18 修正 | 红 → 绿 |
| R11 验收覆盖不等价 | A03 补真许可篡改；A16 补多笔合计；A21 补全返回值遍历；A22 改真实 unknown 跨 reset（完整 reset 由 B25 harness） | Acceptance 内对应用例 | — |

## 2. 红灯证据（基线 35ed7f8）

- `core-rewrite-ii/baseline-red-final.log`：B 矩阵先行版 42 用例，**26 failed / 16 passed**（通过项为对照：嵌套 args 修改被 canonical 隔离、身份字段/克隆伪造、容量对照、B15 false/幂等、B21/B24/B28 回归组）。
- `core-rewrite-ii/baseline-r04-pending-no-exit.log`：R04 基线证明脚本在干净 worktree（35ed7f8 + node_modules junction）运行 **PASS**（= pending 无出口缺陷存在的正面证据）；`fixed-r04-flip.log`：同一脚本在修复后 **FAIL**（同 workKey 再接纳 admitted——sweep 已释放槽位）。
- `core-rewrite-ii/negative-variant-{1,2,3}.log`：B27 负向变体（临时源码修改后运行、随后还原；最终提交不含变体）——弱许可校验→克隆真许可用例 FAIL；忽略 unknown 接收占用→B07 两用例 FAIL；抛错当释放成功→B15 一用例 FAIL。
- 运行命令：`npx jest --config jest.config.cjs --runInBand <路径>`（R04 脚本另加 `--runTestsByPath --testMatch "**/*.baseline.ts"`，文件名不含 .test. 不入默认收集）。

## 3. 完整 reset harness（test/mock/treasuryResetHarness.ts）

五动作：整个 Memory JSON 快照 → JSON.parse 安装为新全局 Memory → jest.resetModules + 重新 require（facade/actionContracts/policyAuthority 新实例，WeakSet/registry/generation 全部归零）→ 重装受控 adapter/policy + 新 facade + 真实 beginTick → 旧 permit/capability 由宿主持有作为攻击输入（新 runtime 拒绝；宿主执行轨迹跨 reset 持续记录）。B25 覆盖断点：pending（未 dispatch）、已进入未写回（dispatching）、释放成功确认未写回、旧 rearm 回放、reconciler 跨 reset（同语义推进/语义变化拒绝）。

## 4. 压力与小模型（treasuryKernelStress 8 tests）

- 10,000 完成生命周期（副作用恰 10,000，终态 <32KB）/ 1,000 代 retry 链 / 固定 unknown 混合 5,000 / 满载最坏体积（I 轮保留，II 重跑通过）。
- II 扩展：接收竞争序列（容量 50,000、每笔 800 → **恰 62 笔获准/138 拒绝**的确定性上界，unknown 流入全额占接收容量不随 TTL 释放）；pending sweep 取消流（10×50 项跨 tick 全取消、真实调用 0、槽位回收、ring ≤128）；公平性（B16：前 8 永久失败、第 9 条 ≤12 tick 完成、前 8 duty 不被删除）。
- 2 槽/2 资源独立参考模型（30 轮随机事件序列判定一致，I 轮保留）。随机路径未声称穷尽证明。

## 5. 最坏体积精确推导（字符数 = JSON.stringify 长度）

最坏单记录 4,776（16 腿×110 + identity 含 512 payload + 8 consumerKeys×132 + 其余字段最大值）+ ring 条目 262 + 根骨架 550（含 recovery）→ 64 active + 128 ring 满载 **339,813**；`TREASURY_CORE_TOTAL_CHAR_BUDGET = 360_000`（≈6% 余量；B19 断言满载实测 ≤ 预算）。推导脚本见 evidence（calc-worst-case 输出）。canonical args 上限沿用 canonical encoding（深度 16/文本 4,096/数组 256/键 64）——heap 许可不含无界 CPU 入口。

## 6. 每 tick 操作上界（如实记录，不宣称 O(1)）

beginTick：dispatching 恢复 ≤8 命令写；pending sweep ≤8；retry 期限 ≤8；closing 清理 ≤8 端口调用 + ≤8 状态写（共享同一预算 8）；lifecycle/recovery 终态写 1 次。对固定 64 active 的扫描是 O(active) 排序遍历（每阶段一次），不是全部逻辑 O(1)。外部端口调用每 tick 全局 ≤8（持久记账跨多次 beginTick/多 facade 共享——B17 实测 8）。

## 7. 验证结果汇总

- typecheck `npx tsc --noEmit -p tsconfig.json`：0 错误。
- build `npm run build`：成功；`dist/main.js` sha256 `72dcb7ff91a671bd3e2a938aa4baf1511cf5b263b5bea4c2c4d2e0d86085f50a`。
- Treasury 定向 16 suites / **327 tests** 全绿（含 II 新增 59：Rewrite2Acceptance 42 + Rewrite2Lifecycle 17）。
- Defense 冻结 11 文件 / 118 tests 全绿；7 个 Defense 生产文件与 35ed7f8 diff 为空。
- 全仓/预算：见 §8 最终 JSON（jest-full.json + verify-jest-budget 输出，验证 HEAD 固定后追加）。
- 无独立 CI——本地验证（Jest + tsc + rollup）。

## 8. 剩余限制（如实）

- 真实经济 writer 保持禁用（生产 adapter 注册表为空）；本模型不能证明真实 driver 的 Memory/副作用原子提交——模拟通过不表述为线上 exactly-once。
- 释放端口/对账端口的生产装配未接线（测试经受控注入验证）。
- "效果保留而最新 Memory 回退"窗口列为运行时模型限制（B25 只覆盖 harness 可模拟的断点）。

## 9. 最终验证（验证 HEAD = ad50c03e3bb459179c2c5dd6cb4dbd4526428ae6）

- 全仓 `npx jest --config jest.config.cjs --runInBand`：**218 suites / 1163 tests 全绿**（原始 JSON：evidence/core-rewrite-ii/jest-full-final.json）。
- build：成功；`dist/main.js` sha256 `68c7caf49abc986c3fec85a847df8f5b7e2a447d0caf88799a4dbaea9742e463`。
- budget：`node scripts/verify-jest-budget.mjs` → `JEST_TEST_BUDGET=PASSED`（suites 218 / tests 1163；requiredBaselineCommit=ad50c03）。
- 验证后变更分类（ad50c03 → 最终 HEAD）：仅 docs（openspec 四文档）/ evidence（本文件 + core-rewrite-ii/ 原始记录）/ budget（test-suite-budget.json + verify 脚本锚点常量）——无源码/测试/类型/构建配置变更。
