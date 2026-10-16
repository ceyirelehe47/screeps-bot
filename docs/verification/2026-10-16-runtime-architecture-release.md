# 运行时专项正式发布记录

用户授权合并与部署后，PR [#1](https://github.com/ceyirelehe47/screeps-bot/pull/1) 于 2026-10-16 合并到 main，合并提交为 `39570a54a71716a0b13f968ead662234f28fa0a9`。随后仅更新 package.json 与 lockfile 的版本字段，以干净提交 `3beed2469d0ad73a8e51b3d0d365c2bde1b781aa` 发布 `2026.10.16-2` 到 `forster / default / shard1`。

## 代码范围与验证

本次包含运行时循环依赖拆解、生产 strict 启用、部署身份常量集中、孵化出口的房间配置以及三个大模块的职责拆分。普通孵化出口通过 `Memory.cfg.rooms[room].spawnExitDirections[spawn]` 配置；历史授权协议的签名房间和 shard 集中在不可变部署常量中，保持已有授权边界。详见[结构与配置说明](../architecture/2026-10-16-runtime-boundaries.md)。

[前置完整验证](2026-10-16-runtime-architecture.md)为 262 套件、1983 用例全部通过，循环依赖由 26 条降至 0，生产 strict 诊断由 238 条降至 0。合并后 619 个验证文件哈希全部一致；版本号调整后，617 个其余文件与完整回归源码继续一致。正式发布重新执行双配置类型检查、构建和真实产物的 64 个映射位置检查，均通过。没有因合并元数据和版本号变更重复完整回归。

所有构建与类型检查均在服务器 `dsh / VM-0-7-ubuntu` 的隔离目录 `/root/codex-jobs/20261016-architecture-release-3beed246` 执行。准确提交通过 archive、commit 原始对象与 tree 校验恢复为干净 detached HEAD；依赖使用隔离目录内的物理副本。服务器没有部署凭据，本机只执行编辑、传输和上线控制。

## 正式产物

- tree：`bf479c6193d643a0d5b91c67d3383a987c25ef33`。
- tag：`2026.10.16-2+3beed24@2026-10-16T13:12:03.283Z`。
- bundle hash：`21e7833dc91cb21652d67666120516df21ec45761f37d62408941da4e875d1cd`。
- main：3,430,904 字节，SHA256 `25a6037f084d32f7ac5890f2043c8549c997d1c5bb0e753d0e7e3ec52e4453ec`。
- main.js.map 模块：1,147,176 字节，SHA256 `97c4fccf4a5b188822c1a4945de2f4f768bc6a8ad53b980411d6dcf3b41742fa`。
- 运行时模块合计 4,578,080 字节，低于仓库 5,000,000 字节守卫。64 个位置与标准源码映射器一致，真实主产物语法与错误映射冒烟检查通过。

正式产物具有本次提交身份，与前置离线验证产物分别保存。服务器测得映射首次约 2.95 ms、缓存命中约 0.0092 ms，仅代表服务器检查耗时。

## 线上验收

上传前核实账号与 activeWorld 分支，回读确认线上仍为 `45571702`，保存完整代码回滚材料与 cfg 快照。console 和 CPU 订阅均先于上传建立。单次上传后，全部模块集合和内容哈希回读一致；观察期再次回读仍一致。

北京时间 21:15:24 捕获新版本 deploy 日志，实际部署 tick 为 `74371727`。三次只读 console 查询在 tick `74371737`、`74371756`、`74371776` 执行，实际 shard、commit、tree、tag 和 bundle hash 全部与正式产物一致。

部署后 CPU 样本确认 towerControl、scheduleSpawnTasks、spawnWork、creepWork 均执行。最后完成 tick 推进至 `74371776`；globalStarts 由 12 增至 13，符合本次部署引发的一次 global reset，lastGap 与 lastIncomplete 沿用发布前记录，没有新增中断。bucket 从首次查询的 9757 恢复到 10000。预热样本 tick `74371752` 的 totalUsed 约 94.77，最终样本 tick `74371773` 约 53.65；不据这两个样本推断整体 CPU 改善。

180 秒 socket 窗口于 21:14:53–21:17:53 正常结束，收到 43 个 shard1 console 帧，其中新部署开始后 37 帧，未见新增异常；窗口后的最后查询也正常完成。44 个账号 CPU 帧没有 shard 或游戏 tick，只保存原始记录，不用于 shard1 每 tick CPU 归因。

发布工具未写入配置、旗标、队列或 profiler。cfg 前后哈希不同，差异仅为 hubPlanner 管理的 E3N59 合成计划及 E3N59/E6N59 plannerOwnership.revision，符合现有 `writeOwnedSynthesisReaction` 运行维护路径；不将动态配置描述为冻结不变。

## 证据与回滚

可提交的结果见[发布摘要](2026-10-16-runtime-architecture/release-summary.json)。原始 console、完整 cfg、完整回滚模块保留在本 worktree 的忽略目录 `monitor-data/20261016-architecture-release/`，不入 Git；服务器检查日志保留于上述发布隔离目录的 logs/。

未触发回滚。若需要回滚，应先核对线上仍是本次产物，再恢复 `rollback-immediate.json` 中的上一版模块，重新回读并核验实际运行身份。原始工作区的 `codex/runtime-cache-correctness-20261015` 分支及未提交 skill 修改保持原状。
