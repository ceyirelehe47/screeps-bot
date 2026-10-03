## ADDED Requirements

### Requirement: 动态 Observer 搜索与复看
系统 MUST 从当前己方位置生成 Observer 范围内高速房候选并去重轮巡，不得使用固定房间名单限制发现、任务执行或角色行程。已接受任务的资格不得取决于当 tick 观察覆盖集合。

#### Scenario: 原固定名单之外的发现
- **WHEN** 当前视野存在原名单之外的合法高速房 PowerBank
- **THEN** 系统必须记录并按实际路径评估，不得仅因房名拒绝

#### Scenario: 失去目标视野
- **WHEN** 新任务缺少目标当前视野或 Bank 身份确认
- **THEN** 系统必须请求有界复看并等待，且不得发布 Spawn 或 Boost 投入

#### Scenario: 观察失败
- **WHEN** 一个候选房的 observeRoom 返回失败
- **THEN** 系统必须继续轮转，且多个 Observer 不得在同 tick 重复观察同房

### Requirement: 完整路径驱动开采准入
系统 MUST 从实际 active Spawn 到 Bank 邻位计算安全走廊内完整路径，分别用战斗、空载去程和满载名义返程时间评估寿命与回收；不得把房间数或 incomplete 路径当作已完成测距。

#### Scenario: 搜索预算或路径证据不足
- **WHEN** 来源测量受预算限制，或 PathFinder 未完成路径
- **THEN** 系统必须有界等待或重试，保留绝对 Bank 截止，不能选择尚未评估完的来源快路

#### Scenario: 预算外的前置工作
- **WHEN** 当 tick 测量配额已耗尽且候选没有可复用证据
- **THEN** 系统必须在昂贵状态、拓扑和后续来源扫描之前等待；缓存证据仍必须验证当前几何，最终不得使用部分来源结果投入资源

#### Scenario: 地形使任务无法完成
- **WHEN** 实际路径与旅行时间超过击杀期限、掉落回收窗口或搬运往返 TTL
- **THEN** 系统必须拒绝该候选，不能继续套用房间数乘50的乐观值

#### Scenario: 当前目标存在战斗威胁
- **WHEN** 当前可见目标存在有效敌方 ATTACK、RANGED_ATTACK、HEAL 或未知敌方战斗能力
- **THEN** 系统不得投入新的开采小队，并必须保留可定位的阻塞原因

### Requirement: 双向搬运与再次拾取
Hauler MUST 按当前房到实际目的地的方向使用任务或旧参数路线，并在空载返矿后通过 mount 协议进入拾取阶段。

#### Scenario: 中间房载货返库
- **WHEN** Hauler 从 Bank 经中间房返回来源
- **THEN** 路线必须朝来源前进，不得再次指向 Bank；走廊外必须动态恢复

#### Scenario: 第二趟回收
- **WHEN** Hauler 完成一趟投递、返回矿场，任务仍处于 hauling 且仍有 Power
- **THEN** 真实 work 循环必须重新拾取并累计同一 owner 的交付
