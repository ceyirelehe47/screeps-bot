# Compat Subphase Online X

状态：NOT_DEPLOYED
归因：SUBPHASE_X_ATTRIBUTION_INCONCLUSIVE
恢复：NOT_DEPLOYED

refactor base: 73726cd44267b0f583f5d08890233ad67a5e803a
compat root base: 57987cda22553fcdc842e8d4c72a98b6e94e00fb
remediation source head: e1e3161fc354322707e05b74640c27535727a2b1
compat OFF head: d5e09b623de7391b3f69e51fb80cf7a852618509

raw reports: 0; diagnostic reports: 0; attributed reports: 0; complete samples: 0

本轮先修复 source manifest 三项陈旧身份，并把生成器门禁扩大到全部 manifest outputs；随后在同一固定实现上执行四点 IX 子阶段在线诊断。

九个子阶段嵌套于已有父阶段，不能与父阶段相加。primitive work counters 只描述工作组成，不是 CPU 权重；测量开销不扣除，也不按 task、reservation、资源键或查询逐项采样。

partial_cpu_budget 仍可作为归因证据，但不是完整样本。空投影行不能解释为零承诺。末点没有后继报告，尾部不可观测且未追加第五点。

候选与恢复各最多一次 POST，共用持久锁和标记。恢复使用独立 closureId 和 75 秒运行确认，不拼接观察连续性。

私有模块快照、凭据和构建产物不入库。原生 git whitespace 检查无例外。
