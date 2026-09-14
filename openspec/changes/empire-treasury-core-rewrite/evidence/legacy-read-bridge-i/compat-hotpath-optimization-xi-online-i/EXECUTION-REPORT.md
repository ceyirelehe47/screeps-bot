# Compat Hot-path Optimization XI Online I

状态：CPU_DIAGNOSTIC_CAPTURE_VERIFIED
归因：HOTPATH_XI_ATTRIBUTION_RECORDED
比较：HOTPATH_XI_COMPARISON_RECORDED
恢复：RESTORED_BYTES_AND_RUNTIME_VERIFIED

refactor base: 53cf8a6c07a171eeb8438c5cc07ac66d4968f1fc
compat root base: 9adb2739935c03c0450acfebbab94912a5e3e593
optimized source head: aa2682a470dcad2ea1890230a43ae65f58e17809
compat OFF head: 91b9a99226a7a135a0e75b8a1d0db255eefe2200

raw reports: 4; diagnostic reports: 4; attributed reports: 4; complete samples: 2

本轮先应用固定 XI 热路径优化并完成真实仓库门禁，再以同一 2 CPU、两房两资源、四点协议执行在线复测。性能改善不是采集成功门槛，比较结果按原始报告重算。

九个 IX 子阶段嵌套于父阶段，不能相加；primitive counters 不是 CPU 权重。partial_cpu_budget 仍不是完整样本，末点尾部仍不可观测。

候选和恢复 POST 各最多一次且不自动重发。恢复使用独立 closureId 和 75 秒运行确认。私有模块快照、凭据和构建产物不入库；原生 git whitespace 检查无例外。
