## ADDED Requirements

### Requirement: 四类观察公平与单意图
系统 SHALL 将作战、PowerBank、Deposit和外矿复看归入同一有界调度器，每Observer每tick最多一个意图，同房跨类别去重，保留普通发现轮巡。

#### Scenario: 多业务竞争
- **WHEN** 四类请求同时存在
- **THEN** 各业务得到有界服务，普通巡检继续，失败不永久阻塞其它房

### Requirement: Observer接替纯视野Scout
系统 SHALL 优先使用可覆盖的Observer并停止纯视野Scout新增生产；入队不等于取得视野，持续实际缺视野时必须恢复后备。

#### Scenario: 外矿Invader防守视野
- **WHEN** 母房Observer覆盖外矿并及时获得视野
- **THEN** 停止该视觉Scout配置与孵化队列，防守与预订单位不受影响

#### Scenario: 覆盖失效或长盲区
- **WHEN** Observer不可用或超过等待宽限仍未真正见到房间
- **THEN** 恢复Scout后备，不把盲区判为清场
