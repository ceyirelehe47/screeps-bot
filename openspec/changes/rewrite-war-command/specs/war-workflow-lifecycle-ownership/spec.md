## MODIFIED Requirements

### Requirement: one-shot generation耗尽具有显式终态
已部署的t3Duo generation成员少于完整二人组且task为one-shot时，War领域 MUST 将task转为`failed`、写机器可读`failReason=generation_exhausted`与`completedAt`，释放production/Boost，并按既有策略detach survivor；不得只返回并让task永久停在非终态。

#### Scenario: one-shot只剩一名survivor
- **WHEN** deployed one-shot generation下一tick只观察到attacker或healer之一
- **THEN** survivor必须保持存活但detached，owner必须进入`failed:generation_exhausted`，且后续tick不得创建下一代或再次生产原generation

#### Scenario: 非one-shot仍可换代
- **WHEN** deployed非one-shot generation少于二人
- **THEN** 系统必须保持现有replacement generation语义，清理旧generation后创建单调递增的新generation；连续无战果且没有可用的新入口时 MUST 进入带原因的终态
