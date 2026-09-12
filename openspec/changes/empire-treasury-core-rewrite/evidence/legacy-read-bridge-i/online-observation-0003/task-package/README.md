# Screeps Treasury — Formal Compatibility Observation 0003

完整实现交付；执行 Agent 仅验证。先阅读 **AGENT-RUN.md**。

## 本轮的唯一主线

固定工具测试 → 真实兼容基线类型/Jest/构建验证 → 即时线上前检与新鲜窗口绑定 → 独立 collector 与恢复 worker → 至多一次候选 code POST → 12 个预定样本 → 至多一次恢复 code POST → 独立回读 + 75 秒同进程运行确认 → 本地默认 OFF → 原始日志独立验收 → 白名单归档与唯一 evidence 提交。

本包不重新执行已通过的 25 分钟联合探针，不部署完整 refactor Treasury，不增加房间或资源，不让 Agent 现场修改实现。

## 可执行交付

- `runtime/`：完整正式执行链与原始证据验证器。
- `tools/`：基线核验、实际编译检查、即时绑定与执行入口、收尾、归档和推送。
- `tests/`：92 项固定离线测试。独立子进程、模拟远端引擎、真实临时 Git 与 loopback HTTP；不是官方服实测。
- `patches/`：三个与上述文件逐字节等价的完整补丁镜像，只应用到空工具目录；**不**应用到生产仓库根目录。
- `references/`：固定基线、来源与测试集合。
- `validation/`：制作方执行原件、限制与校验记录。

执行首选完整文件树，不同时应用 patch 镜像。真正的唯一生产源码路径是 `src/runtime/treasuryCompatConfig.ts`，由固定 binder 和 closer 自动生成与恢复，Agent 不手写配置。

## 关键边界

`observe.cjs --execute --exclusive-target` 是正式主入口。它在昂贵离线检查完成后才读取实时 tick，S=ceil((tick+150)/100)*100，E=S+1100；上传前再次要求至少100 tick提前量。前检或构建过慢时本轮停止，不换窗口。

没有 marker 不代表 HTTP 一定没发出；本实现以排他写入且 fsync 的 attempt 记录先于 POST，未知结果保守处理、不自动重发。恢复前若目标不是本轮候选或备份，不覆盖第三方代码。目标排他使用必须由执行方确认；服务器没有 CAS 的竞态不能由本地锁消除。

成功只代表这次双房间/双资源的兼容只读观察证据完整，并已恢复；不代表 Treasury 生产切换完成。所有完整模块快照只留在 Git 外。

CPU：12 个序列化/输出前成本 + 前11个可由后继样本证实的完整成本；最后一次完整成本没有后继采样，必须明确不可观测。不能加入第13点或伪造计数。

## 平台与验证

目标为已有 Node22 Windows 工作环境；不要求WSL或大小写敏感文件系统。制作方在 Linux Node22.16.0执行本包固定测试，未运行真实Windows、完整生产仓库构建或Screeps网络实验。精确内容见 `validation/LIMITATIONS.md`。
