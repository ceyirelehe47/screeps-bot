# Compat Subphase Online X Retry I

状态：CPU_DIAGNOSTIC_CAPTURE_VERIFIED
归因：SUBPHASE_X_RETRY_ATTRIBUTION_RECORDED
恢复：RESTORED_BYTES_AND_RUNTIME_VERIFIED

refactor base: b6fffa20bfaaa8e6203dee25b09ff050048caa39
compat source base: d5e09b623de7391b3f69e51fb80cf7a852618509
compat OFF head: 9adb2739935c03c0450acfebbab94912a5e3e593

raw reports: 4; diagnostic reports: 4; attributed reports: 4; complete samples: 1

本轮复用已经闭合的 source-manifest remediation，不再修改生产读取实现。新增的包内执行能力只对候选上传前的只读请求实施总时限内、有界次数的重试；候选和恢复 POST 仍各最多一次且绝不自动重发。

九个子阶段嵌套于已有父阶段，不能与父阶段相加。primitive work counters 只描述工作组成，不是 CPU 权重；测量开销不扣除，也不按 task、reservation、资源键或查询逐项采样。

partial_cpu_budget 仍可作为归因证据，但不是完整样本。空投影行不能解释为零承诺。末点没有后继报告，尾部不可观测且未追加第五点。

恢复使用独立 closureId 和 75 秒运行确认，不拼接观察连续性。私有模块快照、凭据和构建产物不入库。原生 git whitespace 检查无例外。
