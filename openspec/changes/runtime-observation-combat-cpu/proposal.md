## Why

线上 2026.10.4-2 的 66 个 CPU 样本均值 100.61、峰值 143.56；Observer 平均 10.87 CPU，PowerBank 调度平均 7.50 CPU。重复房间查询、双人重复占位检查和不必要增援同时消耗 CPU 与生产资源。

当前还确认了三个业务缺口：PowerBank 增援在封闭出口前持续撞墙，E3N53 沿 18 跳固定路线绕行，以及清剿必须等塔完全空才推进，未使用治疗能力。

## What Changes

- 将观察请求、覆盖评估与双人占位查询接到同 tick 共享快照，减少重复扫描与原生调用；新 tick、世界状态和服务身份变化必须失效。
- 修复 PowerBank 出口双格准入与沿边重新排位；来源出口、落地格和同步意图都必须可行。
- 主队能在当前寿命内完成 Bank 时不派增援；确需接班时才评估准备提前量，保留失去能力和无攻击进展的恢复路径。
- 清剿依据预计落点的炮塔总伤害与有效治疗量推进，并验证撤退余量；低等级 NPC 优先无强化，能力不足再使用 T3。
- 为清剿生成当前地图的可解释路线，保留显式路线授权，消除默认历史长绕路；原生路线长度与房内安全分别验证。
- 在服务器执行回归、构建和同输入性能比较，交付中文证据报告；上线与运行配置变更单独处理。

## Capabilities

### New Capabilities

- `runtime-observation-combat-cpu`: 同 tick 共享查询、战斗推进预算、必要增援和双人出口排位的生命周期与性能合同。

### Modified Capabilities

无。本轮新增共同约束，现有任务所有权、Memory 分区、交易 writer 和主循环顺序保持现有合同。

## Impact

涉及 `powerBankObserver`、`powerBankCombatPair`、`powerBankHarvest`、`towerDrainPair`、`warControl` 与其调用和测试。以线上源码 6878c3f 的文档后继 0b6ef5f3 为基线，候选分支为 `codex/architecture-cpu-round1`；高负载验证目录为服务器 `/srv/screeps-treasury-build/architecture-cpu-20261004`。
