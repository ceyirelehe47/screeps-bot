# T2 最终构建隔离实证

本目录的 C1/C2/C3 只针对已许可的 dsh 回环实验世界。正式 Screeps 账号、API 与凭据不在这些工具的访问范围内。环境原件与实验原件仅追加；旧 T1 证据不改写。

实验根目录为 `/srv/screeps-treasury-t1/server`，新运行目录为 `/srv/screeps-treasury-t1/r6-t2-20261002`，账号为 `7dad41a4bfc9d96` / `forster`。官方 engine 4.3.0、common 2.16.0、Node 22.22.1。web/CLI 仅监听 127.0.0.1:21025/21026，storage 仅监听 ::1:21027。仅控制 `screeps-treasury-t1.service`；dsh/nginx 不作变更。

开始时隔离服务 inactive，数据库 gameTime 756、pause=1，旧 H control closed、quota drained、kernel active=0。停态数据库备份位于实验私有运行目录 `db-before.json`，SHA256 `d47abf3a20a0ba894f1413f63f2532a5b079bba941a04f7f51114aeb95a14a0b`，不进入交付包。`environment-check-original.txt`、`evidence/initial-environment.json` 保存核查原件。

新 E1N57 房间及 labs 是明确的隔离装夹。UH 首片用例同时配置真实 UH2O 生产计划及加载状态，目标没有本地 UH/UH2O，OH 放在真实 reagent lab；不是仅创建一个没有用途的任务。1715 与 100 用例分别是独立合成测试实例。旧 H 已消费 control/quota 和 closed kernel 历史保留。

`tools/lab.cjs` 在装夹前校验 pause、实验账号和候选 main SHA；所有证据文件使用 `wx` 防止覆盖。`tools/run-until.cjs` 在同一账号/SHA下推进既有实验世界，25 秒有界，finally 恢复暂停。真实 native 不由工具调用，只由冻结产品的正式 main → resourceControl → Treasury → terminal gateway 产生。目标 UH +1/-1 故障完整更新 Store 并强制读回；不创建 receipt。两端 carrier 分别标为合成已持有 50 H，只证明实际 role 的持货保护及解除后的交付，不声称本轮观测自然 spawn→pickup。它们的实验交付计划使用堆内 assignment，真实 reset 后在责任仍持有时明确重建同一计划并保存 queue 原件；不把这一装夹说成计划本身已跨 reset 持久化。

最终构建尚未冻结，当前材料仅为环境/工具准备；没有把旧 main 读回认作新 UH 验证。
