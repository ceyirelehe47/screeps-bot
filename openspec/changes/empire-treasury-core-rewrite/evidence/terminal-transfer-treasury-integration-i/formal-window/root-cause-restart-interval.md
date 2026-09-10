# 正式窗口未启动的根因分析（lab-ti1-0001 run-treasury）

## 结论

run-treasury 的失败（user_console_stalled → 窗口零样本）不是任何被测代码的缺陷：
live bundle 从未执行过（恢复期间引擎主循环尚未完成重置，新 runner 未接管用户代码），
零次 `terminal.send` 调用。根因是 standalone launcher 的 `restart_interval=3600`
滚动重启撞上了实验恢复时刻。

## 证据链

1. `ti-launcher-stdout4.log`（fixture 后正式引擎树，启动于 ~11:21）：12:14:21 记录
   `engine_runner1 exited with code null, restarting` → 新 runner 117848；
   `engine_processor1 exited` → 138404；`engine_processor2 exited` → 146092。
   storage/backend/engine_main 无重启。这与 `@screeps/launcher/lib/start.js`
   的实现一致：只有 runner 与 processor 的 `_startProcess` 接收
   `opts.restart_interval` 参数（.screeprc 默认 3600 秒），其余进程不滚动。
2. `engine_main.log`：`Game time set to 329`（facts 暂停点）之后出现
   `Main loop reset! Stage: waitForUsers` / `waitForRooms`——runner/processor
   滚动导致主循环重置；reset 完成后才有 `Game time set to 330`（仅一 tick）。
3. `actions.jsonl`（mtime 12:16:54，滚动后 2.5 分钟）：resume OK → 5 秒无目标
   用户 console → `user_console_stalled` 判停（工具承诺的通道故障边界，
   README：连续 5 秒无封装按通道故障停止）→ pause OK（tick 仍 329）。
4. disarm 写入 tick 329 且 readback 确认；随后引擎完成主循环重置推进到
   tick 330 触发 `world advanced after write`（memory-control 的保守失败，
   不自动修复）。控制槽终态事实：写入内容为 `{armed:false, stopped:true,
   attempted:false}`（撤装保留未尝试事实，永久不可再武装）。
5. 无 Windows Application Error 事件（1000/1001）——排除 OOM/崩溃，
   与 launcher 主动滚动重启一致。
6. `process-stop-result.json`：terminated=true、7 PID 全部观察
   （144404 launcher、146208 storage、141476 backend、120704 engine_main、
   117848 runner、138404/146092 processor）、elapsedMs=3010.8、polls=1、
   auditErrors=[]——本轮修复后的停止路径首次在真实 run 内完整确认
   （对照 ec0001 轮的 PROCESS_STOP_UNCONFIRMED）。

## 时序图

```
11:21  正式引擎树启动（fixture 后整树重启）
11:2x  基线 24 样本（tick 301–324）+ 控制往返（inspect/initialize/
       observe-false/arm/observe-armed）+ facts（T0=329 暂停）
11:3x–12:1x  世界暂停 idle，等待 §5.2 全量验证（tsc/build/分层 Jest/
       全量 246 suites ~15min/预算/CLI/live bundle/冻结 diff/第二树）
12:14  restart_interval=3600 到期：launcher 滚动重启 runner+processor
       → engine_main Main loop reset（waitForUsers → waitForRooms）
12:16  run-treasury resume——reset 尚未完成，console 无样本
12:16+ 5 秒判停 user_console_stalled；pause/disarm；重置完成 tick 330；
       killTree 3010ms 全确认
```

## 责任归属与教训

- 本轮 Agent 的环境运维失误：正式树存活 55+ 分钟且大部分时间 idle 等待离线
  验证，未意识到 `.screepsrc restart_interval=3600` 会在整点滚动 runner/
  processor。正式窗口启动前应核对最近一次滚动时刻，或对正式树把
  restart_interval 调大/重启后立即执行正式 run。
- 上轮 ec0001 未踩中：其正式树从启动到 run-formal 结束不足一小时。
- 实验授权消费状态：恢复动作一次（run 内边界），`terminal.send` 零调用。
  按任务书 §5.3「缺观察……立即保留事实并停止；不改 ID/T、不 rearm 重发」，
  lab-ti1-0001 实验关闭，终态 LIVE_FAIL（环境事故），不以新 ID/新 T 重试。
