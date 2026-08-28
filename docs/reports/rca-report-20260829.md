# E5N59 CPU 异常根因报告（第一次 CPU Canary 回滚复盘）

- 生成时间：2026-08-29
- 数据来源：`baseline-pre-deploy.jsonl`（65 样本，tick 73326568–73327016，生产版 6fc4bf2）、`post-deploy.jsonl`（111 样本，含 canary 50 样本 tick 73327107–73327450 + 回滚后 55 样本 tick 73327457–73327835）、`snapshots.jsonl`（部署前 memory 快照）、`rollback-default-6fc4bf2.json`（回滚备份）
- 分析脚本：`analyze-e5n59-rca.mjs`（可复核，输出 `e5n59-rca-20260829.json`）
- 采样机制：`cpuMonitor.latest` 每 7 tick 一个有效样本（sampleInterval=7，外部 25s 轮询去重），房间级数据按 `role × room` 聚合（`cpuPhaseProfiler.measureCreep` 包住整个 `creep.work()`）

## 1. 异常准确窗口

| 项 | 值 |
|---|---|
| E5N59 首个升高样本（>4 CPU） | tick **73327121**（canary 部署 tick 73327107 后第 2 个样本） |
| 最后一个升高样本 | tick **73327450**（canary 最后一个样本，被回滚截断，无自然恢复点） |
| 峰值样本 | tick **73327422**，单房 **53.28**（全局 211.34）与 tick 73327373 单房 53.17（全局 227.89） |
| >4 CPU 样本数 | canary 50 个样本中 39 个（78%） |
| 与 sampleInterval 对齐 | 所有数据点本身即 7-tick 采样点；无法给出样本间 tick 的房间数据（粒度限制，见 §6） |

**关键修正**：deploy-report-20260829.json 中"E5N59 尾段事件、事件后回落 2.3"的叙事不成立。回滚后 E5N59 依然出现 20–72 CPU（27/55 样本 >4，max 72.2 @ tick 73327478，高于 canary 全部峰值）；且**基线期间（部署前、旧版本 6fc4bf2）E5N59 在 65 个样本中 51 个 >4 CPU（78%），avg 18.13 / med 15.43 / max 56.04**。"回落"只是该房间周期性活跃/安静交替的安静段被误读。

## 2. 主导 CPU 分解（房间数据按 role 聚合，无房间级 phase 字段）

E5N59 异常窗口（39 个升高样本）role 分解：

| role | avgUsed | maxUsed | 数量 |
|---|---|---|---|
| **remoteMiningCarrier** | **19.52** | **46.95** | 1–2 |
| carrier | 1.31 | 21.75 | 1 |
| miner | 0.75 | 10.87 | 2–3 |
| worker | 0.27 | 0.92 | 1 |
| spawn | 0.02 | 0.61 | 3 |

- 主导者是 **remoteMiningCarrier（跨房运输 creep）**，非房间级系统（tower/defense/planner 在全局 phase 中持平：towerControl 2.39→2.70，defenseMode/homeDefense/coreDefense 均无变化）。
- 全局层对应 phase 为 `creepWork:pathing`：canary 异常窗口 avg 27.4 vs canary 前段 14.6 vs 基线 22.1。**性质是"每 tick 重复执行"**：代码调查确认 remoteMiningCarrier 无固定路线，依赖 multiRoomSegment 跨 tick 段缓存；`stuckTicks>=2`（交通堵塞/沿途修路停车让后续 carrier 被堵）→ 段缓存禁用并清除 → 每 tick 完整 `PathFinder.search`（maxOps 10000, maxRooms 16）+ 逐房矩阵 clone。活跃/安静交替（AAAA..AAA.. 模式）与"堵塞→逐 tick 重搜→走动一步后恢复缓存"机制吻合。
- **该机制为旧版本（6fc4bf2）与候选共有**。生产版甚至更糟：其 travelMatrixCache 每 tick 清空（候选 961623c 改为拓扑指纹+TTL100），任何一次跨房 search 每 tick 重建全部途经房矩阵。

## 3. 房间工作负载对齐

- E5N59 creep 数在 canary 全程稳定在 8–10（spawn3 + miner2-3 + carrier1 + worker1 + remoteMiningCarrier1-2），无爆发；无 creep 死亡/出生异常波形。
- E5N59 无 hostile/war/tower 战斗迹象：warControl 0.009–0.064、homeDefense/coreDefense/defenseMode 三时期持平；towerControl 2.0–2.7。
- 全局 creep 数：baseline 91 → canary 92–93 → 回滚后 85–89。
- 市场：`market-base-resource-v3-r3` observe 模式全程未变；`marketSaleAutomation` 是全局最大 phase（avg 30.6/35.3/34.0，max 74.7/96.6/80.5）——三时期一致，非回滚因素但为最大常态成本。
- **无 CostMatrix 反复重建风暴证据**（矩阵层无生产计数器，见 §5 缺口）。
- 同窗口其他房间：峰值 tick 73327422 时 E6N59=44.4（colonizerHarvester x2 = 42.7），其余房间 0.4–2.7——异常只集中在 E5N59（既有）与 E6N59（见 §4）。

## 4. 三对照窗口 + E6N59 次要事件

### E5N59（三时期，单位 CPU/样本）

| 窗口 | n | avg | med | p95 | max | remoteMiningCarrier p50/p90/max |
|---|---|---|---|---|---|---|
| 基线（生产版） | 65 | 18.13 | 15.43 | 39.53 | 56.04 | 13.8 / 27.4 / 54.8 |
| canary | 50 | 17.50 | 14.20 | — | 53.28 | 12.9 / 30.8 / 47.0 |
| 回滚后（生产版） | 55 | 13.07 | 2.94 | 42.18 | **72.20** | 11.5 / 26.0 / 45.6 |

**三时期分布一致，canary 中位数甚至略低**。负载归一化 pathing 成本（pathing avg ÷ E5N59 活跃样本占比）：基线 22.1/0.78≈28.3、canary 22.7/0.78≈29.1、回滚后 14.0/0.49≈28.6 —— 单位负载成本三版本相同，**候选无放大**。

### E6N59 colonizerHarvester 事件（canary 尾段独有，无法完全归因）

- canary 尾段 tick 73327408–73327450：colonizerHarvester x2 消耗 12.3–42.7 CPU（n=7 样本）。
- 基线期间同类事件存在于 **E7N58**（n=16，avg 14.1，max 22.6，x2）和 E5N59（n=7，avg 12.2）——殖民路径重建事件是既有的、位置随殖民进度移动的周期行为。
- 第一波 E6N59 异常（remoteMiningReserver 单只 14.1–16.3）**开始于部署前 tick 73327100**（旧版本仍在运行），先于部署。
- **疑点**：canary 期间事件强度（avg 23.8/max 42.7）高于基线同类（avg 14.1/max 22.6）。代码调查确认候选 c51fffb 存在放大器机制：殖民持久路径 key 加 `v2` 版本前缀（部署即全量失配重建）+ 运行时静态障碍验证失败即**删除全局共享路径且重生成无节流**（失败后每 tick 20000-op search 重试；该放大器在生产版同样存在，候选扩大了触发面）。样本量（n=7 vs n=16）不足以区分强度差异是版本差异还是事件本身差异（不同目标房距离/障碍不同）。

## 5. 候选相关缓存/寻路计数器现状

已有（`src/movement/metrics.ts`，按房间聚合，5-tick flush，global heap 累加）：pathRequests、pathCacheHits、pathRepaths、multiRoomSearches、travelRequests、travelRepaths、travelFallbacks、multiRoomSegmentHits、multiRoomSegmentInvalidations、exitRecoveries、yieldPushes、stateClears。

**缺失（本次无法定位的直接原因）**：staticMatrixBuilds、staticMatrixCacheHits、topologyRevisionChanges（矩阵层零生产计数器，仅测试专用 count）；colonization 路径重建次数/原因；findRoute 调用计数。

## 6. 数据粒度不足声明

现有 telemetry 缺少：房间级 phase 拆分（房间数据只有 role 聚合）、非采样 tick 的房间数据、per-creep 寻路次数、矩阵重建/命中计数、殖民路径重建原因码。因此 E6N59 事件无法在现有数据下做出候选放大与否的判定。

## 7. 归因等级

| 异常 | 等级 | 依据 |
|---|---|---|
| **E5N59 主异常（触发回滚 p95 的最大贡献者）** | **C. EXOGENOUS_WORKLOAD** | 三时期（部署前/canary/回滚后，两个版本）强度分布一致；主导 role 为 remoteMiningCarrier 既有逐 tick 重寻路机制；负载归一化 pathing 成本相同；回滚后峰值（72.2）甚至高于 canary |
| E6N59 colonizerHarvester 尾段事件（p95 超标的共因之一） | **D. INSUFFICIENT_DATA（疑似 CANDIDATE_AMPLIFIED）** | 同类事件基线存在但强度较低；候选 c51fffb 有已知"验证删除+重生成无节流"放大器；样本量不足 |

**回滚决策本身正确**（阈值即安全线，且当时无房间级对照数据可用）；本次复盘结论为：E5N59 事件不应再作为下一次 canary 的回滚依据格式（需房间级归因），E6N59 放大器必须在下次 canary 前修复并加计数器。

## 8. 后续动作（本次会话执行）

1. 修复 c51fffb 殖民路径重生成无节流放大器 + 回归测试（消除 CANDIDATE_AMPLIFIED 疑点）。
2. 补齐矩阵层/殖民层低开销计数器（bounded、按房间、默认低频）。
3. 修复部署版本溯源失真（阶段 B）。
4. 满足重部署条件后执行第二次受控 Canary（新 rollback branch、预热 50 tick、300/1000/1500 安全门、双重报告）。
