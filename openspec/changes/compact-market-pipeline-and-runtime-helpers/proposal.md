## Why

S0–S3 已减少构建体积和持久化 Memory，但市场仍保留多代交易编排与许可链的热路径成本。S4 通过小型挑单内核逐步替换，S5 合并重复实现，降低维护成本；所有决策以当前 r8 及线上事实为基线。

## What Changes

- 新增普通数据政策、统一生产溢出函数、纯挑单内核和有界 dryRun 对照状态；新管线首先只观察，V3 继续独占交易写入。
- 对照复用同一次 V3 完整读取的保护、价格、订单和已计算运费；观察放在原交易决策之后，不调用交易、仲裁、二次盘口 API 或旧预算回调。
- 保留 r8 分层价格、生产储备、可信价格、终端能量保护和三处旧市场安全闩。多天对照、静默检查与归档完成后再实施 live 切换及旧代码删除。
- S5 合并 Spawn 队列/配置辅助、JSON console 包装和数值及语义相同的能量默认值；保留调用方的来源范围、活跃 Spawn 偏好、队首顺序及载荷口径。
- 已开启的物流 shadow 保留诊断合同；只收拢其中复用代码，删除实验另行根据实际使用证据推进。

## Capabilities

### New Capabilities

- `compact-market-pipeline`: 新市场内核、零交易写入 dryRun、逐 lane 差异证据和分阶段切换要求。
- `shared-runtime-helpers`: 保持语义的 Spawn 辅助与 console JSON 包装复用。

### Modified Capabilities

无；首次发布不改变生产市场的成交规则、主循环阶段或物流授权。

## Impact

涉及 `src/runtime/market/`、现有市场规划/运行边界、原矿溢出与采矿策略、Spawn 生产模块和 console 注册模块。新增轻量 `Memory.cfg.market`、`Memory.data.market`；保留旧市场根及 segment。构建和测试在服务器隔离目录执行。S4 的 live 切换、删除和放开限额是后续验收阶段，不将 dryRun 上线记为完整 S4 完成。
