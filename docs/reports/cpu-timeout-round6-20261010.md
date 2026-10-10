# CPU 第六轮：错峰规划与超时诊断

本轮候选从实际线上提交 `182e5f43f4b7ca99197eaf826478ac62c2ed723f` 创建，保留近期新房矿工支援与 T3 耗塔修复。当前状态为候选验证中，尚未上传正式服。

## 现场与证据边界

用户报告 2026-10-10 出现 3 次 `Script execution time out ungracefully`，最近一次通知约北京时间 17:00。

20:55 的独立 API 读取确认账号 `forster`、`shard1`、代码分支 `default`；部署标签为 `2026.10.8-1+182e5f4@2026-10-08T11:09:03.753Z`。线上 main 为 3,666,448 字节，SHA-256 为 `6a7edd67955cfa488cb00530ceaf286bf2c6804d90aba380284f4d15a57d305b`；Memory 为 1,595,756 字节。

该次 120 个已完成 CPU 样本的平均总 CPU 为 94.21，最高 193.85，最低 bucket 为 9907；账号 limit 为 120，tickLimit 为 500。平均主要阶段为 creepWork 29.04、市场预检 12.48、PowerBank 调度 11.18、Observer 6.14。creepWork 子阶段已经包含在父阶段内，不能重复相加。当前成功样本不能解释 17:00 的中断，也不能证明没有偶发尖峰。

20:55:24–21:00:21 的只读 console 订阅捕获 71 个事件，没有错误；5 分钟观察不能作为消除每日三次超时的验收。

[官方 CPU 文档](https://docs.screeps.com/cpu-limit.html)明确单 tick 上限由 tickLimit 表示；[运行环境说明](https://docs.screeps.com/architecture.html)描述超时可能终止整个执行进程并重建 global。由此不能把 bucket 正常等同于不会发生这种通知，也不能把所有 global 重建都归因于本账号代码。

## 实现

- 自动缺失布局与外矿道路重规划共用每 tick 一个重规划名额；现有布局的建设检查按 lastRunAt 排队，每个主循环 tick 检查一个到期房间。完成后自然形成不同规划 tick。
- 外矿到期道路按矿点轮转，每 tick 最多尝试一个计划。测路失败也推进游标；无视野任务不占名额。Game 对象跨 tick 重建不重置轮转。容器规划和已有工地推进继续执行。
- 新重规划的启动门为 `used < min(limit × 1.5, tickLimit − max(50, limit))` 且 bucket 至少 2000。当前 limit=120 时，启动阈值为 180 CPU。每个外矿源搜索、每段 PowerBank 搜索前再次检查余量；只推迟新的规划，不让部分路径成为完整证明。
- 迁入尚未上线的第五轮 PowerBank 优化：同 tick 原生所有权事实共享、同一次路线查询的危险集合共享、三段完整路径共用房名坐标表。可变 intel 继续重读，实际跨房安全门继续检查原生视野，已有完整路径缓存继续可读。
- profiler 启用时新增 `Memory.analytics.cpuMonitor.health`，记录 global 重建数、最近完成 tick 和完成缺口。heap 保留的中断可以保留最后阶段与 creep；heap 丢失后仅记录重建和缺口，不猜测丢失的阶段。缺口可能来自暂停、异常或超时，不能单凭它确诊 ungraceful timeout。未采样 tick 仍不增加 profiler 的 getUsed 调用。

未更改主循环生产顺序、市场每 tick 核验、Treasury 权限、普通采矿/搬运/补员/防御动作、现役任务或线上配置。未清理历史 Memory，也未调整 profiler/telemetry 开关。

## 验证

全部构建、类型检查、Jest 与性能对照在 dsh 隔离目录 `/srv/screeps-treasury-build/cpu-timeout-r6-20261010/` 执行；本机仅编辑、查询、传输和校验产物。

首轮测试类型检查发现新 fixture 缺少 CPU 类型字段和布局 timestamp，修正后生产与测试两份 TypeScript 检查通过。13 套定向回归、129 项测试通过，覆盖失败轮转、跨 tick Game 重建、低余量延后不消费时间、独立容器建设、缓存复用、所有权安全、路径连续性、主循环顺序与监控零额外计时。

完整回归、性能对照与冻结产物结果将在验证完成后补入本报告。

## 发布与后续验收

候选目录为 `/Users/forst/code/screeps/.codex/worktrees/cpu-timeout-r6`，分支为 `codex/cpu-timeout-r6`。正式服发布沿用用户此前要求，需要本轮单独明确批准；这次错峰规划许可没有被解释为代码上传许可。

正式发布前应重新读取活动版本与 bundle SHA，保存当时线上代码及 Memory 现场；上传冻结字节后独立读回。发布后需要跨越用户当前的每日故障频率观察，核对新版本 CPU 分布、global 重建/完成缺口、超时通知和正常生产。短窗口与服务器 Node 组件性能对照均不能替代此验收。
