## ADDED Requirements

### Requirement: 重规划取消必须同步失效承诺

系统 MUST 由运输任务所有者取消自动 pending 任务，并同步更新 Treasury 承诺版本；Hub SHALL 保留既有需求判断与取消审计信息。

#### Scenario: 同 tick 已读取承诺后取消
- **WHEN** Treasury 已缓存待发承诺，Hub 在同 tick 取消过期合成路由任务
- **THEN** 后续 Treasury 读取不再包含已取消数量，任务记录 cancelled_by_replan；手动任务及终态任务不被此入口取消
