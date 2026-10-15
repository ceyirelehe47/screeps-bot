---
name: screeps-game-data
description: 诊断 Screeps 的实时房间、creep、任务、移动和 CPU 问题，优先使用 console 聚焦读取 Game 与运行时状态，再按需要补充 socket 轨迹、Memory 或遥测。
---

# Screeps 实况诊断

**默认优先使用游戏 console 聚焦读取，尽量一次批量取齐当前问题所需数据。** Game 与 heap 中的实际路径、目标、疲劳和动作，比配置中“打算去哪”更接近现场。不要先猜代码，也不要强制先运行 monitor:once、遍历所有 shard 或连续读取多份完整 Memory。

## 首选：一次 console 只读查询

当前工作树包含监控入口时，使用：

```bash
npm run monitor:inspect -- --mode pair --room E3N53 --shard shard1
npm run monitor:inspect -- --mode movement --creep-prefix remoteCarrier- --shard shard1
```

按问题选择房间、精确 creep 名称或前缀，控制输出范围。入口说明以 `node scripts/monitor-inspect.mjs --help` 为准。若当前 checkout 较旧，可从本任务的活动工作树使用脚本绝对路径，工作目录仍保持在含认证配置的仓库；不要为诊断重新构建或部署游戏代码。

- 先核实账号与 activeWorld 分支。已知 shard 时直接指定；只有身份冲突或完全不知道活动 shard 时才做一次必要的发现。
- 根据当前问题选择 movement、pair 或 threats 模式，一次只提交一个固定查询。三种模式都读执行 tick、实际 shard、部署 tag、位置、载货、疲劳和现有角色参数；movement 补 heap 路径，pair 补编队阶段/入口/退路，threats 补有界敌情。不要为每次诊断机械地连发三种模式。区分“任务配置目标”和 heap 中当前 travel/path 目标。
- 必须先建立 console socket 订阅，再提交一次查询，并捕获同一 requestId 的完整返回。`POST /api/user/console` 的 accepted 只证明入队，不证明已执行或已拿到数据。
- 校验返回的实际 shard；需要固定版本时同时校验 tag。直接读取返回的 Game.shard.name 即可验证执行位置，不为普通只读诊断先写 Memory probe。
- console 输出可能将 JSON 引号编码为 `&#x22;`、`&#34;` 或 `&quot;`；先尝试原始 JSON，仅在需要时单次解码 HTML 实体，避免把用户字符串二次解码。
- 查询采用固定只读模板，选择器作为数据传入；不运行角色、寻路、市场或其它有副作用的业务函数。不把全局对象和完整 Memory 全量展开。
- 选择器、表达式与结果应有上限；表达式编码后超过 API 限制时在请求前明确失败。身份、订阅、429、POST 拒绝/结果不确定、返回缺失和错 shard 分别报告，不盲目重试。

入口尚不能覆盖所需字段时，可使用本 skill 的 `console-api.mjs --shard shard1 --expr ...` 提交有界只读表达式，但仍须先接 console socket、使用唯一标记并捕获结果。该 helper 仅打印 accepted，不能单独作为实况证据。它的 `--probe` 会临时写 Memory，只用于明确需要的执行通道故障排查，不是常规读取前置步骤。

## 根据问题补充证据

| 需要证明什么 | 合适的数据源 |
| --- | --- |
| 现在去哪、为什么停、正在躲什么 | 首选 console：实际 Game + heap 路径/意图 + 相关任务状态 |
| 来回走、脱队、两 tick 一格、阻挡后能否恢复 | 聚焦房间 socket 的有界连续帧，必要时起止各一份 console 状态 |
| 历史趋势、已启用的 CPU span、任务生命周期 | 已有遥测/Memory 的对应小范围字段 |
| console 暂不可用、离线分析、持久配置本身有问题 | 聚焦 Memory API；需要整体现状时才用 monitor:once |

一次 console 快照不能证明连续移动。轨迹按房间分别重建 delta，保留帧缺口、疲劳、动作和目标；不能将稀疏位置变化当成逐 tick 路径。只采当前对象需要的窗口，到时关闭订阅；不要每帧反复 GET 同一批 Memory。

配置、旗标名称或旧任务布尔值不能代替当前身份。涉及 Invader 回收时核对原生 owner/reservation/Core 或可识别遗产；不要因名字带 INVADER 就把玩家房当成合法目标。

CPU 归因使用已有计时与真实调用链，区分包含型父子 span、采样点和滚动窗口；终止栈只定位中断位置，不能直接断言该函数耗尽了全部预算。采样未 flush 的 tick 不能冒充已通过。

## 补充监控入口

需要历史/整体遥测或 console 不足时，从仓库运行：

```bash
npm run monitor:once
```

核对 selectedShard、latestTick、部署 tag 和所需字段是否新鲜。只有当前没有可靠 shard 时才启用自动选择，不默认扫描其它 shard。

已有 segment 导出开启、且确实缺字段时才读对应 segment；不要为只读诊断自行启停遥测或 profiler。长期观察需要时再使用 `npm run monitor:serve`，完成后停止。默认保持聚焦 console 单次读取。

## Screeps API 限流

Screeps 官方文档说明，普通浏览器和 Steam 客户端请求不受此限流约束，使用 auth token 认证的请求会受限制。超过限制会返回 HTTP `429 Too Many Requests`，响应体例如 `Rate limit exceeded, retry after 51243ms`。

本项目常用接口的官方 auth token 限额：

| 接口 | 限额 |
| --- | --- |
| token 总限额 | 120 / 分钟 |
| `GET /api/user/memory` | 1440 / 天 |
| `POST /api/user/memory` | 240 / 天 |
| `GET /api/user/memory-segment` | 360 / 小时 |
| `POST /api/user/memory-segment` | 60 / 小时 |
| `POST /api/user/console` | 360 / 小时 |
| `POST /api/user/code` | 240 / 天 |

限流响应包含下列提示头：

| 响应头 | 含义 |
| --- | --- |
| `X-RateLimit-Limit` | 当前窗口允许的最大请求数 |
| `X-RateLimit-Remaining` | 当前窗口剩余请求数 |
| `X-RateLimit-Reset` | 窗口重置时间，UTC epoch 秒 |

若 `monitor:once` 输出 `"memory": null`、console probe 收到非 JSON 的 `Rate limit...`，或 helper 报 `429`，停止反复轮询。继续重跑会消耗额度并拖延恢复。

需要估算当前窗口何时恢复时，从仓库根目录执行一次受限状态请求，不输出凭据：

```bash
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(".secret.json","utf8")); const t=process.env.SCREEPS_TOKEN||s.main?.token; fetch("https://screeps.com/api/user/name",{headers:{"X-Token":t,"X-Username":t}}).then(async r=>{const reset=r.headers.get("x-ratelimit-reset"); const now=Math.floor(Date.now()/1000); console.log(JSON.stringify({status:r.status,limit:r.headers.get("x-ratelimit-limit"),remaining:r.headers.get("x-ratelimit-remaining"),reset,secondsUntilReset:reset?Math.max(0,Number(reset)-now):null,body:(await r.text()).slice(0,80)},null,2));})'
```

用户询问还需等待多久时，使用 `secondsUntilReset`。响应头缺失但响应体包含 `retry after Nms` 时换算为秒/分钟。不把 token 放入 `curl` 参数、日志、聊天或命令输出。

Screeps 官方的 [auth token 文档](https://docs.screeps.com/auth-tokens.html)提供 2 小时解限页。用户已明确授权本仓库在需要时用内置浏览器自行完成这一步。页面使用 Google Invisible reCAPTCHA；遵守电脑操作工具在点击或完成验证码时的当场确认要求。若弹出必须由人解答的挑战，交给用户，不通过其他接口绕过。

已于 2026-09-24 实操成功的内置浏览器流程（从仓库根目录运行）：

1. 先确认当前确实使用 `SCREEPS_TOKEN` 或 `.secret.json` 的 `main.token`，避免解限旧令牌。可运行 `node .codex/skills/screeps-game-data/no-rate-limit.mjs --status`，只输出状态和到期时间，不输出令牌。
2. 运行 `node .codex/skills/screeps-game-data/no-rate-limit.mjs --redirect`。它只在 `127.0.0.1` 建立 60 秒、随机路径、单次使用的跳转，终端仅显示本地 URL；真实令牌不会进入命令参数、聊天或工具输出。用内置浏览器打开这个本地 URL，确认最终域名为 `screeps.com`，并在读取页面状态时遮掉 URL 的 `token=` 参数。
3. 在官方页面看到令牌掩码和 `Rate limiting will be turned off for 2 hours` 后，按当前电脑操作规则处理确认，再点击 `Proceed`。页面显示 `Success! You can close this window now.` 才算浏览器步骤成功。随后关闭带令牌参数的临时标签页。
4. 再运行一次 `--status`；`noRatelimitActive: true` 且 `noRatelimitUntil` 是未来的毫秒时间戳，才算令牌状态核验通过。读 API 的限流响应头可以作为附加信号，不单独充当成功证明。若失败，记录页面或状态错误并停止反复重试。

内置浏览器的虚拟剪贴板未必与 macOS `pbcopy` 同步；不要把完整令牌 URL 打印出来再交给浏览器工具。用户若选择自己完成，也可由本地脚本安全地复制官方链接给用户，但不要在聊天中展示令牌。

## 操作边界

- 凭据只从 SCREEPS_TOKEN 或 .secret.json main.token 读入内存；不打印、复制到服务器或提交 token。
- 用户问游戏状态或原因，已授权进行必要的只读 console/API/socket 诊断，无需再次询问是否允许读取。
- 读取不授权改 Memory、旗标、出生队列、市场、遥测配置或游戏代码；这些变更按用户本次及已有授权范围执行，不重复索取已给过的批准。
- 不用 Memory 写入承载常规读取结果。保留带 tick/shard/tag/requestId 的本地证据，写入忽略的 monitor-data 目录；不要把私有完整快照提交仓库。
- 先报告已确认事实；目标配置、实际路径、已发意图与帧末移动分别表述。数据缺失时直接说缺什么，不把缺项解释成无路径或无动作。
