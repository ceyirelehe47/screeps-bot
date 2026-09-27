# Treasury T1 首次上线：默认 OFF 部署与首次 writer 停点

## 结论

2026-09-27 已将修复后的唯一候选上传至 `screeps.com / default / shard1 / forster`，正式服独立 GET 读回 `main` **3,275,477 字节**、SHA-256 `bdfde69f6b79f3b3bd1a3e51d184d58ec4d0c6f25b94ebdc18233c61248d55a2`，与隔离引擎实测字节完全一致。tick `73974020` 已见新运行标签 `2026.8.29-6+16c2ca4@2026-09-27T06:26:24.112Z`。源码提交 `16c2ca4b70b21b05f3c9bedddba3836cdce389ad` 已推至 `ceyirelehe47/screeps-bot` 的 `codex/treasury-t1-first-live`。

**正式 writer 没有启动，也没有正式服 T1 native 发送。** 上传前后完整 canonical 任务表均无既有 `E3N59 → E4N58` H 任务；上线前源 Terminal H 为 0。T1 模式缺省 OFF，control、quota、kernel、任务租约均不存在。本轮未 arm、未切 canary、未迁移预约、未手造任务或补货。按用户直接授权的“无匹配任务则保持 OFF”结束本轮 writer 阶段，不留下等待未来任务的自动观察或接纳窗口。此状态是**默认 OFF 已部署**，不是首次 writer 验收通过。

## 修复与冻结

包内 `T1-LIVE-01` 抽取函数反例在旧源码复现第三房 `→ E3N59` 漏拦截（7 例中的 1 例失败）。最终源码使非 T1 的普通发送对 E3N59、E4N58 两端的入站和出站都受现存 T1 fence 限制；同 tick 已成功或结果不明的普通发送还记录源、目的两房，T1 在准入和 native 前重新检查。无关房间仍可发送，OFF 且无责任时不拦普通业务。包内同一抽取反例在最终源码上变为 7/7；真实入口结果见下节。

新增的一次性控制状态使用持久主/镜像与校验，绑定原 runId、任务 ID/创建 tick/总量/初始余量、两端 Terminal ID、代码标签与 bundle hash。仅目标 shard1 和账号房间身份可 arm；固定截止为 arm 后 600 tick 或 30 分钟，先到者停新接纳；续租最长 60 秒且不延长截止。准入与 native 前均核对租约、任务、结构、CPU 至少 20 的余量、bucket 至少 2,000 和 Memory 小于 1,900,000 字节。原 quota 仍是一次 native 责任；native 前将配额置于 dispatching 并关控制窗口，失败或未知不重发，关闭后不能重开同一控制状态。正式服没有使用这些 operator 入口。

`npm run typecheck` 与最终相关入口 Jest 3 个 suite/17 项通过；较广的市场、国库、carrier、resourceControl、reservation 和主循环组合 18 个 suite/76 项在本轮通过。最终提交的 `npm run build` 通过。构建仅增加格式压缩插件，配置为 `compress:false, mangle:false`，移除排版和非必要注释后低于保守的十进制 5 MB 上限；运行行为用最终字节的隔离引擎再次检查。源码 diff 复核未改市场价格、permit、WAL、备货政策或主循环调用顺序；最终补丁的只读复核由本轮执行者完成，未取得另一位评审人的签署。

冻结清单见 [release-manifest.json](treasury-T1-first-live-evidence-20260927/release-manifest.json)，最终源码验证脚本见 [engine/verify.py](treasury-T1-first-live-evidence-20260927/engine/verify.py)。

## 最终字节隔离引擎

在 `dsh` 的独立 Screeps Engine 4.3.0 世界运行与正式上传相同的 `main` SHA。实验账号 ID `7dad41a4bfc9d96` 与正式账号 ID 不同；为检查正式身份门禁，仅在实验服将该账号显示名临时设为 `forster`，并用隔离 UTS 命名空间使实验引擎的 shard 名为 `shard1`，宿主 hostname 未改变。实验服务只监听回环、暂停分段运行，最终已停止。原数据库另存于实验目录；实验中的重置已消费 quota、添加合成房间/任务仅发生在隔离世界，绝不能用在正式服。

| 场景 | 原生事实与责任结果 |
| --- | --- |
| 100 H 首片 | tick 540 经正式 `main → resourceControl → T1 facade → gateway` 发送 100 H；源 Terminal H `200→100`、Energy `9970→9966`，目标 H `1000→1100`。tick 543 任务 `done/0`，相同 attempt 为 committed。drain 后 OFF：quota 为 drained、任务租约和 kernel active 清零。重启后交易总数仍为 8，没有第二笔 T1。 |
| carrier | 发送后的 fence 窗口真实 carrier 持有 50 Energy、目标 Terminal Energy 仍为 2,100；OFF 后目标 Terminal Energy 为 2,150。两个快照证明延后窗口与恢复变化，不单凭它们断言是同一批 cargo 的唯一归因。 |
| 普通发送先于 T1 | tick 565，第三房 W9N8→源 E3N59 原生发送 100 H；tick 585，W9N8→目标 E4N58 原生发送 100 H。对应两次各自的 T1 任务保持 pending/100，quota 未创建。 |
| T1 先于普通发送 | tick 605 T1 原生发送 100 H；fence 持续时，第三房分别向目标和源发送的普通任务均收到 `send_code_-4`，任务余量仍为 100，交易总数维持 13。受控 OFF 后，普通任务在 tick 615、625 各完成一笔，T1 仍恰结一次且 quota drained。 |

另一次目标房竞争尝试在 tick 575 由 T1 先执行：第三房 Terminal 还在前笔冷却，故不计入“普通先于 T1”的成功证据。该原件保留，随后在双方冷却归零的新隔离场景取得 tick 585 的有效证明。30 份原始读回及装夹记录均在 [engine/evidence](treasury-T1-first-live-evidence-20260927/engine/evidence/)；[engine/verification.json](treasury-T1-first-live-evidence-20260927/engine/verification.json) 由未修改原件的校验脚本复核为 passed。

## 正式服预检与 OFF 读回

07:12:57 UTC 现场预检：账号 `forster / 634fe406347a7b69b28aeccb`，旧 `default/main` SHA `0f13b0…fe0a4f`，市场配置 `market-base-resource-v3-r7`、permit epoch 17、ledger finalized sequence 26、receipt head `csh1:c2dd1b7daf50eaa5cfb99c2b6208dd15`、pending 空；R2 加速实例已 `closed/capacity_recovered`。Memory 实际序列化约 1.45 MB；CPU 近样本 bucket 10,000、tickLimit 500。两房均为本账号 RCL8，E3N59 Terminal H 为 0、Energy 240,000、cooldown 0；目标 Terminal H 1,921、Energy 133,707、cooldown 0。五条 canonical 任务中没有目标 H 任务。其他 shard 的 T1 配置和配额读回为空；产品控制门禁也只允许 shard1。

上传前封存旧 `main` 字节及相关状态摘要；唯一 POST 返回 accepted，随后独立 GET 读回完整新 SHA 和字节。07:15:16 UTC 的 tick `73974020` 又确认新运行标签、默认 OFF、quota/kernel/租约仍空，市场 revision/permit/receipt head/seq 均未改变。07:16:29 UTC 监控仍选 shard1，ResourceControl 更新、市场 V3 planning 完整且无 blocker，CPU bucket 10,000、tickLimit 500。监控规划完整仅证明没有被本次国库代码误锁，不能冒充新市场成交。

正式服前后摘要及复核脚本见 [证据目录](treasury-T1-first-live-evidence-20260927/)；`python3 docs/reports/treasury-T1-first-live-evidence-20260927/verify-production-off.py` 得到 `status=passed`。该结论依据 OFF、无匹配任务、无配额/内核/租约及实际代码读回；没有以正式服交易流独立统计 T1 次数，所以不把它表述成已完成 native writer 实验。

## 停止状态

生产保留新兼容代码与旧市场/账本，T1 保持 OFF，无待恢复的新责任。没有执行正式服 cfg/proposal/accept、reservation 迁移或 terminal.send，也没有使用 FC1/旧市场二进制回退。当前授权的一次活动已按“无匹配任务”分支结束；以后出现任务不能自动把这次授权当作新的 run。
