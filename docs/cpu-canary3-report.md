# CPU 优化 Canary3 报告：市场 hot path + 远采路由治理（2026-08-29）

## 状态定性

**PARTIAL_IMPROVEMENT（强方向，中期窗口确认中）**

- 市场合计（preflight+automation）中期下降 **-24.7 CPU/tick（40.39 → 15.70，-61.1%）**，已超过任务书"稳定下降至少 20 CPU/tick"的目标线，但正式窗口样本（n=12 采样 tick / 77 tick）尚短，需 1000+ tick 确认后才能定 OPTIMIZATION_PASSED。
- 全局 avg 中期 **106.36 → 66.08（-37.9%）**，median 98.42 → 52.10，p95 169.35 → 102.94（-39%），bucket slope 0.98 → -0.09。
- creepWork:pathing 中期 **20.96 → 4.67（-77.7%）**（远采路由治理 + 市场分频降低了整体负载）。
- creepWork:decision 中期 4.64 → 6.88（+48%，n=12 方差大，与上轮 3.23→4.62 同为波动项，需正式窗口复核）。

## 线上身份

- 部署：`6e53048`（version 2026.8.29-4），branch default，上传 sha256 验证通过。
- 市场安全边界：`market-base-resource-v3-r3` 保持，phase=direct（observe 路线），**未启用 r4，未执行 migration**，orders=0、directPending=0（无 exposure）。
- 分支：`cpu-canary-market-safe`（不含 upstream main 的 b8a50bc r4 翻转）。

## 提交清单（每项独立可回滚）

| 提交 | 内容 |
|---|---|
| 37c46a6 | 观测税移除：RoleLifecycle 命中计数批量化（32-tick buffer）、movement metrics 显式模式（off/totals/rooms，默认 totals）、非采样 tick 不建计时闭包 |
| 0007e45 | 远采路由治理：两房固定路线、同 tick 完整搜索共享（cursor 独立）、stuck 指数退避（1/2/4/8/16） |
| fa836f0 | 市场提交A：子 phase 临时诊断（默认关闭、窗口自过期） |
| 5e097e8 | 市场提交B：MarketTickSession——同 tick preflight/automation 共享一次 makeContext/reconcile（以 data 根引用为失效键） |
| 689cd82 | 市场提交C：ensureDataState 跨 tick 快速路径（根引用 + 500-tick 深审计兜底）、liveOrders 按 exposure/planning 门控 |
| 56a7ba5 | 市场提交D：protection 同 tick memo（V3 fresh read 复用外层结果）+ 低开销市场路径计数器 |
| 38a6b43 | 市场提交E：**市场规划分频（5 tick）+ exposure/config revision dirty 立即触发** |
| （锚点） | budget 188 suites / 632 tests；版本 bump 2026.8.29-4 |

## 根因（测量驱动）

线上 121-tick 诊断分解（avg CPU/tick，全部为当时每 tick planning）：

| 子 phase | avg | 说明 |
|---|---|---|
| automationEnvelope | 26.25 | runAutomation 整体（旧实现每 tick 完整 planning） |
| v3Reconcile | 7.29 | V3 状态校验（安全层，保留每 tick） |
| protectionOuter | 2.40 | 外层保护收集 |
| v3FreshProtectionRead | 0.14 | memo 后仅剩 compose（原为又一次全量收集） |
| ensureDataState | 0.022 | 跨 tick fast 生效 |
| persistentReconcile | 0.004 | session 复用生效 |
| liveOrdersSnapshot | （无条目） | 无 exposure 时完全跳过 |

**根因**：ResourceControl 的 `runtime.updatedAt` 被 每 tick 轻量任务路径推进，`planningCycleCurrent` 恒真 → v3-r3 observe 下市场每 tick 执行完整 planning（全量 protection + 定价 + 候选组合 + V3 规划 + 重复的 fresh protection read）。这是市场合计 40+ CPU 的主要来源。

## 语义安全审查

- 分频只作用于 runLive 的 planning 组合层；preflight 的 latch/reconcile/drain 与 automation 的 session 化 reconcile 照常每 tick。
- exposure（managed/pendingCreate/pendingMutations/pendingDirect/direct pending）出现时无视分频立即逐 tick 安全路径（回归测试覆盖）。
- config revision 变化立即重新 planning（锚点同步记录 revision）。
- planning tick 时 RC.updatedAt 仍为当 tick，capacityState/compose staleness 判定与旧实现一致；定价 TTL 语义不变，仅刷新节奏跟随 planning 周期。
- V3 fresh read 调用保留（TOCTOU 关闭语义不变），等价性由"同 tick 同输入引用 → 纯读取输出确定性相同"论证 + 回归测试锚定。
- 损坏状态 fail-closed 不变：structuralWriteBlocker/V3 canonical 校验在 reconcile 层每 tick；ensureDataState 深恢复作为 500-tick 兜底审计与失配恢复。

## 验证（本地，无 CI）

- `npm run typecheck`：exit 0。
- `npm test`：188 suites / 632 tests 全绿。
- `npm run test:budget`：PASSED（188/628+4）。
- `npm run build`：成功（bundle sha256 见部署日志）。
- 部署守卫：clean tree + 上传回读验证通过。

## 后续

1. 采集器持续运行（canary3.jsonl），补足 1000+ tick 后用 `node monitor-data/analyze-canary3.mjs monitor-data/canary2-post-deploy.jsonl monitor-data/canary3.jsonl 73339400` 复核并更新本报告状态。
2. 若 decision 项在正式窗口仍偏高，下一候选：preflight 层 v3Reconcile 的跨 tick 记忆化（当前 7.3 CPU/tick，安全语义需单独评审）。
3. 观察项：远采 fullRouteSearches（E5N59）、marketPlanningDueTicks/DeferredTicks 比率（当前 ~1:4）。
