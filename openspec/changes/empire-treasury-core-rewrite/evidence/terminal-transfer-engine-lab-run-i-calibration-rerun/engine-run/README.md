# engine-run/——Calibration Rerun 实机复验证据（S01–S05，2026-09-09，已授权）

授权：用户在执行会话中对范围确认问题明确答复「授权执行 S01–S06」
（新本机一次性隔离世界、合成用户、W1N57→W10N57、最多一次真实
terminal.send(100H)、全程不接线上服务器；证据保存后停止清理）。
实验目录 `D:\code\screeps\lab-cal-rerun-env\`（证据已核对归档后清理，
内容 0 文件；空目录壳因 Windows 句柄占用暂存，操作已记录）。

## 判读：ENGINE_LAB_INCONCLUSIVE（gate 前置拒绝，单次 send 未消费）

窗口 199..221 完整执行、observer 23/23 tick 采样；**T=201 single-shot
被门禁以 `no_control_record` 前置拒绝**（控制事实检查先于 shard/结构/
费用，后三项本轮未被评估）——零发送边界、零交易、两端零资源变化
（终态原值，见 s05-final-state.txt）。按任务书停止纪律不重新武装、
不换 T。

**根因（实证）**：管理侧武装写入 `db.users.memory`（98 字节回读确认），
但真实 runner 每 tick 从 **env 层 `memory:<userId>`** 装载玩家 Memory
（`@screeps/driver/lib/runtime/data.js:132` `env.get(env.keys.MEMORY+userId)`
→ engine game.js `Memory` getter 解析该字符串）；终态物证：
`envMemory="{}"`（游戏内始终为空）而 `dbMemory` 保持我们写入的记录
（s05-final-state.txt）。即武装数据从未进入游戏运行时——属实验操作
（管理侧写入口径）错误，不是引擎 API 不兼容，也不是 C01 门禁缺陷。

## 文件索引（时序）

| 阶段 | 文件 | 内容 |
| --- | --- | --- |
| S01 | s01-npm-view-*.json／s01-npm-install.log／s01-npm-ls.log／s01-resolved-versions.txt／s01-lockfile-sha.txt | 实际安装原件：版本组合与上轮一致（screeps 4.3.0/engine 4.3.0/driver 5.3.0/backend 3.3.0/common 2.16.0/launcher 4.2.0/pathfinding 0.4.17/storage 5.1.3），lockfile SHA `d95c2c12…`（server-package/ 存**原件** package.json+package-lock.json），解析路径全部在本轮 server/node_modules |
| S01 | s01-screeps-init.log／s01-launcher-stdout.log／s01-launcher-stderr.log／s01-processes-listening.txt | 世界初始化、launcher 进程树（storage 137904/backend 146700/engine_main 130888/runner/processor×2）与监听（21025@127.0.0.1、21026/21027@[::1] 仅本机） |
| S02 | s02-pause-initial.txt／s02-gen-room-*.txt／s02-open-room-*.txt／s02-rooms-verify.txt | 暂停→建房（gen-room 尾部 ASSET_DIR 图片步骤报错但数据插入成功，直查 rooms/terrain/objects 证实——上轮同型经验）→开放 |
| S02 | s02-spawn-bot.txt／s02-user-lookup.txt | 合成用户 `lab-cal-user-0002`（id `c4c7544a1513ce9`，bot `calrun`） |
| S02 | s02-fixture-write.txt／s02-init-snapshot.json | 双 controller level8 归属+双 Terminal（源 aa17545ac3100001 @W1N57(18,18) 1000H+10000E、目标 aa17545ac3100002 @W10N57(20,20) 0H+2000E）+初始化快照（gametime 36） |
| S02 | s02-terrain-update.txt／s02-runner-restart.txt | map.updateTerrainData + runner 重启（新 PID 144628）——上轮同型缓存经验 |
| S02 | s02-console-baseline.jsonl／s02-console-baseline.decoded.json | 外部收集器原始流（217 行）与解码（meta-probe 基线 tick 37..197：shard Forst 逐样本、my/isActive true、controller level8 同主、两端库存原值、**报价恒 26**、交易 0；isActive 初版取值缺陷与修复见下） |
| S02 | s02-metaprobe-v2-sha.txt／s02-metaprobe-reload.txt | meta-probe 修复（真实引擎 `isActive` 是**方法**，初版误当属性）→ v2 SHA `2ec07978…` 重载生效（未武装阶段修复） |
| S02 | s02-users-all.txt／s02-pause-t0.txt／s02-t0-verify.txt／s02-calibration-facts.json | 全部用户清单（系统 NPC+init 自带 4 个 simplebot NPC+本实验用户——交易表 0 且两端结构唯一归属，无其他经济 writer 影响）；T0=198 暂停复读（原值不变）；C02 facts（tick 196/197 稳定样本，晚于最后管理操作 reload） |
| S03 | s03-cal02-real-preflight.* | **C02 真实预检 35/35 pass（exit 0）**——绑定后配置×实机 facts |
| S03 | s03-build-final-identity.txt／s03-loaded-module-hashes.txt／s03-reload.txt／s03-code-readback.json／s03-branch-overview 缺（见 s03-code-readback-line.txt） | 三产物（observer 9831B/1dd18951…、single-shot 29177B/8cf4b364…、main 8392B/de83d0c4…，repoSourceCommit=7b91359）装载（bots.reload 新分支 t1788945341092）后从 `users.code` 集合**活动分支完整回读**，UTF-8 字节+SHA-256 与待装载逐一一致 |
| S03 | s03-arming-world-recheck.txt／s03-cal02-arming-preflight.* | 武装前终检：世界对象与 facts 一致（reload 零世界对象变化、gametime 198 未错过 T=201、暂停中）；C02 正式命令再跑 35/35（reload 为代码装载非 fixture/map 变更，见主报告口径说明） |
| S03 | s03-arming-write.txt／s03-arming-readback.txt | 武装 98 字节 ≤4096 回读确认（db.users.memory——根因即此口径，见上） |
| S04 | s04-resume.txt／s04-stop-guard.log／s04-mid-window-check.txt／s04-console-full.decoded.json | 恢复墙钟 09:17:19Z；180 秒停止保护（09:20:13 兜底触发，gametime 254，幂等）；窗口样本 199..221 共 23/23；**T=201 `lab-precondition-rejection` reason=`no_control_record`**（唯一拒绝行；无任何 lab-send-attempt） |
| S05 | s05-pause-request.txt／s05-paused-verify.txt／s05-final-state.txt | 窗口后暂停（静止 254；T+20 后多跑 33 tick 的停止延迟如实记录：主流程 45 秒轮询所致，窗口后 main 零发送零采样，世界无侧影响——终态原值证实）；终态：两端原值、交易 0、**envMemory="{}" 与 dbMemory=武装记录并存的根因物证** |
| S05 | s05-disarm-write.txt／s05-disarm-readback.txt | 撤装（db 副本 armed=false 保留 attempted=false，99 字节回读） |
| S05 | s05-stop-locate.txt／s05-taskkill.txt／s05-stop-verify.txt | 收集器停止（流定格 217 行）；launcher 进程树 taskkill /T /F（7 进程）；21025-21027 无监听、实验相关 node 进程 0 |
| 工具 | tools/adm.cjs（新增 reload 子命令）／stop-guard.cjs／decode-console.cjs／console-collector.cjs | 本轮实机实际使用的工具源码（adm/collector 复用上轮归档并扩展） |

第二轮离线验证（绑定提交 7b91359 上，S03 的 §9 要求）归档于
`../offline/round2-validation/`（npm ci/typecheck×2/build/五组 Jest
242-1486/budget PASSED/三产物 BUNDLE_CHECK=OK/三组冻结零差异/dist 未
覆盖/C02 离线对照两例）与 `../offline/round2-second-tree/`（LAB 43、
Slice 23 全绿；三产物程序字节与主树逐一 IDENTICAL）。
