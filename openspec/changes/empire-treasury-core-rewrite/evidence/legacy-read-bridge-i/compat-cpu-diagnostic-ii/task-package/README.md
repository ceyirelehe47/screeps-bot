# Compat CPU Diagnostic II

四点、2 CPU 原预算的受控阶段诊断。完整执行链由制作方实现，Agent 只验证和运行。

本包以 compat `43b1b8e51caca0c17b975971a71fbbb0951823bf`、refactor `bb1aa9900bfe6505ff6ef871ead0a0c61e7b1f1f` 为起点。
只临时改变兼容配置，默认 OFF 源树不变；不修改读取器、生成核心、市场、物流或完整 Treasury。

本次是新的 CPU 诊断实验，不是重做0003，不是宣告四点等同于12点正式兼容验收。允许一次新候选上传和最多一次恢复写入，绝不重发写请求。partial_cpu_budget 可以是有效诊断，但不成为完整业务样本。

执行入口：`tools/observe.cjs`。先完成固定工具测试与真实兼容分支两套类型检查、195/685、build-only；入口才即时绑定四点窗口并构建干净 detached 候选。

恢复通路不依赖 game/time，不依赖旧 collector 是否健康。独立恢复进程执行恢复，并以新 closureId 取得75秒 shard1 console及账号CPU，前后核对旧生产字节。网络持续不可用、旧进程遗留 action.lock 或未解决的写入结果，都可能导致 ONLINE_CLOSE_UNCONFIRMED；不能通过重发POST或删标记掩盖。

完整说明及失败收尾见 AGENT-RUN.md。制作方从未使用真实凭据或连接 Screeps。GitHub 获取源码上下文与 loopback 假远端测试不属于官方实测。
