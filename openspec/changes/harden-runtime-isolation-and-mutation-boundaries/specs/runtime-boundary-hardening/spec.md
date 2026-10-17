## ADDED Requirements

### Requirement: 出口选择与执行共用路径约束

系统 SHALL 使用共用安全区与障碍约束选择出口并执行路径；系统 MUST 区分预算耗尽与真实无路。

#### Scenario: 边界走廊不能作为房内捷径
- **WHEN** 到目标边的路径只能先沿另一边界移动
- **THEN** 搜索不得将其当作可执行房内路径；真实失败应短期排除当前跳转

#### Scenario: 搜索预算耗尽仍有局部路径
- **WHEN** 搜索达到 maxOps 且返回 incomplete 局部路径
- **THEN** 系统有界重试一次，仍未完成时允许有效局部推进，且不得将其终点缓存为出口或把房间标记为物理无路

### Requirement: 防御异常逐房隔离

系统 MUST 在塔和本房防御的单房回调出错后继续处理后续房间；关键防御 SHALL 每 tick 重试并限制重复日志与诊断存储。

#### Scenario: 首房连续异常
- **WHEN** 第一间房连续多 tick 抛错
- **THEN** 后续房间每 tick 继续防御，首房也每 tick 重试，重复日志限频

### Requirement: 调度建议仅作为采样 shadow

系统 SHALL 在现有 CPU 采样中记录固定阶段的 T0–T4 建议，MUST 保留所有实际阶段执行，并且 MUST 不增加 CPU 计时 API 调用。

#### Scenario: 低 bucket 时建议延后规划
- **WHEN** 采样 tick 的 CPU 或 bucket 达到低优先级建议阈值
- **THEN** 样本记录建议原因，规划阶段仍按原顺序执行，T0 防御永不建议延后


### Requirement: 静态出口不可达不得作为局部进展

系统 MUST 将静态、预算未耗尽的 incomplete 搜索视为该跳转不可达，并立即短期排除；缓存出口重搜 SHALL 要求完整抵达。动态阻挡或预算不足的局部路径 SHALL 保留普通移动的推进语义。

#### Scenario: 静态墙隔断出口但仍有非空 partial
- **WHEN** 单房真实搜索返回非空 partial、incomplete 且 ops 小于预算，ignoreCreeps 为 true
- **THEN** 不发移动 intent，立即记录 20 tick 跳转排除，不走向死胡同

#### Scenario: 缓存出口在重搜时失去可达性
- **WHEN** 原缓存路径需要重搜，而旧出口只剩半截路径
- **THEN** 立即重新选择其他完整可达出口，或按静态失败排除跳转

### Requirement: 单塔故障不阻断同房防御并持久可见

系统 SHALL 隔离单塔计算与动作异常，继续同房其他塔，每 tick 重试；系统 MUST 在 profiler 关闭时仍维护至多八条有时限的防御故障摘要。

#### Scenario: 同房首塔动作异常
- **WHEN** 第一座塔攻击或治疗抛错
- **THEN** 同房后续塔仍执行相应防御动作，下 tick 首塔重新尝试，并可读取有界摘要

#### Scenario: profiler 关闭且故障过期
- **WHEN** 故障停止超过 1000 tick，profiler 仍关闭
- **THEN** 防御入口按正常运行清除过期摘要，不依赖采样 flush
