# Treasury T1 R2 隔离引擎证据

本目录是 `dsh` 上独立 Screeps Engine 4.3.0 世界 `lab_treasury_t1` 的原始记录。正式 `shard1` 未上传 Treasury，也未切换模式。引擎在取回证据后已停止。

三组快照使用同一生产入口，但代码身份不同：

| 场景 | 源码提交 | `main` SHA-256 | 快照 |
| --- | --- | --- | --- |
| 100 H 一次完成、OFF、重启 | `842206cbba6be4ff1f478af11ed539b87c5d8aeb` | `a06c967360673e4766a9d4cf139f6e06a34f3c49f10f593d405fce3f9e8c3dcb` | `r2-pre-canary` 至 `r2-restart-off` |
| carrier 并发、收尾、OFF、重启 | `cd0d550e3ff3637229e687eefa09fbb90a2dfb20` | `bd78c0719da582dbf090a9dd5f46be3c1618f17e6940eb872e6e3a98b6dfa592` | `r2-carrier-pre` 至 `r2-carrier-restart-off` |
| 市场 r7+T1 最终集成、carrier 并发、OFF、重启 | `c926ddeb01710c685a5546c4a19d1eaaf14a02d0` | `62b83ecf6b3b330c6f54febbe37cc858c1bcbda5e83dc82c97570dddcb7b0966` | `r7-integration/` 中的原始快照 |

`manifest-closure-v1.json` 和 `manifest.json` 记录各自的构建身份。`*.json` 快照包含暂停的游戏 tick、原始 Memory、两房真实结构与 Store、实际交易及代码哈希。`setup-*.cjs` 只修改隔离账号的合成任务和 creep；`set-mode*.cjs` 只在隔离账号上执行指定的一次模式转换。原 2026-09-25 证据目录没有修改。

复核命令：

```bash
python3 docs/reports/treasury-production-T1-engine-evidence-20260926/verify-r2.py
```

校验结果在 `verification.json`。它逐张检查代码身份、100→0、唯一交易、手续费、drain/OFF 收尾、carrier 在 fence 期间持货、OFF 后 50 Energy 进入目标 Terminal、重启后无第二笔 H 交易。原始快照支撑这些有限结论；其余拒绝和损坏场景由本地回归验证。

最终 r7+T1 集成证据由 `python3 docs/reports/treasury-production-T1-engine-evidence-20260926/r7-integration/verify-r7.py` 复核。隔离世界在 tick 520 再发出一笔 100 H，手续费 4 Energy；任务 `done/0`，carrier 在 fence 期间持有 50 Energy，OFF 后交到目标 Terminal，重启交易总数仍为 7。`r7-integration/manifest.json` 记录该次干净构建身份，`verification.json` 记录复核结果。隔离服务完成后再次停止。
