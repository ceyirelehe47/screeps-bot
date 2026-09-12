# Compat Loader Optimization III

源码基线：745231048d97fd43fa7613abe988ae324bea10f8
源码提交：ae15ec55b0363933d31c93acc2480b6adbea306a
证据父提交：2d97f0d93a1bf02191bf4712f1201638263e09ea

六个经审查的定义模块在首次成功初始化后复用；commitmentRevision 与 commitments 模块每样本重建。所有 factory 正文和依赖边保持原字节，业务索引及 observation 仍逐次构建。初始化仍在准入样本预算内部；没有把成本挪到预算外。

首次成功建造仍执行8个 factory（另有缓存发布开销），后续每次2个；12次为96→30次 factory 执行。这不是CPU下降百分比。直接读取路径未优化，首点直接读取超限仍可能发生，真实净开销需另行实测。

固定测试与真实仓库检查通过；20个合成场景使用实际旧/新核心做字节等价对照。Game/Memory是明确合成数据，不是生产重放。

本轮没有使用token、连接Screeps、上传候选或执行恢复；配置OFF、预算2。CPU Diagnostic II的4条诊断/0条完整及既有恢复结论不变。下一轮线上实验须另行授权，本报告不宣称完整国库可切换生产。
