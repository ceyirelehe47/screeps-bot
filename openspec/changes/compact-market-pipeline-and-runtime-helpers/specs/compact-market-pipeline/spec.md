## ADDED Requirements

### Requirement: dryRun 交易隔离
新管线在 dryRun 模式 MUST 不调用市场写 API、terminal 动作、仲裁领取或修改旧市场根；只在生产决策结束后记录自身观察。

#### Scenario: 观察成功或抛错
- **WHEN** 新挑单完成、数据不完整、预算不足或内部异常
- **THEN** 旧管线的选择和实际写入不变，新管线记录有界结果或失败原因

### Requirement: 可卖量与净价的唯一口径
新内核 SHALL 使用当前且完整的生产保护、现行 r8 分层净价和实际运费；可卖量、terminal 库存和能量储备共同限制数量。共享溢出函数 SHALL 同时服务采矿与出售。

#### Scenario: 生产承诺变化
- **WHEN** 原料有保护承诺、在途暴露或旧快照
- **THEN** 新管线不把受保护部分算作可卖量，旧快照不形成可比成功样本

### Requirement: 对照真实性及界限
对照 SHALL 逐 lane 比较保护量、floor 及选单，并记录可比/不可比/差异计数和时间跨度。cost memo 缺项 SHALL 记为不可比，不额外调用旧运费预算回调。

#### Scenario: 缺少某个运费样本
- **WHEN** 新内核需要的运费没有出现在同一完整读取的 memo 中
- **THEN** 该样本不记为一致，V3 预算计数及决策保持不变

### Requirement: 分阶段切换
live 切换 MUST 等待多天覆盖、差异验收、旧市场归档和连续两 tick 无 pending/自有卖单证明；三处旧安全闩 MUST 显式保留。

#### Scenario: dryRun 已部署但观察窗口未完成
- **WHEN** 新状态只有短期样本
- **THEN** 状态报告仍显示 dryRun，旧市场继续为唯一卖出写入者，禁止宣称 S4 完成
