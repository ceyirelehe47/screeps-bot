# 固定来源与制作方边界

Repository: ceyirelehe47/screeps-bot
Evidence commit: 6e4ec0e49c01eed2c130191459cd26b8a1c41257
Evidence path: openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0003

- run/public-session.json — Git blob 66d1d88ced8ce9122eaa9a092920acb210615aa9：身份、快照 SHA、配置和两个模块摘要。
- run/console.jsonl — Git blob 4303303b2b745b94b60859c302bf8c8ea2e9d1e0，312–313 行：首点 &#x22; 转义报告、partial_cpu_budget、commitments 未读取和旧 collector 失败 footer。
- run tree — 5afeca2ba5923aa0837d9b8309d0d11925f75f34：29 个原始文件，没有 restore-attempt.json。
- scripts/lib/deployGuard.cjs — Git blob 796e71d9b5572014fd2ce8e9a0ee797e4e04c7a8：已读出并逐字节复算 Git blob；新包携带同一原件。
- 0003 原包 — task-package tree 56d175e1e3b4a42ac41ff6b98b9d33bee6a5eacd，下载包 SHA 在 SUPERSEDES.md。vendor/0003 来自会话挂载的原 ZIP。

测试的 observedReport/firstFrame 夹具根据已读取的完整首点报告字段构造，并生成同一 &#x22; 编码形式。它不是整个原始 console.jsonl 的逐字节副本；制作方不会把该夹具声称为真实网络运行。Agent 的离线回放从固定 Git blob 物化真实完整原始文件，不能用夹具代替。

制作方没有取得 PRIOR 中两份真实私有模块快照，没有使用真实 token，没有调用 Screeps，没有执行真实恢复或原生 Windows 75 秒采集。制作方实现测试在 Linux / Node 22 执行。Windows 文件系统、真实固定 Git 对象库、私有原件与线上行为由 Agent 用同一固定实现验证。
