# T2 最终构建隔离实证

本目录的 C1/C2/C3 只针对已许可的 dsh 回环实验世界。正式 Screeps 账号、API 与凭据不在这些工具的访问范围内。环境原件与实验原件仅追加；旧 T1 证据不改写。

实验根目录为 `/srv/screeps-treasury-t1/server`，新运行目录为 `/srv/screeps-treasury-t1/r6-t2-20261002`，账号为 `7dad41a4bfc9d96` / `forster`。官方 engine 4.3.0、common 2.16.0、Node 22.22.1。web/CLI 仅监听 127.0.0.1:21025/21026，storage 仅监听 ::1:21027。仅控制 `screeps-treasury-t1.service`；dsh/nginx 不作变更。

开始时隔离服务 inactive，数据库 gameTime 756、pause=1，旧 H control closed、quota drained、kernel active=0。停态数据库备份位于实验私有运行目录 `db-before.json`，SHA256 `d47abf3a20a0ba894f1413f63f2532a5b079bba941a04f7f51114aeb95a14a0b`，不进入交付包。`environment-check-original.txt`、`evidence/initial-environment.json` 保存核查原件。

最终候选源码提交为 `a84275040d4f8f8bfea2135a8465608f97637c22`，main SHA256 为 `a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f`，3308853 字节。所有采用的 C 原件都独立读回这份 main；最初环境原件中的旧 SHA 只用来识别已有实验环境。

新 E1N57 房间及 labs 是明确的隔离装夹。UH 首片用例同时配置真实 UH2O 生产计划及加载状态，目标没有本地 UH/UH2O，OH 放在真实 reagent lab；不是仅创建一个没有用途的任务。四例都从停止状态的 `db-frozen-pre-t2.json` 启动独立合成世界副本，最终有效基线 SHA256 为 `c4fdf23d89f7c31a50c60b788cd52dc0456edaafe2e3a3083af55b86bdd25a2c`。每例都没有 T2 quota/control/ring；旧 H 已消费 control/quota 和 closed kernel 历史保留。不会在同一世界删除已消费 T2 额度后重开。副本及各例完成 DB 留在实验私有目录，不进入交付包。

`tools/lab.cjs` 在装夹前校验 pause、实验账号和候选 main SHA；所有证据文件使用 `wx` 防止覆盖。`tools/run-until.cjs` 在同一账号/SHA下推进既有实验世界，25 秒有界，finally 恢复暂停。真实 native 不由工具调用，只由冻结产品的正式 main → resourceControl → Treasury → terminal gateway 产生。目标 UH +1/-1 故障完整更新 Store 并强制读回；不创建 receipt。两端 carrier 分别标为合成已持有 50 H，只证明实际 role 的持货保护及解除后的交付，不声称本轮观测自然 spawn→pickup。它们的实验交付计划使用堆内 assignment，真实 reset 后在责任仍持有时明确重建同一计划并保存 queue 原件；不把这一装夹说成计划本身已跨 reset 持久化。

## 实际原件

| 组 | 采用的标签 | 实际事实 |
| --- | --- | --- |
| C1 1715 | `c1-1715-r4-*` | 760 唯一 100 UH/10 Energy 国库 native；首次确认余量 1615，重复恢复仍 1615；770 旧正常 task writer 发送 1615 至 done/0，两种交易 description 分开。 |
| C1 100 | `c1-100-*` | 独立实例真实 100 UH/10 Energy，100→done/0；继续推进后没有重复扣减或发送。 |
| C2 | `c2-*`（下述 supplement 另列） | 760 普通 W9N8→E4N58、W8N8→E1N57 各 100 H 入库后才绑定；765 国库 UH100。真实目标 UH100→101 故障阻断确认，OFF 归一化为 drain；两端普通入口及持货 carrier 延后，无关 E3N59→W8N8 真实发送。失联、真实 service restart 保留原 attempt；仅撤掉装夹 1UH 后同 attempt 单次结算，随后普通两端与 carrier 交付恢复。 |
| C3 | `c3-*` | 已绑定但未接纳、quota/active 不存在，真实失联超过 60 秒后自动 `control_lease_expired`/OFF，普通原任务真实发送 100UH；正确落盘后进程重启，实际 tick 推进而无新 T2；官方 arm 再调用返回 `already_used_or_unsettled`。 |

C2 合成正常调度预算为 `taskMaxPerRun=2`：两个正常 manual 优先任务耗完该 tick 原预算，UH 任务继续 pending；不暂停普通调度、不修改优先级或手写业务结果。普通 H 源 Terminal 装夹真实 10000 H，保留默认保护 floor；没有降低储备来制造成功。C3 仅在独立无接纳装夹中关闭 task dispatcher，保持绑定而无执行责任；到期后只通过 `enabled=true` 恢复普通入口，没有 operator close 或手写 mode。

`c2-carrier-prestate-supplement-*` 是从真实 C2 未知期停态私有 DB 的额外独立实验分支，只补强 role 调用前标量观测。副本保留原交易、原 attempt、UH101 矛盾与两只 H50 carrier；没有新 native 或手造 receipt。v2 trace 记录调用前 `role/ready/working/spawnYield/configName`，只委托原 `.work` 并保留原异常/返回，证明真实 role 在 fence 中执行而保持持货。解除目的地由实际两端 H 增量、H50→0 与计划读回重导；成功 `.work` 清掉 pending 字段后，不把空 target trace 解释为已经捕获解除动作实参。补充分支不与原 C2 连续链相加结算或计为另一笔国库发送。

校准原件保持原样，未计为 C 通过：过快停止导致 10 秒 autosave 未落盘的旧 SHA 基线；新增房间后 terrain cache 未重建导致官方 driver 在 main 前拒绝；r2 的正常 carrier 先行触碰终端使 arm 正确拒绝，随后旧普通发送 1715；r3 的观察驱动复用旧结果导致额外 queued arm 被 `already_used` 拒绝。最终 r4 使用唯一 console nonce 和有界同任务重评，不暂停旧系统。恢复/重启前都对照真实 live Memory、Store、code 与 transactions 核验 DB 已落盘。首次下载期间仍追加的 C1-100 run-log 部分保留在 `partial-downloads/`，完整稳定源另存正常位置。

最终 `service-ending.txt` 显示仅隔离服务 inactive，dsh/nginx active。`service-journal-original.jsonl` 保留真实启停原文。原件验证器只采用明确的最终标签；校准仅列身份，不当作通过。它从冻结 main、原 Memory、真实 Store、唯一交易及 journal 重算，不读取派生 `passed` 作证据。

```bash
python3 docs/reports/treasury-T2-first-production-evidence-20261002/engine/tools/verify-evidence.py \
  --main-path /绝对路径/candidate/main.js \
  --output /tmp/treasury-t2-engine-independent-verification.json
```

本目录仅证明最终候选的隔离 C 项；正式生产没有据此执行新 UH 首片。
