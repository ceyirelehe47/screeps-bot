# Remediation III 负向变体（G20）

四项目标回退变体在修复版上的行为红灯（编译错误不算行为红灯——R1 首版 ===999 变体因 TS2367 弃用，改用移除 guard 检查行）。

| 目标 | patch | 红灯测试 | 还原验证 |
| --- | --- | --- | --- |
| R1 guard 失效 | r1-guard-disabled.patch | G01（D0 重入重复调用/份额超 4）exit=1 | restored.log exit=0 |
| R2 truthy 回归 | r2-truthy-regression.patch | G03（truthy 对象误释放；矩阵需全覆盖注入——同步修订 G03 逐 tick 注入）exit=1 | restored.log exit=0 |
| V1 不消费断点事件分支 | v1-no-reopen.patch | G09/G10/G11（恢复 B0 借 B1 效果 committed 等）exit=1 | restored.log exit=0 |
| V2 忽略参数逐次核对 | v2-skip-args-check.patch | G14（参数不匹配仍归属）exit=1 | restored.log exit=0 |

说明：V2 首版（恢复 argsMap 单值注册表）在新测试形态下无覆盖数据来源（新测试不再显式登记 attempt），不构成行为红；改为删除参数逐次核对——同属 V2 目标语义（§5.2 参数逐次核对）的回退。
