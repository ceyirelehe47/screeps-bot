## ADDED Requirements

### Requirement: 有界经济采集准入
系统 SHALL 在实际去返完整路径、身体、当前冷却增长、资源过期、出生TTL、接收容量和孵化等待全部满足时才派遣单体采集运输单位，总并发最多2、每来源最多1。

#### Scenario: 路径或经济性未证明
- **WHEN** 路径incomplete、过高冷却、危险或TTL不够
- **THEN** 不生产新单位，既有载荷优先归仓

### Requirement: 世代孵化与实际交付
系统 SHALL 以实际spawning/creep证据确认出生，并在原生Spawn执行前重核同tick许可。transfer接受不等于交付，下一tick确认实际Store变化后才累计并清理。

#### Scenario: 队列过期或视野变化
- **WHEN** 排队后准入证据失效
- **THEN** 不孵化，取消无效所有者队列，不无限重生

#### Scenario: transfer没有实际卸空
- **WHEN** transfer返回OK但下一tick仍有货
- **THEN** 不完成、不销毁单位或载荷，继续运输或重试
