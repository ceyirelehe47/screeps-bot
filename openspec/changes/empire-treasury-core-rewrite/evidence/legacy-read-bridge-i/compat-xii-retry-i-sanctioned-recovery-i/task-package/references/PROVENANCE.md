# 来源与验证边界

恢复输入来自用户上传 ZIP：c48fe2b796d4d31a13876f402608a72c38a0c230bb346f814cd3c01c8905914f。
GitHub 独立核对：ceyirelehe47/screeps-bot，compat 8c1ddecc126f4aee116d46b88547eafdd0e47d37、refactor ed7eb284c38e3bd346c4b8013aec2ee5124f2b4d。
原 evidence：openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-diagnostic-envelope-optimization-xii-online-ii-retry-i。

vendor/deployGuard.cjs 原字节来自附件中的实际构建源码，Git blob 796e71d9b5572014fd2ce8e9a0ee797e4e04c7a8、SHA-256 f438b3b9cae3f195398e97a6adb7bb9f0bf944b3e295e9ede6076cf7501cfaf7。模块集合 hash 和逐项差异比较继续使用 canonical guard。

runtime/transport.cjs 是恢复专用窄化实现：保留已执行 transport 的 X-Token/X-Username、HTTPS 请求方式和 endpoint，移除 time/overview，显式允许最长 60 秒 GET 与 120 秒唯一恢复 POST；增加 canonical restore body 验证。参考原 transport blob 36958dd8eacbd5a902fa63b003e381d7548af86c。

其余恢复工具为本包新实现，不声称与旧工具逐字节相同。没有从不完整模拟目录物化执行链。包不依赖外部 JS 库或完整源码 clone；只有发布阶段依赖用户现有 Git 仓库。

制作端实测包括真实附件快照验证、4.6 MB GET/4.49 MB main POST 的本地 HTTP 传输、POST 响应丢失、配额持久化、重复 invocation、独立 runtime 验证和原生 Git archive/commit/本地 bare remote push。测试用本地服务器和合成 WebSocket 帧，绝不把它们写作真实 Screeps 恢复。52 项测试计数互不额外累加。

没有使用用户 token，没有调用真实 Screeps API，没有执行真实恢复或真实 75 秒线上观察；没有在 Windows 实机运行本包，也没有向真实 GitHub 推送此包。原 source/290 tests/Jest 的既有通过证据不等于本包的新测试。
