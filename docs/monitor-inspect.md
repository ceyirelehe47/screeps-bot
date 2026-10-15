# 一次只读 console 诊断

`scripts/monitor-inspect.mjs` 用一次有界 console 查询，读取选定 creep 的实际 Game 坐标、血量、疲劳、载货与任务事实，以及选定房间的控制器和出口。按排障需要选择移动、编队或威胁模式；一次只执行一个固定 query。它不依赖遥测刷新，也不通过 Memory 写探针确认执行；不启停遥测、寻路或调用角色业务函数。

从仓库根目录使用 Node.js 22 或更新版本：

```bash
node scripts/monitor-inspect.mjs --shard shard1 --room E3N53 --creep-prefix remoteCarrier-
node scripts/monitor-inspect.mjs --mode pair --shard shard1 --room E3N53 --expect-tag '<完整线上tag>'
node scripts/monitor-inspect.mjs --mode threats --shard shard1 --room E3N53
```

默认 JSON 输出到 stdout，并保存为新的 `monitor-data/inspect-<requestId>.json`，权限为 `0600`。可以用 `--out monitor-data/my-inspect.json` 指定新文件，已有文件拒绝覆盖；`--out -` 只输出 JSON。失败也保存分类、HTTP 状态和受限脱敏原因。工具不接受 `--token`，凭据只从 `SCREEPS_TOKEN` 或 `.secret.json` 的 `main.token` 读入内存，不打印或存盘。

## 查询与身份边界

- `--room` 最多 3 个，自动选中这些房间内的自有 creep；与 `--creep` 精确名称、`--creep-prefix` 前缀按 OR 合并。名称和前缀各最多 4 个，前缀至少 6 字符。最大返回 8 个 creep，`--limit` 可进一步收紧；达到上限时不保证精确名称优先。不自动遍历其它 shard 或整个 Memory。
- `--mode movement` 是默认模式，包含真实 movement heap 的 travel/path 目标、cursor、stuck 与短路径候选；`--mode pair` 包含现有 `_warTowerDrain` 的 phase、目标房、红绿入口、退路房和 blocker；`--mode threats` 包含可见敌兵的 owner 和塔、spawn、Invader Core 摘要。每种模式都有自有 creep 的位置、HP、fatigue、原生 store 各资源和载货总量，以及已存在的 roleArgs 前 3 项、working。所有模式均返回房间可见性、controller owner/reservation 与 `Game.map.describeExits`。
- `--shard` 默认 `SCREEPS_MONITOR_SHARD` 或 `shard1`，必须与执行结果的实际 `Game.shard.name` 一致；不自动探测所有 shard。
- 先用 `/api/auth/me` 核对预期账号，默认 `forster`，可用 `--username` 或 `SCREEPS_MONITOR_USERNAME` 配置；可再用 `--user-id` 精确约束 ID。activeWorld 必须与 `--branch` 或 `.secret.json main.branch` 一致，默认 `default`；不接受 `auto`。
- 可选 `--expect-tag` 在客户端核对实际执行时的部署 tag。返回执行 tick、实际 shard 与 tag，不能把客户端提交时间当作执行时间。

只提供固定只读 query builder；`--expr`、注入字符串和未知选项都会拒绝。console 表达式的唯一输出动作是带 requestId 的 `console.log`；不会写入 Memory/global、创建 flag、市场操作或执行任意用户代码。Game 原生对象的读取可能有其正常 CPU 成本，这不是零开销采样。

官方开源 backend 的 console handler 对 `JSON.stringify(expression).length` 设置 **1024** 上限。工具用紧凑固定 wire 传输，并在任何网络请求前检查表达式大小；选择器太长会明确失败，请缩小精确名称/前缀/房间范围。不会盲目重试、自动拆成多次 POST，或用 eval 绕过上限。[官方 backend 实现](https://github.com/screeps/backend-local/blob/master/lib/game/api/user.js#L316-L320)

## 成功必须收到执行结果

顺序为：核账号与 activeWorld → WS 认证 → 订阅该账号 console → 收到该频道帧，确认服务器已处理订阅 → 唯一一次 console POST → 收到相同 requestId 的合法结果。只有 POST 明确 accepted **且**结果通过 requestId、shard、tick、可选 tag 校验，客户端才输出 `ok: true`。POST accepted 自身不代表查询已执行。

Screeps 实际 console wire 会把引号编码成 `&#x22;`，也可能出现 `&#34;` / `&quot;`。解析器先尝试原始 JSON，失败时只做一层 HTML 实体解码；不会递归解码 creep 名称或字符串里的字面实体。支持有界 gzip 帧，不把不相关 console 日志写到文件。

任何 429、订阅拒绝、socket 断开、结果缺失、错 shard、错 tag 或不确定 POST 都结束本次请求，不自动重连或重试。默认总期限 45 秒，可用 `--timeout-ms` 设置 1000–60000；socket、监听器和计时器都会关闭。`mayHaveExecuted: true` 表示 POST 已开始但没有可靠完成状态，不能据失败结果盲目补发。

## 怎样解释 heap 与采样结果

为满足单次 1KB 表达式上限，任务参数仅返回选中 creep 已存在的 `Memory.creeps[name].roleArgs` 前 3 项，不展开配置层完整任务对象。pair 的 phase/entry 只读取已存在的 `_warTowerDrain`；movement 直接读 `global.__creepMovementState[name]`，不调用会创建状态的 helper，也不使用 `creep.memory` getter 初始化缺失项。heap 中 travel/path 的目标、cursor、stuck 与短路径片段是当前原始观测，travel 的片段来自真实 `multiRoomSegment.positions`；没有 heap 或片段不代表已经无路。候选是原始 cursor 之后最多三步，固定查询不模拟业务的路径恢复、碰撞结算或下一步安全策略，因此它不能当成已接受移动意图，更不能当成已经位移。

选择和输出均有限额：最多检查 1000 个 creep 名称；threats 最多返回每房 8 个敌兵，先检查最多 128 个 hostile structures 再返回其中最多 8 个目标结构，不能用数组长度推断完整敌情数量。输出过大只返回失败标记，不把部分结果当成功。房间不可见明确返回不可见状态，出口仍可用；缺少可见敌情不能解释为安全。任务字段只作只读快照，不保证之后 tick 的业务状态；一次结果也不能证明持续推进或稳定性能。

本工具是独立 CLI，不向已有 web monitor 增加任意 eval 端点。它不替代已有被动 CPU/房间 delta 监听器；需要连续物理进展证据时仍应使用有界订阅记录。
