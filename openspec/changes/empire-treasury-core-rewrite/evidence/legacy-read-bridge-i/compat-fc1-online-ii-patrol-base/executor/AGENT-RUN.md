# FC1 Online II 巡逻兼容副本：执行边界

此发布副本由旧 FC1 r2 执行器加当前生产巡逻基线的精确身份校验构成。先核对包完整性、真实仓库、当前线上模块指纹及 `codex/fc1-online-ii-patrol-base` 的两段 Git 血统，再完成包测试、兼容源码测试、TypeScript 检查、Jest 688 项真实结果和 build-only。不要使用旧 `06ffedb7` 的恢复模块。

本副本仍在 `WAITING_FOR_EXPLICIT_AUTHORIZATION`。取得针对这份新指纹及当前备份字节的明确一次性线上授权后，才可把 `newRoundAuthorization`、policy 与 maker policy 一起更新、重封包并复跑所有发布门禁；不得只改 `onlineExecutionReady` 或跳过结果门。授权额度仍是一次 candidate POST、一次 restore POST，无自动重发、无第五点、无第二轮窗口。丢失回包先只读对账。

正式执行只针对 Screeps `forster/default/shard1` 的 `E3N59`、`E4N58`，资源 energy/H；保留 10 CPU cooperative exposure ceiling、25 CPU reserve、入口 55 CPU headroom、bucket 2000、4 点 100 tick 间隔、75 分钟上传后上限及原择时/恢复余量。测量器仍只读，不发 Treasury 业务动作；正常旧 Bot 业务继续运行。

若任一前置门失败，记录 `NOT_DEPLOYED`，保留证据，不消耗或重开一次性额度。已发生写入后先完成精确恢复与独立运行确认；不能把 OFF 当作恢复。G2 writer 灰度不是这次授权范围。
