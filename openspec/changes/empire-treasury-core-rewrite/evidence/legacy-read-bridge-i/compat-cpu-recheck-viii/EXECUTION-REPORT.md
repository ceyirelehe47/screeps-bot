# Compat CPU Recheck VIII

状态：CPU_DIAGNOSTIC_CAPTURE_VERIFIED
恢复：RESTORED_BYTES_AND_RUNTIME_VERIFIED

refactor base: a9f4cc04d99c8a8fda11f9c7e980861953341f03
compat base: 2d28a6f146fc81e5b87be7cf5b70648352557797
compat OFF head: ef23c464c83b90b413d43d07857f67d538f512a3

raw reports: 4; diagnostic reports: 4; complete samples: 0

本轮四点诊断与完整兼容验收分开。partial_cpu_budget 可提供阶段成本，但不是完整样本。原0003仍为1 raw / 0 complete，已有恢复闭合事实不变。

已生成 BUILD-COMPARISON.json：以固定CPU VI归档为历史对照，仅实际calls=1的区间参与构建调用成本统计。首次准入和首次reader调用分别标记。跨轮工作负载不可控，不计算精确提速百分比，不把降低成本设成采集通过条件。

本轮只测已提交Build VII，不再改任务桶融合、observation中间对象或direct算法。完整样本仍由完整验收函数判定；索引complete与结果行数单列，空rows不是零承诺。成本下降不是采集门槛。

firstAdmitted 指本模块生命周期首次准入，不证明引擎冷启动。阶段为含诊断开销的区间；末样本尾部缺少后继报告，不可观测。没有推导真实CPU提速百分比，没有提高预算2。

每个运行最多一次候选POST、一次恢复POST，共用持久标记；只读复核可以有界重试。代码API没有CAS，部署排他使用是前提。新恢复流使用独立closureId，不拼接观察连续性。

私有模块快照、凭据、构建产物不入库。stdout/stderr/TAP以带原字节摘要的JSON包装保留，不修剪原件。原生git whitespace检查无例外。
