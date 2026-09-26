# Treasury T1 R2：终态收尾与 carrier 并发修复

## 结果与边界

集成候选 `codex/treasury-t1-closure-r2@cd0d550e3ff3637229e687eefa09fbb90a2dfb20` 以已核对的市场 r6 `d690ee8087510aa79b0e3518dd7ae4ff0764c1cd` 为基础，合入 T1 修复；未覆盖市场价格、permit、WAL 和备货代码。Treasury 模式缺省为 `off`。本轮没有向正式 `shard1` 上传或启用 Treasury writer。

- 完成一笔后变为 `done/0` 的任务，由每 tick T1 恢复生命周期继续处理，OFF 依据配额、同一 attempt 的 ring 终态和任务身份释放租约；旧任务清理器保留尚有 T1 责任的业务行。
- 结算后的 `closing` 租约金额为 0，重复恢复先按 attempt、配额和任务创建身份识别已应用结论，不能再扣一次。配额升级为 schema 2，绑定创建 tick 与原任务总量；旧/损坏配额保守挡住新动作。
- 两端 Terminal 的普通 carrier 实际 `withdraw/transfer` 在 T1 fence 期间延后，已携货的交付快照保持到释放后；其他本地 Terminal writer 继续由原仲裁器阻挡。无法归因的外来 Store 变化仍保持未决。

## 验证

在集成分支上执行相关生产入口、市场共享调用、carrier、主循环回归：9 个 Jest suite / 39 项通过；随后补修已携货 `ERR_BUSY` 状态保留，3 个关键 suite / 18 项通过。`npm run typecheck` 和 `npm run build` 通过。最终从干净提交 `cd0d550e` 构建的 `main` 为 4,992,931 字节，SHA-256 `bd78c0719da582dbf090a9dd5f46be3c1618f17e6940eb872e6e3a98b6dfa592`，低于隔离引擎脚本的 5 MiB 边界，余量约 249,949 字节。

隔离引擎原始证据及复核脚本见 [R2 证据目录](treasury-production-T1-engine-evidence-20260926/README.md)。首次代码在 tick 500 原生发送 100 H、4 Energy 费用，tick 501 任务到 `done/0`；OFF 释放租约，重启后无重发。最终代码在 tick 510 再次发送 100 H，同时生产 carrier 取走 50 Energy；tick 511 任务确认，carrier 持货、目标 Terminal Energy 未变。OFF 后目标 Terminal Energy 增加 50；该次场景重启后的交易总数仍为 6。`verify-r2.py` 对 11 份快照复核通过。

## 正式 writer 灰度前置

2026-09-26 12:50 UTC，市场 r7 已实际部署并完成 epoch 17 签名迁移。后继默认 OFF 集成提交 `1204891d` 已将市场 R2 分支完整合入本 T1 候选，未触碰现役 shard1 的 Treasury 模式；`readMode()` 在无 `treasuryTerminalTransferSlice0` 配置时返回 `off`。合并后相关市场/T1/carrier/仲裁/物流 12 个 Jest suite、47 项通过，`npm run typecheck`、`npm run build` 通过；干净合并提交的 `main` 为 5,015,322 字节、SHA-256 `4902e7e25423c26d4fec2f6f5f1ff6ee192fee087ea27a2aa5f5189b786ccdf1`，低于 5 MiB 边界。

随后从干净提交 `c926ddeb01710c685a5546c4a19d1eaaf14a02d0` 构建的最终 r7+T1 包，在独立 Screeps Engine 4.3.0 以 SHA-256 `62b83ecf6b3b330c6f54febbe37cc858c1bcbda5e83dc82c97570dddcb7b0966` 实测：tick 520 原生发送 100 H，4 Energy 手续费；任务 `done/0` 且关闭租约保留责任；原生产 carrier 同时取走 50 Energy，T1 fence 期间持货；drain 不丢责任，OFF 后清除租约、quota 为 drained、carrier 把 50 Energy 交给目标 Terminal；重启再跑 tick 532，交易总数仍为 7。原始快照与 `verify-r7.py` 见 [最终集成证据](treasury-production-T1-engine-evidence-20260926/r7-integration/verification.json)。旧 `cd0d550e` 实测与这次最终组合分开保存。本轮 G2 仍无正式服上传或 writer 灰度，隔离服务已停止。

当前交付是默认 OFF 候选。首次正式 writer 灰度仍需重新核对现役市场代码与 task 身份、是否有合规的 E3N59→E4N58 H 任务、两房真实 Store 与结构、CPU/Memory 和当前上传大小；按新代码身份重新冻结包体并做独立审查。停止新增接纳、关闭内核责任、终端交回旧 writer 分开验证，未决/未知结果不能通过切 OFF 清除。旧 FC1 恢复字节不能充当本候选的回退包。正式服迁移或 `send` 尚未授权，也没有执行。
