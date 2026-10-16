# 战争调度与角色寻路优化

方案基于旧的 `a9c1f81`，本次在已上线的 `1e0b96dbc97db6797a0a022462e86e4a04e888a2` 上实现，保留扫描修复、CPU、许可链和面板改动。用户已批准完成后上线；正式发布版本为 `2026.10.17-3`。完整回归、正式产物和实服发布证据保存于本机忽略目录 `monitor-data/war-scheduling-20261017/`，发布后不追加文档提交，保持 main HEAD 与实际发布 commit 一致。

## P0：可归因计时

战争调度增加 `war.shared`、`war.process`、`war.telemetry`、`war.rebuild`、`war.loot`；角色增加 `war.chooseWarApproach` 和 `war.exitPaths`。沿用既有采样条件与 room×role 聚合；没有开启或修改实服 profiler 配置。细分 span 为包含式计时，不可与父 span 相加当总 CPU。

上线前只读 console 在 shard1、tick `74377582` 确认线上仍为 `2026.10.17-2 / 1e0b96d`。已有采样 tick `74377576` 的 War 为 1.2216 CPU，E2N54 攻击兵一名为 9.3735、治疗兵一名为 1.0675 CPU。这只是一个样本，不能与后续不同负载直接比较并宣称整体收益。

## P1：调度去重与幂等

| 对应项 | 实现 |
| --- | --- |
| H1、H2 | queued 和 terminal 的入口副作用幂等；共享非 owner 撤销后只检查有限成员是否出现新活动，保留恢复和取消路径。新出生的 queued 成员从配置索引补上标记。 |
| H3 | 队列中确有配置才替换数组；同帧重复取消不重复提交原生 intent。 |
| H4 | 在构造新 args/body/config 前比较规范字段；采用直接比较而非哈希，外部原地改坏配置时仍能修复。保留 spawnOnce 时间戳。 |
| H5 | generation 的 argsVersion 包含目标、路线、队形、世代、搭档和成员名字；只在变化或新成员出生时同步，巡逻推进仍重置旧目标。 |
| H6 | TickContext 新增孵化配置索引；可变队列索引限定在一次战争调度内，并在增删时失效，避免其它模块或 console 读取到跨调用旧队列。共享成员换名后立即更新配置索引。 |
| H7 | 当前调度内按 room、队形和 ignore IDs 缓存敌情；新一轮调度重新读取。 |
| H8 | 遥测状态变化立即更新，其余每 10 tick；低 bucket 每 20 tick。终态快照冻结，console 状态查询仍可构造当前快照。Memory 对象重新解析不会绕过 cadence。 |
| H9 | updatedAt 改为状态/请求变化时更新；lastHostileSeenAt 最长每 10 tick 采样，战斗判定仍每 tick 读取当前敌情。 |
| H10 | members 显式记录配置、名字和首次观察出生 tick；旧配置、旧世代、历史 Memory 与孤立队列一次性迁移。后续登记出生、死亡和共享转移，有限成员替代全量前缀扫描。spawnCreep(OK) 当帧即登记名字，停止任务可解绑尚未进入 Game.creeps 的新生 Memory。 |
| H11 | 路线与 NPC 评估用房间哈希错峰，保持最迟 100 tick 复核；初次评估即时，首次对齐可提前。重复战区请求不再重新构造相同任务；显式策略复核仍能升级 NPC 队形。 |
| R3、R4 | 搭档走配置索引并校验当前身份，反击房间快照仅在当前帧复用。 |

## P2：几何与目标决策缓存

- 同房目标评估共享当前帧几何 CostMatrix；修改突破成本时克隆基底，避免污染开放路径证明。
- approach 只缓存目标/屏障 ID 与决策，不缓存移动许可；TTL 为 4 tick，目标、相邻攻击格、几何签名和大距离跳位会使其失效。每次最多评估两个目标，未评估的核心轮转。ops 耗尽仍拒绝破墙。
- 普通队伍且没有可补能敌塔时允许 reusePath=3；耗塔队伍和存在塔威胁时保持 0。塔能量、补能者、身体、体力和最终退路门仍新鲜读取。
- 地形、道路/沼泽、不可走结构与天然障碍共用有容量上限的静态层；入口图叠加当前工地、控制器和守军。相同物理地形可跨 native wrapper 复用，内容变化重新构图。
- 原生地形 buffer 按官方 `raw[y * 50 + x]` 转换到内部索引，适配器没有原生 buffer 时回退到 get。参见[官方 API](https://docs.screeps.com/api/#Room.Terrain.getRawBuffer)。
- 塔伤表键包含塔位置和有效 Operate Tower 等级；退路 BFS 仅同 tick、同几何、入口、守军和塔威胁复用，保留双人路径联通证明和受损身体重算。
- 静态房间层最多 16 房，塔表/入口图/同帧退路最多 32 项，approach 与候选游标最多 128 项。跨 tick 持久缓存仅存标量、ID 和数组；当前活体对象放在以 Game 为弱键的帧缓存。

## P3：模块与状态边界

公开入口 `warControl.ts` 保留既有 API，内部拆为 `war/store.ts`、`fsm.ts`、`production.ts`、`lifecycle.ts`、`admission.ts`、`shared.ts`、`patrol.ts`、`rebuildWatch.ts`、`observation.ts`、`telemetry.ts` 等。admission 统一协调共享、串行与并行准入；状态表约束终态只能通过显式重启恢复，入口效果成功后才标记完成，失败可重试。

`SquadPolicy` 的 standard、t3Duo、towerDrainDuo 分别声明人数、身体、并行、boost、控制器与中立墙政策。staging 无视野与未到期 patrol_waiting 最多每 5 tick 调度，但成员、孵化、来源房能力、路线和视野变化会唤醒；战斗中的任务不降频。低 bucket 仅降低诊断和重建观察请求频率，已有待观察结果和战斗门仍及时处理。

## 同输入 A/B 证据

[机器可读摘要](./2026-10-17-war-scheduling/ab-summary.json)与[原始方案](./2026-10-17-war-scheduling/原始方案.md)。基线产品代码为 `1e0b96d`；基线和候选使用同一份加计数的集成/调度测试 fixture，计数包含矩阵克隆。

网格共 274 帧，位置、移动意图、攻击调用记录逐帧一致。适配器不模拟完整官方引擎，不能把这些帧描述为实服战斗证明。

| 网格计数 | 基线 | 候选 |
| --- | ---: | ---: |
| PathFinder 直接调用 | 218 | 84 |
| CostMatrix 创建及克隆 | 1036 | 808 |
| terrain.get 调用 | 7273893 | 151637 |
| 移动 findPath 调用 | 288 | 288 |

固定调度负载为 3 任务、150 live creep、250 Memory.creeps、3 spawn，观察预热后的 10 tick：

| 模式 | Game.creeps 全扫 | Memory.creeps 全扫 | 任务字段写入 | spawnList 替换 | 遥测写入 |
| --- | --- | --- | --- | --- | --- |
| 串行：基线 → 候选 | 70 → 10 | 20 → 0 | 110 → 1 | 270 → 0 | 10 → 1 |
| 共享：基线 → 候选 | 90 → 10 | 40 → 0 | 130 → 1 | 120 → 0 | 10 → 1 |

候选每帧的一次 creep 扫描是共享 TickContext 建索引；唯一任务字段写入是低频敌情时间戳。没有将调用次数变化等同于实服 CPU 降幅。
