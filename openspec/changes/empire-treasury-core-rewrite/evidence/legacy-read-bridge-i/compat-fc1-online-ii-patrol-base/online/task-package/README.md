# FC1 Online II：巡逻基线兼容发布副本

本目录由固定执行器 `0e1e14f7` 提取后单独修订。原 `screeps-fc1-pending` 和已归档的旧证据保持原样。用户已在本任务中批准这份新指纹的一次 FC1 线上测量与精确恢复；授权范围和来源见 `AUTHORIZATION.json`。`policy.json` 的 `newRoundAuthorization.status=AUTHORIZED`，`onlineExecutionReady=true`。所有身份、离线门禁和一次性额度仍必须在执行时再次核对。

当前 shard1 的 `default/main` 是巡逻修复 `5cef62c5`，SHA-256 `62a993bf917f1a74ef708584eaee1fc3d2deb5aaf8b0c751f8f9d72ff3c08032`。旧 FC1 包的恢复 `main` 是 `06ffedb7`，不能覆盖现役巡逻。本副本把候选源码建立在 FC1 固定源码 `0cdbd061` 加巡逻修复和准确 Jest 门禁的分支 `codex/fc1-online-ii-patrol-base` 上；四个 Treasury 测量模块的源码、输出指纹、runtime emitter ID 和 10 CPU / 25 reserve / 55 headroom / 四点 100 tick 策略保持不变。

`productionBase=06ffedb7` 是冻结测量器自述的**源码血统基点**，而正式服上传前后需要精确匹配的物理备份是 `5cef62c5`。执行器分别验证这两项，不能把报告字段改写成从未由冻结模块发出的值。只有账号、活动 branch、房间所有权、整套模块字节和读回恢复全部满足时，线上结果才有效。

离线门禁顺序：`node tools/verify-package.cjs`、`node tools/run-tests.cjs --out <仓库外新目录>`、`node tools/build.cjs --compat <巡逻基线工作树> --out <仓库外新目录>`。完整执行还需要独立的授权绑定、未消耗额度与正确的远端源分支；当前尚未执行候选上传或恢复 POST。
