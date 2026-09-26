# 隔离引擎原始证据

本目录是合成账号 `lab_treasury_t1` 的 Screeps Engine 4.3.0 验收快照，不含正式 shard1 数据。每个 `*.json` 快照记录暂停 tick、原始 Memory、两房对象、真实引擎交易以及已加载的 `main` 指纹。`manifest.json` 固定源码提交和构建字节；`verification.json` 为 `verify.py` 从快照重算的断言结果。

在本候选工作树执行：

```bash
python3 docs/reports/treasury-production-T1-engine-evidence-20260925/verify.py \
  docs/reports/treasury-production-T1-engine-evidence-20260925
```

第一轮顺序：`pre-canary` → `post-canary` → `drain` → `post-off` → `post-restart-off`。第二轮为人工重新装夹的成本实验：`cpu-off-steady` → `cpu-shadow-steady` → `cpu-canary-first` → `cpu-canary-settlement` → `cpu-canary-steady` → `cpu-drain-steady` → `cpu-off-handback`。第二轮清除的是隔离世界的合成配额，不能被解释为产品的自动 rearm。

服务器 `dsh` 的引擎安装和世界保留在 `/srv/screeps-treasury-t1`。测试服务是临时 systemd unit，当前已停止；停止后 unit 会消失，不会开机自启。若需继续实验，可在服务器启动：

```bash
systemd-run --unit=screeps-treasury-t1 \
  --description="Isolated Screeps Treasury T1 lab" \
  --property=User=screepslab --property=Group=screepslab \
  --property=WorkingDirectory=/srv/screeps-treasury-t1/server \
  --property=MemoryMax=3G --property=CPUQuota=150% \
  --property=NoNewPrivileges=yes --property=Restart=no \
  /srv/screeps-treasury-t1/runtime/node22/bin/node \
  /srv/screeps-treasury-t1/server/node_modules/screeps/bin/screeps.js start
```

配置只在本机回环地址开放游戏、CLI、存储端口 `21025/21026/21027`；模拟世界使用占位 Steam key，因此后端登录接口可能返回 403。它不影响本次 CLI 管理、真实引擎执行和存储快照；不需要给隔离服配置正式 Steam 密钥。停止命令是 `systemctl stop screeps-treasury-t1.service`。第一轮结束时的完整数据库备份仍在服务器 `/srv/screeps-treasury-t1/evidence/db-after-first-run.json`；不要用它覆盖正式服任何数据。
