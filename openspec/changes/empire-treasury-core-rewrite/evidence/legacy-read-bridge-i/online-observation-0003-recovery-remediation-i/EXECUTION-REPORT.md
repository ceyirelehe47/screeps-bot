# 0003 Recovery & Evidence Remediation I

恢复闭合裁决：`RECOVERY_CLOSURE_VERIFIED`。原始观察仍为 `ONLINE_COMPAT_READ_INCONCLUSIVE`。

证据基线：6e4ec0e49c01eed2c130191459cd26b8a1c41257；compat 保持 3292e152b0db465263e4f1fa5c9eac068394acef。本轮不生成或上传新的候选，不改 CPU 配置。

本次闭合命令的恢复 POST 边界：1；代码字节确认：true；新的恢复专用运行确认：true。

代码字节依据是本轮实时只读回读；不是由 Git 默认 OFF、窗口过期或旧 guard 标签推导。运行确认使用新的 closureId，与 0003 的失败 collector 不拼接。

旧原始日志重新解码后收到 1 条桥报告、0 条完整样本。首点 tick=73646500，partial_cpu_budget，commitments=not_read_cpu_budget，序列化/输出前 CPU=2.4981476000029943，配置预算=2。

CPU 子阶段归因、冷启动与稳态的差别及完整输出成本未知；本轮只保留证据，不宣称优化完成，不提高预算。

原 run 已有文件哈希复核：通过。仅允许新增此前未消耗的 restore-attempt.json，另有执行期间的原 action.lock。历史 Git 证据不改写；完整模块正文与凭据不归档。

服务器代码写接口没有 CAS；执行恢复以 --exclusive-target 和 --prior-workers-stopped 的真实确认作为先决条件。读取可有限重试，恢复写入不重试；已有标记、第三方代码或无法确认状态均禁止补发。
