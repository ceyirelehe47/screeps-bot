# Compat CPU Recheck IV

状态：CPU_DIAGNOSTIC_CAPTURE_VERIFIED
恢复：RESTORED_BYTES_AND_RUNTIME_VERIFIED

refactor base: 33cfbd4e2192d65723cf3d9d85ae8cae8e8a06c0
compat base: ae15ec55b0363933d31c93acc2480b6adbea306a
compat OFF head: af7cfb7507d42bb12a32b8ea9d85dadd87d97fae

raw reports: 4; diagnostic reports: 4; complete samples: 0

本轮四点诊断与完整兼容验收分开。partial_cpu_budget 可提供阶段成本，但不是完整样本。原0003仍为1 raw / 0 complete，已有恢复闭合事实不变。

已新增 LOADER-COMPARISON.json：以固定CPU II归档为历史对照，仅实际calls=1的区间参与构建调用成本统计。首次准入和首次reader调用分别标记。跨轮工作负载不可控，不计算精确提速百分比，不把降低成本设成采集通过条件。

firstAdmitted 指本模块生命周期首次准入，不证明引擎冷启动。阶段为含诊断开销的区间；末样本尾部缺少后继报告，不可观测。没有推导真实CPU提速百分比，没有提高预算2。

每个运行最多一次候选POST、一次恢复POST，共用持久标记；只读复核可以有界重试。代码API没有CAS，部署排他使用是前提。新恢复流使用独立closureId，不拼接观察连续性。

私有模块快照、凭据、构建产物不入库。stdout/stderr/TAP以带原字节摘要的JSON包装保留，不修剪原件。原生git whitespace检查无例外。
