# CPU Diagnostic II：本轮依据与边界

来源commit：2d97f0d93a1bf02191bf4712f1201638263e09ea
路径：openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-diagnostic-ii/FINAL-VERIFICATION.json
Git blob：5112f9cc691bb1637b3c94e5b9cee0da0d9e9bbb

这是对已验收材料的摘录，不是新实测。4条raw、4条有效诊断、0完整；恢复RESTORED_BYTES_AND_RUNTIME_VERIFIED。

73654400：directRead 1.9702475000012782；readerLoad未调用；prefix 2.3955776000002516。
73654500：readerLoad 0.5945108000014443；observationBuild调用1次、区间0.71176170000399；prefix 2.5129649999944377。
73654600：readerLoad 1.6839718999981415；observation未调用；prefix 2.8935244000094826。
73654700：readerLoad 1.1415482000011252；observation未调用；prefix 2.0960042999940924。

所有commitmentBuild调用计数为0。因此小的commitmentBuild阶段区间不是构建函数的成本；本轮不据此断言commitment很快/很慢。

本轮工程判断：先减少readerLoad中的重复定义初始化。仅首点directRead已超限的问题仍保留，不能用后续加载优化声称同时解决。复用的只是私有函数/常量定义，不是首点Room、Store、Memory、observation或index。

所有预算边界、初始化所在阶段和CPU I诊断仍保持；是否产生净引擎改善必须另行通过同口径实测验证。
