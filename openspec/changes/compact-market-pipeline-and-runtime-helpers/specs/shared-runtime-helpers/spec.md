## ADDED Requirements

### Requirement: Spawn 复用保持策略
公共 Spawn 辅助 SHALL 保留调用方的孵化负载、队列长度、名字破同分、active 偏好、planned load 以及房间/来源范围。

#### Scenario: active 偏好与计划负载不同
- **WHEN** 某调用方优先 active Spawn，另一调用方使用迁移中的 planned load
- **THEN** 两者通过显式参数保留各自行为，输入数组不被排序修改

### Requirement: console 包装等价
公共 JSON 包装 SHALL 保留 Raw 参数、返回对象语义、缩进、异常传播和已注册命令名称。

#### Scenario: 有参数或带默认值的命令
- **WHEN** 用户调用原有 console 命令
- **THEN** 参数传给同一个 Raw 实现，输出与合并前相同

### Requirement: 默认值与诊断边界
S5 MUST 只合并数值和语义相同的储备默认值；已开启的物流 shadow MUST 保留，直至明确停用。

#### Scenario: 20k 与 25k 同名默认值
- **WHEN** 两个模块的终端储备默认值不同
- **THEN** 不通过公共常量合并改变任一默认值
