# 免限流解除与实时补齐 — 时间线（2026-09-10 晚，用户会话授权轮）

## 授权与边界

用户本轮指令：允许使用本地已有 token 走官方免限流流程，无须再次授权；解除后以实际读取验证；补齐此前未取得的实时字段；不暴露完整 token/前缀/链接；不授权上传/切分支/改 Memory/发资源；不做无界高频轮询。

## 时间线（全部输出经脱敏，token= 片段替换为 <REDACTED>）

1. **状态查询**（2 请求）：
   - `GET /user/memory?shard=shard1&path=runtime` → **429**（`x-ratelimit-limit:1440, remaining:0, retry-after:10105`；响应体含官方解除链接——账号设置变更，本轮前未使用）
   - `GET /auth/tokens` → **404**（不存在公开 token 属性端点；免限流状态无 API 查询途径，只能行为探测或 UI）
   - 结论：token 仍受限。
2. **官方解除流程**（UI，无新增 API 请求）：
   - 脚本运行时从本地 `.env` 构造官方链接（URL 不出现在任何命令、输出、文件中），在既有已登录 Chrome 会话新标签页打开；
   - 页面加载后出现官方确认对话框：`Token: <8 位前缀>-****-****-****-************`（UI 自身脱敏显示）+ **`Rate limiting will be turned off for 2 hours.`** + `Proceed` 按钮；
   - 仅打开页面**未**生效（随后行为探测仍 429，remaining=0——符合"不得仅凭打开页面报告成功"）；
   - 点击 `Proceed`（可访问性元素目标，无截图）。
3. **解除验证**（1 请求）：`GET /user/memory?shard=shard1&path=runtime` → **HTTP 200**、无限流头、返回 gz 数据（130KB 解码）——以实际读取证实恢复。**有效期 = 2 小时**（官方对话框明示，非永久开关）。
4. **有界补齐**（2 请求）：
   - `GET /user/memory?shard=shard1`（根，206KB→解码 783KB）；
   - `GET /user/memory?shard=shard1&path=runtime.resourceControl`（时间对照复核，见下）。

**本轮总请求：6 次**（2 状态探测 + 1 解除前验证 429 + 1 解除验证 200 + 2 补齐 200），全部在 2 小时窗口内一次完成，无轮询。

## 实时原始读数（tick 参照 73614430–73614479，2026-09-10 ~21:2x 本地）

### Memory.runtime（此前 429 未取得——现已实时取得）

- `lastDeployTag = "2026.8.29-6+06ffedb@2026-08-29T14:28:59.403Z"`
- `lastDeployCommit = "06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c"`
- `lastDeployTree = "929fa9557b1a36135a5ef1605231be1d16e87366"`
- `lastDeployBundleHash = "7dce727e…"`、`lastDeployBranch = "default"`、`lastDeployAt = 73346496`（距今 ~26.8 万 tick ≈ 10 天，与 8-29 部署吻合）
- **与在线模块字节、git 历史三方一致——部署身份旁证链闭合。**
- runtime 顶层**无 `treasuryCore` 键**（当前实时事实，非由旧投影推断）；含 `resourceControl/resourceReservations/marketSaleAutomation/hub/…` 与大量 diag* 历史键。

### 旧资源任务与预留（实时）

- `Memory.runtime.resourceReservations = {}` — **当前零资源预留**。
- `Memory.data.resourceControl.tasks = {}` — **当前零活跃资源任务**。
- `runtime.resourceControl`（活跃投影，updatedAt=当前 tick）：8 房全部 `state=balanced`、`capacityState=normal`；capacityPolicy enabled。

### 候选端点容量与库存（实时，按房间×结构类别）

| 房间 | storage used/free | terminal used/free | storageE/terminalE | 原生矿 |
| --- | --- | --- | --- | --- |
| E1N57 | 795,268/204,732 | 240,000/60,000 | 233,306/15,405 | X |
| E3N59 | 775,689/224,311 | 205,834/94,166 | 145,027/34,793 | **H** |
| E4N58（hub） | **4,462,548/3,537,452（合计 8M）** | 224,615/75,385 | 244,562/20,000 | X |
| E5N59 | 800,786/199,214 | 246,225/53,775 | 151,780/41,037 | U |
| E6N59 | 836,490/163,510 | 255,720/44,280 | 243,732/26,000 | O |
| E7N57 | 781,362/218,638 | 199,253/100,747 | 150,314/34,156 | Z |
| E7N58 | 803,408/196,592 | 239,987/60,013 | 194,206/34,310 | L |
| W1N57 | 811,534/188,466 | 240,000/60,000 | 247,722/10,145 | K |

- **E4N58 的 8M 容量 = PowerCrept 技能 `PWR_OPERATE_STORAGE`（Operate Storage）生效**（用户会话澄清）：时间对照（73614430→73614479，49 tick）显示该行实时漂移且内部自洽——used 与 storageEnergy 同步 −3,898、used+free 恒等于 8,000,000；其余 7 房恒 1M（未施放）。账号 power 数据（auth-me：power 2,182,509、powerExperimentations 30）与 Memory 根 `powerCreeps` 键印证。**口径结论：hub 房 Storage 容量随技能在 1M↔8M 波动，容量基线/比较逻辑不得假设恒 1M。**
- 各房 minerals 键均含 H/O/U/L/K/Z/X 七类库存记录；taskHealth 全零挂起。
- **结构身份（Storage/Terminal 的 structure ID）：Memory 不缓存（rooms.* 仅杂项键），只读 REST 亦无房间对象接口 → 只读通路无法取得**（console 表达式注入不在授权内）。候选房间按库存/矿型可定位（如 E3N59 为原生 H 房），结构 ID 留待部署窗口内经合法途径取得或标 N/A。

### 其他实时信号

- `analytics.cpuMonitor.latest`：tick 73614429、**bucket 10000（满）**、totalUsed 56.64 / limit 120。
- `data.marketSaleAutomation.marketActionJournal`：42 条，最新一条 tick 72604730（约 38 天前）——近期无市场动作记录；journal 含 managedOrders/feeLedger/marketReservations 等完整子系统状态。
- Memory 根另含数百个 `__manual*/__codex*/_diag*` 历史控制台实验遗留键（用户既往实验，非本轮产生，未触碰）。

## 与旧快照/无法取得字段的区分

- 实时原始：上表全部（两次读取间隔 49 tick 的时间对照支持"实时"判定）。
- 旧监控快照（已被本轮取代）：canary3.jsonl 2026-09-09T18:55Z 投影。
- 无法取得（只读接口）：Storage/Terminal 结构 ID；Game 级实时对象（视野、rampart 等）。

## 限流终态

2 小时窗口自然过期后恢复限流（未做反向开关——不在授权内，且会再次饿死用户自有监控）。用户既有 canary3 监控全程未触碰；本轮全部读取均在其饥饿间隙外（免限流窗口内）完成。
