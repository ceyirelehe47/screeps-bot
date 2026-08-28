# 第二次 CPU Canary 报告（2026-08-29，候选 cac532b）——修订版 v2

> **修订说明**：本版修正初版报告的四类缺陷：① 正式窗口 tick 数按首尾包含重算（1639，非 1642）；② 新增样本覆盖审计（缺失清单、归因与相关性检查），全文口径改为"全部已采集样本"；③ 固定 ~200 tick 分段替换为逐 tick 滑动窗口检查；④ steady-state 匹配改为无放回最近邻 + block bootstrap 非劣效置信区间，E6N59 事件回到原始数据逐样本核对并降级归因。**全部数字由 `monitor-data/analyze-canary2-v2.mjs` 重新生成**（输出 `monitor-data/derived-canary2/analysis.json`），未重新部署、未改动生产分支。

## 1. 部署身份（完整 SHA-256）

| 项 | 值 |
|---|---|
| 候选提交 | `cac532ba425e9ae622e928570157ea83160864f7` |
| committed tree | `0229ea18f557784c1ba3e19228becfdd8a281b30`（与本地 `git rev-parse "cac532b^{tree}"` 一致） |
| bundle sha-256 | `8f7856e396c39df6ca6ab7185cdb7d100f62d25c0d49f19dcd0794d45b03dd76`（取自部署时构建产物 `dist/main.js` 尾部 `__DEPLOY_BUNDLE_HASH__`） |
| remote modules sha-256 | `25e77207418e2ed87e3c792343483ec2dbee5044c7fa399c68e94d753004f0d0`（按 `scripts/lib/deployGuard.cjs` `computeModulesHash` 规范化 `main\0<content>\0` 从部署时 dist 离线重算；push 日志记录的前缀 `25e77207418e2ed8` 吻合，push 时上传回读比对通过） |
| tag | 2026.8.29-2+cac532b@2026-08-28T21:05:36.927Z |
| 线上 Memory.runtime | lastDeployCommit/tree/BundleHash/Branch/At 全部写入，与本地一致 |
| 部署 tick | 73329650（21:05:36 UTC） |
| rollback 分支 | rollback-pre-canary2-20260828 + 本地备份 `rollback-default-pre-canary2.json`（SHA-256 见 manifest）；回滚脚本 `monitor-data/rollback-canary2.mjs` 备用（未使用） |

## 2. 观察窗口与样本覆盖审计

### 2.1 窗口定义（首尾包含）

| 窗口 | tick 范围 | tick 数 | 理论样本 | 实际样本 | 覆盖率 |
|---|---|---|---|---|---|
| 基线（6fc4bf2 生产） | 73328689–73329585 | 897 | 129 | 128 | 99.22% |
| Canary 预热（不计入统计） | 73329662–73329697（首个样本起至边界） | — | 6 | 6 | 100% |
| **Canary 正式** | 73329704–73331342 | **1639** | 235 | 203 | **86.38%** |

- 采样机制：`cpuMonitor.latest` 与遥测 segment 90 均为 `sampleInterval=7`，全部样本落在 tick ≡ 0 (mod 7) 网格上（两文件 337 个样本全部满足，0 例外）。理论样本数 = 窗口闭区间内网格点数。
- 正式窗口边界：deployTick 73329650 + 预热 50 tick = 73329700，其后首个网格样本 73329704；末样本 73331342。闭区间长度 = 73331342 − 73329704 + 1 = **1639**（初版 1642 为误用 `末 tick − 边界 tick` 的开区间差，已全文修正）。

### 2.2 Canary 正式窗口缺失样本清单（32 个，全部列出）

| 缺失段 | tick 明细 | 数量 | 归因（依据 `collect-canary2.log`） |
|---|---|---|---|
| 73330509–73330523 | 73330509, 73330516, 73330523 | 3 | 采集端网络错误：n=121@73330502 与 n=131@73330593 之间 3 次 TLS 断连（每次 25s 轮询失败期间 `latest` 前进 2 个采样周期，跳过 1 个样本） |
| 73330621–73330670 | 73330621, 73330628, 73330635, 73330642, 73330649, 73330656, 73330663, 73330670 | 8 | 采集端网络错误：n=131 与 n=141@73330719 之间 8 次 TLS 断连 + 1 次 timeout |
| 73330775–73330803 | 73330775, 73330782, 73330789, 73330796, 73330803 | 5 | 采集端网络错误：n=141 与 n=151@73330824 之间 7 次 TLS 断连 |
| 73331027–73331132 | 73331027, 73331034, 73331041, 73331048, 73331055, 73331062, 73331069, 73331076, 73331083, 73331090, 73331097, 73331104, 73331111, 73331118, 73331125, 73331132 | 16 | 采集器停机：85min 定时采集 22:31:29 结束于 73331020，22:37:44 手动重启首样本 73331139（375s 采集空窗覆盖全部 16 个理论采样点） |

基线窗口缺失 1 个：73329445（`collect-baseline2.log` 中 1 次 TLS 断连）。

### 2.3 缺失与高 CPU / bucket / 抓取错误的相关性检查

| 缺失段 | 前邻样本 CPU/bucket | 后邻样本 CPU/bucket | 前后样本相对窗口分布 |
|---|---|---|---|
| 73330509–73330523 | 87.93 / 9791 | 174.79 / 9613 | ≤中位数 / >p95（后邻属 73330530 起 E6N59 事件区，见 §8.2） |
| 73330621–73330670 | 87.58 / 10000 | 90.08 / 10000 | ≤中位数 / ≤中位数 |
| 73330775–73330803 | 97.51 / 9883 | 88.57 / 9944 | ≤中位数 / ≤中位数 |
| 73331027–73331132 | 72.67 / 9299 | 73.74 / 9468 | ≤中位数 / ≤中位数 |

结论：**32 个缺失全部由采集端原因造成**（19 次 TLS 断连 + 1 次 timeout + 采集停机 375s），非游戏侧采样缺席。缺失段邻样本 8 个中 7 个 CPU ≤ 窗口中位数、bucket 全部在 9299–10000 高位——**缺失与高 CPU 或 bucket 枯竭无相关性**。影响：86.4% 覆盖下分位数估计的不确定度增大（§5 的滑动窗口检查已按窗口实际覆盖率披露，§6 的置信区间已覆盖采样误差）；不存在系统性偏向高 CPU 样本缺失或保留的证据。

## 3. 验证命令（真实退出码）

在修订工作树（HEAD=3b67a32，候选 cac532b + 文档提交）上执行：

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `npm run typecheck` | 0 | typecheck:build 与 typecheck:test 均无错误 |
| `npm test` | 0 | 183 suites / 605 tests 全部通过（0 失败 0 跳过），97.4s |
| `npm run test:budget` | 0 | `JEST_TEST_BUDGET=PASSED`，suites=183 / tests=605，与锚点（基线 d0482bc）一致 |
| `npm run build` | 0 | 本地构建成功（无 DEST，仅编译不上传）；dirty-tree 警告源于本次修订的文档变更，非代码变更 |

注：四条命令在修订工作树（HEAD=3b67a32 + 本文档修订）上执行；`npm run build` 的本次重建产物（bundle sha256 前缀 14441cb5…）**不是**部署产物——§1 的部署 bundle/modules 哈希提取自部署时的 dist 产物（重建前），且与 push 日志前缀吻合。原始输出见 `monitor-data/derived-canary2/verification-commands.log`。

## 4. 全部已采集样本维度（A 报告：保留真实长尾）

分位数算法：**Hyndman-Fan type-7 线性插值（h=(n-1)p，R 语言默认）**；括号内 nearest-rank（ceil(np) 序）作敏感性对照。初版报告使用 floor(n·p) 索引（与 nearest-rank 接近），本版以 type-7 为主口径。

| 指标 | 基线（n=128） | Canary（n=203） | 差异 |
|---|---|---|---|
| avg | 106.58 | **106.77** | +0.2%（阈值 +15%） |
| median | 99.07 | 99.03 | 持平 |
| p95 | 168.76（nr 172.32） | **169.32**（nr 169.33） | **+0.3%**（nr 口径 −1.7%；阈值 +25%） |
| p99 | 216.13 | **194.49** | −10.0% |
| max | 221.11 | 220.72 | 持平 |

**方法敏感性披露（重要）**：p95 的相对差异随分位数算法翻转（type-7：+0.3%；nearest-rank：−1.7%），因为两侧样本数不同（128 vs 203）时两种算法的偏置不同。**"p95 改善"不构成结论**；稳健的表述是：全部已采集样本维度 p95 持平（两种算法下差异均在 ±2% 内，远小于 +25% 阈值），p99 明显更低（−10%），长尾（max）持平。avg +0.2% 在 +15% 阈值内。

## 5. 滑动窗口门槛检查（rolling window，非固定分段）

算法：窗口为闭区间 [t0, t0+width−1]，**起点逐 tick 滑动（步长 1）**；每窗口统计落入样本的 avg、p95（type-7）与覆盖率（窗口内实际样本/理论网格样本）。基线阈值取其全部 128 样本：avg 106.58（限值 ×1.15 = 122.57）、p95 168.76（限值 ×1.25 = 210.95）。

### 5.1 Rolling 200-tick 窗口（1440 个窗口）

| 项 | 结果 |
|---|---|
| avg 违规窗口 | **0 / 1440** |
| p95 违规窗口 | **0 / 1440** |
| 最差 avg 窗口 | 73330755–73330954，n=23，覆盖率 82.1%，avg **120.13**（限值 122.57，达 98%），p95 170.05 |
| 最差 p95 窗口 | 73330475–73330674，n=17，覆盖率 60.7%，p95 **183.98**（限值 210.95），avg 108.09 |
| 最低覆盖率 | 42.9%（73330937–73331164 一带窗口，n=12，因跨 §2.2 的 16 样本停机缺失段；该区 avg 87.56–91.33、p95 129.07–141.69，为低负载段） |

初版报告"唯一分段告警 73330530–73330698 p95=220.72"是固定分段 + nearest-rank 在 n=17 小样本上的伪影（p95 退化为取最大值）；在逐 tick 滑动窗口 + type-7 口径下**不存在任何违规窗口**。最差 p95 窗口（183.98）与最差 avg 窗口（120.13）均未越限，但最差 avg 窗口已达限值的 98%——该窗口由 73330755–73330954 段市场相位高峰（marketSaleAutomation ~32）与 E5N59 活跃期叠加驱动，属既有负载形态。

### 5.2 Rolling 300-tick bucket 斜率（1340 个窗口）

| 项 | 结果 |
|---|---|
| 最负斜率窗口 | 73330818–73331117，n=29，OLS 斜率 **−8.485 bucket/tick**（9977→9299） |
| 最正斜率窗口 | 73330937–73331236，n=26，斜率 +6.618（8369→9968） |
| 斜率 < −1/tick 的窗口数 | 400 / 1340 |
| 全窗口 bucket 轨迹 | 首样本 8187 → 末样本 9995，全程带 7893–10000 内振荡 |

bucket 呈充放电循环（高 CPU tick 放电、低 CPU tick 充电），正负斜率窗口交替出现，**无持续单向衰减**；窗口首末比较（8187→9995）为净回升。

### 5.3 安全门重算（正式窗口前 N tick）

| 门 | 窗口 | 样本 | avg（限 122.57） | p95（限 210.95） | 结果 |
|---|---|---|---|---|---|
| 第一门 300 tick | 73329704–73330003 | 43 | 108.52 | 167.02 | ✅ |
| 第二门 1000 tick | 73329704–73330703 | 132 | 106.22 | 168.09 | ✅ |
| 目标 1639 tick | 73329704–73331342 | 203 | 106.77 | 169.32 | ✅ |

## 6. 负载匹配 steady-state（B 报告：只判断代码常态成本）

### 6.1 匹配方法（完整方法学披露）

- **算法**：贪心最近邻匹配，**无放回**（每个基线样本至多配对 1 次；初版报告允许复用，"matched pairs=200" 从 128 个基线样本中产生意味着平均每基线样本被复用 1.56 次，已废弃）。canary 样本按 tick 升序处理，距离并列取最早基线样本。等权配对，无权重。
- **硬约束（必须相等）**：owned rooms 数（有 spawn 角色的房间，两窗口全程稳定为 8）、E5 active、E6 active。
- **caliper（连续变量上限）**：|Δcreep 数| ≤ 3；|Δremote 任务 creep 数| ≤ 2；|Δwar/防御相位负载| ≤ 0.5；|Δ工地相位负载| ≤ 0.5；|Δmarket 相位负载| ≤ 8。
- **距离**：|Δcreeps| + 2·|Δremote| + |Δwar| + |Δconstr| + |Δmarket|/4。
- **匹配变量与数据来源**：creep 总数与 remote 任务数（`rooms.*.roles` 计数；remote = remoteDefender/remoteMiningCarrier/remoteMiningReserver/remoteWorker/colonizerHarvester）；war/hostile 以 warControl+defenseMode+homeDefense+coreDefense 相位 CPU 代理（**战斗事件计数器 NOT OBSERVED**）；construction sites 以 roomPlannerConstruction 相位 CPU 代理（**工地数量 NOT OBSERVED，见 §9.3**）；market 活动以 marketSaleAutomation+marketSalePreflight 相位 CPU 代理（市场相位两窗口恒为 v3-r3/observe——采集期 console 记录，非离线可复核）；profiler/telemetry 配置两窗口完全相同（§9.2）。
- **E5/E6 active 定义（与 CPU 结果无关）**：E5 active = E5N59 存在 remoteMiningCarrier（工作负载在场）；E6 active = E6N59 存在 colonizerHarvester 或 remoteMiningReserver。不以 totalUsed 阈值定义（初版以 `totalUsed>4/5` 定义，属用被解释变量分层，已废弃）。

### 6.2 匹配结果

| 项 | 值 |
|---|---|
| canary 正式样本 | 203 |
| **matched pairs** | **111**（canary 唯一样本 111，基线唯一样本 111，复用次数 0，有效样本量 = 111） |
| 基线样本池 | 128（使用 111，占 86.7%） |
| 未匹配 canary 样本 | 92：E6 active 状态无基线对手 60、remote 任务数 caliper 15、creep 数 caliper 14、war caliper 1、E5 active 硬约束 2 |

未匹配样本主因：E6N59 事件角色（colonizerHarvester/remoteMiningReserver）在场时段在基线窗口无同状态样本——steady-state 对比因此天然剔除了事件态负载，符合其"只判断代码常态成本"的目的。

### 6.3 配对子集独立统计（不复用整体结果）

| 指标 | 基线配子集（n=111） | Canary 配子集（n=111） | 差异 |
|---|---|---|---|
| avg | 102.12 | **102.18** | +0.06 |
| median | 97.32 | 95.64 | −1.7 |
| p95 | 144.85 | **153.75** | **+6.2%** |
| p99 | 174.40 | 172.38 | −1.2% |
| max | 184.63 | 173.85 | −5.8% |

### 6.4 Block bootstrap 非劣效置信区间

方法：配对差与 canary 侧均做**块长 10 对（≈70 tick，处理序列自相关）、10000 次重采样**的 block bootstrap（确定性种子，脚本可复现）。

| 统计量 | 95% CI | 非劣效判定 |
|---|---|---|
| 配对均差（canary−基线） | **[−6.94, +7.26]** | 上界 7.26 < +15%×102.12 = 15.32 → **PASS** |
| 均值比 canary/基线 | [0.953, 1.048] | 含 1，常态成本不劣于基线 |
| canary 配子集 p95 | [133.26, 169.28] | 上界 < 144.85×1.25 = 181.06 → **PASS** |

**如实披露**：配对子集点估计上 p95 高 6.2%（153.75 vs 144.85），但均差的置信区间对称含 0、p95 的 bootstrap 上界远低于 +25% 非劣效界。稳健结论是"**常态成本与基线统计不可区分（非劣效成立）**"，而非"优于基线"。

## 7. movement/cache 计数器（原始计数与比例分列）

窗口口径：基线 = segment 首末样本 73328766–73329557（791 tick，无重置）；canary 全程 = 部署重置后首样本 73329662 至 73331342（1680 tick，含预热）；canary 正式 = 73329704–73331342（1638 tick 跨度）。计数器为累计值取差，窗口长度不同时以每 tick 值与比例为准。

### 7.1 主表（canary 全程含预热 vs 基线；比例分母为同窗口原始计数）

| 指标（分母） | 基线 | Canary | 变化 |
|---|---|---|---|
| pathRequests 原始计数 | 13647（791t） | 27998（1680t） | — |
| pathRepaths 原始计数 | 2429 | 4218 | — |
| **pathRepaths/tick** | 3.0708 | 2.5107 | **−18.2%** ✅ |
| **pathRepaths/pathRequests** | 17.80% | 15.14% | 相对 **−14.9%** ✅ |
| **pathCacheHits/pathRequests** | 79.04% | 82.19% | **+3.15pp** ✅ |
| travelRequests 原始计数 | 9783 | 17286 | — |
| **travelRequests/tick** | 12.3679 | 10.2893 | **−16.8%** ✅ |
| travelRepaths/travelRequests | 18.82% | 16.74% | −2.08pp ✅ |
| multiRoomSearches 原始计数 | 3185 | 5809 | — |
| multiRoomSearches/tick | 4.0265 | 3.4577 | −14.1% ✅ |
| **multiRoomSearches/travelRequests** | 32.56% | 33.61% | **+1.05pp** ⚠️ |
| multiRoomSegmentHits/tick | 5.7649 | 5.6250 | −2.4% |
| multiRoomSegmentInvalidations/tick | 0.0468 | 0.0464 | 持平 |

### 7.2 仅正式窗口口径（73329704–73331342）

pathRepaths/tick 3.0708→2.5324（−17.5%）；pathRepaths/pathRequests 17.80%→15.23%（−14.4%）；pathCacheHits/pathRequests 79.04%→82.09%（+3.05pp）；travelRequests/tick 12.3679→10.3071（−16.7%）；multiRoomSearches/tick 4.0265→3.4994（−13.1%）；multiRoomSearches/travelRequests 32.56%→33.95%（+1.39pp）。两口径方向一致。

### 7.3 仅 canary 存在的新计数器（基线版本无生产计数器）

| 计数器 | 正式窗口原始计数 | 每 tick | 备注 |
|---|---|---|---|
| staticMatrixBuilds | 901 | 0.5501 | — |
| staticMatrixCacheHits | 50799 | 31.0128 | **命中率 50799/(50799+901) = 98.26%** ✅ |
| topologyRevisionChanges | 126 | 0.0769 | 正常工地演化频率 |
| roleFactoryCreates / roleLifecycleCacheHits / Evictions | 11 / 113931 / 0 | 0.0067 / 69.55 / 0 | **命中率 99.99%** ✅ |
| colonizationPathRebuilds / RegeneratesThrottled / BlockInvalidations | 0 / 0 / 0 | 0 | 仅说明矩阵层无重建触发；**不能**据此推断 creep 移动层路径跟随行为（§8.2） |

**如实披露**：multiRoomSearches 总量下降（−14.1%/tick）但 **multiRoomSearches/travelRequests 微升 +1.05pp**——每单位旅行的跨房搜索率略升，与 travelRequests 本身下降 16.8% 相符（低价值旅行请求被缓存命中消化后，剩余旅行的跨房搜索占比略高）。不构成恶化信号，但"整体寻路效率全面改善"的说法不成立。

## 8. E5N59 / E6N59 专项（对照上轮疑点）

### 8.1 E5N59（既有热点，NOT_CANDIDATE_CAUSED；证据强度=分布重叠，非"确认无放大"）

房间级指标（基线 n=128 vs canary 正式 n=203，全部样本）：

| 指标 | 基线 | Canary | 变化 |
|---|---|---|---|
| 房间 CPU/样本 avg / med | 15.85 / 14.75 | 17.38 / 15.52 | +9.6% / +5.2% |
| 房间 CPU/样本 p95 / p99 / max | 36.56 / 50.19 / 68.82 | 35.41 / 47.66 / 62.25 | −3.1% / −5.0% / −9.6% |
| **CPU/creep** | 1.761 | 1.777 | **+0.9%** |
| pathRequests/tick（房间） | 2.5297 | 2.8211 | +11.5% |
| travelRequests/tick（房间） | 1.0076 | 1.1245 | +11.6% |
| multiRoomSearches/tick（房间） | 1.0076 | 1.0830 | +7.5% |
| **CPU/travelRequest** | 15.731 | 15.452 | **−1.8%** |

- 初版报告"确认既有周期负载、非候选放大"的表述**过度断言**。修订后的表述：E5N59 在 canary 窗口承载的负载更高（房间级 path/travel 请求 +7.5%~+11.6%），房间总 CPU 随之上移（avg +9.6%），但**单位负载指标持平**（CPU/creep +0.9%、CPU/travelRequest −1.8%），且高分位（p95/p99/max）低于基线。该证据形态与"候选未放大单位负载"一致，但基于观察性窗口数据，不能等同于受控实验的"确认"。
- 单房异常（>8 CPU 且 >25% 全局）样本：E5N59×27、E7N58×2、E1N57×1，主导 role 均为 remoteMiningCarrier（既有逐 tick 重寻路机制，见 RCA 报告）。峰值 62.25（73329984）在基线 max 68.82 与上轮回滚后历史 72.2 的区间内。
- **回滚语义（全局阈值不豁免）**：E5N59 事件样本计入全局 CPU 参与全部滑动窗口与整体统计（如 73330544 全局峰值即含 E5N59=45.7 贡献）；房间级归因仅用于解释性 RCA，**不改变全局回滚阈值的适用**。单房事件不设免回滚例外。

### 8.2 E6N59（三起独立事件；归因 INSUFFICIENT_DATA）

原始数据逐样本核对结果（canary 正式窗口 E6N59 totalUsed > 8 的全部样本）：

| 事件 | tick 范围 | 主导 role | 强度 | 全局占比 |
|---|---|---|---|---|
| 事件 1（孤立尖峰） | 73330229 | carrier ×1 | 25.1 | 21.9% |
| **事件 2（colonizerHarvester）** | **73330313–73330355**（7 样本） | colonizerHarvester ×2（末样本 ×1） | 20.2–30.1/样本 | 10–24% |
| **事件 3（remoteMiningReserver）** | **73330537–73330565**（5 样本） | remoteMiningReserver ×1 | 11.5–33.1/样本 | 14–16% |

- **初版报告的错误（已在原始数据中确认）**：初版 §3 将全局峰值样本 73330544 的驱动写成"E5N59 峰值 + E6N59 **colonizerHarvester** 事件叠加"，而 §7 又记录 colonizerHarvester 事件在 73330313–73330355——两处自相矛盾。原始数据确认：**73330544（全局 220.7）= E5N59 45.7（remoteMiningCarrier 43.9）+ E6N59 33.9（remoteMiningReserver 33.1）**，即事件 3，与事件 2 无关。
- **colonizationPath 三计数器全 0 的推断降级**：这三个计数器只覆盖殖民持久路径的矩阵层重建/节流/块失效，**不覆盖 creep 移动层是否跟随已有 cachedTravelPath/travelPathCache/multiRoomSegment**（无对应计数器）。因此"计数器全 0 证明事件不经殖民持久路径/来自无固定路线 dynamic routing"不成立。归因降为 **INSUFFICIENT_DATA**：三起事件的 creep 级路径跟随行为无法在现有遥测下判定。
- 后续判定条件：新增 `colonizationPathFollowAttempts / FollowHits / FollowFallbacks / FollowKeyMisses` 计数器后，方可对"事件是否跟随已有缓存路径"作出判定。
- E6N59 未触发 §8.1 的单房异常口径：事件期房间占比 10–24%，均 <25%（该口径要求 >8 CPU 且 >25% 全局同时成立）。

## 9. 相位、房间与遥测补充

### 9.1 Top phases（全部已采集样本 avg，基线 → canary）

| phase | 基线 | Canary | 变化 |
|---|---|---|---|
| creepWork | 40.28 | 41.86 | +3.9% |
| marketSaleAutomation | 30.95 | 32.11 | +3.7% |
| creepWork:pathing | 21.19 | 21.14 | 持平 |
| creepWork:intent | 11.89 | 11.85 | 持平 |
| marketSalePreflight | 9.45 | 8.40 | −11.1% |
| **creepWork:decision** | 3.23 | **4.62** | **+43%（+1.39 CPU/tick）** |
| externalTelemetryExport | 3.23 | 3.67 | 见 9.2 |
| remoteMining | 2.59 | 2.57 | 持平 |

CPU/owned room：基线 13.32 → canary 13.35（+0.2%，两窗口 owned rooms 恒为 8）。creepWork:decision 上升 +1.39 CPU/tick 为本窗口观察到的最大相位增幅（占比小，在回滚阈值内）；候选变更涉及角色派发缓存路径，该相位的变化方向与候选相关，**未做进一步归因**，列入合并前观察项。

### 9.2 遥测配置与开销（两窗口一致）

- 配置：`Memory.cfg.telemetry = { enabled: true, sampleInterval: 7, segmentId: 90 }`，**基线窗口与 canary 窗口完全相同**（`segment-baseline2.jsonl` 与 `segment-canary2.jsonl` 含同一计数器集为证），匹配对比不受配置差异影响。
- 开销：externalTelemetryExport 相位 avg 基线 3.23 / canary 3.67 CPU/tick，已包含在两侧 totalUsed 中。
- cpuMonitor 相位剖析（本报告全部 CPU 数据来源）同样两窗口开启。

### 9.3 观测覆盖声明（PARTIAL / NOT OBSERVED）

| 观测项 | 状态 | 说明 |
|---|---|---|
| CarrierTaskBoard 计数器 | **NOT OBSERVED** | 无现成缓存结构可挂载；避免为观测引入新生产代码路径，列入后续项 |
| Tower 层计数器 | **PARTIAL** | 仅有全局 towerControl 相位 CPU（基线 2.57 → canary 1.86）与 fixedActionCounts.towerControl（5.0→4.3/tick），无命中/决策分桶计数器 |
| construction sites 数量 | **NOT OBSERVED**（代理） | 匹配使用 roomPlannerConstruction 相位 CPU 代理 |
| 战斗/hostile 事件计数 | **NOT OBSERVED**（代理） | 匹配使用 war/defense 相位 CPU 代理 |
| 市场相位 | 采集期 console 记录（v3-r3/observe 恒定） | 非离线可复核 |
| colonization 路径跟随行为 | **NOT OBSERVED** | 见 §8.2 |

## 10. 正确性与市场

- 1639 tick 无 loop 异常、无卡死；bucket 全程 7893–10000 带内振荡、首末净回升（8187→9995）；spawn/tower/carrier 相位正常。
- 市场：`market-base-resource-v3-r3`，requestedMode=direct（observe 语义），canary 全程未发生 r4 migration（采集期记录，见 §9.3 限制）。

## 11. 可复核证据（入库清单）

原始 jsonl/segment/json 文件不入库（含线上运行数据与私有 Memory 快照），以 SHA-256 manifest 锚定；入库文件：

| 文件 | 内容 |
|---|---|
| `monitor-data/analyze-canary2-v2.mjs` | 本报告全部数字的分析脚本（含方法学与常量） |
| `monitor-data/derived-canary2/analysis.json` | 脱敏派生聚合（窗口/覆盖/滑动窗口摘要/匹配/bootstrap/计数器/事件/相位/身份） |
| `monitor-data/derived-canary2/rolling-w200.json` / `rolling-w300.json` | 全部滑动窗口逐窗口表（1440 / 1340 行） |
| `monitor-data/derived-canary2/sample-index.json` | 基线/canary 样本 tick 索引 + 缺失清单 |
| `monitor-data/derived-canary2/manifest-sha256.json` | monitor-data 全部原始文件（jsonl/segment/log/回滚备份等）SHA-256 |
| `monitor-data/derived-canary2/verification-commands.log` | 四条验证命令原始输出与退出码 |

不入库：token（`.env`/`.secret.json` 已在 .gitignore）、完整私有 Memory 快照（snapshots.jsonl/rollback json 仅哈希）、敏感订单数据（如存在于私有 Memory 中，同样仅哈希不复制）。

## 12. 合并条件核对与最终状态

| 条件 | 结果 |
|---|---|
| ≥1000 正式 tick（推荐 1500） | ✅ 1639（首尾包含；203 已采集样本，覆盖 86.38%，缺失全归因于采集端） |
| 无正确性异常 | ✅ |
| 全部已采集样本维度未触发回滚阈值 | ✅ avg +0.2%（<+15%）、p95 持平（<+25%，两算法均成立） |
| 滑动窗口门槛（200-tick avg/p95；300-tick bucket） | ✅ 1440 窗口 0 违规；bucket 无持续衰减（最差 avg 窗口达限值 98%，已披露） |
| steady-state 非劣效 | ✅ 111 对无放回匹配，均差 CI [−6.94, +7.26]，avg/p95 非劣效均 PASS |
| pathRepaths 比例不恶化 | ✅ pathRepaths/tick −18.2%、pathRepaths/pathRequests −14.9%；multiRoomSearches/travelRequests +1.05pp 已如实披露 |
| CostMatrix build/cache 命中符合预期 | ✅ staticMatrix 命中率 98.26% |
| RoleLifecycle 缓存真实命中 | ✅ 99.99%；CarrierTaskBoard NOT OBSERVED、Tower PARTIAL（如实披露） |
| 市场状态未变化 | ✅ v3-r3（采集期记录） |
| 线上 build identity 与候选一致 | ✅ commit/tree/bundle/modules 四重 SHA-256 一致（§1） |

**最终状态：PASSED_NOT_MERGED。**

未合入 `main` 的原因（与初版一致，非指标原因）：本地 `main` 在 6fc4bf2 后已分叉（含 b8a50bc v3-r4 市场翻转与 openspec 文档），本次 canary 的市场前提是 v3-r3；合并将产生 budget 锚点冲突，需独立的锚点更新周期与全量验证。生产 default 分支保持 cac532b 运行（canary 即当前生产）。合并前观察项：creepWork:decision +43%（§9.1）、multiRoomSearches/travelRequests +1.05pp（§7.1）。
