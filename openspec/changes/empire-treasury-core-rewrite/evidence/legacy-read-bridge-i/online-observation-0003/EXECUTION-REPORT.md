# 正式兼容观察 0003

终态：`ONLINE_COMPAT_READ_INCONCLUSIVE` / ONLINE_CLOSE_UNCONFIRMED

refactor 起点：ee03fb4a871b1a707a4244d2f3a7819e5982324d

compat 起点：fcfc125f0e5cd6c3370318b4fee0450f4d09af53

候选 profile：d895423b8226d41b6352e1723695e1326fc3e69a

源码关闭 HEAD：3292e152b0db465263e4f1fa5c9eac068394acef

收到采样 tick：[]

未通过项：["COLLECTOR_TERMINAL_INVALID","FOOTER_INVALID","BRIDGE_JSON_INVALID","EXPECTED_12_SAMPLES","RESTORE_CONFIRMATION_INCOMPLETE","RESTORE_ATTEMPT_MISSING","RESTORED_DEPLOY_FRAME_MISSING","GUARD_NOT_NORMAL_COMPLETION","DRIVER_OR_PROCESS_FAILURE"]

本轮只审查 E3N59 / E4N58 的 storage、terminal，资源 energy / H。只读桥不签发许可、不运行完整 Treasury 生命周期。

CPU 口径：12 个样本的序列化/输出前成本，加上由下一样本报告的前 11 个样本完整成本。最后样本完整成本没有后继样本可报告，必须保留不可观测标记。

legacyProjection 的 stale/absent/mismatch 按原值归档；直接 Store 与核心 observation 的选定范围一致，不等于旧投影、全资源、全帝国或新 Treasury 决策全部等价。

唯一候选 POST 与最多一次恢复 POST 均有执行前持久标记。目标代码 API 没有服务端 CAS；本轮以部署目标排他使用为先决条件。

完整 backup、candidate 模块正文与凭据只留在工作树外，本目录没有复制这些文件。
