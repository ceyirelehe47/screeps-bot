## MODIFIED Requirements

### Requirement: 主循环必须保持 canonical phase 顺序

系统 MUST 由声明式进程表定义生产拓扑。Treasury begin 后先执行部署身份与 coreDefense、defenseMode、homeDefense、towerControl，再执行其余既有生产阶段。防御与 T1 生存阶段每 tick 重试，不因低 bucket、预测预算或熔断而跳过。市场预检为 T2，其成功是本 tick 防御强化采购、资源调度和市场执行的前提。防御强化采购由新增 homeDefenseSupply 阶段执行，不能让订单扫描或市场写入阻塞前置防御。其余原有阶段之间的依赖顺序保持不变。每个阶段 MUST 具有唯一名称、tier、every、minBucket 和明确依赖；阶段 callback 必须完整接入，不能遗漏。

#### Scenario: 低预算或冷启动

- **WHEN** bucket 低、剩余 CPU 不足以覆盖可选阶段与后续关键阶段 EMA，或刚 global reset
- **THEN** 只延后符合条件的 T2–T4 阶段，记录原因与计数，防御、出生和 creep 执行继续尝试

#### Scenario: 市场预检未成功

- **WHEN** 预检因预算、异常或熔断未完成
- **THEN** 资源调度与市场执行不能使用尚未验证的本 tick 市场上下文

### Requirement: 失败传播和 flush 基线必须保持

系统 MUST 隔离可捕获的阶段与实体异常，并在 finally 内完成 Treasury 收尾、profiler flush、调度摘要和存储收尾。T2–T4 连续失败采用有界指数熔断并到期重试；T0–T1 不熔断。诊断面包屑 MUST 独立于 profiler 开关保存；只有 heap 仍在或该帧确已保存时才能恢复上次阶段与实体身份。硬终止丢弃当帧且 VM 重建时 MUST 仅报告完成 tick 缺口，不能声称恢复了被丢弃阶段。

#### Scenario: 阶段抛错

- **WHEN** 一个阶段抛出可捕获异常
- **THEN** 后续符合依赖的阶段继续执行，收尾不因该异常被跳过

#### Scenario: 硬超时后重建

- **WHEN** 上一 tick 的阶段面包屑未完成且发生 heap 重建
- **THEN** 下一 tick 在确有已保存面包屑时恢复阶段；帧被丢弃时只报告缺口，不依赖 CPU profiler 是否启用
