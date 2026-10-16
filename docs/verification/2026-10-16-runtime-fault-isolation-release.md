# 主循环容错正式发布记录

用户授权后，于 2026-10-16 发布到 `forster / default / shard1`。代码提交为 `45571702b76ea3d6022d1dbb0d092e744fbe05e2`，tree 为 `b73da055921732e07fd499bae7addcceb23f23a6`，版本 `2026.10.16-1`。

## 发布身份与验证

- tag：`2026.10.16-1+4557170@2026-10-16T12:00:15.288Z`。
- bundle hash：`916ac03b25a30531853a34fa2c6c90629e5d3f7117384a1e0d11facf379e65fa`。
- 服务器隔离目录：`/root/codex-jobs/20261016-runtime-fault-isolation/release-45571702`。由准确提交建立干净、detached HEAD 源码，未复制凭据；13 个已验证源文件哈希与完整回归时一致。版本字段更新后重新构建并检查真实源码映射，未重复运行完整测试。
- main：3,426,477 字节，SHA256 `b220081110b1331740d27e9e8f76fe85e12791edf03ff58470cfb7b1750f42b3`。
- main.js.map 模块：1,142,635 字节，SHA256 `44b0dc0e7bac00f7ca27fff4288c574803c36fec4a813f0eb828da6c61c6a052`。
- 合计 4,569,112 字节；64 个位置与标准映射器一致。服务器测得冷映射约 3.8 ms、缓存命中约 0.0084 ms；这些不是游戏 CPU 指标。
- 上传前核对线上仍为 `b3f93276`，保存完整回滚代码与配置快照。单次上传成功，重新读取服务器全部模块，模块集合、字节及哈希一致。正式提交的构建身份也与产物内嵌身份一致。

前置验证为[260 套件 / 1974 用例、双配置类型检查及完整性守卫全部通过](2026-10-16-runtime-fault-isolation.md)。

## 线上执行证据

先订阅 console，再上传。北京时间 20:04:26 捕获新版本 deploy 日志；实际 console 查询确认部署 tick 为 `74370717`，执行 tick `74370721` 及预热后的 `74370740` 均返回正确 commit、tree、tag 和 bundle hash。

预热样本 tick `74370737` 位于部署之后，记录了 towerControl、scheduleSpawnTasks、spawnWork、creepWork。最后完成 tick 正常推进；lastGap 和 lastIncomplete 与发布前相同，没有新增中断。bucket 从初次查询的 9490 回升至 9851；单个预热样本 used 约 90.45，不据此推断整体 CPU 改善。

180 秒 socket 窗口正常结束，覆盖上传前及发布后，收到 42 个 shard1 console 帧，未见新增错误。43 个账号 CPU 帧没有 shard/tick，仅保留原始记录，不归因为 shard1 每 tick 耗时。首次查询携带的 CPU 样本早于部署，已排除。

发布没有修改 cfg、注入异常或开启 profiler。回滚材料、凭据及原始 console 不入 Git，保留在本 worktree 忽略目录 `monitor-data/20261016-release/`。需要回滚时，应先核对线上仍为本次代码，再恢复该目录的 `rollback-immediate.json` 模块并读取验收。

循环依赖、strict、房间配置和大文件拆分将在此发布后独立处理；这些结构调整不包含在本次线上版本中。
