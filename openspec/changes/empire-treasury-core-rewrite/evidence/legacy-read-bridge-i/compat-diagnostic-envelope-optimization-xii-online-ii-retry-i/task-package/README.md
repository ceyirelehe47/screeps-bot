# Screeps XII Online II Retry I v2

修复 2026-09-15 Retry I 原包的三项错误路径声明。来源为用户 2026-09-20 的复现证据，独立对照 GitHub `982ac514` 和已归档 v4 实现锁。

本版不改 XII 源码，不创建或迁移 source commit。路径从精确 SHA-256/Git blob 认证的 `references/implementation-lock.json` 读取，不再维护第二份手写清单。物化成功前运行真实 source scope + 47 项冻结锁检查。

入口是本目录 `AGENT-RUN.md`。必须用全新 resolved/execution 目录；65/65 包测试、290 项仓库 Node、loader、双 tsc、Jest、Rollup 仍是 Agent 必须完成的门禁。

原 30 分钟只读网络就绪、三次稳定 canonical 基线检查、四点诊断、candidate/restore 各最多一次和 75 秒恢复确认完全保留。未知线上字节漂移不会因为修复路径而获得批准。

制作方验证范围见 原增量包中的 `DELIVERY-VALIDATION.json`；已认证的 Git 对象子集不等于完整源码 clone，依赖组装测试不等于真实在线执行。
