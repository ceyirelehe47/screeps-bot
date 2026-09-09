# tools-prepared/——实机复验辅助工具（准备件，PREPARED_NOT_RUN）

本目录归档 Calibration Rerun 实机阶段（S01–S06，须新授权）将使用的
**新制**只读工具源码；本轮离线交付时全部未运行。装载时以装载目录内
实际字节的 SHA-256 为准（与归档字节核对后使用）。

| 文件 | 角色 |
| --- | --- |
| `lab-meta-probe.js` | 只读元信息采样器：作为合成用户 bot AI（main.js）每 tick 输出一行 `lab-meta-facts-sample` JSON（shard/两端 my+isActive+控制器/库存/能源/空位/冷却/报价/两交易视图/worldSize 诊断）。零写、零 send。 |

复用件（不再复制，实机时从旧证据根取用，仅连接本轮 loopback 端点）：
`evidence/terminal-transfer-engine-lab-run-i/engine-run/tools/adm.cjs`
（storage RPC 管理：gen-room/open-room/spawn-bot/pause/resume/eval）与
`tools/console-collector.cjs`（用户 console pubsub 直订收集，修正版——
回调约定：数据是唯一位置参数、频道名在 `this.channel`）。

实机阶段还需要（装载时编写/组装，均为派生工具）：

- facts 装配脚本：console JSONL（外层 `{seq,recvWallClock,channel,payload}`
  → payload JSON → HTML 实体解码 → lab JSON）+ 收集器时间戳作样本
  `collectedAtWallClock` + 会话 `runId` + 管理侧 users 表按用户名查得的
  `userId`（证据来源注明）+ 管理操作日志的 `lastAdminChangeWallClock` +
  暂停确认（`paused`/`pauseConfirmedTick`）→ 组装 CalibrationFacts JSON
  （派生文件，标注来源与原行映射）。
- 外部限时停止保护（180 秒墙钟或窗口完成先到）。

C02 正式命令（武装前实际执行并归档输出）：
`node scripts/verify-lab-calibration.mjs --facts <装配后的 facts.json>`
（离线对照的真实运行记录见 `offline/`——本轮无新世界事实，真实预检
未运行，不填写为已校准。）
