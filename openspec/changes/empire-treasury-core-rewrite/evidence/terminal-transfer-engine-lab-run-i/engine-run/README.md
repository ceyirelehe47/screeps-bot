# engine-run/——真实引擎实验证据（Execution 轮 2026-09-09）

授权状态：用户已授权（会话明确回复「我给予你离线授权, 不接入线上服务器
即可」；范围＝接续任务书 §0）。本轮之前的历史占位声明（AUTHORIZATION_
REQUIRED／NOT_RUN）已被执行轮取代；离线轮（task/、offline/）保留原身份。

## 本轮数据文件

| 文件 | 内容 |
| --- | --- |
| `init-snapshot.json` | 管理员初始化快照（gametime 370）：两房全部对象（controller level 8 归属合成 bot、双 Terminal 与初始库存 源 1000H+10000E/目标 0H+2000E、Spawn1）、terrain SHA-256 |
| `console-baseline.jsonl` | 修正格式后的外部收集器原始流：32 条 lab-sample（tick 492..523）+ 系统频道事件（roomTick 等）。每行 `{seq, recvWallClock, channel, payload}`；用户 console 频道 `user:e37d410af9f7afe/console`，payload 含 HTML 转义的 lab-sample JSON |
| `console-all-phase0-misaligned.jsonl` | phase0 采集（字段错位格式：channel 字段承载 payload 字符串）：32 条 lab-sample（tick 370..402）+ WorldMapGrid 崩溃期错误事件。错位原因见 tools/console-collector.cjs 注释（RpcClient.subscribe 回调约定：数据是唯一位置参数、频道名在 this.channel——phase0 版本误按 (channel, data) 双参解析）。保留为原始证据不改写 |
| `api-incompatibility-game-shard.md` | 无 Game.shard 不兼容事实与源码定位（修复提案的实机依据） |
| `tools/adm.cjs` | 管理脚本（直连 storage RPC；gen-room/open-room/spawn-bot/pause/resume/eval） |
| `tools/console-collector.cjs` | 外部 console 收集器（storage pubsub 直订；修正版） |

## 实验身份（详见主文档 §2a）

合成 bot 用户 `lab-synthetic-user`（id `e37d410af9f7afe`，bot AI `labrun1`，
spawn 于 W1N57）；源 Terminal `b0254105a49b92c`（W1N57 @20,20）、目标
Terminal `c61a4141a4a9fcb`（W10N57 @20,20）；T0=554、T=557、报价 q=10。

## 后续内容（发送窗口完成后追加）

T 前控制记录回读、全窗口采样流、发送边界事实、库存/费用/容量/冷却/交易
取证、判读表、停止与清理记录。
