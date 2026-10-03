## ADDED Requirements

### Requirement: 补塔可用Storage
系统 SHALL 在Tower触发补给时允许carrier从Storage及适用proto取能，使用既有补塔门槛与优先级。

#### Scenario: Tower394且Storage充足
- **WHEN** Tower低于600而carrier空载且Storage有能量
- **THEN** carrier可取能并执行补塔

### Requirement: Terminal授权不扩展
系统 SHALL 保留Terminal通用开关和能量储备，仅Spawn/Extension允许使用临时bootstrap授权。

#### Scenario: 仅有bootstrap授权
- **WHEN** 补塔时Terminal通用取能关闭而存在bootstrap授权
- **THEN** 不使用此授权取Terminal能量
