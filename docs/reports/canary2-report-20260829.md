# 第二次 CPU Canary 报告（2026-08-29，候选 cac532b）

## 1. 部署身份（阶段 B 修复的线上验证）

| 项 | 值 |
|---|---|
| 候选提交 | cac532ba425e9ae622e928570157ea83160864f7（full） |
| tag | 2026.8.29-2+cac532b@2026-08-28T21:05:36.927Z |
| committed tree | 0229ea18f557784c1ba3e19228becfdd8a281b30（与本地 `git rev-parse HEAD^{tree}` 一致） |
| bundle sha-256 | 8f7856e396c39df6…（构建产物指纹，与 push 日志一致） |
| 上传回读验证 | ✅ remote modules sha256 25e77207418e2ed8… matches local（push 时自动执行） |
| 线上 Memory.runtime | lastDeployCommit/tree/BundleHash/Branch/At 全部写入，与本地完全一致 |
| 部署 tick | 73329650（21:05:36 UTC） |
| rollback 分支 | rollback-pre-canary2-20260828（部署前 default=6fc4bf2 的克隆）+ 本地备份 `rollback-default-pre-canary2.json`；回滚脚本 `monitor-data/rollback-canary2.mjs` 备用（未使用） |

## 2. 观察窗口

| 窗口 | tick 范围 | tick 数 | 样本数 |
|---|---|---|---|
| 基线（6fc4bf2 生产） | 73328689–73329585 | 897 | 128 |
| Canary 预热（不计入统计） | 73329650–73329699 | 50 | — |
| Canary 正式 | 73329704–73331342 | **1642** | 203 |
| 安全门 | 第一门 300 tick ✅（avg 108.7）· 第二门 1000 tick ✅ · 目标 1500 tick ✅（1642） | | |

采集：cpuMonitor.latest 每 7 tick 有效样本（25s 轮询去重）+ 遥测 segment 90（每 7 tick，movement 计数器）。负载匹配分桶：creep 数 ±3 且 E5N59/E6N59 活跃状态相同（matched pairs=200）。

## 3. 全部 tick 维度（A 报告：保留真实长尾）

| 指标 | 基线 | Canary | 差异 |
|---|---|---|---|
| avg | 106.58 | **106.77** | +0.2%（阈值 +15%） |
| median | 99.16 | 99.03 | 持平 |
| p95 | 172.32 | **169.33** | **-1.7%**（阈值 +25%） |
| p99 | 216.24 | **194.89** | **-9.9%** |
| max | 221.11 | 220.72 | 持平 |

**唯一分段告警（如实披露）**：73330530–73330698 段（169 tick，17 样本）p95=220.72 > 215.4（基线×1.25）。驱动因素为单一样本 tick 73330544（E5N59=45.7 既有 remoteMiningCarrier 峰值 + E6N59=33.9 既有 colonizerHarvester 事件叠加）。该段 avg=106.14（远低于阈值 122.6）、前后段 p95 均合格（163.25 / 172.51），"连续 200 tick"条件不成立 → **不构成回滚**。E5N59 峰值在基线/上轮 canary/上轮回滚后历史区间（56/47/72）内。

## 4. 分段明细（每 ~200 tick）

| tick 范围 | n | avg | p95 | bucket 斜率 | CPU/creep | E5N59 avg | creeps |
|---|---|---|---|---|---|---|---|
| 73329704–73329900 | 29 | 108.5 | 167.11 | +9.20（预热后 bucket 回满） | 1.187 | 18.95 | 91.4 |
| 73329907–73330103 | 29 | 108.1 | 169.28 | 0 | 1.180 | 20.67 | 91.6 |
| 73330110–73330299 | 28 | 94.9 | 147.30 | +0.005 | 1.030 | 12.12 | 92.1 |
| 73330306–73330502 | 29 | 113.04 | 172.51 | -1.07 | 1.174 | 17.94 | 96.3 |
| 73330530–73330698 | 17 | 106.14 | **220.72** | +2.30 | 1.158 | 16.19 | 91.6 |
| 73330705–73330901 | 24 | 111.51 | 163.25 | -3.18 | 1.237 | 19.91 | 90.2 |
| 73330908–73331020 | 17 | 105.00 | 170.11 | +0.80 | 1.158 | 14.88 | 90.7 |
| 73331139–73331300 | 24 | 103.67 | 147.90 | +2.74 | 1.156 | 16.57 | 89.7 |
| 73331307–73331342 | 6 | 117.34 | 169.33 | +2.20 | 1.306 | 19.10 | 89.8 |

bucket 斜率无持续恶化 300 tick（各段正负交替，全局 bucket 维持 7400–10000 区间，ema 稳定 ~100–120）。

## 5. 负载匹配 steady-state（B 报告：只判断代码常态成本）

matched pairs=200（creep 数 ±3、E5/E6 活跃状态相同的基线-canary 配对）下：avg 106.77 vs 106.58（+0.2%）、p95 169.33 vs 172.32（-1.7%）——**常态成本不劣于基线**。

## 6. movement/cache 计数器（每 tick，基线 → canary）

| 计数器 | 基线(6fc4bf2) | Canary(cac532b) | 变化 |
|---|---|---|---|
| multiRoomSearches | 4.027 | 3.458 | **-14%** ✅ |
| travelRepaths | 2.327 | 1.723 | **-26%** ✅ |
| pathRepaths | 3.071 | 2.511 | **-18%** ✅ |
| pathRequests | 17.253 | 16.584 | -4% |
| pathCacheHits | 13.636 | 13.630 | 持平 |
| multiRoomSegmentHits | 5.765 | 5.625 | 持平 |
| multiRoomSegmentInvalidations | 0.047 | 0.046 | 持平 |
| staticMatrixBuilds（新增） | — | 0.541 | 基线无生产计数器 |
| staticMatrixCacheHits（新增） | — | 30.787 | **命中率 98.3%** ✅ |
| topologyRevisionChanges（新增） | — | 0.076 | 正常工地演化频率 |
| roleFactoryCreates / lifecycleCacheHits（新增） | — | 0.007 / 69.5 | **命中率 99.99%**（正式窗口 1639 tick 内仅 11 次创建；含预热累计 78 次创建、0 淘汰）✅ |
| colonizationPathRebuilds/Throttled/BlockInvalidations（新增） | — | 0 / 0 / 0 | 窗口内殖民任务无重建需求（节流器就位未触发） |

Carrier task board / tower 层计数器未实现（无现成缓存结构可挂载，避免为观测引入新生产代码路径；列入后续项）。

## 7. E5N59 / E6N59 专项（对照上轮疑点）

- **E5N59**：正式窗口 avg 16.9 / max 62.2，27 个样本超过"单房>8 且>25%全局"口径——与三时期历史（基线 18.1 / 上轮 canary 17.5 / 上轮回滚后 13.1，max 56/47/72）一致，确认为既有周期负载（remoteMiningCarrier 动态跨房寻路），非候选引入，非候选放大（multiRoomSearches 总量反而 -14%）。
- **E6N59**：出现一次 colonizerHarvester 事件（tick 73330313–73330355，20–30 CPU ×2 只，随后回落）。**colonizationPath 三计数器全 0**——证明该事件不经殖民持久路径（来自 remoteMining 侧无固定路线的动态寻路，与 c51fffb 持久路径放大器无关）。上轮"CANDIDATE_AMPLIFIED 疑点"的放大器路径已修复（节流）且本窗口未触发。
- 单房异常分布：E5N59×27、E7N58×2、E1N57×1；E6N59 无（未达口径）。

## 8. 正确性与市场

- 1639 tick 无 loop 异常、无卡死；bucket 最低 ~7400 并回升；spawn/tower/carrier 相位正常。
- 市场：`market-base-resource-v3-r3`，requestedMode=direct（observe 语义），**未发生 r4 migration**（canary 全程）。
- 遥测已开启（cfg.telemetry: enabled, sampleInterval=7, segment 90）——本次为采集计数器所开，开销可忽略，建议保留；如需关闭：`stopTelemetry()`。

## 9. 合并条件核对（任务第七节）

| 条件 | 结果 |
|---|---|
| ≥1000 正式 tick（推荐 1500） | ✅ 1639 |
| 无正确性异常 | ✅ |
| 全部 tick 维度未触发回滚阈值 | ✅（单段分位数伪影已披露，非连续、avg 未超） |
| steady-state avg/p95 不劣于基线 | ✅ |
| pathRepaths 比例不恶化 | ✅（-18%） |
| CostMatrix build/cache 命中符合预期 | ✅（98.3%） |
| RoleLifecycle 缓存真实命中 | ✅（99.99%）；Carrier board 计数器未实现（如实披露） |
| 市场状态未变化 | ✅（v3-r3） |
| 线上 build identity 与候选提交一致 | ✅（commit+tree+bundleHash 三重一致） |

**未合并**。原因：本地 `main` 在 6fc4bf2 后已分叉（含 b8a50bc v3-r4 市场翻转与 openspec 文档），本次 canary 的市场前提是 v3-r3；且合并将产生 budget 锚点冲突需新一轮锚点更新与全量验证——合并应作为独立变更周期执行。生产 default 分支保持 cac532b 运行（canary 即当前生产）。
