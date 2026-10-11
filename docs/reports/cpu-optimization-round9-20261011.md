# CPU 第九轮：Power Bank、Observer 与观测口径

本轮从已核对线上字节的 `fe2eabf6d5aa89128f2d8f60c2a70e0556d9c5b1` 建立独立候选，分支 `codex/cpu-optimization-r9`。用户同意继续优化后实施代码与离线验证；正式服上传仍需本轮明确批准。所有构建、测试与性能对照在 dsh 隔离目录 `/srv/screeps-treasury-build/cpu-optimization-r9-20261011/` 执行。本机仅编辑、查询、传输与校验。

## 当前基线

2026-10-11 14:41 北京时间，账号 `forster`、shard1 的 120 个完成采样平均业务阶段 CPU 为 98.47，最高 208.33，额度 120，最低 bucket 9696。市场预检查平均 13.58，Power Bank 调度 10.74，Observer 6.87，遥测导出 4.31，寻路子项 2.65。父阶段包含子调用，子项也可能出现在其它模块，不能重复相加。

独立 code GET 核对线上 main 为 3,673,464 字节，SHA-256 `451db260b4985ff9bf2d5bdcbbc20e669835463a780ed5f7632628e3d4e7220a`，与第八轮冻结产物一致。15:32 的只读复核再次确认账号、activeWorld 分支 default、shard1 标签和完整 main SHA 均保持该基线。原始只读审计复制到本工作树的 `monitor-data/cpu-r9-evidence/baseline-readonly.json`，不进入 Git。

现场存在 5 个 discovered Power Bank 与 1 个 attacking 任务；若干等待任务反复处于 `target_not_visible` 或 `path_measurement_pending`。这些状态支持检查重复计算，不能单独证明某个子函数占用了整个调度阶段。

## 实现边界

### 来源路线

原来源评估对所有合格房间重新取得房间级路线，只在同 tick 复用结果。新模块保存最多 64 条纯房间名走廊，正路线最多复用 25 tick，并以 shard、世界范围、起终点和完整危险集合为键。每次跨 tick 命中重新读取沿途房间状态及每段真实出口；同帧多条走廊共享这些原生地图事实，下一帧或原生 reader 替换即重读。闭房、断连、危险集合变化、世界变化或同 tick 替换地图均回到原路线查询。缺少地图证据时只保留原有同 tick 复用。

无路结果不跨 tick 复用。调用方得到数组副本。来源资格、归属、库存、增益物资、剩余寿命、Spawn 集合与完整三段 PathFinder 证明继续按原流程检查。现役任务的战斗与运输流程没有换用这份缓存。

这份缓存只证明当前走廊有效，不声称每 tick 都重新选取最短走廊；其它通道新开放时，已有有效走廊最多保留到 25 tick 的期限。失去连通性时立即重查。未完成三段测量的阶段恢复仍作为后续方案，本轮不扩大准入证明的修改范围。

### Observer 几何

活跃 Observer 仍按每 tick 的真实结构、所有权与 `isActive` 查询。坐标距离仅在原生结果与标准房间坐标的非环绕距离一致时进入有界纯数据缓存；自定义地图或不一致 mock 保留原生查询。键包含 shard、世界范围、来源房与目标房；同 tick 服务或世界替换、时钟倒退清空几何缓存。

请求期限、公平轮转、独占覆盖、每房 500 tick 巡逻、当前威胁与实际 observe 意图均保留原行为。几何候选排序已在第八轮缓存，不重复计为本轮收益。

官方 [Map 实现](https://github.com/screeps/engine/blob/master/src/game/map.js)和 [API](https://docs.screeps.com/api/#Game.map.getRoomLinearDistance)是距离与出口语义依据。

### 遥测与 CPU 口径

debug 投影在一趟 creep 扫描中读取 movement 状态、累计完整计数、选择前 25 名，保留原评分与同分名称顺序；未选中的成员仍进入计数和 truncated 判定。CPU 样本新增可选字段 `startupUsed`、`tickUsedAtFlush`、`topLevelUsed`，外部遥测与只读 monitor 同步透传。

`totalUsed` 保持旧业务阶段口径；`startupUsed` 是该起点之前的累计开销，包含首次 Memory 访问与健康初始化等，不能称为单独的 Memory 解析计时。`tickUsedAtFlush` 是 flush 边界累计值，不含后续样本持久化与引擎收尾。`untracked` 从业务阶段总量减去最外层 measure 总量，避免 inclusive 子阶段把未追踪成本压到零。沿用原时钟读取数量，disabled 与非采样 tick 不新增 getUsed 调用。

现场 profiler 与遥测均每 7 tick 工作，采样点总包含导出。导出阶段 4.31 CPU 按现有频率粗摊约 0.62 CPU/tick，不代表逐 tick 稳态成本。本轮不调整实服采样配置；后续观测需分别报告业务阶段、启动边界与遥测采样偏差。[Memory 首次解析的官方说明](https://docs.screeps.com/global-objects.html)

## 市场持久状态的后续设计

14:43 的只读尺寸统计显示原始 Memory 约 1.59 MB；市场对象重序列化约 1.03 MB，其中 V3 permitChain 约 0.76 MB。本轮只提供设计，不迁移或删除线上许可链。

1. 先按 permitChain 的真实子项盘点活动许可、退休通道、前缀检查点与冷审计证据；区分日常授权所需证据和仅供回放的数据。以字节数、每 tick 规范化调用数、cold-start 时间建立独立基线。
2. 优先评估保持完整字节恢复能力的无损紧凑表示。旧 v1 canonical 摘要、quota/ratchet 高水位、nonce 重放拒绝、前缀承诺与 root CAS 必须逐项保持。只减小日志数组或只信任自报 digest 不构成许可。
3. 若采用冷 segments，先实现统一激活协调。目前遥测直接调用 `setActiveSegments([90])`，会覆盖其它申请；不能直接把市场关键状态搬入另一个 segment。热区只保存有版本的 manifest、长度、内容校验、epoch 与恢复状态。
4. segment 未就绪、校验失败、跨版本或 global 重建时，保持新交易不可写；未决 WAL、交易结果与资金占用必须仍可恢复。不能让“冷数据未载入”被当作“没有历史责任”。
5. 离线回放至少覆盖授权/通道退休、配额与价格高水位、未知 native 结果、迁移中断、坏 segment、读取延迟、重建与回退；真实操作前还要固化全量备份和本轮授权。完整回放等价与 CPU 对照通过后才形成单独候选。

## 验证记录

首版两份 TypeScript 检查通过；14 套定向回归、182 项通过，零失败和 pending，覆盖路线失效、任务轮转、全部 active Spawn 的证明、Observer 公平性、遥测排序及低开销 profiler。最终类型检查在隔离依赖修正后通过。完整回归初次运行因服务器 /tmp 的 1.9 GB tmpfs 用满而失败，本轮自己的 transform 缓存已移至独立磁盘目录，后续测试使用该目录和独立 TMPDIR；其它任务缓存保持原样。该失败不计为通过。最终完整回归结果在完成后补入本节。

最终组件对照以线上提交 `fe2eabf6` 的原源码为基线，每项预热后交错先后顺序测试 7 组，共 21 组，输出 SHA-256 全部一致。地图/A* 部分直接载入官方 engine 源码，保存下载字节的 SHA-256；fixture 建立和输出摘要在计时外。各列分别取中位数，降幅按逐组比例取中位数。

| 组件 | 每组输入 | 基线中位 ms | 候选中位 ms | 逐组降幅中位数 |
| --- | --- | ---: | ---: | ---: |
| 来源路线 | 240 帧，每帧 24 对来源/目标 | 690.15 | 247.95 | 63.71% |
| Observer | 480 帧，3 Observer、99 候选房 | 359.99 | 241.17 | 37.63% |
| debug 遥测 | 1,200 帧，每帧 90 creep | 432.56 | 87.89 | 79.68% |

路线对照包含新 Game/map、途中闭房与世界范围变化；每组真实 A* 查询从 5,760 次降为 470 次，同时增加当前地图事实核验。初版走廊核验的状态/出口读取为 57,840/52,320 次，最终同帧共享后为 15,120/14,160 次。Observer 包含来源成员变化与世界范围变化，原生距离查询从 64,882 次降为 335 次。debug 状态读取从 1,198,800 次降为 108,000 次，输出排序、完整计数和截断均相同。

脚本与逐组结果分别保存于本工作树 `monitor-data/cpu-r9-evidence/components-ab.cjs`、`components-ab-results.json`；服务器原件在同名 evidence 目录。早期脚本缺失 fixture 依赖的运行失败单独保留，没有计入通过组数。

这些百分比只描述服务器 VM 的具体组件。来源对照没有执行全部准入状态机或三段原生 PathFinder；Observer 对照将候选集合视作输入，没有覆盖真实候选开放状态过滤；debug 对照没有覆盖整份遥测序列化与分段写入。各项不能相加，也不能换算成实服整 tick CPU。发布后需取得同版本完整新窗口。
