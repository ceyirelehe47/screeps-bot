# 运行时影子与 dryRun 的所有权

本表约束现存比较器的用途和退出条件。通过测试或上传代码不等于扩展市场/财政权限；既有许可、持久化控制窗口与最终原生写入门禁仍是唯一执行权威。未知、过期或不完整快照不能作为晋级依据。

| 范围 | owner 与入口 | 当前权威 | 毕业条件 | 删除条件 |
| --- | --- | --- | --- | --- |
| CPU 调度 | `processScheduler.ts`、`processTable.ts` | 已由真实 T0–T4 调度执行；旧 `cpuSchedulerShadow.ts` 仅兼容历史样本类型 | 低 bucket、后续关键阶段预算、熔断恢复与实际 shard 执行已验收；后续变更继续验证 | 历史样本与外部消费者不再依赖旧字段后移除兼容类型；不得恢复第二个影子调度器 |
| 帝国库存 | `empireInventoryShadow.ts`，数据 owner 为 TickContext/库存索引 | 只读诊断，无业务写入许可；T4、分层轮转与 oracle 采样 | 出生 accepted/native 快照、死亡、同 tick 装卸、跨房、heap reset 的 parity/oracle 均无差异，且保留可追溯运行窗口 | 新索引完整取代旧生产读取并有上述证据后，删除旧比较实现；保留独立稀疏对账入口 |
| 合成物流 | `logisticsControl.ts`、`synthesisLogisticsShadow.ts`，由 ResourceControl 接入 | 模式和 canary scope 决定权威；完整 producer epoch 是必要门禁 | 完整房间事实、容量/费用/预约与 accepted cargo 对账一致，回滚/归还源仓/出生死亡等反例通过；未知单房输入撤回未执行规划 | 最后 legacy intent 和在途责任结清、回滚桥不再引用时删除旧规划器；此前保留对照与 drain |
| Treasury T1–T4 | `treasuryTerminalTransferLane.ts` 与各 lane 的控制 owner | facade/WAL/受控 canary/单写者门禁；shadow 本身没有成交权限 | 完整控制窗口内 admission、WAL、原生调用、交易回执与账本一一对应，未知结果与 heap reset 可恢复，无 legacy 双写 | 所有旧责任 drain 完成、持久化控制和审计消费者迁移后删除相应观察器；不得因一次无差异样本撤除围栏 |
| 市场策略比较 | `market/comparison.ts`、`market/policy.ts` | `dryRun` 仅记录对照，V3 permit 继续决定执行权限 | 相同输入下候选、资源/费用底线和最终动作差异有解释，覆盖无单、价格变化、房间身份变化、权限撤销与 CPU 截断 | 新策略独立验收且既有执行权威迁移后，移除旧 comparator 与只用于比较的字段；保留许可/费用/实时库存最终校验 |
| Direct 市场 shadow | `marketSaleAutomation.ts`、`marketBaseResourceAutomation.ts` | 已签收许可及 owner 控制；按 lane 区分 shadow、暂停、执行 | lane 证据和许可晋级条件满足；static permit 校验可按已完整验证的不可变 epoch 复用，pending/账本/账号/房间/交易安全每 tick 重读 | lane 已毕业且无旧 permit/审计/回滚引用时移除旧分支；不得通过复用预检结果签发跨 tick readiness |

## 共同发布与失效规则

- 每个候选发布记录比较窗口、执行身份与不一致样本；出现差异先保留旧权威，不能自动扩大 scope。
- 市场廉价安全闸位于防御后的 T0，每 tick 执行；昂贵预检属于 T2，可延后。延后不解除旧市场、工厂采购和 pixel 的安全闸。
- segment 许可链的静态校验仅在完整不可变纯数据证明及语义校验后，按对象身份复用。epoch/manifest 切换或 heap reset 会换对象并重验；可变子树、访问器和外部高水位对账不命中缓存。
- 影子证据不是授权。删除条件未满足时保留相应观察器，并受现有采样、容量与 CPU 预算约束。
