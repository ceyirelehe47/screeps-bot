# Compat CPU Diagnostic II

状态：CPU_DIAGNOSTIC_CAPTURE_VERIFIED
恢复：RESTORED_BYTES_AND_RUNTIME_VERIFIED

refactor base: bb1aa9900bfe6505ff6ef871ead0a0c61e7b1f1f
compat base: 43b1b8e51caca0c17b975971a71fbbb0951823bf
compat OFF head: 745231048d97fd43fa7613abe988ae324bea10f8

raw reports: 4; diagnostic reports: 4; complete samples: 0

本轮四点诊断与完整兼容验收分开。partial_cpu_budget 可提供阶段成本，但不是完整样本。原0003仍为1 raw / 0 complete，已有恢复闭合事实不变。

firstAdmitted 指本模块生命周期首次准入，不证明引擎冷启动。阶段为含诊断开销的区间；末样本尾部缺少后继报告，不可观测。没有推导真实CPU提速百分比，没有提高预算2。

每个运行最多一次候选POST、一次恢复POST，共用持久标记；只读复核可以有界重试。代码API没有CAS，部署排他使用是前提。新恢复流使用独立closureId，不拼接观察连续性。

私有模块快照、凭据、构建产物不入库。stdout/stderr/TAP以带原字节摘要的JSON包装保留，不修剪原件。原生git whitespace检查无例外。
