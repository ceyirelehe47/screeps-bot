# Treasury Compatibility Online Tooling Remediation I

下一轮**实现任务包**：修复线上前检、精确恢复、截止与收集工具，并接续现有兼容桥的一次限定线上观察。不是只有任务说明，也不是国库／兼容桥的新一轮重构。

先阅读 `AGENT-RUN.md`，运行 `node tools/verify-package.cjs`。本包解压在候选工作树外，直接执行新工具；不要覆盖旧证据目录中的脚本，也不要再次应用已入仓的计数器补丁。

代码候选 `compat/treasury-read-bridge-i` @ `6a63a2aff064295ef65efc8def26c9865dfd9db3`；证据分支起点 `5b6afad054d5352a5bbc40d3dae31339c2a5a180`。生产变更仅允许profile启用／关闭，算法、旧业务、Defense、构建器与依赖不修改。

## 包内实现

- 严格 `activeWorld`、成功响应和非空类型完整的modules验证；前检固定原件字节，不只相信旧commit标签。
- 正式使用仓库既有集合摘要算法，并额外核对模块名／类型／内容；修复文本与二进制误判。
- 有界HTTP、恢复子进程和等待终止确认；活PID但断流／缺样本也能触发关闭。
- 不输出原始异常正文；console凭据脱敏及脱敏标记；旧token不再取回。
- 固定build-only产物后一次上传与回读，guard在上传前拿到准确恢复对照，避免 `npm run push` 重建后产物不同。
- 上传结果未知时不拿“暂时还是旧代码”冒充最终关闭；所有操作只影响明确的forster/default目标。

`preflight-read.cjs` → `prepare-session.cjs` → `console-collector.cjs` / `deadline-guard.cjs` → `upload-once.cjs`；人工中止用 `request-close.cjs`。恢复逻辑在 `restore-modules.cjs`。默认不上传；带`--execute`的写操作仍需执行会话授权。

**用户已授权Agent自行办理官方临时免限流，不需重复就此请示。** `token-status.cjs`使用正确query-token端点，不打印token或原URL；官方真人验证不绕过。授权发布与恢复的边界在任务书中一次说清，已有同范围授权直接沿用。

## 本地验证

100项测试通过，五种故障变异检出。含实际本地HTTP、WebSocket、CLI和自建子进程；不是Screeps实机验证。`validation/`保留原始记录、范围与未执行项。真实候选边界测试是独立必跑的 `tests/candidate-boundary.cjs --repo PATH`，没有缺源码就skip的分支。

没有push、连接游戏或使用真实token。Agent接手后原样测试、独立构造反例、确认实际构建与目标，再执行已授权的限定窗口；不能只看本包测试全绿就宣称线上已经完成。
