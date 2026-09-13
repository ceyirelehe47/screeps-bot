# Compat Build Optimization VII

源码基线：cdecde02ec7d364141d71f45bf21dc23969deff0
源码提交：2d28a6f146fc81e5b87be7cf5b70648352557797
证据父提交：04ca086c3d62db5f506389bc59c3fb1bb4b81b66

本轮仅改变只读兼容 capsule 的完整任务索引存储方式及 observation 中间分配。每次仍创建全新 scope/room buckets、完整索引、observation、指标与视图；没有跨样本缓存或延迟构建次级索引。

全表枚举、记录校验、安全整数溢出及部分更新顺序、reason/merge/receiver 查询语义和预留 owner/expiry 规则保留。直接读取、preview、CPU检查点、上下文及加载器均未修改。VII逆变换还原Read V；V逆变换还原canonical前缀。逆变换不代替语义对照。

原生Map计数与136个临时entry pair的减少是合成输入的确定性工作量，不是引擎CPU结果。20场景A/B及完整API反例通过；实际源/目标核心字节固定。

预算2、配置OFF、窗口0；无Screeps调用、token、上传或恢复。CPU VI历史仍4诊断/0完整、3次承诺构建、恢复闭合。引擎缺口仍未解决。
