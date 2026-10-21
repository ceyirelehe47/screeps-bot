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
live 切换 MUST 完成已有对照证据审阅、明确的操作者切换授权、服务器完整回归、旧市场归档和连续两 tick 无 pending/自有卖单证明；三处旧安全闩 MUST 显式保留。监控天数和零差异本身不构成执行验证。2026-10-21 用户明确批准直接切换，不再等待额外天数；缺失的执行验证通过确定性回归和有界线上成交验收补齐。

#### Scenario: dryRun 已部署但观察窗口未完成
- **WHEN** 新状态只有短期样本
- **THEN** 未收到切换授权时仍显示 dryRun；收到明确授权后完成实现、服务器验证、归档与静默交接，不能只修改 mode 或宣称所有 S4 后续任务完成

### Requirement: 有界正式执行与持久交接
新执行器 SHALL 独立采集订单、生产保护、历史价与运费，延续 r8 分层定价、可信底价、EMA/日限幅、冷却与实物保护。首次接管 SHALL 固定当前可写 lane 的房间、Controller 和 Terminal 身份，保留单笔 1000、单周期一笔及现有额度，不自动扩展范围。

#### Scenario: 旧状态停止且归档已绑定
- **WHEN** 操作者设置带发布提交、归档哈希、明确授权和精确 lane 的 cutover 配置
- **THEN** 旧入口保持静默，新状态记录连续两 tick 无暴露后才激活；复制可信地板、动态价格锚、历史成交和冷却高水位，不重置额度

### Requirement: 成交确认与外部兼容
新执行器 MUST 先写 pending、通过统一 arbiter 领取账号和 Terminal、最后重读选择及保护后提交；只有匹配引擎 outgoing transaction 的数量、资源、房间、订单、tick 和价格且净价合格时才计入确认。未知返回/异常/缺帧 MUST 保留 pending，不能盲重试。Exposure、能量补给与物流 SHALL 读取新根，旧持久根在本阶段保留作回滚。

#### Scenario: 暂停或重启时仍有 pending
- **WHEN** mode 设为 off、global reset 或提交返回不确定
- **THEN** 新所有权保持，先对账并保留商品及能量暴露，旧执行器不会自动恢复；有序回滚需先暂停新单并确认无 pending
