# 原始持久化存储终态核对（world-db.json，副本见同目录）

时间：2026-09-10T09:0x Z（环境进程全部退出、端口清零之后读取磁盘副本）

`world-db.json` sha256 `bc0ccc79a4b52d0eb9a773862dc8f95c122b2c4fa175a04629d5fed7a9e34279`
（`SHA256SUMS.txt` 同目录）。在 `collections[name=env].data[0].data` 中：

```
gameTime            557
mainLoopPaused      1
memory:f6afa65997c093d  →  __labTerminalTransferProbe:
  { experimentId: "lab-ti1-0002", armed: false, attempted: true,
    attemptedTick: 536, stopped: true, syncResult: { ok: true, code: 0 } }
                        →  runtime.treasuryCore:
  counters: { admitted:1, dispatched:1, settledCommitted:1, settledNotExecuted:0,
              unknown:1, rearmings:0, rejectedAdmissions:0, recoveryAdvances:0,
              cleanupFailures:0 }
  ring:     [ { attemptId:"tk1_1_20faab99a8378f8a",
                workKey:"biz:terminal-lab:lab-ti1-0002", generation:1,
                terminalPhase:"committed", closedAtTick:538 } ]
  active:   {}
```

意义：工具侧的撤装读回（storage readback）在此获得**落盘层**的独立印证 ——
撤装后的 `armed:false` 与 `attempted@536`/`syncResult` 事实确实写入了 storage
的持久化文件，而非仅存在于进程内存。tasks 书 §9.4 第 3 层"存储读回不宣称
已完成 driver 或磁盘持久化"的限制，在本轮以这份磁盘副本闭合。

注：本节为执行 Agent 的补充事实记录，不改动工具原始返回值
（`treasury-verification.json` 原样保留 `TREASURY_INTEGRATION_PASS`）。
