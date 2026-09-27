# Treasury T1 首次上线证据

本目录的 `release-manifest.json` 绑定源码提交 `16c2ca4b70b21b05f3c9bedddba3836cdce389ad` 与唯一上传的 `main` 字节。`production-before.json`、`production-after.json` 为正式 shard1 的**脱敏定点摘要**；`post-deploy-stable-monitor.txt` 是只读监控原输出。它们不包含 token、cookie 或整份正式 Memory。正式服旧/新 `main` 原字节另存于本机审计目录，不在 Git 中复制大包体。

`engine/evidence/` 包含独立实验服的原始暂停快照及每次实验装夹/模式转换记录。`engine/tools/` 保留实际使用的隔离世界脚本，仅供复核；其中删除实验配额、重建合成任务和更改实验账号显示名的步骤**不得用于正式服**。实验服务已停止，宿主与正式 Screeps 账号未改变。未成功的目标房首轮竞争原件也保留，用于解释冷却干扰；成功的复测为 `pre-target-blocked.json`。

复核命令：

```bash
python3 docs/reports/treasury-T1-first-live-evidence-20260927/engine/verify.py
python3 docs/reports/treasury-T1-first-live-evidence-20260927/verify-production-off.py
```

两者分别输出 `engine/verification.json` 与 `production-off-verification.json`。前者只证明相同构建字节在隔离引擎的动作和恢复；后者只证明正式服默认 OFF 部署及相应读回，不把无匹配任务写作 writer 成功。
