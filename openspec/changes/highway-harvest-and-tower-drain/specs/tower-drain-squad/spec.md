## ADDED Requirements

### Requirement: 无强化双人扫荡
系统 SHALL 提供各25 ATTACK/HEAL加25MOVE的无强化小队，三目标可从同一母房独立激活，不继承旧T3强化或额外CLAIM生产。

#### Scenario: E1N57三目标
- **WHEN** 请求E3N57、E2N54、E3N53的towerDrainDuo
- **THEN** 三个目标独立生成一红一绿配置，现有T3/standard行为保持兼容

### Requirement: 新鲜塔伤与可走退路约束
系统 SHALL 以当前视野、塔能量、身体、疲劳和实际可走退路作为入房、驻留与拆墙门。两人恢复后方可重新入房，塔补能后取消深入。

#### Scenario: 低血或塔回填
- **WHEN** 血量不足覆盖退出预算或塔重新有攻击能量
- **THEN** 沿实际入口退出并协同治疗，不继续拆墙

#### Scenario: 入口盲区或搭档缺失
- **WHEN** 无新鲜目标视野、没有安全退路或搭档失联
- **THEN** 等待或撤退并暴露blocker，不盲入
